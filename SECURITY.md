# Security policy

Supported software: the latest reviewed revision of `main`; no historical release
support promise is made before a release/support policy is approved.

Report vulnerabilities privately through GitHub's private vulnerability reporting
if enabled, or an organization owner using an existing private channel. Do not file
credentials, customer records, exploitation details or personal data in public issues.
A dedicated security contact and response targets must be assigned before production.

Do not store API credentials, production environment files, private corporate records,
model weights, database dumps or user uploads in Git or CI artifacts. Use a secret
manager and access-controlled storage. Separate frontend public configuration from
backend secrets. Local `.env` files must remain ignored; examples contain placeholders.
Use least-privilege database/service identities and protected production environments.

If a credential was committed, revoke/rotate it first, assess access and logs, and
notify the security owner privately. Ignoring or untracking a file does not remove
it from history. Remove it from future commits only after reviewing staged work;
historical removal requires a separately approved, coordinated remediation plan.
Never automatically rewrite history or force-push. Confidential documents already
in history block publication until an owner approves an appropriate remediation.

`python3 scripts/repository_hygiene.py --history` scans available reachable history,
staged content and publishable working files without printing matched values.
This heuristic cannot prove absence of secrets or confidential prose. Enable GitHub
secret scanning/push protection where the organization plan supports it, and conduct
human data-classification review before publishing or uploading CI artifacts.
