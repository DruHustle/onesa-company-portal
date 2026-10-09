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
