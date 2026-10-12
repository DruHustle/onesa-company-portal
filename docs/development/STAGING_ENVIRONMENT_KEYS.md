# Staging environment configuration

Each product uses its own Vercel project. Within this product, `STAGING_VERCEL_PROJECT_ID` equals its production `VERCEL_PROJECT_ID`; the Org/Team ID must match that project's owner. Staging is a Preview deployment of `staging`; production remains separately authorized.

The existing secrets are configured under **Environment secrets → Staging**. Verify
actual injection with the trusted diagnostic below before selecting that deployment
binding. For private GitHub Free, the supported fallback is **Repository secrets →
New repository secret** at https://github.com/DruHustle/onesa-company-portal/settings/secrets/actions,
using the same staging-only names. Repository secrets do **not** provide environment-level
isolation: repository writers can modify Actions to access them. Keep production credentials
outside editable Actions; restrict repository write access and use a separately controlled
staging-only broker when provider capabilities cannot be limited sufficiently. Exact
source/actor/ref checks do not establish server-enforced secret isolation.

The owner has entered the 7/8 required names under the existing Staging environment (7 for Portal, 8 for AI/Robot), confirmed by API metadata and screenshots. Actual injection and authentication are checked separately. Current authenticated repository readback reports public; the selected private-Free strategy does not establish current entitlement. Do not print, copy to chat or replace existing credentials.

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

## Supported deployment scope selection

`STAGING_SECRET_SCOPE` is a non-secret repository Actions variable. Leave it unset
or set it to `repository` for the private GitHub Free fallback. Set it to `environment`
only after the trusted environment diagnostic proves usable injection on the current
public repository. The selected public job declares `environment: Staging`; the private
job has no environment dependency and uses repository `STAGING_*` names. If repository
visibility changes to private, repository mode is selected regardless of the variable.
Both modes share one anchored deployment step sequence and mutually exclusive guards;
there is one staging deployment authority and no secret values in outputs between jobs.
Ordinary PR checks do not invoke these owner-only deployment jobs. Availability never
establishes provider credential isolation; verify target/scope/authentication separately.

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
