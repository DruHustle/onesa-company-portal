# Onesa company billing

This component implements company billing with Stripe-hosted Checkout, explicitly
reviewed invoices, Stripe Tax qualification and an immutable usage outbox for
Metronome. It is separate from product operational authority and existing PasoFi
prepaid connectivity orders. Its default configuration pauses sales and uses test mode.

The backend uses Node 24, Fastify, PostgreSQL and the official Stripe SDK 23.1.0 with
API version `2026-10-28.endive`. The web module is dependency-free and is vendored
into the protected Company Portal at `/account/billing` with an exact version/hash
manifest. Portal's existing account or MFA staff session supplies a short-lived,
server-only assertion; the browser receives no Stripe secret or billing access token.

## Container verification and provenance

The existing required billing verification job also builds the exact backend
Dockerfile for `linux/amd64`, scans the complete image with the pinned Trivy
scanner, and exercises its actual API and worker entrypoints. These commands remain
inside the mandatory billing verification step in the standalone Portal repository.
Billing retains an independent runtime and release qualification. The public
workflow has no merchant credentials and does not deploy an application.

The separate `Onesa company billing native ARM64 verification` workflow runs the
same container fixture on the standard `ubuntu-24.04-arm` GitHub-hosted runner.
It requires the canonical repository to remain public, checks current visibility
before checkout, and has no private or larger-runner fallback. The host, runner,
Docker daemon, application image, scanner and database image must all match the
explicit native ARM64 profile. The default fixture profile remains amd64; neither
profile accepts emulation or evidence from the other architecture. Actions and
Node/Python versions are pinned, and no release or provider credentials are used.
The ARM64 workflow remains separate from the amd64 verification workflow.

The runtime fixture creates its own labelled Docker network, database volume and
containers. The application network is internal, with no host port bindings or
Docker socket mounts. A disposable TLS server provides only the exact authenticated
startup account GET; the unchanged Stripe SDK uses its normal TLS validation and
a fixture-only public CA. Every other provider request is refused. Fixture keys,
passwords and signed test assertions are generated after image construction and
are never built into the image or uploaded as evidence.

The built image runs the explicit migration twice to prove `applied` then
`current`. Four separately provisioned nonowner logins must start the actual
runtime, and substituting a roleless login for each of the four connections must
refuse startup. The fixture also checks actual DDL denial, a changed migration
checksum and an unauthorized live-mode request. The API uses its default image
command; the worker uses `node dist/worker-main.js`. Both run as the image's `node`
user with a read-only filesystem, dropped capabilities, no new privileges and
bounded process/memory resources. Successful SIGTERM handling and drained database
pools are required before cleanup can pass.

Authenticated HTTP checks require test mode and paused sales, reject anonymous,
wrong-issuer and foreign-origin requests, refuse Checkout/manual-invoice intents
and invoice finalization while sales are paused, and reject an unsigned webhook.
They create one disposable account and its immutable, account-bound customer
intent, with empty catalog/request snapshots and the exact fixture provider scope.
They enqueue no customer-creation command. Provider operation, webhook and usage
queues must remain empty and the TLS fixture must observe exactly the two
startup GETs and no provider POST. These checks do not claim that paused sales
disable account administration or every provider operation in other configurations.

Each job uploads only a bounded receipt and, after every required check and owned
cleanup passes, a billing-specific manifest. The manifest binds the canonical
repository, workflow run, exact commit, root and billing subtree, runtime config
image ID, native architecture, scanner result and source hashes. An image config
ID is labelled explicitly; it is not presented as a registry manifest digest.
Failures retain a fixed error category, partial check results and bounded scanner
advisory IDs, severity counts and secret rule categories. Raw logs, scanner report
text, secret matches, credentials and provider payloads are excluded. Unknown
cleanup prevents a successful manifest. The fixture has a ten-minute work budget
and a separate one-minute cleanup budget. Individual commands and output are also bounded;
terminating and reaping a failed child has a further five-second limit.

Both records set `verification_only=true` and `release_authorized=false`. An actual
hosted pass is required; unit fixtures cannot stand in for container acceptance.
Local environments without Docker can run the narrow boundary tests but cannot
produce the runtime manifest. Each manifest qualifies only its observed native
architecture and exact tested source. A pull-request manifest records the tested
merge commit; retain the PR branch head separately rather than replacing that
candidate identity. A real deployment target, backup/recovery, live merchant
activation, Tax and Metronome configuration, and an independently commissioned
billing release authority remain separate requirements. The
[commissioning checklist](docs/commissioning-checklist.md) identifies the required
inputs and evidence for each of those remaining stages.

## Payment and invoice behavior

The browser selects a configured SKU and quantity. Prices, currency, tax behavior,
customer ownership and provider account/mode come from server configuration and the
durable account binding. A commercial intent freezes these values before any Stripe
mutation. A second idempotency key cannot replace the same unresolved intent.

An authenticated owner or payer can open a Stripe-hosted Checkout session. Viewers
can inspect safe billing status without receiving a hosted payment capability URL.
A browser return is never payment evidence: fresh provider retrieval and signed,
durably accepted webhooks establish the observed status. Current Stripe payment
method settings determine the methods available in Checkout.

Manual invoices are created as drafts with `auto_advance=false`, fixed invoice
lines and no unrelated pending customer items. Finalization is a separate explicit
owner command bound to the original draft operation. The integration has no invoice
email-send, automatic-pay, refund or tax-registration mutation endpoint. Creation,
finalization and payment are distinct states.

A lost mutation response is held for reconciliation rather than being automatically
replayed. Signed events can recover the exact customer, Checkout or completed invoice
against its frozen intent. An early partial draft cannot complete invoice creation.
An open/paid invoice can recover an already attempted finalization only when its
original invoice, intent, creation operation and fingerprints agree. An unattempted
finalization is never inferred.

Stripe read outages receive fenced, delayed reconciliation retries, bounded by
40 attempts and 24 hours, with a 15-minute maximum delay. Ownership/configuration
holds remain held. Related credit notes are journaled against an already verified
invoice without completing a payment command. A charge/refund without a proved
parent payment association stays held for explicit reconciliation.

## Tax and usage

Tax settings and registrations are inspected without altering them. Enabling
automatic tax requires active settings and a complete bounded inventory containing
at least one current registration. That is an integration precondition, not a
determination of jurisdictional coverage or a business's tax obligations. The
operator supplies the actual selling jurisdictions, approved product tax treatment
and existing registrations; the service never invents these facts or registers a
business with a tax authority. Existing Stripe defaults are preserved.

New usage billing uses Metronome in accordance with Stripe's current implementation
guidance. It needs its own sandbox/project credential, approved rate card/contract,
customer mapping, billable unit and period/grace boundaries. Stripe credentials alone
do not provision those dependencies. Metronome owns usage invoice generation; this
service refuses to invoice metered offers through its one-off Checkout/manual-invoice
paths. External Metronome invoices require a separately verified invoice mapping
before they can be adopted into the company ledger.

A trusted usage producer submits only a source-event ID, meter ID, exact decimal
quantity and occurrence time. A server-owned authorization mapping selects its
account, Stripe customer, Metronome project/customer/contract and billing period.
Recording the immutable event and its delivery outbox commits atomically. Retries
retain the same transaction ID, payload and original attempt deadline; expired,
altered or out-of-scope events are quarantined. HTTP 200 ingestion acceptance is not
evidence of rating, invoicing or payment. Operational telemetry is not automatically
converted into a billable event.

## Database and identity boundaries

Use a dedicated billing database. The additive migration creates only the `billing`
schema and five nonlogin group roles: owner, API, dispatcher, webhook and meter.
Four separately provisioned runtime logins receive exactly their intended group;
they cannot own the schema, create tables or erase journals. The migration credential
is supplied only to the explicit migration command. The runtime checks actual role
membership, restricted privileges and the packaged migration checksum before startup.
All four URLs must identify the same explicit host/port/database.

Account memberships use the exact trusted issuer and subject. Token role/account
claims are ignored. Owner, payer and viewer memberships are explicit and revisioned;
concurrent removal of the last owner is refused. Closing an account prevents new
commands while retaining financial records, unresolved operations and usage custody.

## Installation preparation

These steps describe a new, separate billing installation. They do not provision a
host, deploy a container or activate a merchant account. The database and login
names below are examples for an administrator to adapt to the reviewed target.
Existing installations use their retained migration history and checksum instead
of repeating the initial database/login creation.

Complete the [source-bound commissioning record](docs/commissioning-checklist.md)
for the selected target before treating this preparation as an installation plan.

### 1. Create an empty dedicated database and establish migration authority

The database administrator creates an empty database such as
`onesa_company_billing`, owned by an administrative role rather than any runtime
login. Do not point this migration at Portal, PasoFi or a product database. The
migration refuses an unrelated user table or incompatible migration history.

The separate migration connection must be able to create or validate the five
nonlogin roles, create `billing` with owner `onesa_billing_owner`, and execute
`SET ROLE onesa_billing_owner`. Database ownership or `CREATEROLE` alone does not
establish every one of these permissions. Use the administrator's approved migration
connection, or have the administrator provision the equivalent dedicated authority
before running it; none of that authority belongs to the four runtime logins.

Supply only `BILLING_MIGRATION_DATABASE_URL_FILE` to the migration process through a
private, readable secret mount. In the built container's `/app` directory, run the
one-time command `node dist/migrate.js`. In a source checkout with development
dependencies installed, run `npm run migrate` from
`onesa-billing/backend`. The production image contains neither npm nor `tsx`.
An applied/current migration result and its packaged checksum are prerequisites
for runtime startup. The migration does not create authenticated runtime logins.

### 2. Provision the four restricted runtime logins

After the migration has established the group roles, the administrator provisions
four distinct logins. Each inherits exactly one group, with no owner, administrator
or additional role membership. This illustrative SQL contains no passwords:

```sql
CREATE ROLE billing_api_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE billing_dispatcher_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE billing_webhook_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE billing_meter_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT onesa_billing_api TO billing_api_login;
GRANT onesa_billing_dispatcher TO billing_dispatcher_login;
GRANT onesa_billing_webhook TO billing_webhook_login;
GRANT onesa_billing_meter TO billing_meter_login;
```

Provision authentication through the administrator's private secret mechanism or
interactive `psql` password prompts, never by substituting a password into this
committed SQL. While connected specifically to the new billing database, ensure
that `public` grants no `CREATE` privilege to runtime logins, including through
`PUBLIC`. Where that default is still present, the administrator can apply
`REVOKE CREATE ON SCHEMA public FROM PUBLIC` in this dedicated database. Grant the
four logins `CONNECT` to this database if its connection policy requires explicit
grants. They must not own the database, `public`, `billing`, or billing relations.

The runtime verifier checks direct login identity, inherited access to the intended
group, absence of every additional role membership and elevated attribute, absence
of relation ownership, and no `CREATE` privilege on either schema. A login that fails
these checks cannot start the service. Granting the owner group to make a failed
runtime check pass is not a supported configuration.

### 3. Mount the private runtime configuration

Create four different credential files, each containing the complete connection
URL for its corresponding login:

| Billing configuration | Example login | Sole group membership |
| --- | --- | --- |
| `BILLING_API_DATABASE_URL_FILE` | `billing_api_login` | `onesa_billing_api` |
| `BILLING_DISPATCHER_DATABASE_URL_FILE` | `billing_dispatcher_login` | `onesa_billing_dispatcher` |
| `BILLING_WEBHOOK_DATABASE_URL_FILE` | `billing_webhook_login` | `onesa_billing_webhook` |
| `BILLING_METER_DATABASE_URL_FILE` | `billing_meter_login` | `onesa_billing_meter` |

All four URLs must name the same explicit host, port and database; only the login
and its credential differ. Configure the database's actual TLS trust requirements.
Host/database overrides in URL query parameters are refused. Mount these files
read-only, readable by the nonroot service UID and inaccessible to unrelated users.
Do not mount the migration credential in either long-running service.

Complete the other paths in `backend/.env.example` with private Stripe key/webhook
secret files and public configuration files for the approved catalog and public
JWKS. Replace every example identifier and the illustrative invoice terms. Set the
reviewed configuration version and stable integration identifier before creating
provider objects. Both API and worker use the same configuration and four runtime
connections. Keep test mode and paused sales during commissioning.

### 4. Match the Portal assertion issuer and signing key

The Portal bridge is disabled by default. Configure its dedicated server settings
only when the billing service and private route are ready:

| Portal backend setting | Required relationship |
| --- | --- |
| `BILLING_BRIDGE_ENABLED=true` | Explicitly enables the fixed account-billing bridge |
| `BILLING_PRIVATE_ORIGIN` | Exact private billing origin, with no path, query or embedded credentials; for example `http://onesa-billing-api:8099` on the reviewed private network |
| `BILLING_ASSERTION_ISSUER` | Exact issuer used by billing's `BILLING_AUTH_ISSUER`; its origin must also equal Portal's `PUBLIC_ORIGIN` |
| `BILLING_ASSERTION_KID` | Matches the `kid` of the corresponding public key in billing's JWKS |
| `BILLING_ASSERTION_PRIVATE_KEY_FILE` | Dedicated Ed25519 PKCS#8 private key available only to the Portal backend |

The private key file must be a regular, single-link file with no group/other
permissions, owned by the Portal process UID or root and readable by the process;
the reader refuses symlinks. Put only its public key in the file selected by
`BILLING_AUTH_JWKS_FILE`. Billing's expected audience is fixed to `onesa-billing`.
The browser receives neither signing material nor the short-lived assertion.
For the company Portal integration, set billing's allowed and return origins to the
reviewed Portal HTTPS origin. Existing Portal session, verified-email, Origin and
CSRF checks remain required.

### 5. Configure webhook delivery and start both processes

The Portal account bridge does not proxy Stripe webhooks. Provide a separately
reviewed HTTPS ingress that forwards only the intended
`POST /v1/webhooks/stripe` endpoint to the private billing API. Preserve the original
request bytes, JSON content type and `Stripe-Signature` header; do not parse and
re-encode the body in a proxy. Configure the corresponding Stripe endpoint for the
same account and test/live mode, the reviewed event/API contract, and its own
signing secret. Account-cookie or interactive sign-in protection must not be placed
in front of this provider endpoint; the application verifies the Stripe signature
and scope before accepting it. This routing and provider configuration are not
created by the container recipe or the public Company proxy.

Once migration, logins and private configuration are complete, start the HTTP API
and worker as separate supervised processes. Both verify role restrictions,
migration checksum and provider account before reporting startup. A live `/health`
response alone does not prove worker processing or webhook delivery. Retain actual
signed-event acceptance and worker reconciliation evidence while sales remain
paused; then qualify the intended hosted payment journey and the separate business,
Tax and Metronome prerequisites before changing activation settings.

## Development

The example catalog and invoice terms are illustrative and must be replaced with
approved business inputs. Real credentials belong in private secret files. The
example environment contains paths/placeholders and must never be committed with
populated secrets. Test/live key prefixes and the expected Stripe account are checked.
Live mode requires a separate explicit configuration opt-in; sales are independently
disabled by default.

From the repository root:

```sh
cd onesa-billing/backend
npm ci
npm run typecheck
npm run build
npm test
```

Set `BILLING_TEST_DATABASE_URL` to a fresh loopback disposable database whose name
ends `_test` for the real PostgreSQL suites. These suites refuse an existing billing
schema, provision synthetic scoped logins and remove their own fixture schema/logins.
Without this variable, their skip is explicit and is not database acceptance.
No production database or Stripe credential is needed by ordinary tests.

Run the web commands from the repository root, rather than the backend directory:

```sh
node --test onesa-billing/web/test/client.test.mjs onesa-billing/web/test/money.test.mjs
node --test onesa-billing/web/test/browser.test.mjs
```

The browser fixture owns its loopback server, browser process and temporary profile,
uses synthetic API responses and never calls Stripe. A compatible Chromium executable
can be selected with `BILLING_CHROMIUM_EXECUTABLE`. A sandbox IPC denial is a blocked
browser test, not a passed layout/accessibility observation.

After the installation prerequisites above, run the source migration from
`onesa-billing/backend` with private migration configuration supplied only to it:

```sh
npm run migrate
```

From that same directory, start the API with `npm start` and the worker with
`npm run worker` in separate processes, each with its private runtime configuration.

The compiled container runs the one-time migration with `node dist/migrate.js`,
using only the dedicated migration credential for that process. Its worker command
is `node dist/worker-main.js`; its default command starts the HTTP API. The runtime
logins must be provisioned separately after migration and must not use the migration
credential.

The HTTP API and worker are separate processes. Checkout/invoice commands return a
durable operation ID for bounded polling. The worker must be running for processing.
The container recipe uses the reviewed Node base, a nonroot runtime and separate
compiled artifacts; building a recipe is distinct from hosted container acceptance.

## API contract

All account routes require a trusted `aud=onesa-billing` assertion with
`scope=billing:account`, a bounded lifetime and explicit current account membership.
Usage requires `billing:usage` plus its configured producer mapping. Mutating intent,
submission, finalization and portal requests require `Idempotency-Key`.

| Method/path | Purpose |
| --- | --- |
| `GET /health` | Process liveness only |
| `GET /v1/catalog` | Safe configured one-off offers |
| `GET/POST /v1/accounts` | List memberships or create an owned billing account |
| `GET /v1/accounts/:id` | Current account and membership role |
| `GET /v1/accounts/:id/operations` | Bounded safe operation history |
| `PATCH /v1/accounts/:id/members` | Owner-only revisioned membership change |
| `POST /v1/accounts/:id/customer` | Reserve the account's one customer-creation operation |
| `POST /v1/accounts/:id/intents` | Freeze a Checkout/invoice intent from SKU/quantity |
| `POST /v1/accounts/:id/intents/:intent/submit` | Reserve that intent's provider operation |
| `POST /v1/accounts/:id/invoices/finalize` | Explicitly finalize a known completed draft operation |
| `POST /v1/accounts/:id/portal` | Explicit configured customer-portal session |
| `GET /v1/operations/:id` | Fresh authorized status and, for payers, hosted URL |
| `POST /v1/usage` | Commit one authorized immutable usage event/outbox record |
| `POST /v1/webhooks/stripe` | Verify exact raw bytes and durably queue supported Stripe events |

Portal exposes only its fixed allowlist beneath `/api/v1/account/billing`, plus a
minimal verified-session bootstrap. It rechecks the current account/session and
email verification under database locks, enforces existing Origin/CSRF protections,
and uses a dedicated Ed25519 signing key. It forwards neither cookies nor browser
CSRF proofs to the private billing service. The public Company host still refuses
protected account routes. The generated Portal OpenAPI contract is authoritative
for the browser bridge; private usage/webhook endpoints are not proxy targets.

## Explicit sandbox provider check

`scripts/sandbox-smoke.mjs` is a separate opt-in provider test. It verifies the account
and test-mode balance before creating clearly labeled synthetic product/price,
customer, Checkout and invoice fixtures. It exercises exact idempotent requests and
explicit invoice finalization, with no payment confirmation or email-send request.
Keep its run ID and private receipt stable across uncertain responses. The readback
script validates the original pre-payment state of those same resources without
provider mutations. Keep that pre-payment receipt unchanged after a later payment.
Neither script is part of pull-request CI. Synthetic fixture prices do not establish
commercial prices.

For a later observation of the **same existing synthetic Checkout**, use
`node --import tsx scripts/sandbox-observe-existing.ts` from the backend source
checkout with its locked development dependencies installed. Set
`BILLING_SANDBOX_OBSERVE=true`, the original `BILLING_SMOKE_RUN_ID`,
`BILLING_SMOKE_REPORT`, and its reviewed `BILLING_SMOKE_RECEIPT_SHA256`; supply the
same `STRIPE_ACCOUNT_ID` and a test-mode `STRIPE_SECRET_KEY` through private process
configuration. Set `BILLING_OBSERVATION_REPORT` to a new filename inside an existing
private directory owned by the invoking user. The original receipt must be a
private, single-link regular file. Existing output files and symlinks are refused.

This observer makes at most six bounded Stripe GET requests, with no retries or
redirect following. It validates the original account, customer, Checkout, frozen
EUR1 price, deterministic fixture metadata and any bound PaymentIntent. It records
supported paid/unpaid states and the stored return targets in a new mode-0600
receipt containing hashed identities, while preserving the original bytes/hash.
It cannot create a payment, change a provider object, import the fixture into the
application ledger, or qualify a deployed browser return or webhook journey.

## Reference guidance

- [Stripe Checkout Sessions](https://docs.stripe.com/payments/checkout-sessions)
- [Usage billing implementation guidance](https://docs.stripe.com/billing/subscriptions/usage-based/implementation-guide)
- [Stripe API versioning](https://docs.stripe.com/api/versioning)
- [Stripe Tax](https://docs.stripe.com/tax)
- [Stripe webhook handling](https://docs.stripe.com/webhooks)
- [Metronome ingest contract](https://docs.metronome.com/api-reference/usage/ingest-events)

Direct runtime dependencies are pinned in the lockfile and use their upstream MIT
licenses: [Fastify](https://github.com/fastify/fastify) 5.12.6,
[jose](https://github.com/panva/jose) 6.2.15,
[node-postgres](https://github.com/brianc/node-postgres) 8.23.1 and the official
[Stripe Node SDK](https://github.com/stripe/stripe-node) 23.1.0. Build tools use their
upstream licenses: TypeScript 5.9.3 is Apache-2.0 and tsx 4.23.15 is MIT. This records
dependency provenance without introducing a project license.

Source and tests do not establish a deployed merchant service. Deployment, real
catalog/terms, tax jurisdiction qualification, Metronome commissioning and actual
hosted/browser acceptance must have their own evidence before activating sales.
