# Contributing

Engineering and security policies live in [AGENTS.md](AGENTS.md). Current verified protection and exact required checks are in [the branch protection report](docs/development/BRANCH_PROTECTION_REPORT.md). **Main protection is currently blocked by GitHub plan eligibility, not enforced.** Follow the PR workflow voluntarily until activation.

1. Inspect the current branch and staged/unstaged work. Preserve existing changes; use a separate checkout when unrelated work would contaminate a PR. Do not initialize Git in the workspace parent.
2. Start `feature/description`, `fix/description` or `security/description` from reviewed current main. Keep each repository and release independent.
3. Implement focused changes, update contracts/operational documentation when affected and run relevant commands in [BUILD_AND_TEST.md](docs/engineering/BUILD_AND_TEST.md), plus repository hygiene.
4. Inspect diffs and stage only reviewed paths; never include private data/secrets. Commit the reviewed changes. Push the feature branch only when authorized and open a PR describing validation and release/rollback impact.
5. Inspect GitHub CI, fix failures with follow-up commits, resolve conversations and synchronize against main. Required CI includes existing security gates; never remove failures to obtain a merge. Do not use skip-CI directives.
6. While the authenticated team has only one developer, zero independent approvals are intended; PRs and all real checks remain mandatory in the prepared protection policy. Add one independent approval and verified security/infrastructure code owners when authorized reviewers join. The author cannot independently approve their own PR.
7. Merge through GitHub only with corresponding authorization and satisfied policy. Production deployment requires separate authorization and exact-revision release qualification. Feature/PR previews and isolated staging are separate from main production promotion.

No direct main pushes, main force pushes, deletion, administrator development bypass, automatic merges or automatic production releases. Keep secrets scoped to trusted deployment workflows/environments. [Recovery and activation](docs/development/branch-protection/ACTIVATION.md) are administrator operations with recorded evidence.

The selected policy is [GitHub Free with private repositories](docs/development/FREE_GITHUB_PLAN.md). PR and check discipline is voluntary until server protection is supported; no upgrade or visibility change is proposed.
