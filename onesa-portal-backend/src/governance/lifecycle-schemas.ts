import { z } from 'zod';
import { reauthentication } from '../api/contracts.js';
import { governanceText, reference } from './schemas.js';
export const targetKind = z.enum(['enquiry', 'application', 'file']);
export const target = z.object({ kind: targetKind, id: z.string().uuid() }).strict();
const refs = z.array(reference).min(1).max(20);
export const holdCreate = z
  .object({
    id: z.string().uuid(),
    target,
    reason: governanceText(2000).min(10),
    evidenceRefs: refs,
    stepUp: reauthentication.optional(),
  })
  .strict();
export const holdRelease = z
  .object({
    expectedVersion: z.number().int().min(1).max(2),
    reason: governanceText(2000).min(10),
    stepUp: reauthentication.optional(),
  })
  .strict();
export const hold = z.object({
  id: z.string().uuid(),
  targetKind,
  targetId: z.string().uuid(),
  reason: z.string(),
  evidenceRefs: z.array(z.string()),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
  releasedBy: z.string().uuid().nullable(),
  releasedAt: z.string().nullable(),
  releaseReason: z.string().nullable(),
  version: z.number().int(),
});
export const holdsQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  state: z.enum(['active', 'released', 'all']).default('active'),
  kind: targetKind.optional(),
  targetId: z.string().uuid().optional(),
});
export const previewInput = z
  .object({
    policyId: z.string().regex(/^RET-\d{2}$/),
    revision: z.number().int().min(1).optional(),
    mode: z.enum(['proposed', 'effective']).default('effective'),
    targetIds: z.array(z.string().uuid()).max(50).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export const preview = z.object({
  schema: z.literal(1),
  mode: z.enum(['proposed', 'effective']),
  policyId: z.string(),
  policyRevision: z.number().int(),
  sourceFingerprint: z.string(),
  asOf: z.string(),
  calendarContext: z.string().nullable(),
  blockers: z.array(z.string()),
  items: z.array(
    z.object({
      id: z.string().uuid(),
      kind: targetKind,
      expiresAt: z.string().nullable(),
      disposition: z.enum(['blocked', 'would_expire']),
      reasons: z.array(z.string()),
    }),
  ),
  wouldExpire: z.number().int(),
  executionAllowed: z.literal(false),
  productionDeletionAuthorized: z.literal(false),
  planSha256: z.string(),
  hasMore: z.boolean(),
  scope: z.literal('portal'),
  sourceRecordHashes: z.record(z.string(), z.string()),
});
export const caseCreate = z
  .object({
    id: z.string().uuid(),
    caseReference: governanceText(2000).min(1),
    identityEvidenceRefs: refs,
    targets: z.array(target).min(1).max(20),
  })
  .strict();
export const caseAction = z
  .object({
    expectedVersion: z.number().int().positive(),
    planSha256: z.string().regex(/^[a-f0-9]{64}$/),
    note: governanceText(2000).min(10),
    stepUp: reauthentication.optional(),
  })
  .strict();
export const caseTarget = z.object({
  kind: targetKind,
  id: z.string().uuid(),
  recordSha256: z.string().nullable(),
  result: z.string(),
  resultCode: z.string(),
  storageStatus: z.string().nullable(),
});
export const lifecycleCase = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  caseReference: z.string(),
  identityEvidenceRefs: z.array(z.string()),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
  state: z.string(),
  version: z.number().int(),
  planSha256: z.string(),
  targets: z.array(caseTarget),
  externalActionsRequired: z.array(z.string()),
});
export const caseEvent = z.object({
  id: z.string(),
  action: z.string(),
  actorId: z.string().uuid(),
  note: z.string(),
  evidenceRefs: z.array(z.string()),
  createdAt: z.string(),
});
export const replayExportInput = z
  .object({
    sourceBackupSha256: z.string().regex(/^[a-f0-9]{64}$/),
    backupCreatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const identities = z.object({
  deleted_enquiries: z.array(z.string().uuid()),
  deleted_applications: z.array(z.string().uuid()),
  deleted_files: z.array(z.string().uuid()),
  unpublished_content: z.array(z.string().uuid()),
  disabled_users: z.array(z.string().uuid()),
});
export const replayExport = z.object({
  schema: z.literal(1),
  classification: z.literal('INTERNAL'),
  complete: z.literal(false),
  activationAuthorized: z.literal(false),
  coverageStartedAt: z.string(),
  remainingReconciliation: z.array(z.string()),
  candidateLedger: z.object({
    schema: z.literal(1),
    product: z.literal('portal'),
    source_backup_sha256: z.string(),
    backup_created_at: z.string(),
    reconciled_through: z.string(),
    events: identities,
    legal_holds: identities,
  }),
});
export const caseCompletion = caseAction
  .extend({
    processorEvidenceRefs: refs,
    backupReplayEvidenceRefs: refs,
    storageVerificationEvidenceRefs: z.array(reference).max(20),
  })
  .strict();
