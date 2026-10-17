# Company portal API

The source contract is `onesa-company-portal-backend/openapi/openapi.json`, generated
from Fastify/Zod route schemas. All routes are under `/api/v1`. Public routes expose
verified company information and approved content; enquiries/applications are subject
to publication gates. `/api/v1/ready` checks DB access and production role restrictions.

Admin routes cover users, facts/settings, content revisions/approval, enquiries,
applications, templates/files and audit history. Session cookies require password/MFA;
mutations require a session CSRF token and the configured same-origin boundary.
Role permissions are enforced by the backend. Drafts/private files are not public.

Generate with backend `npm run api:export`, then frontend `npm run api:generate`.
Run `python3 scripts/check-contracts.py` and `scripts/test-contract-break.py` from
repository root. Generated client source remains committed; build outputs do not.
Vercel forwards API calls to the qualified Oracle APIs, so browsers retain one origin and cookie scope.


## Sensitive user changes and own-password changes (2026-10-10)

`PATCH /admin/users/{id}` now requires a `stepUp` object containing the actor’s own
`password` and a fresh authenticator or unused recovery `code`. The factor is consumed
in the same transaction as the user change and its audit entries. Missing proof returns
403; failed or forbidden requests do not consume a recovery code. The helper locks and
rechecks the current user/session and role. Codes used to log in cannot be reused.
Owner restrictions, last-owner protection and the prohibition on self-admin edits remain.
This intentionally tightens authorization: clients must send fresh proof for each change.

`POST /auth/password/change` takes `password` (new, 14–256 characters) and `stepUp`.
It is available to all signed-in roles in the Security tab. Fresh password/MFA proof,
rate limits, Origin and CSRF checks apply. The transaction updates the password,
revokes every session, removes outstanding password-reset tokens, and records a safe
audit entry. The browser is signed out; MFA stays enabled. Password and proof inputs
are cleared after submission. Existing email recovery remains separate and requires
qualified SMTP/worker delivery. No actual customer email was sent during local tests.


### Host boundaries — 2026-10-10

When `SITE_URL` and `PORTAL_URL` configure the split, the company BFF exposes only
`/api/v1/public/*`. Authentication/admin operations use `portal.onesa.eu`. Backend
`PUBLIC_ORIGIN` is the portal origin; optional `COMPANY_ORIGIN` permits only public
API mutations from the company site. Existing body/response schemas are unchanged.
Resend integration affects the private worker, not the public HTTP contracts.

## Internal governance contracts

The `/admin/governance` operations expose protected overview/records/details/history,
revision creation, scoped review, archive/restore, events and revision PDFs. Existing
session/MFA and CSRF guards apply; only the reauthenticated owner may approve/reject.
`expectedRevision` rejects lost updates with 409. PDFs use `application/pdf` and
private/no-store headers; authentication and validation errors retain JSON responses. No operation enables business-data deletion or public
privacy publication. See [the governance architecture](../engineering/PRIVACY_GOVERNANCE.md).


## Publication operating stage

`GET /api/v1/public/company` reports `publication_stage` (`prelaunch` or `launch`) and
`publication_enabled` separately from the unchanged `release_ready` legal-readiness
result. The protected dashboard exposes corresponding `publicationStage` and
`publicationEnabled` fields. Pre-launch is an explicit owner-authorized runtime
exception to the global legal hold; it does not publish drafts, grant permissions,
approve files, enable retention deletion or change recorded legal decisions.

## Protected lifecycle controls

Under `/admin/governance`, holds support bounded listing, owner-confirmed creation
and release. Requests support exact-ID impact plans, bounded listing, details,
events, pre-execution cancellation, owner-confirmed execution and evidenced
completion. `/lifecycle/preview` is read-only and distinguishes proposed from
effective rules; `/lifecycle/replay-export` returns an explicitly incomplete
private recovery candidate. Generated OpenAPI/client types define all fields.

Mutation requests require Origin/CSRF. Hold changes, execution and completion
require fresh owner password/MFA proof, with account/peer rate limits. Execution
binds the saved plan/version, rechecks hashes and holds, and reports per-target
outcomes. It never claims external erasure from a successful local DELETE.
See [governance architecture](../engineering/PRIVACY_GOVERNANCE.md).
