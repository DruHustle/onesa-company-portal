# Engineering Docs sign-in through Onesa Portal

<!-- onesa-protected-source: portal-engineering-identity -->

Detailed operational instructions are maintained in protected Engineering Docs.
This public source is a reference page, not a deployment or recovery runbook.

[Open the protected guide](https://docs.engineering.onesa.eu/docs/ecosystem/PORTAL_ENGINEERING_DOCS_IDENTITY).
Sign in through Onesa Portal with an individually approved engineering identity.

Public repository history may contain earlier editions; moving this active copy
does not erase historical exposure. Credentials, records and release evidence
belong in their existing restricted stores, never in this reference page.

Administrator sign-in checks enrollment after password or email-link proof. An
approved account without MFA is guided to authenticator setup; an enrolled account
uses its existing app or recovery code. Enrollment is never disclosed by an
email-only lookup. Accepted email-link requests show Sent and a 30-second resend
countdown. Existing approval, MFA, membership and one-use-link controls remain.
Source changes require separate qualified component releases.

## Shared Portal entry

Company administration and Engineering Docs start at the Onesa Account sign-in
and registration pages. Existing Engineering interaction links redirect to
`/account` with the initiating browser's validated interaction identifier. The
account page submits Docs decisions to the original interaction so the issuer
can finish its existing authorization-code and PKCE exchange. Existing emailed
proofs stay in the URL fragment until the browser reads them. Staff email-link
redemption still requires the enrolled authenticator or recovery code.

A signup can verify an Onesa account before the user requests a connected
product. Opening registration from company administration additionally starts
the existing owner-reviewed staff request.

## Link an existing Docs approval

With shared Onesa identity enabled, an approved Engineering identity may be linked
explicitly to an already authenticated, email-verified central account. The user
chooses the link in Onesa Account and proves the existing Docs password or
approved one-use email link. Both proofs must identify the same approved mailbox.
Matching email alone never creates a link, administrator role or approval. Existing
membership IDs, passwords, MFA and exact Cloudflare approvals are retained; a link
cannot be reassigned to a replacement account with the same email.

After linking, Docs uses the central session and existing Continue with Onesa action.
The retained Docs password cannot independently start a new session for that linked
identity. An unlinked member signs in to or creates their Onesa account, then
confirms their existing Docs approval. Previously mailed links can still be
opened and confirmed. While central identity is disabled, the account entry
retains the existing working sign-in methods for the requested destination.
An administrator still completes central MFA, and a forced fresh request uses new
central authentication. The fixed account return path preserves the current browser's
bounded Docs interaction; it never transfers OIDC state or cookies between browsers.

Central logout and credential/disable changes revoke linked Docs issuer artifacts.
Cloudflare Access sessions are separate, including an exchange already admitted
before central logout that finishes issuing its signed ID token. Their independent
sign-out/revocation or expiry remains required; no Portal response claims to clear
that cookie or retract an issued ID token. Current
exact membership and external-email policy checks remain in force. Disabling shared
identity does not silently reactivate the independent password for linked accounts.
Published Mobile migration 015 precedes Engineering account-link migration 016.
The migrations and these source changes require their own qualified release; no
live account, approval, credential, provider or policy change is claimed here.

A verified Onesa account holder opening Docs for the first
time can choose **Use my Onesa account for Docs** when access registration is
enabled. A new membership can be linked immediately only for an individually
preapproved eligible address with recorded owner policy evidence. Other new
addresses enter the existing owner review queue. Migration 019 records the
verified account ID that initiated a new pending request. On approval, the
owner's fresh-MFA action rechecks that identity and the eligible mailbox before
linking the new membership. The member can continue the original browser
interaction using their Onesa session. Existing unbound requests and old
memberships still require explicit ownership proof. Apply migration 019 before
rolling out the matching API.
Existing, disabled, previously rejected and conflicting identities stay in their
existing review or recovery paths. The Cloudflare Access policy must allow the
individual email address at the protected Docs hostname.
