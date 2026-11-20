import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { db, transaction } from '../services/db.js';
import { HttpError, normalize, required, enqueueStorageDeletion } from '../services/workflows.js';
import { reauthenticate } from '../auth/reauthenticate.js';
import type { Actor } from '../access/roles.js';
import * as L from './lifecycle-schemas.js';
import { getRecord, fingerprint } from './store.js';
import { planLifecycle, type LifecycleKind, type LifecyclePolicy } from './lifecycle-plan.js';

type Connection = Pick<PoolClient, 'query'>;
type Target = z.infer<typeof L.target>;
const registry = {
  enquiry: { table: 'enquiries', scope: 'category', trigger: 'closed_at' },
  application: { table: 'applications', scope: 'status', trigger: 'rejected_at' },
  file: { table: 'files', scope: 'classification', trigger: 'purpose_end_at' },
} as const;
const uuid = (value: string) => value.toLowerCase();
function found<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new HttpError(404, 'NOT_FOUND', 'Record not found');
  return value;
}
function definition(kind: LifecycleKind) {
  if (!Object.hasOwn(registry, kind))
    throw new HttpError(400, 'LIFECYCLE_TARGET', 'Unsupported lifecycle target');
  return registry[kind];
}
function owner(actor: Actor) {
  if (actor.role !== 'owner')
    throw new HttpError(
      403,
      'LIFECYCLE_OWNER',
      'Only the owner may change privacy holds or authorize erasure.',
    );
}
function asHold(value: unknown) {
  const r = normalize<Record<string, unknown>>(value);
  return L.hold.parse({
    id: r.id,
    targetKind: r.target_kind,
    targetId: r.target_id,
    reason: r.reason,
    evidenceRefs: r.evidence_refs,
    createdBy: r.created_by,
    createdAt: r.created_at,
    releasedBy: r.released_by,
    releasedAt: r.released_at,
    releaseReason: r.release_reason,
    version: r.version,
  });
}
export async function listHolds(input: z.infer<typeof L.holdsQuery>) {
  const values = [input.state, input.kind ?? null, input.targetId ?? null];
  const where =
    "WHERE ($1='all' OR ($1='active' AND released_at IS NULL) OR ($1='released' AND released_at IS NOT NULL)) AND ($2::text IS NULL OR target_kind=$2) AND ($3::uuid IS NULL OR target_id=$3)";
  const total = Number(
    (await db.query('SELECT count(*) AS n FROM privacy_holds ' + where, values)).rows[0].n,
  );
  const items = (
    await db.query(
      'SELECT * FROM privacy_holds ' + where + ' ORDER BY created_at DESC,id OFFSET $4 LIMIT $5',
      [...values, (input.page - 1) * input.limit, input.limit],
    )
  ).rows.map(asHold);
  return { items, total, page: input.page, limit: input.limit };
}
async function targetSnapshot(c: Connection, target: Target, lock = false) {
  const spec = definition(target.kind);
  const child =
    target.kind === 'application'
      ? ",t.file_id AS related_id,(SELECT storage_key FROM files WHERE id=t.file_id) AS storage_key,(SELECT encode(sha256(convert_to(to_jsonb(f)::text,'UTF8')),'hex') FROM files f WHERE f.id=t.file_id) AS related_sha256"
      : target.kind === 'file'
        ? ',(SELECT id FROM applications WHERE file_id=t.id) AS related_id,t.storage_key,NULL::text AS related_sha256'
        : ',NULL::uuid AS related_id,NULL::text AS storage_key,NULL::text AS related_sha256';
  const r = (
    await c.query(
      `SELECT t.id,t.${spec.scope} AS scope_tag,t.${spec.trigger} AS trigger_at,encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS record_sha256${child} FROM ${spec.table} t WHERE t.id=$1${lock ? ' FOR UPDATE OF t' : ''}`,
      [target.id],
    )
  ).rows[0];
  return r ? normalize<Record<string, unknown>>(r) : null;
}
export async function targetHeld(c: Connection, target: Target) {
  const direct = (
    await c.query(
      'SELECT 1 FROM privacy_holds WHERE target_kind=$1 AND target_id=$2 AND released_at IS NULL LIMIT 1',
      [target.kind, target.id],
    )
  ).rowCount;
  if (direct) return true;
  if (target.kind === 'application')
    return !!(
      await c.query(
        "SELECT 1 FROM privacy_holds h JOIN applications a ON a.file_id=h.target_id WHERE h.target_kind='file' AND a.id=$1 AND h.released_at IS NULL LIMIT 1",
        [target.id],
      )
    ).rowCount;
  if (target.kind === 'file')
    return !!(
      await c.query(
        "SELECT 1 FROM privacy_holds h JOIN applications a ON a.id=h.target_id WHERE h.target_kind='application' AND a.file_id=$1 AND h.released_at IS NULL LIMIT 1",
        [target.id],
      )
    ).rowCount;
  return false;
}
/** Lock related application/file identities in a stable order before business row locks. */
export async function lockLifecycleTarget(c: PoolClient, target: Target) {
  const initial = found(await targetSnapshot(c, target));
  const subjects: Target[] = [target];
  if (initial.related_id && target.kind === 'application')
    subjects.push({ kind: 'file', id: String(initial.related_id) });
  if (initial.related_id && target.kind === 'file')
    subjects.push({ kind: 'application', id: String(initial.related_id) });
  subjects.sort((a, b) => (a.kind + ':' + a.id).localeCompare(b.kind + ':' + b.id));
  for (const subject of subjects)
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('privacy:'||$1::text||':'||$2::uuid::text,0))",
      [subject.kind, subject.id],
    );
  const locked = new Map<string, Record<string, unknown>>();
  for (const subject of subjects)
    locked.set(subject.kind + ':' + subject.id, found(await targetSnapshot(c, subject, true)));
  const current = required(locked.get(target.kind + ':' + target.id));
  if (current.related_id !== initial.related_id)
    throw new HttpError(
      409,
      'LIFECYCLE_CHANGED',
      'The associated record changed. Refresh before retrying.',
    );
  return current;
}
export async function guardHeldDeletion(c: PoolClient, kind: LifecycleKind, id: string) {
  const target = { kind, id: uuid(id) };
  const snapshot = await lockLifecycleTarget(c, target);
  if (await targetHeld(c, target))
    throw new HttpError(409, 'PRIVACY_HOLD', 'An active privacy hold prevents deletion.');
  return snapshot;
}
async function holdEvent(
  c: PoolClient,
  id: string,
  action: string,
  actor: Actor,
  note: string,
  refs: string[],
  requestId: string,
) {
  await c.query(
    'INSERT INTO privacy_lifecycle_events(hold_id,actor_id,action,note,evidence_refs,http_request_id) VALUES($1,$2,$3,$4,$5,$6)',
    [id, actor.id, action, note, refs, requestId],
  );
  await c.query('INSERT INTO audit(actor_id,action,record_id,request_id) VALUES($1,$2,$3,$4)', [
    actor.id,
    'privacy.' + action,
    id,
    requestId,
  ]);
}
export async function createHold(
  input: z.infer<typeof L.holdCreate>,
  actor: Actor,
  sessionToken: string,
  requestId: string,
) {
  owner(actor);
  const target = { kind: input.target.kind, id: uuid(input.target.id) },
    id = uuid(input.id);
  const intent = fingerprint({
    target,
    reason: input.reason,
    evidenceRefs: input.evidenceRefs,
    actor: actor.id,
  });
  return transaction(async (c) => {
    const existing = (await c.query('SELECT * FROM privacy_holds WHERE id=$1 FOR UPDATE', [id]))
      .rows[0];
    if (existing) {
      if (existing.intent_sha256 !== intent)
        throw new HttpError(
          409,
          'LIFECYCLE_INTENT',
          'This operation ID was already used for another intention.',
        );
      return asHold(existing);
    }
    if (
      (await reauthenticate(
        c,
        { userId: actor.id, token: sessionToken, csrf: actor.csrf },
        input.stepUp,
      )) !== 'owner'
    )
      throw new HttpError(403, 'LIFECYCLE_OWNER', 'Owner confirmation required.');
    const current = await lockLifecycleTarget(c, target);
    if (current.storage_key) {
      const pending = await c.query(
        'SELECT status FROM storage_deletions WHERE storage_key=$1 FOR UPDATE',
        [current.storage_key],
      );
      if (pending.rowCount)
        throw new HttpError(
          409,
          'STORAGE_DELETION_STARTED',
          'Storage deletion has already been requested. Reconcile it before claiming a hold.',
        );
    }
    const inserted = await c.query(
      'INSERT INTO privacy_holds(id,target_kind,target_id,reason,evidence_refs,created_by,intent_sha256) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING *',
      [id, target.kind, target.id, input.reason, input.evidenceRefs, actor.id, intent],
    );
    const row =
      inserted.rows[0] ??
      required((await c.query('SELECT * FROM privacy_holds WHERE id=$1', [id])).rows[0]);
    if (row.intent_sha256 !== intent)
      throw new HttpError(
        409,
        'LIFECYCLE_INTENT',
        'This operation ID was already used for another intention.',
      );
    if (inserted.rowCount)
      await holdEvent(c, id, 'hold.created', actor, input.reason, input.evidenceRefs, requestId);
    return asHold(row);
  });
}
export async function releaseHold(
  id: string,
  input: z.infer<typeof L.holdRelease>,
  actor: Actor,
  sessionToken: string,
  requestId: string,
) {
  owner(actor);
  return transaction(async (c) => {
    const current = required(
      (await c.query('SELECT * FROM privacy_holds WHERE id=$1 FOR UPDATE', [id])).rows[0],
    );
    if (current.released_at) {
      if (current.released_by === actor.id && current.release_reason === input.reason)
        return asHold(current);
      throw new HttpError(
        409,
        'HOLD_RELEASED',
        'This hold is already released and its history is immutable.',
      );
    }
    if (current.version !== input.expectedVersion)
      throw new HttpError(409, 'LIFECYCLE_CHANGED', 'The hold changed. Reload before releasing.');
    if (
      (await reauthenticate(
        c,
        { userId: actor.id, token: sessionToken, csrf: actor.csrf },
        input.stepUp,
      )) !== 'owner'
    )
      throw new HttpError(403, 'LIFECYCLE_OWNER', 'Owner confirmation required.');
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('privacy:'||$1::text||':'||$2::uuid::text,0))",
      [current.target_kind, current.target_id],
    );
    const updated = required(
      (
        await c.query(
          'UPDATE privacy_holds SET released_by=$2,released_at=now(),release_reason=$3,version=2 WHERE id=$1 RETURNING *',
          [id, actor.id, input.reason],
        )
      ).rows[0],
    );
    await holdEvent(c, id, 'hold.released', actor, input.reason, [], requestId);
    return asHold(updated);
  });
}
export async function previewLifecycle(input: z.infer<typeof L.previewInput>) {
  return transaction(async (c) => {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let record = await getRecord(input.policyId, input.revision, c);
    if (
      input.mode === 'effective' &&
      input.revision === undefined &&
      record.effectiveRevision !== null
    )
      record = await getRecord(input.policyId, record.effectiveRevision, c);
    if (record.version.payload.type !== 'retention')
      throw new HttpError(400, 'LIFECYCLE_POLICY', 'Choose a retention rule.');
    const version = record.version;
    const payload = version.payload;
    if (payload.type !== 'retention')
      throw new HttpError(400, 'LIFECYCLE_POLICY', 'Choose a retention rule.');
    const policy: LifecyclePolicy = {
      stableId: record.stableId,
      revision: version.revision,
      effectiveRevision: record.effectiveRevision,
      status: version.status,
      archived: record.archived,
      productScopes: version.productScopes,
      sourceFingerprint: version.sourceFingerprint,
      effectiveAt: version.effectiveAt,
      reviewDueAt: version.reviewDueAt,
      payload,
    };
    const now = new Date().toISOString(),
      binding = policy.payload.lifecycleBinding;
    const empty = planLifecycle(policy, [], now, input.mode);
    if (!binding || empty.blockers.length)
      return { ...empty, hasMore: false, scope: 'portal' as const, sourceRecordHashes: {} };
    const spec = definition(binding.target),
      ids = input.targetIds?.map(uuid) ?? null;
    const rows = (
      await c.query(
        `SELECT t.id FROM ${spec.table} t WHERE t.${spec.scope}=ANY($1::text[]) AND ($2::uuid[] IS NULL OR t.id=ANY($2)) ORDER BY t.${spec.trigger} NULLS LAST,t.id LIMIT $3`,
        [binding.scopeTags, ids, input.limit + 1],
      )
    ).rows;
    const snapshots = [];
    const hashes: Record<string, string> = {};
    for (const row of rows.slice(0, input.limit)) {
      const target = { kind: binding.target, id: String(row.id) },
        snapshot = found(await targetSnapshot(c, target));
      snapshots.push({
        id: target.id,
        kind: target.kind,
        scopeTag: String(snapshot.scope_tag),
        triggerAt: snapshot.trigger_at ? String(snapshot.trigger_at) : null,
        held: await targetHeld(c, target),
      });
      hashes[target.kind + ':' + target.id] = String(snapshot.record_sha256);
    }
    return {
      ...planLifecycle(policy, snapshots, now, input.mode),
      hasMore: rows.length > input.limit,
      scope: 'portal' as const,
      sourceRecordHashes: hashes,
    };
  });
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const planFingerprint = (value: unknown) => fingerprint(canonical(value));
const externalActions = [
  'Verify processor/mailbox copies and any applicable exceptions.',
  'Reconcile post-snapshot deletion and active holds before restoring any backup.',
  'Confirm object absence separately; outbox acceptance is not proof of purged historical versions.',
];
type PlannedTarget = {
  kind: LifecycleKind;
  id: string;
  recordSha256: string | null;
  relatedId: string | null;
  relatedSha256: string | null;
  blocker: string | null;
};
async function plannedTarget(c: Connection, target: Target): Promise<PlannedTarget> {
  const snapshot = await targetSnapshot(c, target);
  if (!snapshot)
    return {
      ...target,
      recordSha256: null,
      relatedId: null,
      relatedSha256: null,
      blocker: 'NOT_FOUND',
    };
  const blocker = (await targetHeld(c, target))
    ? 'LEGAL_HOLD'
    : target.kind === 'file' && snapshot.related_id
      ? 'USE_APPLICATION_CASCADE'
      : target.kind === 'file' &&
          !['internal', 'confidential', 'applicant'].includes(String(snapshot.scope_tag))
        ? 'PUBLIC_FILE_OUTSIDE_SCOPE'
        : null;
  return {
    ...target,
    recordSha256: String(snapshot.record_sha256),
    relatedId: snapshot.related_id ? String(snapshot.related_id) : null,
    relatedSha256: snapshot.related_sha256 ? String(snapshot.related_sha256) : null,
    blocker,
  };
}
async function readCase(c: Connection, id: string) {
  const r = required(
    (await c.query('SELECT * FROM privacy_lifecycle_requests WHERE id=$1', [id])).rows[0],
  );
  const rows = (
    await c.query(
      'SELECT t.*,s.status AS storage_status FROM privacy_lifecycle_targets t LEFT JOIN storage_deletions s ON s.storage_key=t.storage_key WHERE request_id=$1 ORDER BY target_kind,target_id',
      [id],
    )
  ).rows;
  return L.lifecycleCase.parse({
    id: r.id,
    kind: r.request_kind,
    caseReference: r.case_reference,
    identityEvidenceRefs: r.identity_evidence_refs,
    createdBy: r.created_by,
    createdAt: new Date(r.created_at).toISOString(),
    state: r.state,
    version: r.version,
    planSha256: r.plan_sha256,
    targets: rows.map((t) => ({
      kind: t.target_kind,
      id: t.target_id,
      recordSha256: t.record_sha256,
      result: t.result,
      resultCode: t.result_code,
      storageStatus: t.storage_status ?? null,
    })),
    externalActionsRequired: ['completed', 'cancelled'].includes(r.state) ? [] : externalActions,
  });
}
export const getCase = (id: string) => readCase(db, id);
export async function listCases(input: { page: number; limit: number }) {
  const total = Number(
    (await db.query('SELECT count(*) AS n FROM privacy_lifecycle_requests')).rows[0].n,
  );
  const ids = (
    await db.query(
      'SELECT id FROM privacy_lifecycle_requests ORDER BY created_at DESC,id OFFSET $1 LIMIT $2',
      [(input.page - 1) * input.limit, input.limit],
    )
  ).rows;
  return { items: await Promise.all(ids.map((row) => readCase(db, row.id))), total, ...input };
}
async function caseEvent(
  c: PoolClient,
  id: string,
  action: string,
  actor: Actor,
  note: string,
  refs: string[],
  requestId: string,
) {
  await c.query(
    'INSERT INTO privacy_lifecycle_events(lifecycle_request_id,actor_id,action,note,evidence_refs,http_request_id) VALUES($1,$2,$3,$4,$5,$6)',
    [id, actor.id, action, note, refs, requestId],
  );
  await c.query('INSERT INTO audit(actor_id,action,record_id,request_id) VALUES($1,$2,$3,$4)', [
    actor.id,
    'privacy.' + action,
    id,
    requestId,
  ]);
}
export async function caseEvents(id: string) {
  await getCase(id);
  return {
    items: (
      await db.query(
        'SELECT * FROM privacy_lifecycle_events WHERE lifecycle_request_id=$1 ORDER BY id DESC LIMIT 200',
        [id],
      )
    ).rows.map((row) =>
      L.caseEvent.parse({
        id: String(row.id),
        action: row.action,
        actorId: row.actor_id,
        note: row.note,
        evidenceRefs: row.evidence_refs,
        createdAt: new Date(row.created_at).toISOString(),
      }),
    ),
  };
}
/** Explicit IDs only. No email search, automatic expiry, global sweep or implicit cross-product cascade. */
export async function createCase(
  input: z.infer<typeof L.caseCreate>,
  actor: Actor,
  requestId: string,
) {
  const targets = input.targets
    .map((t) => ({ kind: t.kind, id: uuid(t.id) }))
    .sort((a, b) => (a.kind + ':' + a.id).localeCompare(b.kind + ':' + b.id));
  if (new Set(targets.map((t) => t.kind + ':' + t.id)).size !== targets.length)
    throw new HttpError(400, 'DUPLICATE_TARGET', 'Each target may appear once.');
  const id = uuid(input.id),
    intent = fingerprint({
      caseReference: input.caseReference,
      identityEvidenceRefs: input.identityEvidenceRefs,
      targets,
      actor: actor.id,
    });
  return transaction(async (c) => {
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('privacy-case:'||$1::uuid::text,0))",
      [id],
    );
    const prior = (
      await c.query('SELECT intent_sha256 FROM privacy_lifecycle_requests WHERE id=$1', [id])
    ).rows[0];
    if (prior) {
      if (prior.intent_sha256 !== intent)
        throw new HttpError(
          409,
          'LIFECYCLE_INTENT',
          'This case ID already belongs to another intention.',
        );
      return readCase(c, id);
    }
    const planned = [];
    for (const target of targets) planned.push(await plannedTarget(c, target));
    if (
      planned.some(
        (t) =>
          t.kind === 'application' &&
          targets.some((other) => other.kind === 'file' && other.id === t.relatedId),
      )
    )
      throw new HttpError(
        400,
        'OVERLAPPING_TARGETS',
        'An application plan already includes its attached file.',
      );
    const plan = {
      schema: 1,
      kind: 'erasure',
      scope: 'portal',
      targets: planned,
      externalActionsRequired: externalActions,
    };
    await c.query(
      "INSERT INTO privacy_lifecycle_requests(id,request_kind,case_reference,identity_evidence_refs,created_by,plan_sha256,plan,intent_sha256) VALUES($1,'erasure',$2,$3,$4,$5,$6,$7)",
      [
        id,
        input.caseReference,
        input.identityEvidenceRefs,
        actor.id,
        planFingerprint(plan),
        plan,
        intent,
      ],
    );
    for (const t of planned)
      await c.query(
        'INSERT INTO privacy_lifecycle_targets(request_id,target_kind,target_id,record_sha256,result,result_code) VALUES($1,$2,$3,$4,$5,$6)',
        [
          id,
          t.kind,
          t.id,
          t.recordSha256,
          t.blocker === 'LEGAL_HOLD'
            ? 'held'
            : t.blocker === 'NOT_FOUND'
              ? 'not_found'
              : t.blocker
                ? 'skipped'
                : 'planned',
          t.blocker ?? 'PREVIEW_ONLY',
        ],
      );
    await caseEvent(
      c,
      id,
      'case.planned',
      actor,
      'Explicit target preview; no deletion or policy approval.',
      input.identityEvidenceRefs,
      requestId,
    );
    return readCase(c, id);
  });
}
export async function cancelCase(
  id: string,
  input: z.infer<typeof L.caseAction>,
  actor: Actor,
  requestId: string,
) {
  return transaction(async (c) => {
    const r = required(
      (await c.query('SELECT * FROM privacy_lifecycle_requests WHERE id=$1 FOR UPDATE', [id]))
        .rows[0],
    );
    if (r.plan_sha256 !== input.planSha256)
      throw new HttpError(409, 'LIFECYCLE_CHANGED', 'The plan identity changed.');
    if (r.state === 'cancelled') return readCase(c, id);
    if (r.state !== 'planned' || r.version !== input.expectedVersion)
      throw new HttpError(
        409,
        'LIFECYCLE_CHANGED',
        'Only an unchanged unexecuted plan may be cancelled.',
      );
    await c.query(
      "UPDATE privacy_lifecycle_requests SET state='cancelled',cancelled_at=now(),version=version+1 WHERE id=$1",
      [id],
    );
    await caseEvent(c, id, 'case.cancelled', actor, input.note, [], requestId);
    return readCase(c, id);
  });
}
/** Owner-confirmed local erasure. External/provider and backup actions remain explicitly outstanding. */
export async function executeCase(
  id: string,
  input: z.infer<typeof L.caseAction>,
  actor: Actor,
  sessionToken: string,
  requestId: string,
) {
  owner(actor);
  return transaction(async (c) => {
    const r = required(
      (await c.query('SELECT * FROM privacy_lifecycle_requests WHERE id=$1 FOR UPDATE', [id]))
        .rows[0],
    );
    if (r.plan_sha256 !== input.planSha256)
      throw new HttpError(409, 'LIFECYCLE_CHANGED', 'The plan identity changed.');
    if (['partial', 'storage_pending'].includes(r.state)) return readCase(c, id); // Replaying an acknowledged operation never executes it again.
    if (r.state !== 'planned' || r.version !== input.expectedVersion)
      throw new HttpError(
        409,
        'LIFECYCLE_CHANGED',
        'Only the unchanged planned version may execute.',
      );
    if (
      (await reauthenticate(
        c,
        { userId: actor.id, token: sessionToken, csrf: actor.csrf },
        input.stepUp,
      )) !== 'owner'
    )
      throw new HttpError(403, 'LIFECYCLE_OWNER', 'Owner confirmation required.');
    if (
      r.request_kind !== 'erasure' ||
      r.plan.kind !== 'erasure' ||
      r.plan.scope !== 'portal' ||
      planFingerprint(r.plan) !== r.plan_sha256
    )
      throw new HttpError(409, 'LIFECYCLE_PLAN', 'Unsupported or inconsistent plan.');
    const targets = r.plan.targets as PlannedTarget[];
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 20)
      throw new HttpError(409, 'LIFECYCLE_PLAN', 'Invalid bounded plan.');
    await c.query(
      "UPDATE privacy_lifecycle_requests SET state='executing',reviewed_by=$2,reviewed_at=now() WHERE id=$1",
      [id, actor.id],
    );
    for (const target of targets) {
      await c.query('SAVEPOINT privacy_target');
      let result = 'skipped',
        code = target.blocker ?? 'UNRECONCILED',
        storageKey: string | null = null;
      try {
        if (!target.blocker) {
          const current = await lockLifecycleTarget(c, target),
            latest = await plannedTarget(c, target);
          if (latest.blocker) {
            result = latest.blocker === 'LEGAL_HOLD' ? 'held' : 'skipped';
            code = latest.blocker;
          } else if (
            latest.recordSha256 !== target.recordSha256 ||
            latest.relatedId !== target.relatedId ||
            latest.relatedSha256 !== target.relatedSha256
          ) {
            code = 'RECORD_CHANGED';
          } else {
            const fileId =
              target.kind === 'application'
                ? target.relatedId
                : target.kind === 'file'
                  ? target.id
                  : null;
            const keys = [
              ...(target.kind === 'enquiry'
                ? ['enquiry:' + target.id]
                : target.kind === 'application'
                  ? ['application-notify:' + target.id, 'application-ack:' + target.id]
                  : []),
              ...(fileId
                ? ['pending', 'approved', 'rejected'].map(
                    (state) => 'document-approval:' + fileId + ':' + state,
                  )
                : []),
            ];
            const reminder = target.kind === 'enquiry' ? target.id : null;
            const jobScope =
              "dedupe_key=ANY($1::text[]) OR ($2::uuid IS NOT NULL AND (dedupe_key LIKE 'reminder-due:'||$2::uuid::text||':%' OR (kind='reminder' AND payload->>'recordId'=$2::uuid::text)))";
            const jobs = await c.query(
              'SELECT status FROM jobs WHERE ' + jobScope + ' FOR UPDATE',
              [keys, reminder],
            );
            if (jobs.rows.some((job) => job.status === 'running')) {
              code = 'MAIL_DELIVERY_IN_FLIGHT';
            } else {
              await c.query('DELETE FROM jobs WHERE ' + jobScope, [keys, reminder]);
              const spec = definition(target.kind);
              await c.query(`DELETE FROM ${spec.table} WHERE id=$1`, [target.id]);
              if (target.kind === 'application')
                await c.query('DELETE FROM files WHERE id=$1', [target.relatedId]);
              // Only completed exact-target transfer receipts; unfinished uploads have no proven subject association.
              await c.query(
                "DELETE FROM bounded_transfers WHERE result_status=201 AND result->>'id'=ANY($1::text[])",
                [[target.id, ...(target.relatedId ? [target.relatedId] : [])]],
              );
              storageKey = current.storage_key ? String(current.storage_key) : null;
              if (storageKey) await enqueueStorageDeletion(c, storageKey);
              result = storageKey ? 'storage_pending' : 'deleted';
              code = storageKey ? 'OUTBOX_REQUESTED' : 'LOCAL_DATABASE_ERASED';
            }
          }
        }
        await c.query('RELEASE SAVEPOINT privacy_target');
      } catch (error) {
        await c.query('ROLLBACK TO SAVEPOINT privacy_target');
        await c.query('RELEASE SAVEPOINT privacy_target');
        const failure = error as { code?: string; constraint?: string };
        result =
          failure.constraint === 'privacy_active_hold'
            ? 'held'
            : failure instanceof HttpError && failure.status === 404
              ? 'not_found'
              : 'failed';
        code =
          result === 'held'
            ? 'LEGAL_HOLD'
            : result === 'not_found'
              ? 'NOT_FOUND'
              : 'TARGET_TRANSACTION_FAILED';
        storageKey = null;
      }
      await c.query(
        'UPDATE privacy_lifecycle_targets SET result=$4,result_code=$5,storage_key=$6,updated_at=now() WHERE request_id=$1 AND target_kind=$2 AND target_id=$3',
        [id, target.kind, target.id, result, code, storageKey],
      );
    }
    // Local database success is deliberately not labelled a fully completed erasure.
    await c.query(
      "UPDATE privacy_lifecycle_requests SET state=CASE WHEN EXISTS(SELECT 1 FROM privacy_lifecycle_targets WHERE request_id=$1 AND result='storage_pending') THEN 'storage_pending' ELSE 'partial' END,version=version+1 WHERE id=$1",
      [id],
    );
    await caseEvent(c, id, 'case.executed', actor, input.note, [], requestId);
    return readCase(c, id);
  });
}

/** Candidate replay material only. The owner must reconcile historical/external coverage before use. */
export async function exportReplay(input: z.infer<typeof L.replayExportInput>) {
  return transaction(async (c) => {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const now = new Date(),
      backup = new Date(input.backupCreatedAt);
    if (!Number.isFinite(backup.getTime()) || backup > now)
      throw new HttpError(400, 'REPLAY_WATERMARK', 'Backup time must be a valid past timestamp.');
    const start = required(
      (
        await c.query(
          "SELECT applied_at FROM schema_migrations WHERE name='009_privacy_lifecycle.sql'",
        )
      ).rows[0],
    );
    const events = {
      deleted_enquiries: [] as string[],
      deleted_applications: [] as string[],
      deleted_files: [] as string[],
      unpublished_content: [] as string[],
      disabled_users: [] as string[],
    };
    const holds = structuredClone(events);
    const key = {
      enquiry: 'deleted_enquiries',
      application: 'deleted_applications',
      file: 'deleted_files',
    } as const;
    const rows = (
      await c.query(
        'SELECT DISTINCT target_kind,target_id FROM privacy_erasure_journal WHERE erased_at>=$1 AND erased_at<=$2 ORDER BY target_kind,target_id LIMIT 3001',
        [backup.toISOString(), now.toISOString()],
      )
    ).rows;
    const active = (
      await c.query(
        'SELECT DISTINCT target_kind,target_id FROM privacy_holds WHERE released_at IS NULL ORDER BY target_kind,target_id LIMIT 3001',
      )
    ).rows;
    for (const row of rows) events[key[row.target_kind as LifecycleKind]].push(row.target_id);
    for (const row of active) holds[key[row.target_kind as LifecycleKind]].push(row.target_id);
    // A file hold also protects its containing application during an isolated restore.
    for (const row of (
      await c.query(
        "SELECT DISTINCT a.id FROM applications a JOIN privacy_holds h ON h.target_kind='file' AND h.target_id=a.file_id AND h.released_at IS NULL LIMIT 1001",
      )
    ).rows)
      holds.deleted_applications.push(row.id);
    for (const row of (
      await c.query(
        "SELECT DISTINCT a.file_id FROM applications a JOIN privacy_holds h ON h.target_kind='application' AND h.target_id=a.id AND h.released_at IS NULL LIMIT 1001",
      )
    ).rows)
      holds.deleted_files.push(row.file_id);
    for (const map of [events, holds])
      for (const k of Object.keys(map) as (keyof typeof events)[]) {
        map[k] = [...new Set(map[k])].sort();
        if (map[k].length > 1000)
          throw new HttpError(
            409,
            'REPLAY_EXPORT_BOUND',
            'Replay categories exceed the supported bound. Use a reviewed operator export.',
          );
      }
    return L.replayExport.parse({
      schema: 1,
      classification: 'INTERNAL',
      complete: false,
      activationAuthorized: false,
      coverageStartedAt: new Date(start.applied_at).toISOString(),
      remainingReconciliation: [
        'Reconcile erasures before journal installation and the complete post-snapshot interval.',
        'Reconcile unpublished content, disabled users, external processors, in-flight transactions and current legal holds.',
        'Validate the exact backup hash, isolated restore and current release controls; this export grants no activation authority.',
      ],
      candidateLedger: {
        schema: 1,
        product: 'portal',
        source_backup_sha256: input.sourceBackupSha256,
        backup_created_at: backup.toISOString(),
        reconciled_through: now.toISOString(),
        events,
        legal_holds: holds,
      },
    });
  });
}

export async function completeCase(
  id: string,
  input: z.infer<typeof L.caseCompletion>,
  actor: Actor,
  sessionToken: string,
  requestId: string,
) {
  owner(actor);
  return transaction(async (c) => {
    const r = required(
      (await c.query('SELECT * FROM privacy_lifecycle_requests WHERE id=$1 FOR UPDATE', [id]))
        .rows[0],
    );
    if (r.plan_sha256 !== input.planSha256)
      throw new HttpError(409, 'LIFECYCLE_CHANGED', 'The plan identity changed.');
    if (r.state === 'completed') return readCase(c, id);
    if (!['partial', 'storage_pending'].includes(r.state) || r.version !== input.expectedVersion)
      throw new HttpError(409, 'LIFECYCLE_CHANGED', 'Review the current executed request first.');
    const targets = (
      await c.query(
        'SELECT t.result,t.storage_key,s.status FROM privacy_lifecycle_targets t LEFT JOIN storage_deletions s ON s.storage_key=t.storage_key WHERE request_id=$1',
        [id],
      )
    ).rows;
    if (
      !targets.length ||
      targets.some(
        (t) =>
          t.result !== 'deleted' && (t.result !== 'storage_pending' || t.status !== 'accepted'),
      )
    )
      throw new HttpError(
        409,
        'ERASURE_INCOMPLETE',
        'One or more local targets or storage requests remain unresolved.',
      );
    if (targets.some((t) => t.storage_key) && !input.storageVerificationEvidenceRefs.length)
      throw new HttpError(
        409,
        'STORAGE_EVIDENCE',
        'Record independent storage-verification evidence, including versioning limitations.',
      );
    if (
      (await reauthenticate(
        c,
        { userId: actor.id, token: sessionToken, csrf: actor.csrf },
        input.stepUp,
      )) !== 'owner'
    )
      throw new HttpError(403, 'LIFECYCLE_OWNER', 'Owner confirmation required.');
    await c.query(
      "UPDATE privacy_lifecycle_targets SET result='deleted',result_code='STORAGE_ACCEPTED_OWNER_VERIFIED',updated_at=now() WHERE request_id=$1 AND result='storage_pending'",
      [id],
    );
    await c.query(
      "UPDATE privacy_lifecycle_requests SET state='completed',completed_at=now(),version=version+1 WHERE id=$1",
      [id],
    );
    await caseEvent(
      c,
      id,
      'case.completed',
      actor,
      'Owner-recorded external reconciliation; not an automated provider or historical-backup purge certification. ' +
        input.note,
      [
        ...input.processorEvidenceRefs,
        ...input.backupReplayEvidenceRefs,
        ...input.storageVerificationEvidenceRefs,
      ],
      requestId,
    );
    return readCase(c, id);
  });
}
