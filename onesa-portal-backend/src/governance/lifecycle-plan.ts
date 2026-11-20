/** Pure impact planning. No database, filesystem, network or deletion side effects. */
import { createHash } from 'node:crypto';
import type { Snapshot } from './schemas.js';
import { retentionInterpretationIssues } from './interpretation.js';

type Retention = Extract<Snapshot['payload'], { type: 'retention' }>;
export type LifecycleKind = 'enquiry' | 'application' | 'file';
export type LifecyclePolicy = {
  stableId: string;
  revision: number;
  effectiveRevision: number | null;
  status: string;
  archived: boolean;
  productScopes: readonly string[];
  sourceFingerprint: string;
  effectiveAt: string | null;
  reviewDueAt: string | null;
  payload: Retention;
};
/** Candidates and holds must be read by the authorized server adapter, never trusted from a public request. */
export type LifecycleCandidate = {
  id: string;
  kind: LifecycleKind;
  scopeTag: string;
  triggerAt: string | null;
  held: boolean;
};
const identifier = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const stamp = (value: string) => {
  const parts = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
  );
  if (!parts || !Number.isFinite(Date.parse(value))) throw new Error('Invalid lifecycle timestamp');
  const [, year, month, day, hour, minute, second] = parts.map(Number),
    last = new Date(0);
  last.setUTCFullYear(year, month, 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > last.getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    throw new Error('Invalid lifecycle timestamp');
  return new Date(value);
};

/** Calendar arithmetic preserves the UTC time and clamps to the target month's last day. */
export function lifecycleExpiry(triggerAt: string, period: number, unit: string): string {
  const start = stamp(triggerAt);
  if (!Number.isSafeInteger(period) || period < 1 || period > 36500)
    throw new Error('Invalid lifecycle duration');
  if (unit === 'days') return new Date(start.getTime() + period * 86400000).toISOString();
  if (!['calendar_months', 'calendar_years'].includes(unit))
    throw new Error('Unsupported lifecycle unit');
  if ((unit === 'calendar_months' && period > 1200) || (unit === 'calendar_years' && period > 100))
    throw new Error('Calendar duration exceeds operational bound');
  const months = start.getUTCMonth() + (unit === 'calendar_years' ? period * 12 : period);
  const year = start.getUTCFullYear() + Math.floor(months / 12),
    month = months % 12;
  const last = new Date(start);
  last.setUTCDate(1);
  last.setUTCFullYear(year, month + 1, 0);
  const end = new Date(start);
  end.setUTCDate(1);
  end.setUTCFullYear(year, month, Math.min(start.getUTCDate(), last.getUTCDate()));
  return end.toISOString();
}

export function planLifecycle(
  policy: LifecyclePolicy,
  candidates: readonly LifecycleCandidate[],
  nowIso: string,
  mode: 'proposed' | 'effective' = 'effective',
) {
  const now = stamp(nowIso);
  if (!['proposed', 'effective'].includes(mode) || policy.payload.type !== 'retention')
    throw new Error('Unsupported lifecycle preview');
  if (
    !/^RET-\d{2}$/.test(policy.stableId) ||
    !Number.isSafeInteger(policy.revision) ||
    policy.revision < 1 ||
    !/^([a-f0-9]{64})$/.test(policy.sourceFingerprint)
  )
    throw new Error('Invalid lifecycle policy identity');
  if (
    candidates.length > 50 ||
    new Set(candidates.map((c) => c.kind + ':' + c.id)).size !== candidates.length ||
    candidates.some(
      (c) =>
        !identifier.test(c.id) ||
        typeof c.held !== 'boolean' ||
        !['enquiry', 'application', 'file'].includes(c.kind),
    )
  )
    throw new Error('Invalid lifecycle candidate batch');
  const payload = policy.payload,
    binding = payload.lifecycleBinding;
  const blockers: string[] = [];
  if (policy.archived) blockers.push('POLICY_ARCHIVED');
  if (!policy.productScopes.some((scope) => ['portal', 'corporate', 'shared'].includes(scope)))
    blockers.push('PRODUCT_LOCAL_EXECUTION_REQUIRED');
  if (retentionInterpretationIssues(payload).length)
    blockers.push('UNRESOLVED_PERIOD_INTERPRETATION');
  if (!binding) blockers.push('NO_EXPLICIT_TARGET_BINDING');
  else if (binding.calendarTimezone !== 'UTC') blockers.push('UNSUPPORTED_CALENDAR_CONTEXT');
  if (payload.proposedPeriod === null) blockers.push('NO_REVIEWED_DURATION');
  else
    try {
      lifecycleExpiry(nowIso, payload.proposedPeriod, payload.periodUnit);
    } catch {
      blockers.push('UNSUPPORTED_DURATION_OR_UNIT');
    }
  if (mode === 'effective') {
    if (policy.status !== 'approved' || policy.effectiveRevision !== policy.revision)
      blockers.push('NO_MATCHING_EFFECTIVE_APPROVAL');
    if (!policy.effectiveAt || stamp(policy.effectiveAt) > now)
      blockers.push('POLICY_NOT_EFFECTIVE');
    if (!policy.reviewDueAt || stamp(policy.reviewDueAt) <= now)
      blockers.push('POLICY_REVIEW_REQUIRED');
  }
  const canCalculate = !blockers.some((reason) =>
    [
      'PRODUCT_LOCAL_EXECUTION_REQUIRED',
      'UNRESOLVED_PERIOD_INTERPRETATION',
      'NO_EXPLICIT_TARGET_BINDING',
      'UNSUPPORTED_CALENDAR_CONTEXT',
      'NO_REVIEWED_DURATION',
      'UNSUPPORTED_DURATION_OR_UNIT',
    ].includes(reason),
  );
  const items = candidates.map((candidate) => {
    const reasons = [...blockers];
    let expiresAt: string | null = null;
    if (binding && candidate.kind !== binding.target) reasons.push('TARGET_BINDING_MISMATCH');
    const scopeMatches =
      !!binding && (binding.scopeTags as readonly string[]).includes(candidate.scopeTag);
    if (binding && !scopeMatches) reasons.push('DATA_CLASS_OUTSIDE_BINDING');
    if (candidate.held) reasons.push('LEGAL_HOLD');
    if (!candidate.triggerAt) reasons.push('NO_AUTHORITATIVE_TRIGGER');
    else {
      const trigger = stamp(candidate.triggerAt);
      if (trigger > now) reasons.push('TRIGGER_IN_FUTURE');
      if (
        canCalculate &&
        scopeMatches &&
        candidate.kind === binding?.target &&
        payload.proposedPeriod !== null
      )
        try {
          expiresAt = lifecycleExpiry(
            candidate.triggerAt,
            payload.proposedPeriod,
            payload.periodUnit,
          );
        } catch {
          /* Report the policy blocker; do not guess an expiry. */
        }
      if (expiresAt && stamp(expiresAt) > now) reasons.push('NOT_DUE');
    }
    return {
      id: candidate.id,
      kind: candidate.kind,
      expiresAt,
      disposition: reasons.length ? ('blocked' as const) : ('would_expire' as const),
      reasons,
    };
  });
  const result = {
    schema: 1 as const,
    mode,
    policyId: policy.stableId,
    policyRevision: policy.revision,
    sourceFingerprint: policy.sourceFingerprint,
    asOf: now.toISOString(),
    calendarContext: binding?.calendarTimezone ?? null,
    blockers,
    items,
    wouldExpire: items.filter((i) => i.disposition === 'would_expire').length,
    executionAllowed: false as const,
    productionDeletionAuthorized: false as const,
  };
  return {
    ...result,
    planSha256: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
  };
}
