# Production release checklist

## AI application directions — prepared 2026-10-15

The Products page adds English/German recommendations and decision-support use cases
(travel planning, business feasibility and investment research) and smart farming
(crop choice, step-by-step cultivation, weather, water, costs and market demand).
An ordered farming workflow connects crop selection through selling opportunities.
Business/investment and farming applications remain explicitly planned; this copy
does not introduce working domain tools or data integrations. Content renders on the
server without additional API requests or client JavaScript. Exact-source validation
and release evidence must precede any claim that this copy is live.
Local lint, type checks and the production build pass. Eight Chromium views cover
English/German at390/1440px in system light/dark appearance, with all five ordered
steps, existing product documentation links, no page errors or horizontal overflow
and no external browser requests. Publication hygiene and repository docs checks pass.

## Early mobile interaction — prepared 2026-10-14

Hosted staging reproduced a lost first menu tap before hydration: the hero appeared
at 491 ms, a tap at 546 ms did nothing, and a later tap opened the menu. The mobile
navigation now uses a native disclosure, retaining the same links, focus handling and
system appearance. Local Chromium/WebKit acceptance passes all 20 navigation cases,
including JavaScript-disabled language switching and a first tap while client scripts
are held, with the opened menu preserved through hydration and no browser errors.
Pending client navigation has a localized status outside the closing mobile menu;
the current page remains usable during a slow response. The initial route-wide
streaming fallback failed missing-detail HTTP404 acceptance and was removed; the
replacement uses Next's link status without changing server status codes. The native
summary explicitly exposes its button role. These changes need fresh three-browser
CI and exact-source hosted qualification before production.

## Language switching and system appearance — prepared 2026-10-14

The live site still uses a clock script to set `data-theme`. EN/DE navigation clears
that attribute and the old stylesheet falls back to light. The existing development
CSS follows the browser/system preference and preserves appearance through language
switches. `tests/navigation.spec.ts` checks both directions on the homepage and contact
pages at mobile/desktop widths, opposing clocks, live preference changes and rendering
without JavaScript. Chromium and WebKit pass these cases locally. Firefox must run
in CI because its installed local browser fails to launch. This source still requires exact-source CI, staging qualification
and production promotion; pushing `dev` does not update `https://onesa.eu/`.

## Homepage loading — prepared 2026-10-14

The local production build streams the homepage while optional CMS/news requests
run concurrently with a 1.5-second deadline. Synthetic slow-API checks cover `/`,
`/en`, `/de`, content recovery, CSP nonces and request-scoped publication approval;
timeouts preserve the existing approval gate. Frontend lint, types, build, domain,
appearance, documentation and publication-hygiene checks pass. Chromium and WebKit
confirm streamed insertion, timeout fallback and mobile/language navigation without
CSP or hydration errors. The installed local Firefox fails to launch with
`Could not find profile folder`; verify Firefox on the CI runner before acceptance.
This source is not deployed. Qualify the exact revision through staging and the owner-controlled release
path, then remeasure browser first paint and complete loading on `https://onesa.eu/`.

## Privacy governance implementation — 2026-10-13

Local verification: 73 backend tests pass, including nine governance/import/approval tests; generated contracts contain 70 operations and match the frontend client. Frontend lint, type checks and production build pass. Browser acceptance covers protected PDFs, amendments, comparisons, scoped owner approval and six responsive day/night scenarios. Hosted migration/import and authenticated staging/production UI evidence remain required. Imported documents and retention/provider/decision proposals stay INTERNAL drafts; no legal approval, DPA execution, public notice publication or deletion automation is inferred.

See [privacy governance](docs/engineering/PRIVACY_GOVERNANCE.md).

## 2026-10-12 — Oracle staging runtime qualification

The existing owner-provisioned ARM64 VM has separate hardening and runtime receipts.
Deploy only exact staging source after full CI/hygiene and the new scanner image gate.
Run the private native scanner/EICAR acceptance script before qualifying scanning.
Worker startup, private upload processing, queue/mail/retry/restart and hosted resource
qualification remain BLOCKED until the owner configures the staging-only environment
and confirms a wholly synthetic staging database/bucket. Preserve publication and
production release approvals. No local test supplies an external hosted PASS.


## Repeat audit — 2026-10-12

The Auto/Light/Dark feature has been removed; fixed light styling is the current source. Verified staging authentication, database readiness and user isolation pass at fc4af11d97a4cbdbc10990232701a2ecdb1ba062 (run38232302545). Storage/scanner acceptance returns409, and full business acceptance remains blocked. New scanner diagnostics and configuration inventory require fresh exact-source CI and staging verification; historical appearance counts below do not describe the current interface. Production publication, worker/mail delivery, operations and legal approval remain unqualified.

## Search and sharing acceptance

- Verify `/`, `/en`, `/de`, `/robots.txt` and the 1200×630 PNG on the deployed
  exact-source frontend with browser, facebookexternalhit and Facebot user agents.
- Canonical, og:url, hreflang and sitemap use the same root English homepage;
  published details use implemented routes and actual revision dates. No localhost
  URL or obsolete SVG preview may appear in company metadata.
- Confirm Facebook's actual Scrape Again response after deployment. A simulated
  user-agent GET200 does not establish access from Meta infrastructure.
- Retain noindex/empty sitemap before editorial and backend release_ready approval;
  search and private administration remain noindex after public approval.

## Application prerequisites

- Exact source revision passed CI, including publication hygiene and full contracts/tests.
- Vercel frontend and Render API/worker have approved account ownership and capacity.
- PostgreSQL migrations applied with owner credentials outside the API/worker runtime;
  restricted application credentials passed readiness and role-isolation tests.
- API and worker use the same access-controlled encrypted S3 bucket and encryption key.
- SESSION_KEY and PROXY_SHARED_KEY are securely shared where needed; public origin is
  one approved HTTPS Vercel/custom hostname, with Secure cookies and CSRF validation.
- Backup retention, off-host restoration, database health, worker/notification failures,
  access alerts and operational contacts are configured and tested on the target.
- Verify the six required company facts and approve the English/German legal pages,
  recruitment handling and provider review using authorized company records. Do not
  mark unverified claims approved merely to pass a gate. PUBLISH_ENABLED stays false
  until editorial/legal approval; public forms remain gated in production.
- Run end-to-end tests on isolated fixtures, target-host smoke checks and rollback
  with backward-compatible schema. Confirm upload limits and private file quarantine.
- Existing local data is preserved; no private records are automatically migrated.

Source publication and infrastructure preparation alone do not complete this checklist.

## Outstanding owner and hosted acceptance

- Oracle worker VM: the [OCI provisioning script](infra/oracle/provision-worker.py)
  passed offline tests. The owner-approved BaSyx resize to 1 OCPU/6 GB returned to
  RUNNING with identity/IP/storage preserved. The separate Frankfurt AD-2 worker
  was created and its 1 OCPU/6 GB/50 GB Ubuntu ARM64 configuration and restricted
  network passed provider readback. SSH and reboot recovery pass, cloud-init is done,
  automatic security updates are enabled, and root/password login is disabled;
  verification is recorded privately. Portal worker/ClamAV deployment and actual
  storage/scanner/job/mail acceptance remain pending. See
  [the OCI CLI instructions](docs/engineering/DEPLOYMENT.md).
- Verify organization ownership and provider bindings; the inspected GitHub owner
  is DruHustle, not an independently verified onesa-ug organization.
- Retest hosted API/worker readiness and original503 failures at the reviewed revision.
- Verify credential rotation privately; never restore exposed credentials.
- Complete independent security/accessibility and API compatibility acceptance.
- Confirm domain/DNS, email delivery, staging isolation and target-host operations.
- Obtain real company-fact/editorial/legal approval before public release.

Check current evidence before closing these items. Removing completed setup/handoff
instructions does not satisfy release gates. Implementation history remains in Git
and CHANGELOG.md; ongoing policies are consolidated in root AGENTS.md.


## Portal runtime acceptance

The guarded staging layout action passed at reviewed revision f3715a4 in run
38136781194. Readback 38136905181 confirms audit branch, backend root, Node command,
readiness path and disabled native auto-deploy. All eight required staging runtime
variables remain missing. The service named worker is actually a web service. Its runtime secrets, private storage and real executor
must be independently qualified; no owner URL or exposed credential may be reused.

Local image/readiness checks pass; current exact-SHA CI must qualify the combined
runner/audit revision. The owner-confirmed autumn-glade target was initialized with
seven migrations and a restricted login. Last authenticated production runtime
readback pointed to dark-boat; current runtime remains unqualified. Database
initialization is complete and must not be repeated. Hosted
acceptance still needs that cutover, frontend proxy settings and a verified worker
target. See docs/engineering/VERCEL_RENDER.md.

## Branch protection acceptance — 2026-10-10

- **NOT ENFORCED:** Fresh public main readback shows no active protection. Earlier writes were rejected while private; current eligibility must be checked separately. No production approval is inferred.
- Activate and verify the [prepared policy](docs/development/branch-protection/ACTIVATION.md) after separately authorized eligibility changes; verify check uniqueness and pending/failure/pass merge behavior.
- Resolve the [recorded deployment environment/integration gaps](docs/development/BRANCH_PROTECTION_REPORT.md) before promotion.

## Historical private local runner acceptance — 2026-10-11

- Verified repository scope, online/idle state, Linux ARM64/custom labels, checksum,
  idempotent registration, systemd service restart and LaunchAgent VM boot recovery.
- Initial [push CI](https://github.com/DruHustle/onesa-company-portal/actions/runs/38131161012),
  [PR CI](https://github.com/DruHustle/onesa-company-portal/actions/runs/38131178868),
  [publication hygiene](https://github.com/DruHustle/onesa-company-portal/actions/runs/38131161041)
  and [manual smoke](https://github.com/DruHustle/onesa-company-portal/actions/runs/38131160962)
  passed at `09a5bc6`; job metadata identifies `onesa-portal-local-arm64` (ID 21).
- Owner merged [the runner-policy PR](https://github.com/DruHustle/onesa-company-portal/pull/4). The audit merge retains all newer application fixes and requires fresh exact-revision hosted checks, including x86 runtime jobs.
  ARM CI/security images do not establish x86 runtime security equivalence. Production commands remain untested against providers; no
  production workflow was dispatched. Existing release gates still apply.
- No private registration is currently active. Real Mac reboot/login and sleep
  recovery remain separately authorized future private-runner acceptance tasks.

## Public hosted runner acceptance — 2026-10-11

- Owner selected public repositories and GitHub-hosted Actions. Local runner jobs
  are private-only; existing shared concurrency and production gates remain intact.
- Verify test, browser, contract, publication-hygiene and AMD64 image-security jobs
  on the new exact commit before accepting the routing change.
- Historical private runner acceptance does not certify a current registration.
  Production promotion still requires all applicable release gates and authorization.

## Automated release qualification acceptance

Local evidence/approval automation and rejection tests are implemented. See
[qualification guide](docs/engineering/AUTOMATED_QUALIFICATION.md) for the trust model and owner actions. Remote CI/provenance validation, main
protection, encryption secret provisioning, complete hosted staging/production
acceptance and explicit owner operations/legal approval remain blocked.
The migration switch stays off and the original secret gate is retained.

## Private-Free production prerequisites — 2026-10-11

Local credential-free qualification/authorization and failure demonstration are implemented. Owner billing/visibility confirmation, production credential removal/rotation, provider auto-deploy readback, isolated staging acceptance and remote workflow installation remain pending. Direct pushes remain possible. See [the enforcement report](docs/development/PRIVATE_FREE_SAFEGUARDS.md). Physical Robot deployment stays separately blocked.
