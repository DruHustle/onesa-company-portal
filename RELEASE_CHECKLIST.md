# Production release checklist

## Portal-based Engineering Docs sign-in — prepared 2026-10-17

The owner now requests registration with approval, plus emailed sign-in links or
email/password for both administration and Docs. Existing two approved addresses
retain their decisions. Existing administrator credentials, roles and MFA remain
unchanged; engineering approval grants no Portal role. Additive 010/011 and
default-off identity/registration flags require source-bound hosted qualification.
The superseded OTP-only staging Preview stopped before backend login; its original
failure is retained. No production identity selection has changed. The revised
source passes 123 isolated backend tests (including 9 new registration/link cases),
15 domain/redirect/fragment tests, 12 expanded OIDC tests (including both new
methods), 14 isolated production-renderer/accessibility views and a production
frontend build. A further two production-renderer views verify default-off rollout
compatibility and existing password/MFA login. Full remote CI and hosted acceptance
remain required.
See the [activation and onboarding procedure](docs/engineering/ENGINEERING_DOCS_IDENTITY.md).

## Owner step-up and concurrent deletion — correction prepared 2026-10-17

Exact-main CI `39035817445` exposed a hold/deletion deadlock: step-up's exclusive
owner-row lock blocked deletion's audit foreign-key reference while waiting for
the deletion target. A deterministic local regression reproduces that blocked
reference. `FOR NO KEY UPDATE` retains account/factor serialization and permits
the foreign-key read. All 104 isolated backend tests, lint, type checks, build,
contract drift, documentation and publication hygiene pass with the correction.
Fresh remote CI and qualified API/worker rollout remain required; no failed
technical check is overridden. The earlier mobile Preview acceptance is retained
for its unchanged frontend component, rather than repeated as backend evidence.

## Portal lifecycle controls — implementation, not deployed

Additive migration 009, generated contracts and the protected requests UI are
prepared. The original 41 production governance records and approvals must remain
unchanged. Do not run real erasure for acceptance or enable draft-driven retention.
Full backend, three-engine CI, relevant UI, migration/restore and exact-source hosted
qualification are required before promotion/deployment. Keep the existing production
artifacts until those checks pass; no technical bypass is authorized.

## Rounded homepage and Oracle monitoring — LIVE 2026-10-16

Frontend `8bee209a6ea82a2d63d187d1b23046f051698f0f`, deployment
`dpl_CfUvaU7BZE4QQ3r2GGEsvy1Y5CzM`, is live on the existing domains. Exact-main
verification `38867502290` and hygiene `38867502186` pass. Eight affected CSS views,
two corrected Preview runtime views and two canonical production views pass, including
20px cards/buttons, navigation, axe, overflow, public news200 and the existing public403/
Portal401 private boundary. The accepted backend tree, accounts and data are unchanged.
Existing Oracle monitoring now covers six APIs with a real healthy timer sample,
zero restarts/alerts and preserved application/worker/scanner identities. Restricted
receipts: `private/oracle/application-release-20261016/` and the existing migration
directory. Earlier prepared/Render-hold entries below are historical; the owner has
authorized current qualified Oracle/Vercel application releases, with Render still held.

## Rounded homepage action buttons — prepared 2026-10-16

“Explore our technology” and the closing “Start a conversation” button use 20px
corners, matching the rounded homepage cards. Scoped to hero/CTA buttons; link
labels, destinations and the hero's secondary text link remain unchanged. Four local
CSS fixture views pass at mobile/desktop in light/dark, including links, focus and
overflow. Full-route release acceptance remains pending; no artifact deployment.


## Rounded homepage capability cards — prepared 2026-10-16

The “From ideas to infrastructure.” cards use 20px corners and separate borders
with 20px spacing, matching the homepage product cards. Scoped to #capabilities;
technology-page grids, navigation, copy and API behavior are unchanged. Eight local
CSS fixture views pass across EN/DE, mobile/desktop and light/dark, checking corners,
borders, keyboard focus and overflow. Full-route release acceptance remains pending.
No artifact deployment is authorized by this styling change.


## Render credit hold — prepared local guard, 2026-10-16

Owner confirms exhausted Render credits: backend delivery and backend-deploying
staging runs are paused. Maintained deploy/staging scripts now reject suspended,
contradictory or unavailable service metadata before any creation request; deploy
success also rechecks service availability. Three offline regression methods pass,
covering eight invalid states, an active target and suspension after deployment.
No provider request, paid resource, application mutation or new deployment occurred.
Existing UI evidence remains valid; outstanding API acceptance remains blocked.


## Products Apps section — UI LIVE; API BLOCKED 2026-10-15

Frontend `c2186bcd7951f15623a0ae86a4a7cfb289f1ed04`, deployment `dpl_13ppT1z8nStM6DQ2FLRaHQYDTc4y`, passed exact-main
verification `38789628532`, hygiene `38789628779`, staging `38792242497`,
qualification `38792591575` and owner handoff `38792678934`. Four final EN/DE
Home/Products views and image hashes pass: Apps is independent; farming workflow
and requested Robot caption are absent. Full production acceptance remains BLOCKED:
Render reports the unchanged Company backend suspended by billing, and the private
probe returned503. AI/Robot production services report the same billing hold.
Preserve the passed UI evidence; resolve the provider hold, verify readiness and run
only the outstanding read-only private denials. Do not redeploy or repeat the UI suite.
Restricted outcome: `private/privacy-governance/production-products-apps-20261015/production-release-outcome.json`.

## Homepage product previews and clean imagery — LIVE 2026-10-15

Runtime frontend `bcf2081f10df619c2d6c380d9df90e69c1ab5d28`, deployment `dpl_83TKhQ1UJzTrBTJuWPfZ9g2iBKQC`, serves the existing
Company/Portal domains. Exact-main verification `38785535973` and hygiene
`38785535983`, hosted staging `38787542991`, qualification `38787957768` and
owner handoff `38788052862` pass. Home previews AI Platform
and Robot with links to fuller Products sections; image overlay badges are removed.
Final image hashes, four EN/DE mobile/desktop Home/Products views and anonymous/
spoofed private denials pass. No application-data write, production backend/worker
rebuild or credential change. Restricted evidence:
`private/privacy-governance/production-home-products-01cb854/`.
Earlier release entries below remain historical; Home now intentionally features
brief previews, with detailed information on Products.

## Company public availability and Onesa image — LIVE 2026-10-15

Frontend source `abdad3b24e3e45bc782e1d775e162f5139725f59` is live at the existing
Company/Portal production domains, deployment `dpl_8VYEca9qYBdbBZ9zouyXbJLWppFt`.
Exact-main CI `38779263142`, hygiene `38779263376`, hosted staging `38781041825`,
qualification `38781367455` and owner handoff `38781465582` passed. The Onesa-branded
AI visual and Robot concept artwork appear under Products; the AI Home feature and
public approval waits/hold screen are removed. Two production image hashes, four
EN/DE desktop/mobile Home/Products views and two anonymous/spoofed private denials
pass, with zero browser errors or application-data writes. Unchanged backend/worker
remain at qualified source `bfe2891487107d4d3a9126dc5ba2a4dd72f0f0ab`.
Restricted receipts: `private/privacy-governance/production-onesa-image-18a471f/`.
Earlier prepared entries below are retained as historical context; this receipt
records the actual deployment. No legal/governance approval is inferred.

## Company Products Robot visual — prepared 2026-10-15

Replace the three-box Operator/Cloud simulation/Simulated state diagram with the
existing approved Onesa Robot concept artwork, responsive 32/87KB WebP assets,
English/German product messaging and a concise concept-art caption. Keep the actual
under-development status, existing product/Docs links and server-rendered content.
Asset hashes and original image-generation provenance are retained in the existing
brand source register. No API calls, client scripts, live telemetry or hardware claims
are added. This visual change needs its own affected-page validation and normal
frontend release; it does not invalidate the independent Robot qualification.
Local lint, type checks and production build pass. Eight Chromium views cover EN/DE,
390/1440px and system light/dark appearance, with loaded responsive images, zero axe
violations, browser errors or overflow. Desktop and mobile screenshots were reviewed.

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


### Owner-authorized pre-launch features and footer correction — 2026-10-15

- Owner requested deferral of the global Company legal-publication hold until launch;
  source separates operating mode from actual legal readiness and keeps all private,
  editorial, file and deletion safeguards. Production activation remains unverified.
- Careers uses “There are currently no open positions.” for an empty published list.
  Footer general contact uses the localized Contact page; legal particulars remain.
- Required: isolated production-mode integration regression, API compatibility, build,
  exact-source staging/release qualification and hosted public/private readback.

- Subsequent owner instruction permits indexing of approved public Company production
  pages during pre-launch; keep private/staging/Preview exclusions and access controls.


Public availability correction (prepared): remove the public release-approval renderer
and its blocking company-status read. Keep factual public pages and indexing independent
of that operational endpoint, and retain published-only CMS reads, private access controls
and existing bounded loading. Preview text names its environment without approval wording.
Isolated production build, lint, types, hygiene, documentation validation and the existing
homepage/public-loading regression suites PASS. HTML/RSC, unpublished-detail404, bounded
API failures, English/German navigation and Chromium/WebKit mobile/desktop checks pass.
Navigation under delayed optional CMS content took307–341ms in8 local browser cases;
these are synthetic local samples, not hosted/cold-start guarantees. No approval-status
requests were sent. Production acceptance remains pending an actual hosted deployment.


Products presentation correction (prepared): remove the AI Platform feature section
from Home, retain its Products entry and exact product/Docs links, and replace the
text-heavy SVG with an original professional AI interaction concept image based on
the owner’s visual reference. Responsive local WebP variants are 23,330/60,820 bytes;
source provenance is recorded in the existing asset manifest. The long duplicate
alt/caption descriptions are removed. Product capability/research scope remains in
the Products text. Final isolated build/lint/types and Home-placement regressions PASS. Eight English/German
desktop/mobile light/dark Products views and both Home locale checks PASS, with zero
accessibility violations, browser errors, overflow or approval-status requests. Product
and exact public documentation links remain present. Hosted production acceptance is pending.


Company visual storytelling (prepared): homepage image-led hero and alternating product
showcases; Products separates overviews, capability explanations and Apps directions.
Uses existing responsive WebP assets, deterministic server rendering and no new client
JavaScript or dependency. Verify EN/DE, mobile/desktop, light/dark, reduced motion,
keyboard focus, artwork loading, product/Docs destinations and prompt optional-content
streaming. Promote only through dev → staging → main; hosted acceptance remains pending.

Validation: lint, TypeScript, production build, existing homepage loading regression,
shared appearance/contrast checks, documentation validation and repository hygiene PASS.
Sixteen isolated Chromium views (EN/DE × Home/Products × 390/1440px × light/dark)
passed image loading, axe accessibility, overflow and browser-error checks with external
requests blocked. Desktop hero visually inspected after browser paint. Synthetic slow
content retained prompt hero rendering (7–18ms) and 1.5s response bounds. These local
measurements are not hosted performance guarantees. Other browsers and hosted acceptance
remain pending in the normal release pipeline.

Footer scope amendment: replace duplicate flat link rows with grouped Company,
Products and Resources navigation, one enquiry action, a quieter address and a separate
legal/administration strip. Preserve all existing destinations and approved company
particulars; retain contact-page enquiries without public general-mail/telephone links.
Prior Home/Products acceptance remains valid for unchanged components; qualify the new
footer in EN/DE across 320/390/768/1440px, both system appearances, keyboard and axe.

Footer validation: lint, TypeScript, production build, documentation/hygiene and 16
isolated EN/DE × 320/390/768/1440px × light/dark browser views PASS. Checked axe,
overflow, image loading, unique footer destinations, retained Company/Product/Docs/legal
links, no mailto/telephone links and keyboard focus. Visually reviewed desktop EN and
mobile DE. Earlier c199fa6 full CI and body-layout acceptance are preserved; no unrelated
application or backend change is included. Hosted footer acceptance remains pending.

Footer release closure: the above prepared work is now live from main
`90e994757d010cf2d3ead8c7342f6bde2cc137e6`, deployment
`dpl_Hr9rpZwXx3p38uarjNLhZb2KK69q`. Full exact-main CI/security and hygiene passed;
16 hosted footer views, two exact-main Preview views and two production views passed,
with the unchanged body evidence explicitly retained. Canonical Home/Products and
public/private API boundaries passed. Restricted `company-footer-release/completion.json`
holds the current receipt; no backend deployment or credential change occurred.

Mobile homepage correction (prepared): content-sized hero, aligned stacked actions,
compact rounded capability rows and tighter product/section spacing below 761px.
Keep desktop composition and all public content/destinations. Twenty isolated EN/DE ×
320/390/600/768/1440px × light/dark views passed axe, image loading, overflow and
browser-error checks. Visually reviewed EN390 and DE320. These are local results;
full required technical CI and exact-source hosted acceptance must pass before release.
The owner's current direction revokes earlier technical-test bypass permission;
pre-launch legal deferrals do not waive any technical, access, preservation or safety check.


### Mobile homepage simplification — 17 October 2026

- Owner requested a quieter phone hero: hide only its supporting introduction and two calls to action below 761px, while retaining desktop copy and navigation/contact access.
- Extend the navy hero to at least one stable viewport height, so it continues beyond the opening screen below the header. Natural content sizing supports short landscape screens and enlarged text.
- Phone/tablet-width EN/DE, system light/dark, keyboard scroll cue, overflow, production build and exact-source hosted acceptance must pass before publication. Existing release evidence is not acceptance for this new layout.
- Source prepared; production publication is pending fresh checks and normal promotion.
