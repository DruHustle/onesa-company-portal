# Consolidated source protocol and regression reference

Maintenance home: the retained `DruHustle/onesa-company-portal` repository, under its existing engineering policy.

This directory preserves all 41 non-product files from `DruHustle/onesa-ug` commit `0341f51dfc6bf41ee84bedb0dbac4de40f2725b5`. It gives the canonical-source protocol, regression corpus, shared-policy history and coordination code a retained, reviewable home before the old repository can be removed. The original six product subtrees have their own retained homes and are not duplicated here.

## Current authority

The owner retained Company Portal, AI Platform, Robot and Drone as independent repositories. Smart Factory and Smart Logistics remain canonical. Only the five old split Factory/IMSOP repositories are retirement targets; `onesa-ug` is removed last after dependency migration. The original consolidation instructions in the referenced README and migration documents are historical and do not override this current scope or the maintained product policies.

All original file bytes and executable modes are recorded in `source-manifest.json`. Reference files receive only a `.txt` filename suffix; their contents are unchanged. They are outside active workflow directories and Python test discovery. These copies do not add another set of native product tests, activate an old dispatcher, or alter any repository ID, workflow identity, source pin or private-consumer trust decision.

## Regression maintenance

The retained corpus includes source-consumer, Docs materialization, Portal component/historical-journal, source provenance, workflow boundary and downloader regressions. Existing standalone product verification remains authoritative for current product changes. The `SourceFixture` class copied into AI, Robot and Drone is only one fixture from this larger corpus.

For an audit or compatibility investigation, restore the complete `onesa-ug.bundle` from the separately preserved monorepo archive into an isolated checkout and select the exact commit above. Verify this manifest's file hashes against that checkout. Follow the recorded root README and pinned `scripts/ci/requirements.lock` from that historical source before running its original tests. The old harness expects its complete historical product layout; running renamed reference files inside the Portal checkout is not a supported replacement. No live repository download or private production configuration is needed to recover the original fixture from the bundle.

When a regression remains relevant to a maintained standalone implementation, adapt it once in that implementation's existing suite, retaining its provenance and source-identity assertions. Do not create duplicate test runners or change immutable historic fixtures to make new source look like old evidence. Keep these recorded bytes intact; add a separately reviewed successor or disposition when a protocol is migrated.

## Remaining ownership and retirement gates

The Oracle capability-request producer, workflow and tests are useful retained sources. They remain bound to the original `onesa-ug` identity and its private-probe digest. No workflow runs were visible in the recorded API observation, but that does not establish that private consumers are absent. This reference copy does not migrate the dispatch channel. An active successor requires coordinated producer and trusted-consumer policy changes and independent acceptance; a repository-slug replacement is insufficient. Deletion stays blocked until that dependency is resolved or its retirement is explicitly established.

The original email-domain policy is retained here as dated history. Its maintained [shared-operations counterpart](../../shared-operations/EMAIL_DOMAIN_AND_SENDERS.md) belongs to Company Portal; provider/DNS observations must retain their dates, and current provider state must be read afresh. Historical software-readiness and repository-migration documents likewise remain evidence rather than current completion claims.

The full monorepo Git graph and GitHub metadata are preserved separately. JSON metadata and these reference files do not recreate original GitHub issue IDs, author identities, Actions runs or production qualification. Source preservation alone does not establish runtime readiness or authorize repository deletion.
