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
Vercel forwards API calls to Render, so browsers retain one origin and cookie scope.


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
