# GitHub organization setup

Repository: https://github.com/onesa-ug/onesa-company-portal
Local branch: `main`. Frontend and backend share this repository's history but build
and deploy separately. No parent workspace repository is required.

## Visibility and access

Recommend **private** for this repository while ownership, security and data review
are incomplete. Keep the company portal private even when its approved website is
public. Keep AI intellectual property, training provenance and robot control software
private until owners approve any public release. Assign least-privilege team access;
require organization 2FA and a named security/release owner. Do not change visibility
as part of local setup. Private GitHub storage does not authorize uploading records.

## Protect main

After the first approved push, target `main` with a ruleset: pull requests, one
independent approval (two for sensitive changes), dismiss stale approvals, resolved
review conversations and passing checks. Block force pushes and deletion. Restrict
bypass rights to audited emergency owners. Require reviews of workflow/infra/security
changes; assign real CODEOWNERS teams once membership is confirmed. Keep signed
commits as an organization policy decision. Select actual status checks after their
first execution; do not require nonexistent jobs. Avoid path-filtered required
checks that may remain pending. Protect release tags and the `production` environment
with reviewers and prevent self-approval. Availability depends on the GitHub plan.

Required checks: `publication-hygiene`, plus the application checks listed in
`docs/engineering/BUILD_AND_TEST.md`. Do not promote an artifact built from a different
revision or use secrets in untrusted fork pull requests. Image release workflows package candidates. Cloud deployments use the independently
selectable GitHub workflow documented in `docs/engineering/VERCEL_RENDER.md`.

Sources: [GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
[secret scanning availability](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/detect-secret-leaks/enable-secret-scanning),
[GitHub CLI repository creation](https://cli.github.com/manual/gh_repo_create).

## Exact setup commands if an empty remote is missing

Run from this project directory, only after authorization to create the online repo:

```sh
gh auth login --hostname github.com
gh repo view onesa-ug/onesa-company-portal
# If confirmed absent; creates an empty private repo and does not push:
gh repo create onesa-ug/onesa-company-portal --private
# If origin is absent; preserve any existing remote instead of replacing it:
git remote add origin https://github.com/onesa-ug/onesa-company-portal.git
git remote -v
```

Do not initialize another Git repository here if `.git` already exists. Preserve
existing branches/history. No `--push`, initial README, license, or remote commit
is used during empty repository creation.

## Publication checklist (not authorization)

Review all existing staged work, run
build/test and full-history hygiene checks, classify source and documents, rotate
any exposed credentials, and obtain ownership approval. `.gitignore` does not remove
tracked content or historical blobs. Never blindly run `git add .` during cleanup.
After explicit authorization, stage reviewed paths individually, review the staged
diff, create the reviewed commit, and run `git push -u origin main` (no force flag).
Set GitHub's default branch to `main` and protections after it exists remotely.


## Current ownership audit — 2026-10-09

GitHub REST returns `DruHustle/onesa-company-portal` with owner type User; the intended onesa-ug remote redirects. Do not assume organization ownership from a configured URL. Verify/create the intended organization, explicitly approve an ownership transfer preserving history/private visibility, and revalidate provider installations/service bindings. Current production release is NO-GO. No transfer or remote edit was performed.
