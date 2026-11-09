# Onesa UG

Onesa UG contains the public software for the Company Portal, AI Platform, Robot,
Drone and Mobile. Each product keeps its own application, configuration, dependency
locks, tests, container builds, and release policy.

| Folder | Project | Development instructions |
| --- | --- | --- |
| `onesa-company-portal` | Company Portal and shared identity | [Build and test](onesa-company-portal/docs/engineering/BUILD_AND_TEST.md) |
| `onesa-ai-platform` | AI Platform | [Product README](onesa-ai-platform/README.md) |
| `onesa-robot` | Robot | [Build and test](onesa-robot/docs/engineering/BUILD_AND_TEST.md) |
| `onesa-drone` | Drone | [Local development](onesa-drone/docs/engineering/local-development.md) |
| `onesa-mobile` | Mobile telephony product: public website, customer and internal operations previews, native apps and API | [Product README](onesa-mobile/README.md) |
| `onesa-billing` | Separate company billing service and protected Portal billing module | [Billing development and configuration](onesa-billing/README.md) |

## Verification

The root `Onesa verification` workflow aggregates the four imported product
suites and the separate company billing suite. It runs on pull requests and pushes to `dev`, `staging`, and `main`, on a
weekly schedule, and by manual dispatch. Pushes, scheduled runs, and manual runs
execute all five suites. Pull requests may
select affected components; repository controls, shared identity, contract changes,
and ambiguous Git evidence select all products. Every selected product runs its
complete existing verification, including its browser, database, container,
security, and release-contract tests.

Company billing verifies its own PostgreSQL role and operation boundaries, provider
adapters, usage outbox, web client and actual synthetic Chromium journey. It is a
verification component, not an imported product or a new release authority. Its
sales, automatic Tax and Portal bridge stay disabled by default; passing CI does
not activate provider configuration or deploy the API and worker.

Mobile retains its independent **Onesa Mobile qualification** and **Onesa Mobile
native compilation** workflows with their existing product path filters and
checks. Their source definitions live in `onesa-mobile/scripts/ci/workflows/`;
the root generator preserves their complete jobs and adds the same hosted-runner,
repository-visibility and included-allowance guard. Native Android and iOS
compiler jobs remain separate from JavaScript bundle verification and the
four-product aggregate.

The independent publication gate also retains the original Portal/Robot
documentation checks and scans all products' preserved source history plus root
paths. This gate runs for every event, including pull requests that select only
one product's application tests.

Locked review tools allow at most three transient GET attempts within one
90-second total download budget. Certificate, archive and checksum failures
remain terminal; every installed binary must match its recorded digest.

The required aggregate result is **Onesa required verification**. It fails when
any selected product or repository gate fails, is cancelled, is missing, or is
unexpectedly skipped. Configure this check in branch protection after its first
successful hosted run. The workflow uses read permissions and synthetic fixtures;
it does not deploy services or grant hardware or release authorization.

Root workflow files are generated from the reviewed product verification
workflows. To verify a workflow edit locally:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install --require-hashes --no-deps -r scripts/ci/requirements.lock
.venv/bin/python scripts/ci/generate_workflows.py
.venv/bin/python scripts/ci/generate_workflows.py --check
.venv/bin/python -m unittest discover -s scripts/ci -p 'test_*.py'
.venv/bin/python scripts/repository_hygiene.py
```

Run application tests and builds from the relevant product directory using its
instructions and locked dependencies. Product publication checks require the
explicit consolidated boundary, for example:

```sh
cd onesa-drone
python3 scripts/repository_hygiene.py --monorepo-root .. --history
```

This preserves the standalone scanners' refusal to scan an arbitrary ancestor
repository. The root scanner checks both staged blobs and publishable working
files, with each product's restrictions and all product restrictions for root
files. Passing a software check establishes only the behavior that check covers.
Hardware qualification still requires the product's reviewed physical safety,
operator, device, and integration evidence.

## Fixed Oracle capability request

The separate `Oracle capability request` workflow publishes a small request for
one reviewed read-only capability probe. It has no inputs, runs only on a fresh
owner dispatch from `dev`, `staging`, or `main`, and uses no VM or provider
credentials. It does not execute the probe or contact Oracle. Its artifact binds
the repository ID, exact workflow/source revision, run, actors, and fixed probe
SHA256. Requests expire after 15 minutes; a rerun cannot renew one. Publication
does not grant deployment or release authority and does not qualify the source.

The operation refers to a reviewed probe retained in private custody. Only its
version and digest are published here; its target binding and executable bytes
stay outside public Git and CI artifacts. Target IDs, commands, credentials, and
operational evidence cannot be supplied as request inputs or added to the JSON
schema.

To inspect a downloaded request locally, run:

```sh
python3 scripts/ci/oracle_request.py --validate /path/to/oracle-capability-request.json
```

This checks only the bounded schema, fixed scope, and expiry. It does not
authenticate GitHub provenance. A separately commissioned consumer must verify
the real workflow/run and artifact bytes before running its own pinned probe.
There is currently no request consumer, OCI credential, VM execution, or
deployment activation supplied by this workflow. Existing source and release
qualification gates remain unchanged. Register and verify the workflow through
the normal branch integration before claiming it is available to dispatch.

## Domains and migration

[Email domain conventions](docs/email-domain.md) define the shared `onesa.eu`
sender addresses and the remaining provider/DNS requirements. Secrets, mailbox
data, deployment evidence, and corporate records belong in their approved private
locations, outside this public repository.

[Repository migration](docs/repository-migration.md) describes the imported
history, workflow generation, source provenance, and prerequisites for retiring
the old repositories. Existing deployments and release consumers must be migrated
and qualified before their source repositories are removed. Legacy deployment
workflows remain historical inputs inside product folders; no root deployment
workflow is enabled by this consolidation.
The existing product repositories remain authoritative for release and deployment while the unified repository's workflows and security controls are qualified. The folders include the reviewed main-branch sources and retain their original Git ancestry.

Onesa Mobile is developed directly in [`onesa-mobile/`](onesa-mobile/README.md). Its root-level workflow qualifies the development foundation only; it does not deploy or activate a telecommunications service.
