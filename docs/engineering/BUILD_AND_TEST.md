# Separate application builds and tests

Run from the repository root with Node 24, Python 3 and Docker when building images.
Commit lockfiles; `npm ci` installs their exact dependency resolutions.

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

Existing `verify.yml` runs lint/build/contracts/database/browser/docs/container checks
under the `verify` job. Require `verify` and `publication-hygiene`. Local preparation
only runs non-database unit tests; full CI is a separate gate and has not run remotely.

## Container readiness regression

After backend tests create the restricted fixture role on an isolated
`TEST_DATABASE_URL` ending `_test`, build `portal-backend-ci` and run
`python3 scripts/startup_smoke.py portal-backend-ci`. This executes the actual
production CMD at PORT 10000, checks liveness, unsafe-role/unavailable-DB 503,
restricted-role 200, anonymous protected-route 401 and SIGTERM shutdown.
Do not use production records or change a live database role to run this test.

The read-only Portal role workflow can run on the reviewed audit branch. Its
allowlisted phase identifies whether runtime or migration URL validation failed;
never relax the established database identity guard or paste URLs into logs.
Inspection reports actual role safety and grants only after verifying the database
identity and schema. Applying a repair remains restricted to the original operator
branches and successful exact-revision checks.
