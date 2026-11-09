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

## Prepared common-account link

With shared Onesa identity enabled, an approved Engineering identity may be linked
explicitly to an already authenticated, email-verified central account. The user
chooses the link in the Docs sign-in page and proves the existing Docs password or
approved one-use email link. Both proofs must identify the same approved mailbox.
Matching email alone never creates a link, administrator role or approval. Existing
membership IDs, passwords, MFA and exact Cloudflare approvals are retained; a link
cannot be reassigned to a replacement account with the same email.

After linking, Docs uses the central session and existing Continue with Onesa action.
The retained Docs password cannot independently start a new session for that linked
identity. Unlinked identities retain the existing login during the transition.
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
