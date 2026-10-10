# Onesa domains and transactional email

Owner-requested mapping (2026-10-10). This configuration is prepared locally;
provider assignments, DNS changes, TLS and real delivery are not yet completed.

| Hostname | Application | Vercel project / root |
| --- | --- | --- |
| `onesa.eu` | Public bilingual company site | `onesa-company-portal` / `onesa-company-portal-frontend` |
| `portal.onesa.eu` | Private administration | Same project and frontend; hostname selects `/admin` |
| `platform.onesa.eu` | AI platform | AI chat project / `onesa-ai-platform-frontend/apps/chat` |
| `robot.onesa.eu` | Future robot operator interface | Reserved intention only; no executable application exists |

Three Git repositories remain independent. Two hostnames on the company frontend
do not create a fourth repository or another backend. Company admin pages redirect
to the portal. Portal root redirects to `/admin`, other public pages redirect to the
company site, and portal responses are noindex. On the company hostname the BFF only
forwards `/api/v1/public/*`; authentication/admin APIs require the portal hostname.
Unknown hosts fail closed when the split is configured. Cookies retain their existing
host-only scope: never set a shared `.onesa.eu` cookie domain.

## Provider and DNS setup

1. In Vercel project Settings → Domains, add `onesa.eu` and `portal.onesa.eu` to the
   company/portal frontend. Add `platform.onesa.eu` to the AI chat frontend.
2. Copy the exact A/AAAA/CNAME and any ownership-verification records Vercel provides.
   Record values are project-specific; do not substitute a guessed generic IP or CNAME.
3. Public DNS inspected on 2026-10-10 used `nsd1` through `nsd4.squarespacedns.com`.
   Apex A records were `198.49.23.144`, `198.49.23.145`, `198.185.159.144`, and
   `198.185.159.145`. No MX records or requested-subdomain CNAME answers were returned.
   Confirm current authoritative records in the account before editing.
4. In Squarespace Domains → onesa.eu → DNS → DNS Settings, add the Vercel records.
   Export/capture existing DNS first. Replace conflicting apex website records only
   when the intended Vercel project is ready; preserve unrelated TXT/MX records and
   existing nameservers. Do not create a dangling robot CNAME before its application exists.
5. Verify each domain in Vercel and wait for managed TLS. Confirm the correct pages,
   redirects, cookie scope, CSRF and noindex behavior over HTTPS on the actual hosts.

Vercel company/portal server environment:

```dotenv
SITE_URL=https://onesa.eu
PORTAL_URL=https://portal.onesa.eu
PUBLIC_ORIGIN=https://portal.onesa.eu
BACKEND_URL=https://ACTUAL_RENDER_API_HOST
PROXY_SHARED_KEY=PRIVATE_MATCHING_BACKEND_KEY
PUBLIC_RELEASE_ENABLED=false
ONESA_HSTS_ENABLED=false
```

Render API and worker share `PUBLIC_ORIGIN=https://portal.onesa.eu` and
`COMPANY_ORIGIN=https://onesa.eu`. The second origin is accepted only for public
API mutations. The primary portal origin remains mandatory for authentication and
administration. Vercel's upload limit and the publication gates still apply.
For protected previews use separately approved stable HTTPS hostnames and matching
configuration; arbitrary Vercel preview aliases are rejected by a split deployment.
AI Render and Vercel use `ONESA_PUBLIC_ORIGIN=https://platform.onesa.eu`, with
`ONESA_API_URL` pointing to its actual Render API on Vercel. Keep API/model keys private.

## Resend sending domain

Recommended sending domain: `mail.onesa.eu`, sender
`Onesa <notifications@mail.onesa.eu>`. This separates application mail reputation
from Zoho staff mailboxes at `onesa.eu`. This is a recommendation, not a provisioned
or verified domain.

1. Add `mail.onesa.eu` in Resend Domains; select Ireland (`eu-west-1`) for sending.
   Keep open/click tracking disabled for transactional security messages.
2. Copy the exact generated DKIM TXT and sending/Return-Path SPF TXT and MX records
   from Resend into Squarespace. They belong at the provided names under the sending
   domain, not at the root staff-mailbox MX. Do not duplicate SPF TXT records at one
   hostname. Check DMARC alignment and existing policy before adding/changing it.
   Resend sending-region selection does not establish EU data residency: its official
   documentation says account data, email metadata, logs and API records remain in the US.
3. Verify the domain and create a send-only API key scoped to this domain.
   Store it as `RESEND_API_KEY` in the Render **worker** secret environment only.
   Do not put it in Vercel, `NEXT_PUBLIC_*`, GitHub source, logs or shared frontend files.
4. Configure the worker as below. Set API `NOTIFY_EMAIL` to an existing owner-approved
   recipient and share it with the worker. `hello@onesa.eu` is only a possible Reply-To:
   creating that sender string does not provision an inbox.

```dotenv
MAIL_PROVIDER=resend
RESEND_API_KEY=replace-with-private-send-only-key
MAIL_FROM=Onesa <notifications@mail.onesa.eu>
NOTIFY_EMAIL=OWNER_APPROVED_EXISTING_MAILBOX
# Optional, only after the mailbox exists:
# MAIL_REPLY_TO=hello@onesa.eu
```

The portal keeps its durable encrypted-body email outbox, worker lease/fencing and
bounded retries. Resend uses HTTPS with a 15-second timeout and a stable job-UUID
idempotency key. Provider acceptance changes a job to `accepted`; it does not prove
inbox delivery. Resend idempotency lasts 24 hours, so retries after that window need
operator reconciliation. The existing SMTP transport remains selectable with
`MAIL_PROVIDER=smtp`; no new SDK dependency is required.

The integration currently covers existing portal notifications and password-reset
messages. AI email verification/recovery and robot notifications are not implemented
by these settings. Resend receiving/webhooks are a separate application feature;
staff inboxes use the owner-selected Zoho Mail service. No inbound MX
changes, mailbox purchase, real recipient message, commit, push or deploy happened here.
Before enabling production, qualify delivery, bounce/complaint handling and the actual
provider/data-handling configuration; retain the existing release approval gates.

## Local verification

Backend: `npm run lint`, `npm run typecheck`, `npm run build`, and `npm test` against
an isolated `_test` database. Mail tests use an injected fake transport and send no mail.
Frontend: `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run test:domains`.
Host tests cover exact origins, unknown hosts, redirects and invalid configuration.
Hosted DNS/TLS and inbox delivery remain pending account access and target qualification.

Sources: [Vercel custom domains](https://vercel.com/docs/domains/working-with-domains/add-a-domain),
[Squarespace DNS editing](https://support.squarespace.com/hc/en-us/articles/360002101888-Edit-your-domain-s-DNS-records),
[Resend domains](https://resend.com/docs/dashboard/domains/introduction),
[Resend regions/data residency](https://resend.com/docs/dashboard/domains/regions),
[Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys),
[Resend receiving](https://resend.com/docs/dashboard/receiving/introduction).

## Zoho Mail staff inboxes (owner-selected)

The owner confirmed Squarespace DNS and Zoho Mail on 2026-10-10. Use Zoho for staff
mailboxes at `onesa.eu` and Resend only for transactional mail at `mail.onesa.eu`.

1. In the existing Zoho Mail Admin Console, add `onesa.eu` to the intended organization.
   Confirm its actual account region/data center; do not select or purchase a new plan
   merely to copy a DNS template. An EU account should show EU-specific record values.
2. Verify ownership using Zoho's account-specific TXT or CNAME record in Squarespace.
3. Create the approved staff mailbox(es) and aliases in Zoho. Suggested starting names:
   `andrew@onesa.eu` for the owner and `hello@onesa.eu` for general enquiries; these are
   suggestions, not provisioned mailboxes. Aliases for `security@onesa.eu` and
   `privacy@onesa.eu` should route to a monitored inbox if used in published policies.
4. Set root-domain MX records to the exact three hosts and priorities displayed in
   Zoho Admin Console. Check existing root MX before replacement; this task selected
   Zoho as the mailbox provider. Resend Return-Path MX stays on its generated subdomain.
5. Add Zoho's root-domain SPF record and its selector-specific DKIM record. Use the
   actual account/data-center values and one SPF record per hostname. Resend's SPF/DKIM
   belong under `mail.onesa.eu`, so the two providers need no conflicting root SPF.
6. Configure one DMARC TXT record at `_dmarc.onesa.eu` after checking for an existing
   policy. A monitoring policy `v=DMARC1; p=none` can start alignment checks; add a
   report recipient only when a monitored report mailbox exists. Enforce quarantine/
   reject only after validating all legitimate Zoho and Resend senders.
7. Verify Zoho MX/SPF/DKIM status, sign in to the provisioned mailbox with MFA, and
   qualify inbound/outbound delivery with an explicitly approved test recipient.
8. Then set portal `NOTIFY_EMAIL` to the actual monitored Zoho mailbox and optional
   `MAIL_REPLY_TO=hello@onesa.eu`. Those values alone do not create inboxes.

No Zoho account, mailbox subscription, DNS change or external message was created.
Zoho management and Squarespace DNS need owner account access. Copy provider-generated
records from the respective consoles; do not paste credentials into chat.

Sources: [Zoho domain verification](https://www.zoho.com/mail/help/adminconsole/domain-verification.html),
[Zoho MX setup](https://www.zoho.com/mail/help/adminconsole/configure-email-delivery.html),
[Zoho SPF](https://www.zoho.com/mail/help/adminconsole/spf-configuration.html).

### Isolated HTTP host acceptance

`npm run test:domain-http` targets only a loopback frontend at port 3362 (override
with `DOMAIN_TEST_FRONTEND_ORIGIN`). Start the production-built frontend with
`SITE_URL=https://onesa.eu`, `PORTAL_URL=https://portal.onesa.eu`,
`PUBLIC_ORIGIN=https://portal.onesa.eu` and a deliberately stopped loopback backend
at 8362. The probe checks host redirects, API routing, rejected forwarded-host
spoofing, original-image hashes, actual favicon/social metadata and portal noindex.
It does not establish hosted TLS/DNS or delivery acceptance.

Local verification completed on 2026-10-10: 30 backend tests, four host unit tests,
built-server host/metadata/image probes, both application builds, lint/types,
contract drift, documentation/hygiene and official Blueprint schema passed.
No live DNS, Zoho mailbox or Resend domain was created, and no email was sent.

## Neon database and Object Storage — 2026-10-10

The owner supplied a Neon pooled database URL and identified bucket `s3-bucket`.
Credentials are excluded from this document. Runtime API and worker need the same
restricted application-role URL; `neondb_owner` belongs to migration/provisioning
operations. Run schema migrations and scoped-role provisioning on the intended
branch before attempting production readiness. Do not connect the local development
app to production as an incidental configuration change.

Neon Object Storage exposes a branch-specific S3-compatible endpoint. Configure
API and worker with `S3_BUCKET=s3-bucket`, copy Neon `AWS_ENDPOINT_URL_S3` to portal
`S3_ENDPOINT`, and copy Neon `AWS_REGION` to portal `S3_REGION`. Supply storage-scoped
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` through the provider secret UI. Do not
use the PostgreSQL password as an object-storage credential. The bucket must be
private, and DB/bucket must target the same intended Neon branch. The current uploader
requests AES256 server-side encryption; verify provider acceptance with a synthetic
upload/read/delete and API-to-worker round trip before claiming target compatibility.
No hosted storage operation was performed.

Preserve the existing `SESSION_KEY` on both services because it encrypts MFA/outbox
data. Replace the conversation-exposed database password and proxy key through
provider settings; a replacement proxy key must match the Vercel BFF and Render API
(and worker configuration). Do not publish secrets in logs or commit them. The local
`.env` remains on its original loopback development DB/storage, is Git-ignored, and
was not modified. Endpoint, signing region and scoped storage credentials remain
missing, so bucket-name-only configuration is not complete.

Sources: [Neon Object Storage](https://neon.com/blog/building-neon-object-storage),
[Neon storage environment mapping](https://neon.com/blog/building-a-private-searchable-photo-library-on-the-neon-backend).

## Deployment review — 2026-10-10

Render's `generateValue` produces a 256-bit base64 value (44 characters), whereas
the portal enforces at least 48 characters for `SESSION_KEY`. The Blueprint now
requires an explicitly supplied persistent key (`sync: false`). For a new empty
database, generate a key with `openssl rand -hex 32` and save it privately on the API;
the worker must use the identical value. Preserve a working existing encryption key.
Changing it without a reviewed re-encryption procedure makes existing MFA/outbox
ciphertext unreadable. Existing Blueprint updates do not populate `sync: false`
values: configure missing values directly in the service environment.

Live HTTPS checks found the company apex still served by Squarespace, the portal
redirecting to `/en`, the platform responding, and the robot returning 404. These
checks establish reachability, not application acceptance or deployment success.
GitHub lacks the portal `RENDER_BACKEND_SERVICE_ID` and both application
`VERCEL_PROJECT_ID` secrets. Release qualification remains blocked and must not be
replaced with a fabricated passing record. Exposed database/storage/Resend/proxy
credentials must be rotated privately before production use.

Source: [Render generated secrets and manual secret updates](https://render.com/docs/blueprint-spec#generating-random-secrets).
