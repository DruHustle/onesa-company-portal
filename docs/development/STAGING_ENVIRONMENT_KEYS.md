# Staging environment configuration

Each product uses its own Vercel project. Within this product, `STAGING_VERCEL_PROJECT_ID` equals its production `VERCEL_PROJECT_ID`; the Org/Team ID must match that project's owner. Staging is a Preview deployment of `staging`; production remains separately authorized.

Create staging-only secrets at https://github.com/DruHustle/onesa-company-portal/settings/secrets/actions → **Repository secrets → New repository secret**. This is the GitHub Free private-compatible binding. Manual staging jobs use repository-level `STAGING_` names and do not declare the GitHub Staging environment, so older environment values cannot shadow the owner's repository entries. Repository secrets do **not** provide environment-level isolation: repository writers can modify Actions to access them. Keep production credentials outside editable Actions; use a separately controlled staging-only broker when provider token capabilities cannot be limited sufficiently. Exact source/actor/ref checks remain necessary but do not establish server-enforced secret isolation.

The owner's account/provider setup and secret-entry work are pending. Current authenticated repository readback still reports public; do not change visibility or claim private enforcement from the selected strategy. Secret metadata alone cannot prove a usable value. Enter actual values privately, without blank placeholder secrets or credential output.

## Verify the actual configured secret scope

The owner confirms that the existing entries are under the exact GitHub environment
`Staging`. Name metadata and usable workflow injection are separate checks. The
registered owner-only inspection workflow offers boolean-only diagnostics with no
checkout, provider requests or secret-value output:

```sh
gh secret list --env Staging -R DruHustle/onesa-company-portal
gh workflow run inspect-hosting.yml --repo DruHustle/onesa-company-portal --ref dev -f secret_scope=environment
gh workflow run inspect-hosting.yml --repo DruHustle/onesa-company-portal --ref dev -f secret_scope=repository
```

The environment diagnostic explicitly declares `environment: Staging`. A missing or
empty value fails with its exact name; a successful availability check does not prove
that a token authenticates, an operator password matches or targets are isolated.
Inspect actual repository visibility and account entitlement. Public readback currently
reports `private:false`; an absent account-plan API field is not proof of Free or Pro.
Private GitHub Free must retain the repository-level fallback with the same names.
Only the owner re-enters actual values privately; do not copy production credentials,
print values or expose deployment secrets to untrusted PR code. Oracle's root-only
worker environment file is a separate configuration requirement.

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

The configured project-ID aliases and staging Render service ID are real identifiers. Remaining newly created names are empty and require owner values; existing staging secrets are preserved. The matching Org/Team ID is configured. Current credential readiness belongs in the restricted release audit; secret-name presence alone is not verification.

Branch archives and previous PR records remain in ignored local release-audit storage. Local worktree contents are retained as detached snapshots; deleted branch history is recoverable from the restricted Git bundle. No production branch content is changed by branch cleanup.
