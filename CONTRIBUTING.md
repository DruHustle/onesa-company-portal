# Contributing to Onesa UG

This repository is independently maintained within `onesa-ug`. Keep its frontend and
backend in their existing subdirectories. Do not initialize a workspace-level Git
repository, add sibling projects as submodules, or couple their release cycles.

Create a feature branch from `main`, make focused changes, and open a pull request.
Preserve work already staged or modified locally. Require one independent review;
use two reviews for authentication, personal data, infrastructure or robot actuation.
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
visibility changes require explicit authorization. See `GITHUB_SETUP.md` and
`docs/engineering/DEPLOYMENT.md`. Branch protections are recommendations until configured.
