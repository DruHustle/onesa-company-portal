# Staging environment configuration

Each product uses its own Vercel project. Within this product, `STAGING_VERCEL_PROJECT_ID` equals its production `VERCEL_PROJECT_ID`; the Org/Team ID must match that project's owner. Staging is a Preview deployment of `staging`; production remains separately authorized.

Create real secrets at https://github.com/DruHustle/onesa-company-portal/settings/environments → **Staging → Environment secrets → Add environment secret**. The staging workflow declares `environment: Staging`. This scopes credentials; it does not imply private GitHub Free approval protection. Required names without supplied values are created as genuinely empty entries, never dummy tokens. Empty entries remain unconfigured and cannot authenticate; secret-name presence is not readiness evidence. Existing repository production deployment tokens must not be reused as staging tokens.

## Required workflow secret names

- `STAGING_FIXTURES_JSON`
- `STAGING_RENDER_API_KEY`
- `STAGING_RENDER_SERVICE_ID`
- `STAGING_VERCEL_AUTOMATION_BYPASS_SECRET`
- `STAGING_VERCEL_ORG_ID`
- `STAGING_VERCEL_PROJECT_ID`
- `STAGING_VERCEL_TOKEN`

The Vercel automation bypass secret is required for protected Preview probes. Fixtures must correspond to actual synthetic accounts. Database migration credentials target only staging. Provider token capabilities must be verified: sharing a Vercel project does not itself restrict a token to Preview. If a token can promote production, keep it outside editable repository Actions and use an independently controlled preview path; production qualification remains blocked until this boundary is verified.

## Environment variables

- `STAGING_AUTOMATION_ENABLED`

Leave automatic staging disabled until provider isolation, configuration and exact-commit checks pass. No approval, billing or repository visibility changes are implied.

## Branches and release evidence

Remote branches are standardized as `dev`, `staging`, `main`. Dev work is reviewed through a PR. Source Vercel configuration enables staging Git previews and disables automatic dev/main deployments. Applying this file to a branch changes only that branch's configuration; inspect actual provider settings and hooks before claiming production is protected. Branch preview success does not substitute for exact-main staging qualification required by the existing production gate.

The configured project-ID aliases and staging Render service ID are real identifiers. Remaining newly created names are empty and require owner values; existing staging secrets are preserved. The Org/Team ID is still pending.

Branch archives and previous PR records remain in ignored local release-audit storage. Local worktrees and historical branches are retained for recovery. No production branch content is changed by branch cleanup.
