# Onesa domains and transactional email

Owner-requested mapping (2026-10-10). This configuration is prepared locally;
provider assignments, DNS changes, TLS and real delivery are not yet completed.

Historical mail evidence, 2026-10-13: authoritative DNS is now Cloudflare and staff MX
points to Zoho EU. The existing Ireland Resend domain is verified. Missing sending
authentication records after the nameserver migration caused a real Zoho DMARC
bounce. The exact Resend DKIM TXT plus `rsend.mail` and `send.mail` CNAME records were
restored and verified on both authoritative nameservers and two public resolvers.
Zoho MX, website records and strict DMARC were preserved. Subsequent explicitly
authorized synthetic messages show Delivered in Resend, with owner inbox receipt
confirmed. Historical setup intentions below do not supersede this evidence or
establish unrelated application deployment/processing approval.

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

## One sending domain: onesa.eu

The owner-selected policy from 2026-11-04 uses `onesa.eu` for all visible
transactional senders. Portal configuration examples now use
`Onesa Portal <notifications-portal@onesa.eu>`; AI examples use
`Onesa AI <notifications-ai@onesa.eu>`. Existing configured runtime values remain
authoritative until a verified cutover. The historical verification of
`mail.onesa.eu` above does not establish that `onesa.eu` is verified for Resend.

Resend supplies email delivery. Render or Oracle hosts the application/worker and
stores its private configuration; adding a custom web domain in Render does not
verify an email sender. A single verified Resend domain can send using all required
local parts without creating a sender identity for each address. These sender
strings do not create mailboxes. Replies continue to the existing approved,
monitored `info@onesa.eu` inbox through `MAIL_REPLY_TO`.

1. Inspect the existing Resend domain and Cloudflare records. Add or verify the
   exact `onesa.eu` sending domain only if required. Keep transactional open/click
   tracking disabled. Preserve the existing region and unrelated settings.
2. Copy the exact DKIM and Return-Path records supplied by this domain's Records
   tab. Current Resend domains can use CNAME pairs or MX/TXT records; do not copy
   historical values from the old subdomain or invent provider DNS values. Keep
   existing Zoho root MX and its DKIM/SPF records. Validate existing DMARC alignment
   without weakening its policy or adding a second SPF record at one hostname.
3. Keep sending keys private and scoped to the intended domain/environment. A
   domain-scoped key for `mail.onesa.eu` does not establish permission to send from
   `onesa.eu`. Production and staging retain separate credentials and deployment
   settings; no staging notification policy is changed by the sender examples.
4. Before changing live `MAIL_FROM` or `MAIL_REPLY_TO`, finish or reconcile pending,
   running and ambiguously accepted email jobs under their existing configuration.
   The provider idempotency key is stable per job, but a changed sender changes
   the request body. Do not reset attempts, create replacement jobs automatically,
   clear reconciliation failures or remove the old verified domain to force retries.
5. Update only the intended worker environment, deploy through its existing release
   path and verify actual provider acceptance and inbox delivery with a separately
   approved recipient. Source tests use fake transports and send no external mail.

```dotenv
MAIL_PROVIDER=resend
RESEND_API_KEY=replace-with-private-send-only-key
MAIL_FROM=Onesa Portal <notifications-portal@onesa.eu>
MAIL_REPLY_TO=info@onesa.eu
NOTIFY_EMAIL=OWNER_APPROVED_EXISTING_MAILBOX
```

`MAIL_FROM` accepts one bare email address or one display-name/address pair.
`MAIL_REPLY_TO` accepts one bare email address. Control characters and address lists
are rejected before a network request or SMTP transport is created. Explicit valid
sender bytes are preserved, including an existing subdomain during migration.
Never put mail credentials in frontend configuration, source or logs.

The durable encrypted-body outbox, worker lease/fencing, bounded retries and
stable job-UUID idempotency key remain unchanged. Provider acceptance records
`accepted`; it does not prove inbox delivery. Expired or ambiguous retries require
operator reconciliation. `MAIL_PROVIDER=smtp` remains available for supported
hosts. Use the Resend HTTPS API on Render Free, whose SMTP ports are blocked.

Shared Onesa account verification and recovery remain Portal identity functions.
Product notification names do not create separate product accounts. A dedicated
`Onesa Accounts <accounts@onesa.eu>` sender is reserved for a future separately
configured identity channel; the current Portal outbox uses its single `MAIL_FROM`
for its existing mail types. Robot and Drone have no standalone mail transport in
this source. Their sender names are policy reservations, not enabled delivery.

Resend sending-region selection alone does not establish all service data residency;
review the provider's current processing documentation for the actual account.
No DNS, mailbox, provider setting or deployed environment is changed by these source
examples. Retain the existing release and data-handling approvals.

References: [Resend sender addresses](https://resend.com/docs/knowledge-base/how-do-I-create-an-email-address-or-sender-in-resend),
[Resend MX and CNAME coexistence](https://resend.com/docs/knowledge-base/how-do-i-avoid-conflicting-with-my-mx-records),
[Render environment settings](https://render.com/docs/configure-environment-variables),
[Render Free SMTP limits](https://render.com/docs/free).

## Local verification

### Search and Facebook previews

The English homepage canonical is `https://onesa.eu/`; `/en` serves its alias.
German uses `/de`. Homepage hreflang and sitemap entries use those same destinations,
including x-default. Sections keep their locale prefix. Published detail records enter
the sitemap with their actual updated_at dates; translations are advertised only for
the shared static routes. Search pages and administration remain noindex.

SITE_URL must be an exact origin without credentials, path, query or fragment.
HTTPS is mandatory on Vercel and for public release; loopback HTTP is limited to local
previews. Missing SITE_URL uses the known company origin rather than localhost.
The existing PUBLIC_RELEASE_ENABLED and backend release_ready approval checks still
govern indexing and the sitemap. An empty sitemap before approval is intentional.

The unreleased robots response permits facebookexternalhit and Facebot only for `/`,
`/en`, `/de` and the PNG social card, preserving the disallow-all rule for other
crawlers. The released robots file excludes `/admin` and `/api/`. Robots rules are
crawler guidance; authentication and hostname isolation continue to protect data.

After an authorized deployment, verify anonymous GET responses for `/en`,
`/robots.txt` and `/social/onesa-social-card.png` using both a browser and Facebook
user agent. The HTML head must contain one set of Open Graph tags, an absolute
canonical and og:url, and the 1200×630 PNG. Run the Facebook Sharing Debugger's
Scrape Again to confirm Meta's own network access; a simulated user agent cannot
prove that. If Meta still gets 403 while ordinary GETs succeed, inspect Vercel Firewall
events at the scrape time and distinguish deployment protection from WAF/platform
mitigation. Preserve Preview protection and application authorization; do not add a
global user-agent bypass or disable the firewall without matching evidence.

See [Vercel bot management](https://vercel.com/docs/bot-management) and
[firewall concepts](https://vercel.com/docs/vercel-firewall/firewall-concepts).

### Commands

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

## Zoho Mail staff inboxes (historical setup, 2026-10-10)

The owner confirmed Squarespace DNS and Zoho Mail on 2026-10-10. This dated setup
record is retained as history. Current authoritative DNS is Cloudflare; preserve
Zoho staff mailboxes and root MX. The current sender policy above supersedes the
old Resend `mail.onesa.eu` recommendation, and its generated sending records must
be read from the actual verified domain.

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
