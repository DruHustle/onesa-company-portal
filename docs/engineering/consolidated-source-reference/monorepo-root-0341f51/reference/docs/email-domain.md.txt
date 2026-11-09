# Onesa email domain and sender policy

Use the visible sending domain `onesa.eu` for all product email, as requested on
2026-11-04. Product names live in the address's local part and the friendly sender
name. This policy does not create mailboxes, enable a delivery integration or
establish that the new domain has completed provider verification.

## Product senders

| Product | Friendly sender and primary address | Operational alerts |
| --- | --- | --- |
| Smart Logistics | `Smart Logistics <notifications-logistics@onesa.eu>` | `alerts-logistics@onesa.eu` |
| Smart Farmer | `Smart Farmer <notifications-farmer@onesa.eu>` | `alerts-farmer@onesa.eu` |
| Smart Factory | `Smart Factory <notifications-factory@onesa.eu>` | `alerts-factory@onesa.eu` |
| Onesa Robot | `Onesa Robot <notifications-robot@onesa.eu>` | `alerts-robot@onesa.eu` |
| Onesa Drone | `Onesa Drone <notifications-drone@onesa.eu>` | `alerts-drone@onesa.eu` |
| Pasofi | `Pasofi <notifications-pasofi@onesa.eu>` | `alerts-pasofi@onesa.eu` |
| Onesa Portal | `Onesa Portal <notifications-portal@onesa.eu>` | `alerts-portal@onesa.eu` |
| Onesa AI | `Onesa AI <notifications-ai@onesa.eu>` | `alerts-ai@onesa.eu` |

`notifications-` identifies normal system messages. Reserve `alerts-` for
actionable operational events with the existing deduplication, backoff and
production/staging notification controls. The `pasofi` spelling follows the
current product repository and the owner's exact requested suffix.

One shared Onesa account continues to serve the enabled products. Registration,
verification, password recovery and cross-product access remain the Portal
identity service's responsibility. Reserve `Onesa Accounts <accounts@onesa.eu>`
for a dedicated shared identity channel; do not create separate product accounts
or credentials to introduce product notification addresses. The current Portal
outbox has one `MAIL_FROM` for its existing mail types, so the reserved account
sender does not imply automatic category-based routing.

Portal and AI source examples select their primary addresses above. Robot and
Drone have no independent mail transport in the consolidated source. The other
products have separate source repositories and retain independent releases;
listing their addresses here does not change their runtime configuration.

## Provider responsibilities

Resend delivers application messages over HTTPS. Render and Oracle host
applications and store their private mail configuration. A Render web custom
domain is independent of Resend email-domain verification. Verify `onesa.eu` once
in the intended Resend account, then send from the product local parts above.
Resend does not require a separately registered sender identity for each address.

Cloudflare holds the current authoritative DNS. Preserve existing Zoho MX records
for staff inboxes and replies. The sender addresses are not newly provisioned
inboxes; `MAIL_REPLY_TO=info@onesa.eu` reuses the existing approved contact mailbox.
If product-specific support replies are later needed, create and verify the
corresponding Zoho aliases before advertising them or changing Reply-To.

Read the exact DKIM and Return-Path records from the selected Resend domain.
Depending on when the domain was created, Resend can provide CNAME pairs or
MX/TXT records. Its technical Return-Path subdomain can coexist with the single
visible `@onesa.eu` sender domain. Do not replace Zoho root MX, invent record
values, duplicate SPF records at one hostname or weaken existing DMARC policy.

Use separate send-only credentials for the intended product/environment where
supported, scoped to `onesa.eu`. Do not assume a key scoped to `mail.onesa.eu`
authorizes the parent domain. Domain scoping does not by itself enforce a
per-address restriction within that domain. Keys stay server-side in existing
secret custody, never frontend/public environment variables, Git or logs.

## Configuration contract

Portal worker:

```dotenv
MAIL_PROVIDER=resend
RESEND_API_KEY=<private-send-only-key>
MAIL_FROM=Onesa Portal <notifications-portal@onesa.eu>
MAIL_REPLY_TO=info@onesa.eu
```

AI API and its existing identity-mail worker:

```dotenv
ONESA_MAIL_PROVIDER=disabled
ONESA_RESEND_API_KEY=<private-ai-send-only-key>
ONESA_MAIL_FROM=Onesa AI <notifications-ai@onesa.eu>
ONESA_MAIL_REPLY_TO=info@onesa.eu
```

Keep AI delivery disabled until its sender, private delivery key, provider
credential and worker have been qualified. Setting the sender name alone must
not enable mail. Shared identity remains controlled by its existing feature flag;
this email policy neither enables native AI registration nor duplicates accounts.

Sender validation rejects control characters, malformed addresses and address
lists before transport use. Valid explicit values are preserved byte for byte.
An existing verified `mail.onesa.eu` sender remains accepted during migration;
the application never silently rewrites it to `onesa.eu`.

### Existing operations monitor

The Portal operations monitor can optionally choose a product sender for an
unambiguous production API incident in its existing Portal, AI or Robot targets.
Its existing private Portal environment accepts this JSON mapping:

```dotenv
OPERATIONS_MAIL_FROM_BY_PRODUCT={"portal":"Onesa Portal <notifications-portal@onesa.eu>","ai":"Onesa AI <notifications-ai@onesa.eu>","robot":"Onesa Robot <notifications-robot@onesa.eu>"}
```

The mapping is optional and may contain any subset of those three products. It
also recognizes `drone` for the separately accepted optional route below; that
sender entry alone does not activate a target.
An absent or empty value preserves the configured `MAIL_FROM`. Each entry must
contain one valid sender using `notifications-<product>@onesa.eu` or
`alerts-<product>@onesa.eu`; duplicate keys, unknown products, malformed JSON,
address lists and control characters are refused before sending. This contract
does not add monitoring targets, create a product mail worker or enable an
existing disabled monitor. Farmer and Factory are not monitor targets.

Mixed-product incidents, shared worker/scanner/database/backup failures, uncertain
product attribution and synthetic qualifications use the configured Portal
`MAIL_FROM`. Shared incidents retain that classification through their updates,
reminders and recovery. The existing staging exclusions, incident grouping,
cooldowns, recovery observations and approved notification recipients remain.

Before a real provider request, the monitor saves the exact serialized email body,
its SHA-256 digest, the event identity and a versioned fingerprint of the current
Resend credential in its private state. It does not store the credential or an
Authorization header. The state writer uses a private unique temporary file,
flushes and syncs it, atomically replaces the record and syncs its directory before
allowing delivery. A failed persistence step prevents the provider request.
A retry uses those saved bytes and the same idempotency key;
later sender, recipient, mapping or message-template changes cannot alter it.

Changing the sending credential, even within the same account, holds the pending
event for reconciliation. Missing or invalid envelopes, old pending events that
never recorded an envelope, an expired retry window and existing policy holds
also remain blocked. Current configuration must not be used to guess their old
request. Restoring an earlier credential does not clear a recorded reconciliation
hold. Preserve the pending event, original receipts and cooldown history while
reconciling provider acceptance; do not delete or recreate it to force a send.

Offline tests exercise request persistence and routing with a fake provider.
Actual installation, effective private configuration and delivery qualification
remain separate release steps; no mapping or feature is enabled by these source
changes.

### Optional Drone operations sender

The optional Drone production route uses `Onesa Drone <notifications-drone@onesa.eu>`
for an unambiguous Drone API incident. It is disabled by default and preserves the
original six Portal, AI and Robot slots. It uses the existing bounded, database-free
Drone liveness endpoint and requires the response to retain simulation mode.
It adds no customer mail feature, application account, flight capability or new
notification recipient. Mixed/shared events retain the Portal sender and existing
incident timing and durable request behavior.

Operator configuration is a selection, not acceptance. The private profile must
match an active commissioned Drone issuer and an existing signed accepted production
operation. A read-only consumer validates the required unrevoked record chain,
successful staging and operations observations, runner/source/policy pins, provider
receipt and accepted runtime snapshot. It then
checks the exact container, immutable image, source, full configuration fingerprint,
loopback port and simulation mode. Unsupported records, source-only CI artifacts,
missing runtime snapshots and invalid custody leave an explicit activation hold;
an invalid profile causes no Drone Docker observation or HTTPS probe. The consumer
does not read the signing key, invoke a release runner or issue acceptance.

Only the existing `shared-identity-v1` Drone backend record format is supported.
Older password-profile records and the new consolidated verification-only records
cannot activate this route. An existing accepted legacy source remains labelled
with its actual repository; it does not become a consolidated release by being read.
Installation, separate owner commissioning and real runtime qualification remain
required through the protected operations procedure. These source changes establish
no current Drone deployment or enabled route.

Pending Drone requests retain their exact bytes and acceptance binding. Revocation,
disabled enrollment, changed source/profile or ambiguous legacy state prevents
automatic retry without clearing the event or its receipts. A new accepted runtime
cannot silently recover an incident bound to a different accepted runtime. Valid
optional sender configuration does not change delivery for the original targets
when Drone is disabled. No production test email is part of the offline checks.

## Runtime migration and verification

### Observed setup on 2026-11-04

The root domain `onesa.eu` is now created in Resend's Ireland (`eu-west-1`)
region. Its exact provider-issued DKIM TXT record and the `rsend.onesa.eu` and
`send.onesa.eu` DNS-only CNAME records were saved and read back in Cloudflare.
Resend subsequently reported the domain as **Verified**, with DKIM and both
`rsend` and `send` records also **Verified**. Its domain event recorded completed
verification at 00:53 UTC. Sending is enabled; receiving through Resend remains
disabled so the existing Zoho inbox routing stays authoritative.

No test message was sent. No live runtime sender, sending credential or worker
configuration was changed. Existing mail domains remain in place while migration
and pending-delivery reconciliation are outstanding; the address policy above
does not claim that deployed workers have switched to the root domain.

### Worker cutover

Before changing a deployed sender or Reply-To, inspect the effective configuration
in its actual hosting environment and verify the new domain/key. Finish or
reconcile pending, leased/running and ambiguously accepted mail under its original
configuration. Resend binds idempotency to a request body; changing the sender
while retrying an old key can fail. Do not reset attempts, recreate jobs, delete
delivery evidence or remove the old domain merely to force retry success.

Change only the selected mail settings and retain unrelated values and secrets.
Deploy through the product's existing release process. Validate provider
acceptance, delivery/bounce state and actual inbox receipt separately using an
approved recipient. Fake transport tests do not send real email and do not prove
DNS verification or external delivery. No automatic email test sends are included
in these changes.

Render Free blocks the usual SMTP ports; its applications should use Resend's
HTTPS API. Configuring a staging host does not update an active Oracle worker.
Apply and verify the sender configuration in the environment of the worker that
actually sends mail.

## References

- [Resend sender addresses](https://resend.com/docs/knowledge-base/how-do-I-create-an-email-address-or-sender-in-resend)
- [Resend verified domains](https://resend.com/docs/dashboard/domains/introduction)
- [Resend sending records and existing MX](https://resend.com/docs/knowledge-base/how-do-i-avoid-conflicting-with-my-mx-records)
- [Render environment variables and deployment behavior](https://render.com/docs/configure-environment-variables)
- [Render Free networking limits](https://render.com/docs/free)

## Email presentation

New Portal, AI and operations messages use the Onesa email design: navy product
header, clear heading, readable content, blue action buttons, security-code panels,
plain-text alternatives, mobile layout and system dark-mode styles. Inline styling
and presentation tables provide a fallback when a mail client removes stylesheets.
No tracking pixels, remote fonts, remote images or new delivery integrations are
introduced. The Portal's existing owner artwork remains an inline CID attachment.
Only trusted account routes become buttons. All supplied text is escaped.

The immutable Portal `email-design-v1.ts` renderer is selected by `branded-v2` on
the first claim. Already selected `branded-v1` and attempted plain jobs retain their
original rendering. Operations envelopes version 2 contain both HTML and text;
version 1 remains readable and is retried using its original stored bytes. AI's
additive `20261104_email_presentation` migration admits distinct `queued_html_v1`
and `leased_html_v1` states. They preserve presentation across retries and keep
older plain-only workers from claiming new HTML attempts. Attempted legacy AI
jobs remain plain. Delivery stays disabled where it is already disabled.

The new AI source accepts the previous shared-identity schema for API observation,
but its mail worker requires the new constraint before processing fresh HTML jobs.
The source migration and backup tools explicitly recognize both schema versions;
rollback and restore receipts must match the exact selected schema. Commission the
new tool hashes through owner policy before rollout; installed tools and existing
receipts are not edited. Qualify the migration and drain or hold pending versioned mail before an older
binary is used for rollback; never rewrite an attempted request to another template.
Source and preview checks do not establish deployment or inbox delivery. Oracle and
Cloudflare provider-generated messages retain their provider-controlled appearance.
