# Onesa Account architecture

## Independent Identity pilot

The Portal issuer described below is the pre-migration baseline. During the pilot, the Identity service owns user administration. Portal owns its CMS, settings, business records and /admin. Public Developer Docs at docs.onesa.eu and private Engineering Documents at docs.engineering.onesa.eu have separate catalog entries and access policies.

Set ONESA_IDENTITY_ADMINISTRATION=external on a paired candidate Portal API and frontend after the Identity administrator has verified the destination and imported approvals. Configure ONESA_IDENTITY_UI_ORIGIN on the frontend with the environment-specific HTTPS origin serving the Identity UI. The frontend sends legacy user-administration bookmarks to its /admin path and registration to /register. Browser fragments and search inputs stay local. The API refuses its legacy directory and access-decision routes in this mode. Portal roles retain local content permissions. Product access is limited to explicit grants. The cutover flag is independent of provider login. Enable it in production once migrated operators and customer self-service pass in staging.

The optional managed Portal login uses Authorization Code with S256 PKCE and an independent confidential client. Apply migration 020 and reapply the normal restricted runtime-role grants before starting the compatible API. Set ONESA_IDENTITY_PORTAL_LOGIN=managed in both deployments. The frontend and backend require the same ONESA_IDENTITY_ISSUER. The API additionally needs ONESA_IDENTITY_PORTAL_CLIENT_ID, ONESA_IDENTITY_PORTAL_CLIENT_SECRET and ONESA_IDENTITY_PORTAL_AUDIENCE. Register the exact callback at the Portal origin /api/v1/auth/managed/callback. Give the client its own resource identifier and enable the reviewed provider policy and MFA Actions in that environment.

The callback verifies both token signatures with RS256, nonce, state, issuer, its own audience and the same subject. It resolves the signed stable Onesa user ID to an existing enabled Portal record and checks the provider's Portal-specific role against the local role. Only Identity's verified mapping may supply that UUID. A Portal session is bounded by the remaining signed grant, the original factor lifetime and a five-minute maximum. The API can serve an existing grant during issuer downtime and after an API restart. A cookie rotation cannot extend its deadline. Failed exchanges preserve the local Portal bookmark for retry. New authorization and sensitive actions requiring fresh provider MFA remain unavailable during an outage. Provider step-up for protected governance actions must complete qualification before activation for operators needing those actions.

Before returning approvals to the legacy database, reconcile all Identity changes since cutover, including suspensions, revocations, new accounts and grants. Verify the result against the current Identity audit history. Switching the flag restores routing only. Operators must synchronize the current account data separately.

Onesa Account is the human identity service for Company Portal, AI Platform,
Robot, Smart Farmer, Drone, Smart Logistics, Onesa Mobile, Smart Factory and
PasoFi. The shared sign-in page is `https://portal.onesa.eu/account`. The
protocol issuer remains `https://portal.onesa.eu/api/v1/identity`, keeping
the existing issuer and user identifiers stable. This describes the target
architecture and release criteria. Product source and production can be at
different revisions.

## Ownership

| Component | Responsibility |
| --- | --- |
| Portal identity service | Register and verify accounts, check passwords and one-use emailed proofs, enforce MFA, recover accounts, maintain central sessions and record product approvals. |
| Portal account page | Present the same two sign-in methods for customers and staff. Resume the initiating product, show the user's approved applications on direct entry, and offer registration and recovery. |
| Product backend | Start its own authorization request, bind the callback to the initiating browser, validate the central grant, and create a product-scoped session. Enforce tenant, record, action and freshness policies at the API. |
| Product frontend and native app | Open the product's sign-in flow and restore the intended screen. Report expired access or service unavailability and allow retry from that screen. |
| Engineering Docs and Cloudflare Access | Retain the existing Docs membership subject and Access policy. The Docs adapter accepts central proof for a linked member and completes the existing Access callback. |

Keep identity as one logical service inside the existing Portal backend.
Registration, access and recovery already share its account store and audit
trail. A later independent deployment can route the same issuer and account
URLs to that service without changing any product's identity keys. Products
hold their own sessions and data. Each environment has a distinct client
configuration, callback allowlist and signing material.

## Web and mobile journeys

1. A product stores the intended local destination against its initiating
   session and starts OpenID Connect authorization code flow with S256 PKCE,
   unpredictable state, a nonce and its registered callback. Each of the eight
   products has its own confidential backend client. Client secrets stay on
   that backend.
2. Onesa Account can continue an active central session. A signed-out visitor
   enters their password or explicitly confirms a time-limited emailed proof.
   Privileged accounts and sensitive actions use the existing MFA and freshness
   policies. Registering proves control of the mailbox. Product access and
   staff approval are separate decisions.
3. The product backend verifies state, nonce, issuer, audience, signature and
   expiry, exchanges the single-use code, and obtains a live, client-bound
   assertion. It resolves the stable issuer and subject to the existing local
   account before allowing access to a tenant or record.
4. On iOS and Android, open the system browser and use the registered app
   return. A backend-brokered client returns a short-lived one-use handoff
   bound to the originating app transaction. Use an app-claimed HTTPS callback
   where supported. If a native binary is registered as a direct client, it is
   a public client with its own registered redirect and PKCE verifier. Keep
   passwords, reusable tokens and client secrets out of deep links.
5. Opening an email in another browser can verify account ownership. Product
   authorization resumes in its originating browser. If its interaction has
   expired, sign-in starts again from the product screen.

An ordinary member entering through a staff bookmark can sign in and use their
account. Only approved staff can enter the administrative workspace. Old
Portal and Engineering entry URLs direct the browser to the shared form.
Protocol action paths and narrowly scoped interaction cookies still complete
their original transaction. Public Docs remain public.

## Existing records and access changes

Use the stable pair of issuer and subject as the identity key. Link an existing
local identity using authenticated proof of both accounts or an operator-reviewed
mapping with recorded ownership evidence. Preserve its original local user ID
and foreign keys. An email match is insufficient. For Smart Farmer this includes
historic farms, sole-owner access, authorship and device-bound offline data.
A new farm invitation alone cannot restore the original identity.

Central account disablement and product revocation must invalidate the relevant
grant. Each product checks the authenticated issuer session endpoint under its
own client identity and enforces current tenant or workspace access. Recheck
before privileged work and fail closed if current authorization cannot be
established. An ID token records an authentication event and has a finite
lifetime. It cannot establish ongoing access to a farm, shipment or machine.
Report the separately measured lifetime or invalidation of every external
session, especially Cloudflare Access and native offline access.

A PasoFi Wi-Fi voucher, router credential, payment webhook, factory agent or
hardware interlock has its own scope and lifecycle. Human sign-in identifies
the person using a product. Product or device controls still decide whether a
purchase, connection, dispatch or physical action can proceed.

## Rollout and verification

Deploy the compatible account page first. Release the issuer, mail worker
and verified per-environment callback configuration through their qualified
paths. Migrate one product and client type at a time, preserving previous
successful builds and the existing issuer, subjects and sessions. Enable a
new client only after the following checks pass on its exact branded origin
and deployed build. Each product owner records the revision and results.

- Start signed out and with an active Portal session. Test a new approved
  ordinary member, an existing member with historical records, and an MFA
  administrator. Verify their original destination and record ownership.
- Use a controlled temporary inbox to complete registration, password
  sign-in and emailed sign-in. Exercise expiry, recovery, cancellation and
  one-use replay. Correlate failures across request, queue, worker and
  provider delivery without recording credentials or proof URLs.
- Revoke just one membership, then disable the test account. Check existing
  web and native sessions, the next protected API request, other products,
  and the advertised behavior during an identity-service interruption.
- For Engineering Docs, compare the linked membership, returned subject,
  Access policy and sign-out behavior. Retire the legacy adapter only after an
  approved Cloudflare cutover preserves these independently measured outcomes.
- For native apps, validate clean install and upgrade on signed iOS and Android
  builds. Verify a cold app start from the callback and return to the exact
  record. A desktop browser result qualifies only the web flow.

The identity service owner operates sign-in, signing keys, worker delivery and
issuer availability. Each product owner operates its callback, session and
record mapping. Release decisions use receipts from both sides.

[OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html) ·
[OAuth Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700) ·
[OAuth for Native Apps](https://www.rfc-editor.org/rfc/rfc8252)
