# Separate application builds and tests

> Current pipeline: [automated review, staging qualification and owner activation](../development/CI_CD_PIPELINE_REPORT.md). Prepared local changes are not live deployments; branch/PR optimization and automatic technical evidence supersede older manual-only details.

Run from the repository root with Node 24, Python 3 and Docker when building images.
Commit lockfiles; `npm ci` installs their exact dependency resolutions.

Dependabot version updates target `dev` and follow `dev → staging → main`.
Keep the Portal frontend on TypeScript 5.9.3 while `openapi-typescript` 7.13.0
requires `^5.x` and the installed typescript-eslint 8.71.1 peers require
`>=4.8.4 <6.1.0`. The TypeScript 7.0.2 update in PR #28 failed `npm ci`
with `ERESOLVE`; it must not enter a release. Dependabot ignores compiler major
version updates until the generator, lint tooling and compiler can be upgraded
together and pass contract generation, lint, type checks and builds. Do not use
`--force` or `--legacy-peer-deps` to hide peer conflicts. Minor/patch version
updates continue. Security updates remain on the default branch under
[GitHub's documented target-branch behavior](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#target-branch)
and still require compatibility checks and the qualified release path.

## Frontend

```sh
npm --prefix onesa-company-portal-frontend ci
npm --prefix onesa-company-portal-frontend run lint
npm --prefix onesa-company-portal-frontend run typecheck
npm --prefix onesa-company-portal-frontend run build
docker build -t onesa-portal-frontend:local onesa-company-portal-frontend
```

For local development: `npm --prefix onesa-company-portal-frontend run dev`.
Configure `BACKEND_URL` privately on the frontend server, never in a browser secret.
The container listens on 3300 and needs same-origin routing for `/api/v1/*` to the
backend. `SITE_URL` and public-release settings are build-time configuration.
Frontend env example lives in its subdirectory; current native dev scripts load the
root `.env`, so export values explicitly for independent deployments.

## Backend

```sh
npm --prefix onesa-company-portal-backend ci
npm --prefix onesa-company-portal-backend run lint
npm --prefix onesa-company-portal-backend run typecheck
npm --prefix onesa-company-portal-backend run build
(cd onesa-company-portal-backend && node --import tsx --test tests/unit.test.ts tests/contracts.test.ts)
docker build -t onesa-portal-backend:local onesa-company-portal-backend
```

For a simpler unit command, from the backend directory use
`node --import tsx --test tests/unit.test.ts`. Supply `DATABASE_URL`, `SESSION_KEY`
and the other backend env values at runtime. Native development:
`npm --prefix onesa-company-portal-backend run dev`; production: built server or image.
The native scripts load root `.env` when present; examples are references, not auto-loaders.

## Integrated checks

`python3 scripts/check-contracts.py` and `python3 scripts/test-contract-break.py`
validate contracts. Full backend `npm test` requires a disposable PostgreSQL database
with `TEST_DATABASE_URL` ending `_test`; it truncates test tables. Never point it at
application data. Browser tests need an isolated seeded stack and installed Chromium:
`npm --prefix onesa-company-portal-frontend run test:e2e`.

Backend test files run serially because their shared fixture performs grants,
migrations, truncation and sequence writes. The initialization regression creates
and removes only its uniquely named disposable `_test` database and test role;
it verifies rollback, strict refusal of existing objects and restricted permissions.

Existing `verify.yml` runs lint/build/contracts/database/browser/docs/container checks
under the `verify` job. Require `verify` and `publication-hygiene`. Full exact-source remote CI is a separate gate; inspect the actual current GitHub run and hosted acceptance receipts rather than treating local builds as deployed evidence.

## Container readiness regression

After backend tests create the restricted fixture role on an isolated
`TEST_DATABASE_URL` ending `_test`, build `portal-backend-ci` and run
`python3 scripts/startup_smoke.py portal-backend-ci`. This executes the actual
production CMD at PORT 10000, checks liveness, unsafe-role/unavailable-DB 503,
restricted-role 200, anonymous protected-route 401 and SIGTERM shutdown.
Do not use production records or change a live database role to run this test.

The read-only Portal inspection uses the retained reviewed development/staging/main workflow scopes. Its
allowlisted phase identifies whether runtime or migration URL validation failed;
never relax the established database identity guard or paste URLs into logs.
Inspection reports actual role safety and grants only after verifying the database
identity and schema. Applying a repair remains restricted to the original operator
branches and successful exact-revision checks.


After full backend tests provision the synthetic restricted role on the disposable
`TEST_DATABASE_URL`, run `python3 scripts/startup_smoke.py onesa-portal-backend:local`.
On Linux CI it uses host networking; for a dedicated Docker test database use
`--network container:<isolated-test-db>`. It exercises the production image's default
CMD at PORT=10000, health, owner-role 503, restricted-role 200, unavailable DB 503,
authentication and SIGTERM. Never supply an application database to this test.

## Approved company particulars and CMS

The maintained private owner record is `onesa-company-portal-backend/records/company-facts.v1.json`.
Only its eight expressly approved public fields are generated into independent product
snapshots; unapproved business claims, private records and identifiers remain excluded.
Run `python3 scripts/sync_company_details.py --workspace --check` when all three local
repositories are available, or omit `--workspace` for the independent Portal build.
The generated snapshots are committed, so CI and deployments require no private record
or sibling checkout. Never commit the private record simply to make a check pass.

`npm --prefix onesa-company-portal-backend run seed` is an explicit operator command,
never an application startup action. It synchronizes the approved company particulars
and EN/DE legal-notice CMS text transactionally, preserving previous CMS revisions.
New pages remain drafts; existing publication states and all legal/privacy settings
are preserved. Owner confirmation is identified as the source, not an independent
register extract. Company approval does not approve processors, retention, transfers,
recruitment or privacy disclosures. Check any assigned W-IdNr against the actual tax
notification; [DDG section 5](https://www.gesetze-im-internet.de/ddg/__5.html) requires
publication of assigned applicable identifiers. Do not invent an identifier or DPO.

Run the mail and company-publication unit tests and the public legal-page browser
checks, including contact links, exact EN/DE particulars, mobile layout and contrast.
Mail signatures retain stable provider idempotency keys and are not duplicated on
retries. Do not send actual email merely to execute the transport unit tests.

## Retired local approval files

`python3 scripts/release/qualify.py decision` always fails closed. Editable `gates.json` strings and a matching local source hash do not establish verified release authority. Use the existing trusted `release-qualification.yml`/`free-qualification.yml` workflow and owner-controlled promotion path. This does not add another reviewer or invalidate existing owner authorization. Contracts, isolated verification and safe anonymous smoke commands remain available.
