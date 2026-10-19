# Onesa UG Company Portal

Production API hosting moved to the existing Oracle Free VM on 2026-10-16; the
Vercel frontend and existing data services remain. See the
[verified hosting cutover](docs/engineering/DEPLOYMENT.md#verified-production-hosting-cutover--2026-10-16)
for source identities, protected ingress, acceptance and rollback.

The latest company-first Home and concise Engineering Docs sign-in frontend
`56eb17c80cfff656608005c60c3ca8d2c9da09a2` is accepted at Vercel `dpl_BcvxvfeoSCa3zLapdrWx1F5wAXZh` on the existing Company/Portal
hosts. API `4e47e3102a3a90054725cc06ad46b95339e0e544`, worker `3fad26e` and scanner remain independently retained.
No backend activation or migration accompanied this frontend release. See the
[current component release](docs/engineering/DEPLOYMENT.md#current-company-and-sign-in-release--2026-10-19).

The 2026-10-18 editorial/task release is accepted; see the
[current component identities and acceptance](docs/engineering/DEPLOYMENT.md#current-portal-editorial-release--2026-10-18).

The Company Portal is Onesa UG’s corporate website and protected business workspace.
It combines an English/German public site with a custom CMS, enquiries, recruitment,
private documents, background processing and database-backed privacy governance.
Public content requires editorial approval; private records require backend authorization.
Engineering Docs can use separately qualified Portal email-link/password sign-in with
owner-managed individual memberships; this grants no Portal administrator role.
First-time users register and verify their email before owner review. Existing
explicit approvals are retained; new administrator access keeps MFA.
See the [protected access procedure](docs/engineering/ENGINEERING_DOCS_IDENTITY.md)
for its prepared status, qualification and onboarding boundaries.
The protected privacy workspace includes policy review and explicit Portal lifecycle
controls: read-only impact plans, preservation holds and owner-confirmed erasure.
Draft rules never activate automatic expiry. See the [governance architecture](docs/engineering/PRIVACY_GOVERNANCE.md)
and [release checklist](RELEASE_CHECKLIST.md) for source behavior and deployment status.

```mermaid
flowchart LR
  Visitor[Public visitor] --> Site[Company website]
  Owner[Authorized staff] --> Admin[Protected administration]
  Site --> API[Fastify API]
  Admin --> API
  API --> DB[(Portal PostgreSQL)]
  API --> Storage[Private file storage]
  Worker[Qualified background worker] --> DB
  Worker --> Scanner[Private malware scanner]
  Worker --> Storage
```

| Directory | Responsibility |
| --- | --- |
| `onesa-company-portal-frontend/` | Next.js 16 / React 19, public site and administration |
| `onesa-company-portal-backend/` | Fastify / TypeScript, APIs, migrations, CMS and worker |
| `infra/` | Deployment, private scanner and operational configuration |
| `scripts/` | Contracts, local verification and controlled release tooling |
| `docs/` | Engineering references; restricted evidence is excluded from Git |

Use Node 24 and a disposable PostgreSQL database for integration tests. Docker is optional
for native development and required for container/recovery qualification. Locked installs:

```sh
npm --prefix onesa-company-portal-backend ci
npm --prefix onesa-company-portal-frontend ci
```

Copy `.env.example` to an ignored `.env` only when no environment file exists; privately
configure local database and storage values. Never use production credentials or replace
an existing environment. `python3 scripts/bootstrap-env.py` provides the existing local
setup helper. Full command contexts, prerequisites and side effects are in
[Build and test](docs/engineering/BUILD_AND_TEST.md).

```sh
npm --prefix onesa-company-portal-backend run dev
npm --prefix onesa-company-portal-frontend run dev
```

These commands run in separate terminals. The frontend uses port 3300; its server proxy
uses `BACKEND_URL`. Cloud storage, email and malware scanning require their actual
configured dependencies; local rendering does not establish hosted operation.

```sh
npm --prefix onesa-company-portal-backend run lint
npm --prefix onesa-company-portal-backend run typecheck
npm --prefix onesa-company-portal-frontend run lint
npm --prefix onesa-company-portal-frontend run typecheck
npm --prefix onesa-company-portal-frontend run build
node scripts/test_system_appearance.mjs
python3 scripts/validate-docs.py
python3 scripts/repository_hygiene.py
```

Backend `npm test` requires `TEST_DATABASE_URL` ending `_test` and truncates its fixture
tables. Browser tests require the isolated seeded API/frontend and installed browsers.
Never run fixture tests against application data. Generate APIs from Fastify schemas;
[contracts](docs/api/API.md) explain the deterministic client pipeline.

Onesa uses one shared visual foundation with distinct product interfaces. Light/dark
appearance follows the browser/OS preference, including live changes; no application
selector, stored appearance override or clock schedule exists. Administration and public
content have distinct shells and access boundaries.
The public mobile menu works before JavaScript loads. Pending client navigation shows
a localized status while fresh approved content is fetched, retaining the current page
and true missing-page HTTP responses. Optional homepage content does not block the hero. Section copy, listings and related
stories stream independently with bounded public reads. A genuine missing detail keeps
HTTP404; a transient content outage shows a localized noindex retry state. Required
publication and detail checks stay fresh, preserving the browser/OS appearance.

Vercel hosts the frontend; the existing Oracle VM hosts the API and qualified private
worker/scanner services. Governance currently contains draft policies; deployment does not approve
retention, processor contracts, legal publication or applicant/customer processing.
The owner-authorized pre-launch runtime mode enables existing public features while legal prerequisites remain explicitly unapproved. Default launch mode restores their global publication hold. Editorial review and every protected-data boundary remain enforced; see the deployment procedure.
Free-provider wakeups and capacity limits are documented, without an uptime guarantee.

Keep three permanent branches: `dev`, `staging`, `main`. Temporary Dependabot security-update
and necessary narrow security-release branches are allowed. Normal fixes integrate through
`dev → staging → main`; bot PRs target default main and receive isolated tests, never
automatic production deployment. Urgent fixes exclude unfinished work and require isolated
staging qualification, owner release and reconciliation into development.
Review [agent policies](AGENTS.md), [deployment](docs/engineering/DEPLOYMENT.md) and
[qualification](docs/engineering/AUTOMATED_QUALIFICATION.md). Current CI is available in
[GitHub Actions](https://github.com/DruHustle/onesa-company-portal/actions).
[Onesa Developer Docs](https://docs.onesa.eu) contains approved public guides;
[Onesa Engineering Docs](https://docs.engineering.onesa.eu) requires authorized access
and includes Architecture & Workflows, Engineering Onboarding and the design system.

## Private vulnerability reporting

Report privately to [info@onesa.eu](mailto:info@onesa.eu), or GitHub private vulnerability
reporting when enabled. Include the affected version, safe reproduction steps and impact.
Do not post sensitive details publicly or send passwords, CVs or customer records.
Support covers the latest reviewed main revision; no response SLA, bounty or historical
version support is promised.

Maintained by Onesa UG (haftungsbeschränkt), Heidelberg, Germany. No project software
license has been assigned; dependency and model licenses do not grant an Onesa license.
