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

## Engineering Docs identity (prepared, feature disabled by default)

The internal `engineering-sign-in` details/start/verify operations bind an OIDC
interaction cookie, exact Portal Origin and interaction proof. Codes expire after
ten minutes, allow at most five failed proofs and are redeemed once transactionally.
The existing mail outbox stores encrypted message text; no new mail provider is used.
The separately encrypted OIDC store enforces expiry, grant revocation and one-use
authorization codes. Protocol endpoints are excluded from generated business schemas.

Owner-only `admin/engineering/memberships` lists and updates individually approved
memberships. Changes require a current owner session, CSRF, password/fresh MFA,
expected revision and access-policy evidence. An engineering identity has no Portal
role. The exact Cloudflare email policy remains an independent requirement. See
[Engineering Docs access](../engineering/ENGINEERING_DOCS_IDENTITY.md).

## Prepared common-account Docs link

Prepared additive account-link fields preserve older clients: current Docs details
may include `onesaSignInPath` with only the fixed central-account return to the
current `/engineering/sign-in/{uid}`, and `onesaLink:{email}` when the central
account is eligible to prove its existing Docs identity. Password, link-verify and
handoff-verify accept `linkOnesaAccount`, default false. The request-link operation
does not link accounts. The opt-in operation requires both the live central session
and the existing approved Docs proof, with immutable-ID collision and one-use-link
checks in the same transaction. `ENGINEERING_ACCOUNT_PROOF` and
`ENGINEERING_ACCOUNT_CONFLICT` refuse mismatches; `ONESA_SESSION_REQUIRED` and
`ONESA_REAUTH_REQUIRED` route the user through central sign-in without accepting an
unapproved identity or bypassing MFA. Linked membership UUIDs remain the Docs OIDC
subjects; no Cloudflare identity or allowlist is silently replaced.
For an already proven linked account that needs fresh authentication, details
include `onesaReauthRequired:true`; the fixed account return then presents central
password/MFA again. Rounded OIDC timestamps do not permit reuse within the same second.

## Cross-browser Engineering email links (accepted 2026-10-21)

Independently accepted API `cfe0d43e7032dabc83be8e49dba340660e1975e0` has the identical reviewed tree to
qualified main `32f3b24c4937632d2da500b44002602bdedd8449`. Actual approved-owner Access
acceptance remains separate from protocol/UI qualification.

`POST /engineering-sign-in/{uid}/link-prepare` validates an unconsumed engineering
link and its original membership revision through the exact Portal proxy/Origin.
It sets an encrypted, Secure, HttpOnly, host-only handoff cookie for at most five
minutes and returns only the fixed `/engineering` destination. It neither consumes
the link nor signs in. The receiving browser obtains its own fresh OIDC state,
PKCE and interaction cookie through the normal Access flow. Details can then show
the verified `linkEmail`; `handoff-verify` requires that fresh interaction, Origin,
CSRF and explicit confirmation before atomic one-use redemption of the original
link. Expired, used, tampered or offboarded links fail closed. The link's separate
15-minute lifetime remains enforced even if its original interaction has expired.
No new Portal role, database migration or privileged Access bypass is introduced.
Existing administrator email links and MFA are unchanged. Deployment and actual
Access acceptance must be recorded separately from generated contracts/local tests.

## Working drafts and published editions

Migration 012 adds a private published snapshot and the `published_content` read
view. Public lists, details, categories, legal readiness and vacancy intake use
that approved edition while `/admin/content` exposes the editable working row.
Saving or restoring a draft does not unpublish it. Editors may save replacements
and submit `pending_review`; only publishers approve, schedule, publish or unpublish.
Text/media changes invalidate review. Publication requires matching revision/digest
and atomically replaces the snapshot; stale revisions return 409.

`POST /admin/content/{id}/unpublish` requires `expectedRevision` and publisher
permission. It removes the public edition and schedule, retains the draft/history,
and invalidates approval. Archive also withdraws publication. Restoration includes
kind/slug/locale and text/media, remains a draft and never automatically republishes.

`GET /admin/content/media` returns only approved, clean, unarchived public images
for editorial roles. `GET /admin/enquiries/assignees` returns only ID/email of active
assignable business staff to enquiry-authorized roles; it does not grant `/admin/users`.
Users, templates and audit now apply their bounded `search` server-side. Existing
Origin/CSRF, object permissions, holds, legal settings and erasure safeguards remain.

`GET /admin/files/{id}` returns metadata only after the existing document's role/
classification checks. It supports the selected CV's scan state without changing
application or export response shapes. The UI requires a clean result for that exact
file before offering Download; the download endpoint independently rechecks quarantine
and authorization. A stale or failed metadata read never enables another CV.

### Protected editorial publication summary

Managed content responses optionally include `publication` for additive compatibility:
`live` contains only edition revision, kind, locale, slug, title and publication time;
`everPublished`, `hasUnpublishedChanges`, `scheduledAt` and `scheduledRevision` describe
the working row relative to that public edition. Scheduling requires the exact approved
revision and digest. Explicit unpublishing retains draft/history and removes live access.
The public content contract excludes this summary, working review metadata and snapshots.
Older clients ignore the added property; a new client receiving an older response reports
that live-edition details are unavailable rather than inferring publication from a draft.
The change uses schema 012 and retains the worker's existing publication postconditions.

## Shared Onesa account and product access (prepared, default off)

The public account configuration and authenticated account snapshots now include
an additive `catalog` of `{product,name,connected}` entries. AI, Drone and Robot
and optional Mobile are connected only when their fixed confidential client is configured.
Farmer, Logistics and PasoFi can each register a confidential client for verified
platform administrators. Those clients receive only their own entry in
`onesa_applications` and `onesa_product_roles`, an MFA-backed `global_admin`
claim and no workspace memberships. Each application enforces its own resource
permissions. The registration and product-grant APIs retain their four-product
vocabulary. Smart Factory remains a catalog entry.
The existing `applications` response and legacy audience-bound three-product claims remain
compatible; Mobile keeps its separately configured vocabulary and client boundaries.
Future commissioning requires an independently reviewed client and its
own scoped data/action authorization; appearing in the catalog grants nothing.

The existing Portal hosts the independent `/api/v1/identity` issuer using its
locked OpenID Connect provider. Fixed confidential clients use authorization code
flow with mandatory S256 PKCE and exact HTTPS callbacks. Protocol routes remain
separate from Engineering Docs identity and its independently approved membership.
The authenticated `/identity/session` endpoint returns live, audience-bound account,
MFA and product claims; applications never treat an unchecked ID token as proof.
`/identity/revoke` defaults to a single token. With `all_sessions=true`, a live
matching grant and its exact source session are required before revoking that
account across products. `all_sessions_revoked` is true only after that transaction
commits; an idempotent `ok` alone never proves global sign-out.

`/account/register` accepts a name, email and one to four requested products.
Mobile requests are accepted only when a Mobile client is explicitly configured.
One-use mailbox verification creates a `member`, with pending product access and
no Portal administration authority. Connecting an existing Portal account requires
its current password and a verification link bound to its immutable user ID. It
retains credentials, MFA and prior approvals. Account login, security and product
requests use host-only cookies, exact Origin and CSRF on authenticated mutations.
Identity artifacts stay encrypted server-side. Email uses the existing encrypted
outbox; queue success does not establish delivery.

Owner and Administrator roles administer Company Portal and configured Onesa products.
The optional Mobile client uses `customer`, `agent`, `support`, `operations`,
`finance`, `auditor` and `admin` roles. New Mobile requests default to pending
`customer` access. Every Mobile staff role requires MFA at sign-in, continuation
and live assertion; existing AI/Drone/Robot role rules remain unchanged.
Mobile claims are returned to the Mobile client only. Legacy client assertions
retain their three-product vocabulary even when Mobile is configured.
Assigning or removing an Onesa Administrator requires fresh owner password/MFA
proof; existing administrative routes enforce the same rule in shared mode.
`/admin/identity/accounts` provides bounded account search. Product-access updates
require current revision plus fresh administrator proof. Per-product administrators
require MFA as well. Normal accounts receive only active explicit product grants.
Drone additionally requires explicit membership in an existing workspace; its
product role caps each workspace role. Robot actuation and safety confirmations
remain independently enforced by Robot.

For positive OIDC `max_age`, the issuer checks the actual central authentication time.
A fresh verified session can continue. An expired freshness window, `prompt=login`
or `max_age=0` requires new proof. Same-account step-up retains the OIDC browser
session during the pending interaction and rotates the central credential.

Every issued grant is bound to the exact account or MFA Portal session that
approved it. Sign-out, credential changes, disablement and global-role changes
invalidate that source. Held-lock regressions prove that admitted requests and
late protocol writes cannot restore authority after sign-out. Permission changes
are read on each application request. Source preparation does not enable the
feature or establish hosted staging acceptance.

Native Portal `/auth/logout` ends only the presented Portal session and the
product grants bound to that native session. It preserves other native sessions
and independent account sessions. `/account/logout` and `/auth/revoke` retain
their documented all-session revocation behavior.

Same-account reauthentication rotates the browser credential while carrying existing
product grants to its replacement. Each carried grant retains its original
authentication time, factors and expiry; confirming MFA in one product cannot
freshen another product's sensitive-action proof. Switching accounts instead
revokes the previous account's bindings in that browser.

## Company billing bridge (prepared, default off)

The authenticated browser prefix is `/api/v1/account/billing`. The backend maps
only the fixed routes below to the private billing service's `/v1` prefix; the
browser must not add another `/v1` after `billing`. The existing company hostname
still serves only `/api/v1/public/*`; `/account/billing` belongs on the protected
Portal hostname. The bridge is unavailable until `BILLING_BRIDGE_ENABLED=true`
and its dedicated backend configuration is valid.

Every request requires an existing verified Onesa account or MFA Portal session.
The backend locks and rechecks the current account, session expiry and verified
email before forwarding. Mutations additionally require the exact Portal Origin
and `X-CSRF-Token`; cross-site requests are refused. The backend signs a short-lived
Ed25519 assertion for audience `onesa-billing`, the current immutable user ID and
scope `billing:account`. It contains no Portal or product role. The billing service
independently enforces its account membership and operation ownership.
The session bootstrap works with an existing native MFA Portal session while the
separate shared-identity issuer remains disabled.

All paths in this table are relative to `/api/v1/account/billing`. Identifiers are
UUIDs, bodies are strict, and query parameters are refused. Responses and current
field types are generated in OpenAPI and the frontend client contract.

| Method and path | Contract |
| --- | --- |
| `GET /session` | Returns only `{csrf, displayName}` from the locked current session; it makes no billing-provider request. |
| `GET /catalog` | Current mode, sales availability and bounded server-owned one-off catalog. |
| `GET /accounts` | Current actor's billing accounts and billing roles. |
| `POST /accounts` | Creates a billing account from `{displayName}`; billing owns the membership. |
| `GET /accounts/{accountId}` | Reads one authorized account. |
| `GET /accounts/{accountId}/operations` | Reads up to 50 current account operations for status and recovery. |
| `POST /accounts/{accountId}/customer` | Takes `{}` and prepares or recovers the account's stable customer operation. |
| `PATCH /accounts/{accountId}/members` | Takes `expectedRevision`, `subject`, `role` and `status`; current billing owner authority and membership constraints apply. |
| `POST /accounts/{accountId}/intents` | Takes `{kind, items}` with `kind` equal to `checkout` or `invoice`; items contain server catalog SKUs and integer quantities. Requires `Idempotency-Key`. |
| `POST /accounts/{accountId}/intents/{intentId}/submit` | Takes `{}` and submits the saved intent. Requires `Idempotency-Key`. |
| `POST /accounts/{accountId}/invoices/finalize` | Takes `{draftOperationId}` for a separately verified draft. Requires `Idempotency-Key`. |
| `POST /accounts/{accountId}/portal` | Takes `{}` for the dedicated customer-portal flow. Requires `Idempotency-Key`. |
| `GET /operations/{operationId}` | Reads an owned operation and, where available, its freshly verified payment status or hosted redirect. |

Intent creation does not accept `kind: "portal"`; the dedicated portal route keeps
that operation separate. Stable request keys are retained across uncertain
responses. The frontend proxy forwards the header only for the billing prefix,
and the bridge validates it before forwarding. Operation states include
`prepared`, `dispatched`, `succeeded`, `failed` and `unknown`; a successful creation
or redirect alone is not a payment confirmation. The account page shows a paid
state only from `paymentConfirmed: true` on the verified operation.

The bridge limits requests to 16 KiB and responses to 64 KiB, with an eight-second
upstream deadline, no redirects and private/no-store responses. It accepts hosted
links only on the exact HTTPS Stripe Checkout, Invoice and Billing hostnames.
It exposes no arbitrary upstream path, usage-ingestion endpoint or webhook proxy.
The page starts catalog Checkout and reads invoice status; direct invoice creation
and finalization remain explicit authorized API operations. Metronome usage and
Stripe webhook processing stay in the independent billing service.

When a Farmer client is configured, a verified Onesa customer with active Farmer
access receives `onesa_product_roles.farmer = "user"`. Verified Portal staff can
enter Farmer under their existing Portal approval. An explicit pending, rejected
or revoked Farmer decision takes precedence for ordinary staff. Platform
administrators retain the existing MFA requirement. Farmer receives only its own
product assertion and resolves all farm memberships within Smart Farmer. With no
membership, the user may create a farm or accept an invitation.
A self-service account with the ordinary `member` role requests Farmer from
`/account` using `POST /api/v1/account/products/farmer/request`. A Portal
administrator can approve the existing account in the product-access manager.
An approval for another product grants access only to that product.
