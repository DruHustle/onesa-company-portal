# Company billing commissioning checklist

This checklist records the inputs and observed results needed for a separate
company billing installation. It does not commission a release authority, select
a host, provision a merchant or enable sales. Keep credentials in the target's
private secret mechanism; record only their owner and opaque reference here.

The container fixture and the supplemental native ARM64 workflow can be completed
from reviewed source with synthetic credentials. Target networking, database
administration, merchant configuration and business inputs require the actual
target owners. An unchecked or unsupported item remains open.

## 1. Bind every result to the reviewed source

Fill these fields from the final candidate and its first-attempt hosted runs.
Changing source, images, configuration or target invalidates the corresponding
observations until the changed boundary has been verified again.

| Required field | Value or retained evidence reference |
| --- | --- |
| Canonical repository and repository ID | `DruHustle/onesa-company-portal`, `1412150327` |
| Billing PR and reviewed branch head | Unset |
| Actual tested checkout commit (`GITHUB_SHA`) | Unset; keep the PR merge commit distinct from its branch head |
| Root tree and `onesa-billing` subtree | Unset |
| Required main verification run/attempt and complete job results | Unset; all required jobs and steps must pass |
| Native runtime run/attempt, profile and image config ID | Unset; use the actual target architecture |
| Runtime receipt and manifest SHA256 | Unset; retain both files and their source hashes |
| Browser receipt SHA256 and tested Portal billing source | Unset |
| Proposed deployment image registry digest and configuration version | Unset; an image config ID alone is not a published registry digest |
| Commissioning owner, reviewer and date | Unset |

- [ ] Verify the manifest's canonical repository, run, first attempt, actual
  checkout, root tree, billing subtree and evidence source hashes against the
  retained candidate. Do not rewrite a successful manifest to name another head.
- [ ] Verify all required runtime checks and owned cleanup, scanner OS and
  installed Node coverage, zero HIGH/CRITICAL findings and zero secrets. Preserve
  any lower-severity findings under the existing policy; do not silently discard
  them from the record.
- [ ] Obtain a native proof for the target architecture. The normal billing gate
  proves `linux/amd64`; the supplemental `ubuntu-24.04-arm` workflow proves
  `linux/arm64`. Neither proof substitutes for the other. Both remain
  `verification_only=true` and `release_authorized=false`.
- [ ] Retain successful actual browser checks separately from API/runtime checks.
  The synthetic fixture proves source behavior and isolation, not a real payment
  or a deployed browser return route.

Source anchors: [`runtime_acceptance.py`](../scripts/ci/runtime_acceptance.py),
[`verify.yml`](../scripts/ci/workflows/verify.yml),
[`verify-arm64.yml`](../scripts/ci/workflows/verify-arm64.yml),
[`Dockerfile`](../backend/Dockerfile).

## 2. Select and authorize the separate target

| Required owner input | Acceptance evidence |
| --- | --- |
| Host/service identity and native architecture | Exact intended target, supported native image and sufficient disk/memory capacity |
| Process supervision and storage owner | Separate API and worker definitions, private runtime mounts and bounded resources |
| Private service network and Portal route | Exact billing origin and reachability only through the reviewed routes |
| Public Portal HTTPS origin and webhook HTTPS endpoint | Certificate/hostname verification and explicit route ownership |
| Billing deployment/rollback authority | A separately reviewed, source-bound billing commissioning record |
| Backup owner, retention and recovery objectives | Approved database backup/restore procedure and observed restore result |

- [ ] Select an explicit target and configuration before rendering installation
  commands. The example service names, domains and database names in the README
  do not identify an existing commissioned target.
- [ ] Preserve nonroot execution, read-only application files, dropped
  capabilities, no new privileges, private secrets and separate API/worker
  processes. Supply writable storage only where the reviewed runtime needs it.
- [ ] Create a billing-specific deployment and rollback procedure that binds the
  reviewed source, native image, target and configuration. Do not repurpose the
  Portal presentation, Nvidia or identity release profiles: their accepted source
  contracts intentionally do not commission billing or its new frontend mount.
- [ ] Demonstrate backup and restore against an isolated target copy, including
  migration history, account bindings, immutable intents, provider operations,
  event journals and usage custody. Record the observed recovery point and time.

The source repository currently supplies an image recipe and installation
preparation, not a commissioned billing deployment bundle. The target-specific
service definitions and independent release authority remain work to complete
once the target and its owners are known.

## 3. Establish database and secret ownership

- [ ] Have the database administrator provide an empty, dedicated billing
  database, its exact host/port/database identity and actual TLS trust settings.
  Portal, PasoFi and product databases are not migration targets.
- [ ] Provide migration authority privately to the one-time
  `node dist/migrate.js` process. Retain the applied/current result and packaged
  checksum. Do not mount that credential in the API or worker.
- [ ] Provision four distinct runtime logins with only their designated nonlogin
  group: `onesa_billing_api`, `onesa_billing_dispatcher`,
  `onesa_billing_webhook` and `onesa_billing_meter`. Confirm no ownership,
  administrator attributes, additional role membership or schema CREATE rights.
- [ ] Mount the four corresponding database URL files read-only for the nonroot
  service UID. Every connection must identify the same explicit host, port and
  database. Record file ownership and secret references, never connection strings.
- [ ] Start both compiled processes with the same reviewed configuration. Retain
  actual role, migration checksum and provider-account startup checks, process
  supervision and graceful shutdown observations. `/health` proves liveness only.

Follow the exact commands and role requirements in
[Installation preparation](../README.md#installation-preparation) and the path
contract in [`backend/.env.example`](../backend/.env.example). Keep
`BILLING_MODE=test`, `BILLING_ALLOW_LIVE=false` and `BILLING_SALES_ENABLED=false`
through initial target and identity commissioning.

## 4. Connect the Portal and signed webhook ingress

- [ ] Obtain the real Portal HTTPS public origin, private billing origin,
  assertion issuer, signing-key owner and key ID. Provision a dedicated Ed25519
  private key only to the Portal backend, with the required regular-file,
  single-link ownership and private-mode checks. Supply only the corresponding
  public JWKS to billing; audience remains `onesa-billing`.
- [ ] Match the Portal issuer to billing's exact issuer and Portal public origin.
  Match billing's allowed and return origins to the approved Portal HTTPS origin.
  Enable the default-disabled bridge only after the private service is ready.
- [ ] Verify account session, verified email, Origin/CSRF, account membership,
  owner/payer/viewer permissions, session expiry and mobile browser behavior on
  the actual deployed Portal route `/account/billing`.
- [ ] Supply a separately reviewed HTTPS
  `POST /v1/webhooks/stripe` ingress. Preserve raw request bytes, content type and
  `Stripe-Signature`; do not require an account-cookie or interactive sign-in on
  that provider route. The account bridge does not proxy webhooks.
- [ ] Configure the actual Stripe endpoint for the same account, mode and
  reviewed event/API contract, using its own privately mounted signing secret.
  Observe a real signed event being durably accepted and processed by the worker;
  confirm duplicate delivery does not duplicate a financial transition.
- [ ] Retain rejected invalid signatures and wrong-scope events, durable event
  status and worker reconciliation evidence. An HTTP response or browser return
  alone does not establish payment or webhook processing.

Source anchors: [`backend/src`](../backend/src),
[`web`](../web), and the Portal bridge configuration documented in the
[installation instructions](../README.md#4-match-the-portal-assertion-issuer-and-signing-key).

## 5. Supply approved commercial and provider inputs

| Required input | Owner-supplied evidence |
| --- | --- |
| Stripe account, test/live mode and key owner | Actual account identity, scoped key reference and webhook secret reference |
| Catalog and invoice terms | Approved SKUs, prices, currency, quantities, tax behavior, due terms and allowed business/customer scope |
| Stable integration identifier and configuration version | Values fixed before creating provider objects; no example placeholders |
| Stripe Tax qualification | Actual settings and current registrations, plus approved selling jurisdictions and product tax treatment |
| Metronome qualification | Actual sandbox/project/token, rate card/contract, customer mapping, billable unit and period/grace boundaries |
| Optional customer portal | Independently approved configuration for the same Stripe account and mode |

- [ ] Replace every illustrative catalog, invoice term and identifier with the
  approved input. Do not derive merchant jurisdiction or tax coverage from a
  domain, payment currency, test transaction or repository location.
- [ ] Preserve existing Stripe settings. Qualify automatic tax through read-only
  settings/registration checks and the owner's actual coverage requirements
  before enabling it. The service does not register the business with a tax
  authority or decide its tax obligations.
- [ ] If usage billing is in scope, establish the independent Metronome project,
  credential and contract mappings. Verify immutable source events, exact decimal
  units, idempotent delivery, rating, invoice generation and payment status
  separately. Ingestion HTTP 200 alone is not billing completion.
- [ ] Keep metered offers out of one-off Checkout/manual-invoice paths. Require a
  separately verified mapping before adopting an external usage invoice into the
  company ledger.

## 6. Qualify a real payment journey before activation

- [ ] After target/identity checks and explicit owner authorization, qualify the
  intended test-mode sales configuration with approved synthetic commercial
  inputs. Observe the actual hosted Checkout or reviewed invoice journey, the
  deployed return route, fresh provider retrieval, signed webhook processing and
  account-bound ledger state. Reconcile any prior unresolved payment first.
- [ ] Exercise lost-response recovery and duplicate delivery without issuing an
  extra provider mutation. Verify holds stay held when ownership or configuration
  differs. Retain the original intent, operation and provider identity references.
- [ ] For invoices, prove draft creation, separately authorized finalization and
  observed payment as distinct steps. This implementation does not add automatic
  invoice payment, email-send or refund commands.
- [ ] Have the authorized business owner approve the actual merchant/live scope,
  catalog, Tax/usage qualification and support/recovery procedure. Record this
  approval separately from CI and host installation authority.
- [ ] Apply live-mode and sales activation only through the separately
  commissioned configuration/change process. Record the resulting exact source,
  image, configuration, provider account/mode and reconciliation observations.

Completion means the evidence for the selected scope is retained and each
remaining limitation is explicit. A successful native CI manifest by itself
does not complete target commissioning or authorize commercial activation.
