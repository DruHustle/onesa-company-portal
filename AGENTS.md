# Onesa engineering and agent policies

This is the single policy file for `onesa-company-portal`, including Codex/agent instructions,
contribution rules, security reporting and repository governance. Keep policies here;
do not recreate separate setup, implementation-status or session-handoff documents.
Read the README, current roadmap/release checklist, relevant architecture and existing
code before editing. Continue incomplete work; do not restart implemented features.
Update the changelog, contracts and affected operational documentation when behavior
changes. Record unverified functionality honestly in the applicable release checklist
or roadmap. Explicit user instructions and previously authorized scope take precedence.
Preserve local modifications, history and data; stage only reviewed paths.
Use free services only; do not provision paid resources or accept paid upgrades
without explicit budget authorization.

## Contribution rules

This repository is independently maintained within `onesa-ug`. Keep its frontend and
backend in their existing subdirectories. Do not initialize a workspace-level Git
repository, add sibling projects as submodules, or couple their release cycles.

Create a feature branch from `main`, make focused changes, and open a pull request.
Preserve work already staged or modified locally. The verified team currently has one
developer: require PRs and automated checks, with zero independent approvals until
an authorized reviewer exists. Then require one independent review; seek two for
authentication, personal data, infrastructure or robot actuation when available.
Describe the problem, resulting behavior, validation and deployment/rollback impact.
Update API contracts, migrations and documentation with behavior changes.

Run the commands in `docs/engineering/BUILD_AND_TEST.md` and
`python3 scripts/repository_hygiene.py` before staging. Inspect `git diff --cached`
and `git status --short`. Never stage private records, uploads, dumps, models or secrets.
Use synthetic fixtures; a private repository is not a secret store. Keep environment
examples as placeholders. New dependencies need provenance and license review.
Do not introduce a project license until ownership and licensing are approved.

Application builds and releases are independent. Changes to a shared contract must
remain compatible during separate rollouts. Production promotion, remote pushes and
visibility changes require explicit authorization. See `AGENTS.md` and
`docs/engineering/DEPLOYMENT.md`. Actual protection status and activation prerequisites are recorded in
`docs/development/BRANCH_PROTECTION_REPORT.md`; currently BLOCKED, NOT ENFORCED.

## Security policy

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

## Repository governance

### Visibility and access

Recommend **private** for this repository while ownership, security and data review
are incomplete. Keep the company portal private even when its approved website is
public. Keep AI intellectual property, training provenance and robot control software
private until owners approve any public release. Assign least-privilege team access;
require organization 2FA and a named security/release owner. Do not change visibility
as part of local setup. Private GitHub storage does not authorize uploading records.

### Protect main

The authenticated repositories are private and personally owned by DruHustle. GitHub
rejected ruleset creation and classic branch protection with its Pro-plan requirement;
main remains unprotected. Never claim local configuration enforces remote rules.
See `docs/development/BRANCH_PROTECTION_REPORT.md` for verified evidence, exact CI
contexts and deployment limitations, and `CONTRIBUTING.md` for the Codex PR workflow.

The prepared main policy blocks force pushes/deletion, requires PRs, resolved
conversations and all observed CI/security checks from GitHub Actions, with strict
up-to-date checks and no bypass actors. Zero independent approvals keeps the verified
solo-developer workflow usable. Raise this to one and last-push approval when a real
reviewer is authorized; add CODEOWNERS only after ownership/permissions are verified.
Do not drop failing security checks, invent required jobs or enable a merge queue
without compatible workflows. Emergency recovery is an audited temporary policy edit
by an authorized administrator, never routine Codex bypass. Billing, visibility,
credentials, merging and production promotion need their corresponding authorization.
Production environments/integrations and preview secrets require separate verified
controls; current branch protection cannot establish deployment security.

Sources: [GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
[secret scanning availability](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/detect-secret-leaks/enable-secret-scanning),
[GitHub CLI repository creation](https://cli.github.com/manual/gh_repo_create).


## Selected GitHub Free policy

The owner selected GitHub Free. Follow `docs/development/FREE_GITHUB_PLAN.md`; do
not upgrade billing, change visibility or transfer ownership. Prepared protection
payloads are reference only while eligibility is blocked. Use voluntary feature-branch
PRs and verified CI with least practical write access; never claim server enforcement.
