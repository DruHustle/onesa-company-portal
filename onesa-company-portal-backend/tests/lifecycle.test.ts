import './local-environment.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { governanceSeed } from './governance-fixture.js';
if (
  !process.env.TEST_DATABASE_URL ||
  !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')
)
  throw new Error('Governance tests require an isolated _test database');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
process.env.COMPANY_ORIGIN = '';
process.env.SESSION_KEY = randomBytes(32).toString('hex');
process.env.PUBLIC_ORIGIN = 'http://localhost:3300';
process.env.STORAGE_DIR = await mkdtemp(join(tmpdir(), 'onesa-governance-test-'));
process.env.S3_BUCKET = '';
process.env.S3_ENDPOINT = '';
process.env.AWS_ENDPOINT_URL_S3 = '';
process.env.MAIL_PROVIDER = 'smtp';
process.env.SMTP_HOST = '';
process.env.RESEND_API_KEY = 'synthetic-disabled-provider';
process.env.NOTIFY_EMAIL = 'synthetic@example.invalid';
const { db } = await import('../src/services/db.js'),
  { migrate } = await import('../src/services/migrate.js');
const { buildApp } = await import('../src/app.js'),
  { importGovernance } = await import('../src/governance/import.js');
const { hash, passwordHash, encrypt } = await import('../src/auth/crypto.js');
const app = await buildApp({ logging: false }),
  password = randomBytes(32).toString('hex'),
  actors = new Map<
    string,
    { id: string; headers: { cookie: string; 'x-csrf-token': string; origin: string } }
  >();
before(async () => {
  await migrate();
  await db.query(
    'TRUNCATE governance_events,governance_versions,governance_records,audit,users CASCADE',
  );
  for (const role of ['owner', 'administrator', 'editor', 'business', 'hr', 'viewer']) {
    const id = randomUUID(),
      raw = randomBytes(32).toString('hex'),
      csrf = randomBytes(32).toString('hex');
    await db.query(
      'INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,$2,$3,$4,$5)',
      [
        id,
        `governance-${id}@example.invalid`,
        passwordHash(password),
        role,
        encrypt('JBSWY3DPEHPK3PXP'),
      ],
    );
    await db.query(
      "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [hash(raw), id, csrf],
    );
    actors.set(role, {
      id,
      headers: {
        cookie: 'onesa_session=' + raw,
        'x-csrf-token': csrf,
        origin: process.env.PUBLIC_ORIGIN!,
      },
    });
  }
  await importGovernance(governanceSeed());
  await app.ready();
});
after(async () => {
  await app.close();
  await db.end();
  await rm(process.env.STORAGE_DIR!, { recursive: true, force: true });
});
const prefix = '/api/v1/admin/governance';
const owner = () => actors.get('owner')!;
async function proof() {
  const code = randomUUID();
  await db.query('INSERT INTO mfa_recovery(user_id,code_hash) VALUES($1,$2)', [
    owner().id,
    hash(code),
  ]);
  return { password, code };
}
const json = (role = 'owner') => actors.get(role)!.headers;
async function enquiry() {
  const id = randomUUID();
  await db.query(
    "INSERT INTO enquiries(id,category,name,email,message,locale) VALUES($1,'general','Synthetic lifecycle test','synthetic@example.invalid','Isolated fixture only','en')",
    [id],
  );
  return { kind: 'enquiry' as const, id };
}
async function application() {
  const id = randomUUID(),
    file = randomUUID(),
    job = randomUUID();
  await db.query(
    "INSERT INTO content(id,kind,locale,slug,title,body,state) VALUES($1,'job','en',$2,'Synthetic vacancy','Fixture only','draft')",
    [job, job],
  );
  await db.query(
    "INSERT INTO files(id,filename,mime,size,storage_key,sha256,classification,title) VALUES($1,'synthetic.pdf','application/pdf',123,$1::uuid::text,$2,'applicant','Synthetic fixture')",
    [file, 'a'.repeat(64)],
  );
  await db.query(
    "INSERT INTO applications(id,job_id,name,email,file_id,delete_after) VALUES($1,$2,'Synthetic applicant','synthetic@example.invalid',$3,now()+interval '1 day')",
    [id, job, file],
  );
  return { kind: 'application' as const, id, file };
}
async function hold(target: { kind: string; id: string }, id = randomUUID()) {
  const payload = {
    id,
    target,
    reason: 'Synthetic preservation test only',
    evidenceRefs: ['tests/synthetic/hold'],
    stepUp: await proof(),
  };
  return {
    payload,
    response: await app.inject({
      method: 'POST',
      url: prefix + '/holds',
      headers: json(),
      payload,
    }),
  };
}
async function plan(targets: { kind: string; id: string }[], id = randomUUID()) {
  const payload = {
    id,
    caseReference: 'Synthetic isolated erasure request',
    identityEvidenceRefs: ['tests/synthetic/identity'],
    targets: targets.map(({ kind, id }) => ({ kind, id })),
  };
  return {
    payload,
    response: await app.inject({
      method: 'POST',
      url: prefix + '/requests',
      headers: json(),
      payload,
    }),
  };
}
async function execute(record: { id: string; version: number; planSha256: string }, extra = {}) {
  return app.inject({
    method: 'POST',
    url: prefix + '/requests/' + record.id + '/execute',
    headers: json(),
    payload: {
      expectedVersion: record.version,
      planSha256: record.planSha256,
      note: 'Synthetic owner scope confirmation',
      stepUp: await proof(),
      ...extra,
    },
  });
}
test('Lifecycle endpoints enforce anonymous denial, exact roles, CSRF and fresh owner proof', async () => {
  for (const path of ['/holds', '/requests']) {
    assert.equal((await app.inject({ url: prefix + path })).statusCode, 401);
    for (const role of ['editor', 'business', 'hr', 'viewer'])
      assert.equal((await app.inject({ url: prefix + path, headers: json(role) })).statusCode, 403);
    assert.equal(
      (await app.inject({ url: prefix + path, headers: json('administrator') })).statusCode,
      200,
    );
  }
  const target = await enquiry(),
    payload = {
      id: randomUUID(),
      target,
      reason: 'Synthetic isolated hold',
      evidenceRefs: ['tests/synthetic/hold'],
    };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: prefix + '/holds',
        headers: json('administrator'),
        payload,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: prefix + '/holds', headers: json(), payload }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: prefix + '/holds',
        headers: { ...json(), 'x-csrf-token': 'invalid' },
        payload: { ...payload, stepUp: await proof() },
      })
    ).statusCode,
    403,
  );
});
test('A hold protects actual deletion at API and database boundaries; retries preserve one event and proof is never stored', async () => {
  const target = await enquiry(),
    { response, payload } = await hold(target);
  assert.equal(response.statusCode, 200, response.body);
  const again = await app.inject({
    method: 'POST',
    url: prefix + '/holds',
    headers: json(),
    payload,
  });
  assert.equal(again.statusCode, 200);
  assert.equal(
    (
      await db.query('SELECT count(*)::int AS n FROM privacy_lifecycle_events WHERE hold_id=$1', [
        payload.id,
      ])
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/enquiries/' + target.id,
        headers: json(),
        payload: {},
      })
    ).statusCode,
    409,
  );
  await assert.rejects(db.query('DELETE FROM enquiries WHERE id=$1', [target.id]), {
    code: '23514',
    constraint: 'privacy_active_hold',
  });
  const second = await app.inject({
    method: 'POST',
    url: prefix + '/holds',
    headers: json(),
    payload: { ...payload, id: randomUUID(), target: await enquiry() },
  });
  assert.equal(second.statusCode, 403);
  const serialized = JSON.stringify(
    (await db.query('SELECT * FROM privacy_lifecycle_events WHERE hold_id=$1', [payload.id])).rows,
  );
  assert.ok(!serialized.includes(password));
  assert.ok(!serialized.includes(payload.stepUp.code));
  const release = await app.inject({
    method: 'POST',
    url: prefix + '/holds/' + payload.id + '/release',
    headers: json(),
    payload: {
      expectedVersion: 1,
      reason: 'Synthetic case concluded safely',
      stepUp: await proof(),
    },
  });
  assert.equal(release.statusCode, 200, release.body);
  await assert.rejects(db.query('DELETE FROM privacy_holds WHERE id=$1', [payload.id]), {
    code: '23514',
  });
  await assert.rejects(
    db.query("UPDATE privacy_holds SET reason='Changed historical reason' WHERE id=$1", [
      payload.id,
    ]),
    { code: '23514' },
  );
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/enquiries/' + target.id,
        headers: json(),
        payload: {},
      })
    ).statusCode,
    200,
  );
});
test('File holds prevent attached application cascade, and actual outcome timestamps never invent historical dates', async () => {
  const a = await application(),
    held = await hold({ kind: 'file', id: a.file });
  assert.equal(held.response.statusCode, 200, held.response.body);
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/applications/' + a.id,
        headers: json(),
        payload: {},
      })
    ).statusCode,
    409,
  );
  assert.equal((await db.query('SELECT id FROM files WHERE id=$1', [a.file])).rowCount, 1);
  const e = await enquiry();
  await db.query("UPDATE enquiries SET status='closed' WHERE id=$1", [e.id]);
  const closed = (await db.query('SELECT closed_at FROM enquiries WHERE id=$1', [e.id])).rows[0]
    .closed_at;
  assert.ok(closed);
  await db.query("UPDATE enquiries SET notes='Synthetic note only' WHERE id=$1", [e.id]);
  assert.equal(
    (
      await db.query('SELECT closed_at FROM enquiries WHERE id=$1', [e.id])
    ).rows[0].closed_at.toISOString(),
    closed.toISOString(),
  );
  await db.query("UPDATE enquiries SET status='new' WHERE id=$1", [e.id]);
  assert.equal(
    (await db.query('SELECT closed_at FROM enquiries WHERE id=$1', [e.id])).rows[0].closed_at,
    null,
  );
  const old = randomUUID();
  await db.query(
    "INSERT INTO enquiries(id,category,name,email,message,locale,status) VALUES($1,'general','Old synthetic fixture','old@example.invalid','No historical trigger','en','closed')",
    [old],
  );
  assert.equal(
    (await db.query('SELECT closed_at FROM enquiries WHERE id=$1', [old])).rows[0].closed_at,
    null,
  );
});
test('Explicit plans are non-mutating, bounded and cancellable; operation IDs cannot be rebound', async () => {
  const e = await enquiry(),
    p = await plan([e]);
  assert.equal(p.response.statusCode, 200, p.response.body);
  const r = p.response.json();
  assert.equal(r.state, 'planned');
  assert.equal((await db.query('SELECT id FROM enquiries WHERE id=$1', [e.id])).rowCount, 1);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: prefix + '/requests',
        headers: json(),
        payload: p.payload,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: prefix + '/requests',
        headers: json(),
        payload: { ...p.payload, caseReference: 'Different synthetic intention' },
      })
    ).statusCode,
    409,
  );
  assert.equal((await plan([e, e])).response.statusCode, 400);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: prefix + '/requests/' + r.id + '/cancel',
        headers: json('administrator'),
        payload: {
          expectedVersion: r.version,
          planSha256: r.planSha256,
          note: 'Synthetic cancellation before any deletion',
        },
      })
    ).statusCode,
    200,
  );
  assert.equal((await execute(r)).statusCode, 409);
  assert.equal((await db.query('SELECT id FROM enquiries WHERE id=$1', [e.id])).rowCount, 1);
});
test('Record changes and holds added after preview block deletion with exact per-target results', async () => {
  const e = await enquiry(),
    p = (await plan([e])).response.json();
  await db.query("UPDATE enquiries SET message='Synthetic modified record' WHERE id=$1", [e.id]);
  const changed = await execute(p);
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().targets[0].resultCode, 'RECORD_CHANGED');
  const other = await enquiry(),
    q = (await plan([other])).response.json();
  assert.equal((await hold(other)).response.statusCode, 200);
  const held = await execute(q);
  assert.equal(held.statusCode, 200, held.body);
  assert.equal(held.json().targets[0].result, 'held');
  assert.equal((await db.query('SELECT id FROM enquiries WHERE id=$1', [other.id])).rowCount, 1);
  const a = await application(),
    c = (await plan([a])).response.json();
  await db.query("UPDATE files SET title='Synthetic changed child file' WHERE id=$1", [a.file]);
  const child = await execute(c);
  assert.equal(child.json().targets[0].resultCode, 'RECORD_CHANGED');
  assert.equal((await db.query('SELECT id FROM applications WHERE id=$1', [a.id])).rowCount, 1);
});
test('Owner execution commits exact application cascade/outbox, removes related local payloads and is idempotent without claiming full erasure', async () => {
  const a = await application();
  await db.query("INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1,'email',$2,$3)", [
    randomUUID(),
    'application-ack:' + a.id,
    { to: 'synthetic@example.invalid', text: 'Synthetic only' },
  ]);
  const transfer = randomUUID();
  await db.query(
    "INSERT INTO bounded_transfers(id,peer_hash,capability_hash,scope,expected_bytes,checksum,result,result_status) VALUES($1,'synthetic','synthetic','application',1,'synthetic',$2,201)",
    [transfer, { id: a.id, status: 'saved' }],
  );
  const p = await plan([a]);
  assert.equal(p.response.statusCode, 200, p.response.body);
  const r = p.response.json();
  const denied = await app.inject({
    method: 'POST',
    url: prefix + '/requests/' + r.id + '/execute',
    headers: json('administrator'),
    payload: {
      expectedVersion: 1,
      planSha256: r.planSha256,
      note: 'Synthetic forbidden execution',
    },
  });
  assert.equal(denied.statusCode, 403);
  const result = await execute(r);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().state, 'storage_pending');
  assert.equal(result.json().targets[0].result, 'storage_pending');
  assert.ok(result.json().externalActionsRequired.length);
  for (const [table, id] of [
    ['applications', a.id],
    ['files', a.file],
    ['bounded_transfers', transfer],
  ])
    assert.equal((await db.query(`SELECT id FROM ${table} WHERE id=$1`, [id])).rowCount, 0);
  assert.equal(
    (await db.query('SELECT id FROM jobs WHERE dedupe_key=$1', ['application-ack:' + a.id]))
      .rowCount,
    0,
  );
  assert.equal(
    (await db.query('SELECT status FROM storage_deletions WHERE storage_key=$1', [a.file])).rows[0]
      .status,
    'pending',
  );
  const retry = await execute(r);
  assert.equal(retry.statusCode, 200);
  assert.deepEqual(retry.json(), result.json());
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM privacy_lifecycle_events WHERE lifecycle_request_id=$1 AND action='case.executed'",
        [r.id],
      )
    ).rows[0].n,
    1,
  );
  const events = await app.inject({
    url: prefix + '/requests/' + r.id + '/events',
    headers: json(),
  });
  assert.equal(events.statusCode, 200);
  assert.equal(events.json().items.length, 2);
  assert.ok(!events.body.includes(password));
});
test('In-flight email delivery is deferred and a failing target rolls back its own changes while other exact targets finish', async () => {
  const running = await enquiry();
  await db.query(
    "INSERT INTO jobs(id,kind,dedupe_key,payload,status) VALUES($1,'email',$2,$3,'running')",
    [randomUUID(), 'enquiry:' + running.id, { to: 'synthetic@example.invalid' }],
  );
  const p = (await plan([running])).response.json();
  const deferred = await execute(p);
  assert.equal(deferred.json().targets[0].resultCode, 'MAIL_DELIVERY_IN_FLIGHT');
  assert.equal((await db.query('SELECT id FROM enquiries WHERE id=$1', [running.id])).rowCount, 1);
  const a = await application(),
    other = await enquiry();
  await db.query(
    `CREATE FUNCTION synthetic_lifecycle_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='${a.file}'::uuid THEN RAISE EXCEPTION 'Synthetic isolated target failure'; END IF; RETURN OLD; END $$`,
  );
  await db.query(
    'CREATE TRIGGER synthetic_failure BEFORE DELETE ON files FOR EACH ROW EXECUTE FUNCTION synthetic_lifecycle_failure()',
  );
  try {
    const q = (await plan([a, other])).response.json(),
      result = await execute(q);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().targets.find((t: { id: string }) => t.id === a.id).result, 'failed');
    assert.equal(
      result.json().targets.find((t: { id: string }) => t.id === other.id).result,
      'deleted',
    );
    assert.equal((await db.query('SELECT id FROM applications WHERE id=$1', [a.id])).rowCount, 1);
    assert.equal((await db.query('SELECT id FROM files WHERE id=$1', [a.file])).rowCount, 1);
    assert.equal(
      (await db.query('SELECT storage_key FROM storage_deletions WHERE storage_key=$1', [a.file]))
        .rowCount,
      0,
    );
  } finally {
    await db.query('DROP TRIGGER synthetic_failure ON files');
    await db.query('DROP FUNCTION synthetic_lifecycle_failure()');
  }
});
test('Read-only policy previews require an explicit Portal binding and preserve original draft/approval state', async () => {
  const record = (await app.inject({ url: prefix + '/records/RET-02', headers: json() })).json(),
    v = record.version,
    e = await enquiry();
  await db.query("UPDATE enquiries SET status='closed' WHERE id=$1", [e.id]);
  await db.query("UPDATE enquiries SET closed_at=now()-interval '30 days' WHERE id=$1", [e.id]);
  const amended = await app.inject({
    method: 'POST',
    url: prefix + '/records/RET-02/revisions',
    headers: json(),
    payload: {
      expectedRevision: 1,
      title: v.title,
      owner: v.owner,
      productScopes: ['portal'],
      versionLabel: '0.2-synthetic',
      reviewDueAt: null,
      evidenceRefs: ['tests/synthetic/preview'],
      payload: {
        ...v.payload,
        proposedPeriod: 7,
        periodUnit: 'days',
        notes: 'Synthetic seven-day proposal only',
        lifecycleBinding: {
          target: 'enquiry',
          trigger: 'closed_at',
          scopeTags: ['general'],
          calendarTimezone: 'UTC',
        },
      },
    },
  });
  assert.equal(amended.statusCode, 201, amended.body);
  const preview = await app.inject({
    method: 'POST',
    url: prefix + '/lifecycle/preview',
    headers: json(),
    payload: { policyId: 'RET-02', mode: 'proposed', targetIds: [e.id] },
  });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().wouldExpire, 1);
  assert.equal(preview.json().executionAllowed, false);
  assert.equal(preview.json().items[0].id, e.id);
  const effective = await app.inject({
    method: 'POST',
    url: prefix + '/lifecycle/preview',
    headers: json(),
    payload: { policyId: 'RET-02', mode: 'effective', targetIds: [e.id] },
  });
  assert.equal(effective.statusCode, 200, effective.body);
  assert.equal(effective.json().wouldExpire, 0);
  assert.ok(effective.json().blockers.includes('NO_MATCHING_EFFECTIVE_APPROVAL'));
  assert.equal((await db.query('SELECT id FROM enquiries WHERE id=$1', [e.id])).rowCount, 1);
});
test('Concurrent hold creation and deletion cannot both succeed for the same target', async () => {
  const target = await enquiry(),
    stepUp = await proof();
  const [h, d] = await Promise.all([
    app.inject({
      method: 'POST',
      url: prefix + '/holds',
      headers: json(),
      payload: {
        id: randomUUID(),
        target,
        reason: 'Synthetic concurrent preservation',
        evidenceRefs: ['tests/synthetic/concurrency'],
        stepUp,
      },
    }),
    app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/enquiries/' + target.id,
      headers: json(),
      payload: {},
    }),
  ]);
  assert.ok(
    (h.statusCode === 200 && d.statusCode === 409) ||
      (h.statusCode === 404 && d.statusCode === 200),
    JSON.stringify({ hold: h.statusCode, deletion: d.statusCode }),
  );
  const exists = (await db.query('SELECT id FROM enquiries WHERE id=$1', [target.id])).rowCount;
  assert.equal(exists, h.statusCode === 200 ? 1 : 0);
});
test('Replay export includes exact erasures and associated active holds but never claims complete coverage or activation', async () => {
  const start = new Date(Date.now() - 1000).toISOString(),
    e = await enquiry(),
    a = await application();
  assert.equal((await hold({ kind: 'file', id: a.file })).response.statusCode, 200);
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/enquiries/' + e.id,
        headers: json(),
        payload: {},
      })
    ).statusCode,
    200,
  );
  const result = await app.inject({
    method: 'POST',
    url: prefix + '/lifecycle/replay-export',
    headers: json(),
    payload: { sourceBackupSha256: 'b'.repeat(64), backupCreatedAt: start },
  });
  assert.equal(result.statusCode, 200, result.body);
  const body = result.json();
  assert.equal(body.complete, false);
  assert.equal(body.activationAuthorized, false);
  assert.ok(body.candidateLedger.events.deleted_enquiries.includes(e.id));
  assert.ok(body.candidateLedger.legal_holds.deleted_files.includes(a.file));
  assert.ok(body.candidateLedger.legal_holds.deleted_applications.includes(a.id));
  assert.ok(body.remainingReconciliation.length);
  const entry = (
    await db.query(
      "SELECT id FROM privacy_erasure_journal WHERE target_kind='enquiry' AND target_id=$1",
      [e.id],
    )
  ).rows[0];
  await assert.rejects(db.query('DELETE FROM privacy_erasure_journal WHERE id=$1', [entry.id]), {
    code: '23514',
  });
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: prefix + '/lifecycle/replay-export',
        headers: json(),
        payload: {
          sourceBackupSha256: 'b'.repeat(64),
          backupCreatedAt: new Date(Date.now() + 60000).toISOString(),
        },
      })
    ).statusCode,
    400,
  );
});
test('Completion requires resolved local targets, accepted outbox and fresh owner evidence; it never invokes a provider', async () => {
  const a = await application(),
    r = (await plan([a])).response.json(),
    executed = await execute(r);
  assert.equal(executed.statusCode, 200, executed.body);
  const current = executed.json();
  const base = {
    expectedVersion: current.version,
    planSha256: current.planSha256,
    note: 'Synthetic fixture reconciliation only',
    processorEvidenceRefs: ['tests/synthetic/provider-review'],
    backupReplayEvidenceRefs: ['tests/synthetic/replay'],
    storageVerificationEvidenceRefs: ['tests/synthetic/object-check'],
  };
  const post = async (payload: object) =>
    app.inject({
      method: 'POST',
      url: prefix + '/requests/' + r.id + '/complete',
      headers: json(),
      payload,
    });
  assert.equal((await post({ ...base, stepUp: await proof() })).statusCode, 409);
  await db.query("UPDATE storage_deletions SET status='accepted' WHERE storage_key=$1", [a.file]);
  assert.equal(
    (await post({ ...base, storageVerificationEvidenceRefs: [], stepUp: await proof() }))
      .statusCode,
    409,
  );
  assert.equal((await post(base)).statusCode, 403);
  const complete = await post({ ...base, stepUp: await proof() });
  assert.equal(complete.statusCode, 200, complete.body);
  assert.equal(complete.json().state, 'completed');
  assert.equal(complete.json().targets[0].resultCode, 'STORAGE_ACCEPTED_OWNER_VERIFIED');
  assert.deepEqual(complete.json().externalActionsRequired, []);
  assert.equal((await post(base)).statusCode, 200);
  const events = await app.inject({
    url: prefix + '/requests/' + r.id + '/events',
    headers: json(),
  });
  assert.match(events.json().items[0].note, /Owner-recorded/);
  assert.ok(events.json().items[0].evidenceRefs.includes('tests/synthetic/replay'));
});

test('SQL cannot rebind reviewed plan/target identities or reopen cancelled history', async () => {
  const e = await enquiry(),
    r = (await plan([e])).response.json();
  await assert.rejects(
    db.query("UPDATE privacy_lifecycle_requests SET plan='{}'::jsonb WHERE id=$1", [r.id]),
    { code: '23514' },
  );
  await assert.rejects(
    db.query('UPDATE privacy_lifecycle_targets SET target_id=$2 WHERE request_id=$1', [
      r.id,
      randomUUID(),
    ]),
    { code: '23514' },
  );
  await assert.rejects(
    db.query('DELETE FROM privacy_lifecycle_targets WHERE request_id=$1', [r.id]),
    { code: '23514' },
  );
  await assert.rejects(
    db.query("UPDATE privacy_lifecycle_requests SET state='completed' WHERE id=$1", [r.id]),
    { code: '23514' },
  );
});
