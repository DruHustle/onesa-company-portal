'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '@/lib/api/client';
import { EvidenceLink } from './governance-document';
import type { operations } from '@/lib/api/generated/schema';
type Hold =
  operations['listPrivacyHolds']['responses'][200]['content']['application/json']['items'][number];
type Case = operations['getPrivacyRequest']['responses'][200]['content']['application/json'];
type Preview =
  operations['previewPrivacyLifecycle']['responses'][200]['content']['application/json'];
type CaseEvent =
  operations['privacyRequestEvents']['responses'][200]['content']['application/json']['items'][number];
type Target =
  operations['planPrivacyRequest']['requestBody']['content']['application/json']['targets'][number];
const lines = (value: string) =>
  value
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
const human = (value: string) => value.toLowerCase().replaceAll('_', ' ');
export function PrivacyLifecycle({ owner }: { owner: boolean }) {
  const [holds, setHolds] = useState<Hold[]>([]),
    [cases, setCases] = useState<Case[]>([]),
    [selected, setSelected] = useState<Case | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [epoch, setEpoch] = useState(0),
    [page, setPage] = useState(1),
    [more, setMore] = useState(false);
  const [events, setEvents] = useState<CaseEvent[]>([]);
  function failed(error: unknown) {
    setNotice(
      error instanceof ApiError
        ? `${error.message} · Request ${error.requestId || error.status}`
        : 'Unable to complete the request. Refresh before trying again.',
    );
  }
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setBusy(true);
    Promise.all([
      api.GET('/api/v1/admin/governance/holds', {
        signal: controller.signal,
        params: { query: { page, limit: 20, state: 'all' } },
      }),
      api.GET('/api/v1/admin/governance/requests', {
        signal: controller.signal,
        params: { query: { page, limit: 20 } },
      }),
    ])
      .then(([h, c]) => {
        if (active) {
          setHolds(h.data!.items);
          setCases(c.data!.items);
          setMore(Math.max(h.data!.total, c.data!.total) > page * 20);
        }
      })
      .catch((error) => {
        if (active && !controller.signal.aborted) failed(error);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [page, epoch]);
  useEffect(() => {
    const id = selected?.id;
    if (!id) return;
    let active = true;
    const controller = new AbortController();
    api
      .GET('/api/v1/admin/governance/requests/{id}/events', {
        params: { path: { id } },
        signal: controller.signal,
      })
      .then((result) => {
        if (active) setEvents(result.data!.items);
      })
      .catch((error) => {
        if (active && !controller.signal.aborted) failed(error);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [selected?.id, selected?.version]);
  async function submit(
    e: FormEvent<HTMLFormElement>,
    action: 'hold' | 'plan' | 'preview' | 'execute' | 'cancel' | 'release' | 'complete' | 'export',
  ) {
    e.preventDefault();
    const form = e.currentTarget,
      data = new FormData(form),
      value = (name: string) => String(data.get(name) || '');
    setBusy(true);
    setNotice('');
    const stepUp = { password: value('password'), code: value('code') };
    try {
      if (action === 'hold') {
        await api.POST('/api/v1/admin/governance/holds', {
          body: {
            id: crypto.randomUUID(),
            target: { kind: value('kind') as Target['kind'], id: value('target') },
            reason: value('reason'),
            evidenceRefs: lines(value('evidence')),
            stepUp,
          },
        });
        setNotice('Hold recorded. Existing deletion routes enforce it.');
      }
      if (action === 'release') {
        const hold = holds.find((h) => h.id === value('hold'));
        if (!hold) throw new Error('Choose a hold');
        await api.POST('/api/v1/admin/governance/holds/{id}/release', {
          params: { path: { id: hold.id } },
          body: { expectedVersion: hold.version, reason: value('reason'), stepUp },
        });
        setNotice('Hold release recorded; history is retained.');
      }
      if (action === 'plan') {
        const targets = lines(value('targets')).map((line) => {
          const [kind, id, ...extra] = line.split(':');
          if (extra.length || !['enquiry', 'application', 'file'].includes(kind) || !id)
            throw new Error('Enter one kind:UUID per line.');
          return { kind: kind as Target['kind'], id };
        });
        const result = await api.POST('/api/v1/admin/governance/requests', {
          body: {
            id: crypto.randomUUID(),
            caseReference: value('reference'),
            identityEvidenceRefs: lines(value('evidence')),
            targets,
          },
        });
        setSelected(result.data!);
        setNotice('Preview saved. No records have been deleted.');
      }
      if (action === 'preview') {
        const result = await api.POST('/api/v1/admin/governance/lifecycle/preview', {
          body: {
            policyId: value('policy'),
            mode: value('mode') as 'proposed' | 'effective',
            limit: 20,
          },
        });
        setPreview(result.data!);
        setNotice('Read-only policy impact calculated. This does not authorize deletion.');
      }
      if (action === 'export') {
        const result = await api.POST('/api/v1/admin/governance/lifecycle/replay-export', {
          body: {
            sourceBackupSha256: value('backupHash'),
            backupCreatedAt: new Date(value('backupAt')).toISOString(),
          },
        });
        const blob = new Blob([JSON.stringify(result.data, null, 2) + '\n'], {
            type: 'application/json',
          }),
          url = URL.createObjectURL(blob),
          link = document.createElement('a');
        link.href = url;
        link.download = 'onesa-portal-replay-candidate.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice(
          'Private replay candidate downloaded. Historical/external reconciliation is still required.',
        );
      }
      if (action === 'complete') {
        if (!selected) throw new Error('Choose a request');
        const result = await api.POST('/api/v1/admin/governance/requests/{id}/complete', {
          params: { path: { id: selected.id } },
          body: {
            expectedVersion: selected.version,
            planSha256: selected.planSha256,
            note: value('reason'),
            processorEvidenceRefs: lines(value('processors')),
            backupReplayEvidenceRefs: lines(value('backups')),
            storageVerificationEvidenceRefs: lines(value('storage')),
            stepUp,
          },
        });
        setSelected(result.data!);
        setNotice('Owner completion and supporting references recorded.');
      }
      if (action === 'execute' || action === 'cancel') {
        if (!selected) throw new Error('Choose a request');
        const body = {
          expectedVersion: selected.version,
          planSha256: selected.planSha256,
          note: value('reason'),
          ...(action === 'execute' ? { stepUp } : {}),
        };
        const result =
          action === 'execute'
            ? await api.POST('/api/v1/admin/governance/requests/{id}/execute', {
                params: { path: { id: selected.id } },
                body,
              })
            : await api.POST('/api/v1/admin/governance/requests/{id}/cancel', {
                params: { path: { id: selected.id } },
                body,
              });
        setSelected(result.data!);
        setNotice(
          action === 'cancel'
            ? 'Unexecuted request cancelled.'
            : 'Local results recorded. Review each target and complete external actions separately.',
        );
      }
      setEpoch((v) => v + 1);
    } catch (error) {
      failed(error);
    } finally {
      for (const input of form.querySelectorAll<HTMLInputElement>('input[type=password]'))
        input.value = '';
      setBusy(false);
    }
  }
  const proof = (
    <fieldset>
      <legend>Fresh owner confirmation</legend>
      <label>
        Current password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <label>
        Authenticator or unused recovery code
        <input name="code" type="password" autoComplete="one-time-code" required />
      </label>
    </fieldset>
  );
  const evidence = (
    <label>
      Identity/scope evidence references · one non-secret reference per line
      <textarea name="evidence" required maxLength={10000} />
    </label>
  );
  return (
    <div className="privacy-lifecycle">
      <p role="status">
        {busy
          ? 'Loading privacy controls…'
          : notice || 'Explicit Portal targets only. Automatic expiry remains disabled.'}
      </p>
      <section className="admin-card">
        <h3>Retention impact preview</h3>
        <p>
          Effective previews require a matching approved version and an explicit data-class binding.
          Proposed previews are hypothetical. Neither executes deletion.
        </p>
        <form onSubmit={(e) => void submit(e, 'preview')}>
          <div className="form-grid">
            <label>
              Retention rule
              <input name="policy" pattern="RET-[0-9]{2}" placeholder="RET-01" required />
            </label>
            <label>
              Policy context
              <select name="mode">
                <option value="effective">Effective approved policy</option>
                <option value="proposed">Proposed rule · hypothetical</option>
              </select>
            </label>
          </div>
          <button className="button" disabled={busy}>
            Preview impact
          </button>
        </form>
        {preview && (
          <div>
            <p>
              {preview.policyId} · revision {preview.policyRevision} ·{' '}
              {new Date(preview.asOf).toLocaleString()} · {preview.wouldExpire} would expire
            </p>
            {preview.blockers.length > 0 && (
              <ul>
                {preview.blockers.map((reason) => (
                  <li key={reason}>{human(reason)}</li>
                ))}
              </ul>
            )}
            <TargetTable
              items={preview.items.map((t) => ({
                id: t.id,
                kind: t.kind,
                result: t.disposition,
                resultCode: t.reasons.map(human).join(', ') || 'Eligible in this preview',
              }))}
            />
            {preview.hasMore && (
              <p>Preview is limited to 20 records; this is not a complete inventory.</p>
            )}
          </div>
        )}
      </section>
      <section className="admin-card">
        <h3>Preservation holds</h3>
        <p>
          Active holds protect the record and its associated application/CV cascade. A hold cannot
          recover an already requested object deletion.
        </p>
        <ul>
          {holds.map((h) => (
            <li key={h.id}>
              {h.targetKind} · {h.targetId} · {h.releasedAt ? 'Released' : 'Active'}
              <p>{h.reason}</p>
              <small>
                {new Date(h.createdAt).toLocaleString()} · {h.id}
              </small>
            </li>
          ))}
        </ul>
        {holds.length === 0 && <p>No holds on this page.</p>}
        {owner && (
          <>
            <details>
              <summary>Create a hold</summary>
              <form onSubmit={(e) => void submit(e, 'hold')}>
                <label>
                  Record type
                  <select name="kind">
                    <option value="enquiry">Enquiry</option>
                    <option value="application">Application and CV</option>
                    <option value="file">Private file</option>
                  </select>
                </label>
                <label>
                  Exact record UUID
                  <input name="target" required />
                </label>
                <label>
                  Preservation reason
                  <textarea name="reason" minLength={10} maxLength={2000} required />
                </label>
                {evidence}
                {proof}
                <button className="button" disabled={busy}>
                  Record hold
                </button>
              </form>
            </details>
            <details>
              <summary>Release a hold</summary>
              <form onSubmit={(e) => void submit(e, 'release')}>
                <label>
                  Active hold
                  <select name="hold" aria-label="Active hold" required defaultValue="">
                    <option value="" disabled>
                      Choose a hold
                    </option>
                    {holds
                      .filter((h) => !h.releasedAt)
                      .map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.targetKind} · {h.targetId}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Release reason
                  <textarea name="reason" minLength={10} maxLength={2000} required />
                </label>
                {proof}
                <button className="button" disabled={busy || !holds.some((h) => !h.releasedAt)}>
                  Release selected hold
                </button>
              </form>
            </details>
          </>
        )}
      </section>
      <section className="admin-card">
        <h3>Scoped erasure requests</h3>
        <p>
          Verify identity and scope before planning. This adapter covers Portal enquiries,
          applications and private files. It does not search or erase AI/Robot data, delivered
          email, provider logs or historical backups.
        </p>
        <form onSubmit={(e) => void submit(e, 'plan')}>
          <label>
            Internal case reference
            <input name="reference" required maxLength={2000} />
          </label>
          {evidence}
          <label>
            Explicit targets · one kind:UUID per line
            <textarea
              name="targets"
              placeholder="enquiry:00000000-0000-4000-8000-000000000000"
              required
            />
          </label>
          <p>
            Maximum 20 targets. An application includes its attached CV. Public files are excluded.
          </p>
          <button className="button" disabled={busy}>
            Save impact plan
          </button>
        </form>
        <ul>
          {cases.map((c) => (
            <li key={c.id}>
              <button
                className="governance-record-link"
                disabled={busy}
                onClick={() => setSelected(c)}
              >
                {c.caseReference}
              </button>{' '}
              · {human(c.state)} · {new Date(c.createdAt).toLocaleString()}
            </li>
          ))}
        </ul>
        {selected && (
          <article>
            <h4>{selected.caseReference}</h4>
            <p>
              {selected.id} · version {selected.version} · {human(selected.state)}
            </p>
            <details>
              <summary>Identity and scope evidence</summary>
              {selected.identityEvidenceRefs.map((ref) => (
                <p key={ref}>
                  <EvidenceLink value={ref} />
                </p>
              ))}
            </details>
            <TargetTable items={selected.targets} />
            <details>
              <summary>Request audit timeline</summary>
              <p>Latest 200 immutable events.</p>
              <ol>
                {events.map((event) => (
                  <li key={event.id}>
                    <strong>{human(event.action)}</strong> ·{' '}
                    {new Date(event.createdAt).toLocaleString()}
                    <p>{event.note}</p>
                    <small>Actor {event.actorId}</small>
                    {event.evidenceRefs.map((ref) => (
                      <p key={ref}>
                        <EvidenceLink value={ref} />
                      </p>
                    ))}
                  </li>
                ))}
              </ol>
            </details>
            <h4>
              {selected.state === 'completed'
                ? 'External reconciliation recorded'
                : 'Outstanding external actions'}
            </h4>
            <ul>
              {selected.externalActionsRequired.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p>
              Local deletion or object-outbox acceptance does not establish full erasure. Preserve
              case evidence and the post-snapshot deletion record before any restore activation.
            </p>
            {selected.state === 'planned' && (
              <>
                <form onSubmit={(e) => void submit(e, 'cancel')}>
                  <label>
                    Cancellation reason
                    <textarea name="reason" minLength={10} maxLength={2000} required />
                  </label>
                  <button disabled={busy}>Cancel this plan</button>
                </form>
                {owner && (
                  <details>
                    <summary>Owner: review and execute this exact plan</summary>
                    <form onSubmit={(e) => void submit(e, 'execute')}>
                      <p>
                        This permanently removes eligible local records and queues attached-object
                        deletion. Changed or held records are skipped. Review target IDs, identity
                        evidence and external actions first.
                      </p>
                      <label>
                        Execution scope and review note
                        <textarea name="reason" minLength={10} maxLength={2000} required />
                      </label>
                      <label className="check">
                        <input type="checkbox" required />I have verified identity, scope and the
                        exact target plan.
                      </label>
                      {proof}
                      <button className="button" disabled={busy}>
                        Execute reviewed local erasure
                      </button>
                    </form>
                  </details>
                )}
              </>
            )}
            {owner && ['partial', 'storage_pending'].includes(selected.state) && (
              <details>
                <summary>Record independently verified completion</summary>
                <form onSubmit={(e) => void submit(e, 'complete')}>
                  <p>
                    Every target must be locally erased and each storage request accepted. These
                    references record your independent review, including limitations of retained
                    backups and object versions.
                  </p>
                  <label>
                    Processor/mailbox reconciliation references
                    <textarea name="processors" required />
                  </label>
                  <label>
                    Backup deletion-replay evidence
                    <textarea name="backups" required />
                  </label>
                  <label>
                    Independent object verification references
                    <textarea
                      name="storage"
                      required={selected.targets.some((t) => t.storageStatus !== null)}
                    />
                  </label>
                  <label>
                    Completion scope and limitations
                    <textarea name="reason" minLength={10} maxLength={2000} required />
                  </label>
                  {proof}
                  <button className="button" disabled={busy}>
                    Record verified completion
                  </button>
                </form>
              </details>
            )}
          </article>
        )}
      </section>
      <section className="admin-card">
        <h3>Backup replay preparation</h3>
        <p>
          Download internal erasure identities and current holds for one exact backup. The candidate
          is incomplete until historical, external and in-flight changes are reconciled. It cannot
          authorize restored-service activation.
        </p>
        <form onSubmit={(e) => void submit(e, 'export')}>
          <label>
            Backup SHA-256
            <input name="backupHash" pattern="[a-f0-9]{64}" required />
          </label>
          <label>
            Backup creation time (local)
            <input name="backupAt" type="datetime-local" required />
          </label>
          <button className="button" disabled={busy}>
            Download private replay candidate
          </button>
        </form>
      </section>
      <div className="admin-actions">
        <button disabled={busy || page === 1} onClick={() => setPage((v) => v - 1)}>
          Previous records
        </button>
        <span>Page {page}</span>
        <button disabled={busy || !more} onClick={() => setPage((v) => v + 1)}>
          Next records
        </button>
      </div>
    </div>
  );
}
function TargetTable({
  items,
}: {
  items: { kind: string; id: string; result: string; resultCode: string }[];
}) {
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Privacy target outcomes">
      <table>
        <thead>
          <tr>
            <th scope="col">Target</th>
            <th scope="col">Result</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {items.map((t) => (
            <tr key={t.kind + ':' + t.id}>
              <th scope="row">
                {t.kind}
                <small>{t.id}</small>
              </th>
              <td>{human(t.result)}</td>
              <td>{t.resultCode}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
