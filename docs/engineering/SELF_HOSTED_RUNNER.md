# GitHub-hosted product checks and private local verification

Public product pull requests, required checks and release workflows use GitHub-hosted runners. Product repositories have no local runner registrations. A change in repository visibility follows the [GitHub Free procedure](../development/FREE_GITHUB_PLAN.md).

The dedicated local runner from October 2026 was removed. On 12 November the owner requested local GitHub runner configuration again. Provisioning and manual dispatch now belong to the separate, owner-only private [Onesa CI controller](https://github.com/DruHustle/onesa-local-ci). Its [setup and verification instructions](https://github.com/DruHustle/onesa-local-ci/blob/main/README.md) cover registration, health and shutdown on the owner's dedicated Ubuntu ARM64 guest.

The controller accepts the exact reviewed commit at the tip of public Portal main. When local verification is requested, its guest runs documentation and system appearance checks, then GitHub independently runs the same checks against that commit. A hosted-only dispatch records its narrower scope. A completed local verification requires a successful local job at the selected SHA and a matching hosted result. The controller grants no staging, production or hardware authorization.
