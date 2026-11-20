import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lifecycleExpiry,
  planLifecycle,
  type LifecyclePolicy,
} from '../src/governance/lifecycle-plan.js';
const id = '12345678-1234-4234-8234-123456789abc',
  other = '12345678-1234-4234-8234-123456789abd';
const now = '2026-10-17T00:00:00Z';
const policy = (): LifecyclePolicy => ({
  stableId: 'RET-01',
  revision: 2,
  effectiveRevision: 2,
  status: 'approved',
  archived: false,
  productScopes: ['portal'],
  sourceFingerprint: 'a'.repeat(64),
  effectiveAt: '2026-01-01T00:00:00Z',
  reviewDueAt: '2027-01-01T00:00:00Z',
  payload: {
    type: 'retention',
    dataClass: 'Synthetic class',
    purpose: 'Synthetic isolated test only',
    proposedPeriod: 7,
    periodUnit: 'days',
    expiryTrigger: 'Explicit synthetic purpose completion',
    deletionMethod: 'Synthetic only',
    exceptions: '',
    notes: '',
    automaticDeletionEnabled: false,
    lifecycleBinding: {
      target: 'enquiry',
      trigger: 'closed_at',
      scopeTags: ['general'],
      calendarTimezone: 'UTC',
    },
  },
});
test('Calendar month/year calculations preserve UTC time and clamp leap/month boundaries without fixed-day substitution', () => {
  assert.equal(
    lifecycleExpiry('2024-01-31T12:34:56Z', 1, 'calendar_months'),
    '2024-02-29T12:34:56.000Z',
  );
  assert.equal(
    lifecycleExpiry('2025-01-31T12:34:56Z', 1, 'calendar_months'),
    '2025-02-28T12:34:56.000Z',
  );
  assert.equal(
    lifecycleExpiry('2024-02-29T12:34:56Z', 1, 'calendar_years'),
    '2025-02-28T12:34:56.000Z',
  );
  assert.equal(
    lifecycleExpiry('2026-08-31T01:02:03Z', 6, 'calendar_months'),
    '2027-02-28T01:02:03.000Z',
  );
  assert.notEqual(
    lifecycleExpiry('2026-08-31T01:02:03Z', 180, 'days'),
    lifecycleExpiry('2026-08-31T01:02:03Z', 6, 'calendar_months'),
  );
  for (const args of [
    [now, 0, 'days'],
    [now, 1, 'unknown'],
    [now, 101, 'calendar_years'],
    ['not-a-date', 1, 'days'],
    ['2026-02-31T00:00:00Z', 1, 'days'],
  ] as const)
    assert.throws(() => lifecycleExpiry(args[0], args[1], args[2]));
});
test('Impact preview distinguishes due, held, missing trigger and not-due records and never authorizes execution', () => {
  const report = planLifecycle(
    policy(),
    [
      { id, kind: 'enquiry', scopeTag: 'general', triggerAt: '2026-10-01T00:00:00Z', held: false },
      {
        id: other,
        kind: 'enquiry',
        scopeTag: 'general',
        triggerAt: '2026-10-01T00:00:00Z',
        held: true,
      },
    ],
    now,
  );
  assert.equal(report.wouldExpire, 1);
  assert.deepEqual(report.items[1].reasons, ['LEGAL_HOLD']);
  assert.equal(report.executionAllowed, false);
  assert.equal(report.productionDeletionAuthorized, false);
  const missing = planLifecycle(
    policy(),
    [{ id, kind: 'enquiry', scopeTag: 'general', triggerAt: null, held: false }],
    now,
  );
  assert.ok(missing.items[0].reasons.includes('NO_AUTHORITATIVE_TRIGGER'));
  assert.ok(
    planLifecycle(
      policy(),
      [
        {
          id,
          kind: 'enquiry',
          scopeTag: 'general',
          triggerAt: '2026-10-16T00:00:00Z',
          held: false,
        },
      ],
      now,
    ).items[0].reasons.includes('NOT_DUE'),
  );
  assert.equal(planLifecycle(policy(), [], now).wouldExpire, 0);
});
test('Draft, wrong effective revision, future or overdue approval and missing binding cannot produce an effective plan', () => {
  const candidates = [
    {
      id,
      kind: 'enquiry' as const,
      scopeTag: 'general',
      triggerAt: '2026-01-01T00:00:00Z',
      held: false,
    },
  ];
  for (const patch of [
    { status: 'draft_pending_review' },
    { effectiveRevision: 1 },
    { effectiveAt: '2027-01-01T00:00:00Z' },
    { reviewDueAt: '2026-02-01T00:00:00Z' },
    { archived: true },
  ]) {
    const p = { ...policy(), ...patch };
    assert.equal(planLifecycle(p, candidates, now).wouldExpire, 0);
  }
  const p = policy();
  delete p.payload.lifecycleBinding;
  assert.ok(planLifecycle(p, candidates, now).blockers.includes('NO_EXPLICIT_TARGET_BINDING'));
  const draft = { ...policy(), status: 'draft_pending_review', effectiveRevision: null };
  const proposed = planLifecycle(draft, candidates, now, 'proposed');
  assert.equal(proposed.mode, 'proposed');
  assert.equal(proposed.wouldExpire, 1);
  assert.equal(proposed.executionAllowed, false);
});
test('Original calendar ambiguity is reported without rewriting the policy and plan identity changes with holds/version/time', () => {
  const p = policy();
  p.payload.notes = '6 calendar months after closure';
  p.payload.proposedPeriod = 180;
  const before = JSON.stringify(p);
  assert.ok(planLifecycle(p, [], now).blockers.includes('UNRESOLVED_PERIOD_INTERPRETATION'));
  assert.equal(
    planLifecycle(
      p,
      [
        {
          id,
          kind: 'enquiry',
          scopeTag: 'general',
          triggerAt: '2026-01-01T00:00:00Z',
          held: false,
        },
      ],
      now,
    ).items[0].expiresAt,
    null,
  );
  assert.equal(JSON.stringify(p), before);
  const candidates = [
    {
      id,
      kind: 'enquiry' as const,
      scopeTag: 'general',
      triggerAt: '2026-01-01T00:00:00Z',
      held: false,
    },
  ];
  const a = planLifecycle(policy(), candidates, now);
  assert.notEqual(
    a.planSha256,
    planLifecycle(policy(), [{ ...candidates[0], held: true }], now).planSha256,
  );
  assert.notEqual(
    a.planSha256,
    planLifecycle(policy(), candidates, '2026-10-18T00:00:00Z').planSha256,
  );
  assert.throws(() => planLifecycle(policy(), [...candidates, ...candidates], now));
  assert.throws(() => planLifecycle(policy(), [{ ...candidates[0], id: 'invalid' }], now));
  assert.throws(() =>
    planLifecycle({ ...policy(), sourceFingerprint: 'prefix' + 'a'.repeat(64) }, [], now),
  );
  assert.throws(() =>
    planLifecycle(
      policy(),
      Array.from({ length: 51 }, (_, i) => ({
        ...candidates[0],
        id: '12345678-1234-4234-8234-' + i.toString(16).padStart(12, '0'),
      })),
      now,
    ),
  );
});
test('A policy cannot silently expand to another product or file class', () => {
  const p = policy();
  p.productScopes = ['ai'];
  const candidates = [
    {
      id,
      kind: 'enquiry' as const,
      scopeTag: 'general',
      triggerAt: '2026-01-01T00:00:00Z',
      held: false,
    },
  ];
  const external = planLifecycle(p, candidates, now);
  assert.ok(external.blockers.includes('PRODUCT_LOCAL_EXECUTION_REQUIRED'));
  assert.equal(external.items[0].expiresAt, null);
  const files = policy();
  files.payload.lifecycleBinding = {
    target: 'file',
    trigger: 'purpose_end_at',
    scopeTags: ['internal'],
    calendarTimezone: 'UTC',
  };
  const report = planLifecycle(
    files,
    [{ id, kind: 'file', scopeTag: 'applicant', triggerAt: '2026-01-01T00:00:00Z', held: false }],
    now,
  );
  assert.ok(report.items[0].reasons.includes('DATA_CLASS_OUTSIDE_BINDING'));
  assert.equal(report.wouldExpire, 0);
  assert.equal(report.items[0].expiresAt, null);
});
