# Oracle staging worker and private scanner

Use the existing owner-provisioned `onesa-portal-worker`. Provisioning and SSH
configuration are documented in [DEPLOYMENT](DEPLOYMENT.md); do not create another VM
or resize any resource as part of runtime deployment. Private inventory and SSH
receipts stay outside Git. The current target is Ubuntu 24.04 ARM64, 1 OCPU, 6 GB RAM
and a 50 GB boot volume in Frankfurt. Runtime installation is separate from release
qualification: Docker being available does not prove a working Portal worker.

## Reusable owner SSH connection

The authorized owner's local `~/.ssh/config` defines `onesa-portal-worker` and the
existing VM IP using the retained private key and pinned known-hosts record. It uses
`ControlMaster auto`, an owner-only control directory and `ControlPersist 8h` to reuse
one authenticated transport across terminal sessions. Thirty-second keepalives detect
a disconnected transport; subsequent connections authenticate using the existing key.
Password authentication and agent forwarding are disabled. These are local client
settings; they do not change the VM firewall, Oracle Console sessions or OCI CLI MFA.

```sh
ssh onesa-portal-worker
ssh -O check onesa-portal-worker
ssh -MNf onesa-portal-worker    # start a background transport if none is running
ssh -O exit onesa-portal-worker # close it after finishing active sessions
```

The IP entry also lets the existing pinned deployment scripts reuse this connection.
Keep `~/.ssh/config` at mode `0600` and `~/.ssh/onesa-control` at mode `0700`.
No application port forwarding is configured. ClamAV continues to use its private
Unix socket; databases, queues and worker endpoints remain unexposed.

## Artifact and resource limits

`compose.oracle-staging.yaml` runs only the existing Portal background executor and
ClamAV. It creates no database, API or frontend. The worker consumes the existing
staging database, encrypted job payloads and private object bucket. Production worker
startup rejects a missing shared bucket or an unsafe database application role.
Do not bind this runtime to a production database or copy production credentials.

The pinned Alpine 3.24.2 ARM64 scanner image installs signed ClamAV 1.4.6-r0
distribution packages (daemon, clamdscan, Freshclam and retained documentation);
the reviewed official `stable_base` image was AMD64 only. Alpine
[package provenance](https://pkgs.alpinelinux.org/package/v3.24/community/aarch64/clamav)
and [release support](https://alpinelinux.org/releases/) are independently verifiable. Preserve the image digest,
package provenance and licenses, and run vulnerability checks on every built image.
The scanner uses one scan thread, a 4 GB memory limit and 0.8 CPU; the worker has
768 MB and 0.2 CPU. These limits leave memory for the host and avoid assigning more
CPU quota than this VM provides. Actual signature loading, latency, queue throughput,
CPU throttling and memory use must pass hosted qualification before suitability is
confirmed. Do not add swap or resize the VM to conceal an unmet capacity requirement.

ClamAV runs as `clamav`, with no added capabilities. Its Unix socket is mode 660,
group 3000, on a Docker volume shared with the worker. Scanner health also requires daily signature files updated within 48 hours and writes
a group-readable, atomic readiness timestamp. The Unix-socket adapter leaves uploads
quarantined when that timestamp is absent, invalid or older than 90 seconds. Freshclam
notifies clamd to reload after updates. No TCP socket, published port,
public scanning endpoint, container engine API or internal job HTTP listener is used.
Keep SSH restricted to the approved administrator `/32`. Outbound HTTPS is needed
for staging database/object/mail services and signature updates. Review the OCI
security list/NSG and host listeners independently; no broad inbound rule is required.

## Owner configuration

Create `/etc/onesa/portal-staging.env` through the approved private SSH session using
`sudoedit`. Its containing directory must be root-owned mode 700 and the file mode
600. Do not paste, commit, echo or include its contents in evidence. Supported names:

| Name | Source and requirement |
| --- | --- |
| `DATABASE_URL` | Existing Portal **staging** restricted application connection, with verified TLS; preserve its role and database. |
| `PUBLIC_ORIGIN` | Exact approved Portal staging Preview HTTPS origin. |
| `SESSION_KEY` | Same staging encryption key as the API, so encrypted queued mail can be read. |
| `PROXY_SHARED_KEY` | Existing staging-only proxy key; required by production-mode configuration. |
| `S3_BUCKET` | Existing private staging bucket. Shared object storage is mandatory for this remote executor. |
| `S3_ENDPOINT` | Existing staging HTTPS object endpoint, when custom; `AWS_ENDPOINT_URL_S3` is the implemented alias. |
| `S3_REGION` | Existing bucket region; `AWS_REGION` is the implemented alias. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Private staging object identity with only required bucket operations. No public bucket access. |
| `AWS_SESSION_TOKEN` | Optional, only for an actual temporary AWS credential session. |
| `MAIL_PROVIDER` | Existing approved `smtp` or `resend` profile. |
| `RESEND_API_KEY` | Required only for Resend; staging-scoped owner configuration. |
| `MAIL_FROM` | Required for enabled mail; actual verified sender. |
| `NOTIFY_EMAIL` | Approved synthetic staging notification recipient, when notifications are tested. |
| `MAIL_REPLY_TO` | Optional valid reply address. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | Required according to the actual SMTP provider if selected; omit for Resend. |
| `COMPANY_ORIGIN` | Optional separate company origin, if actually configured in the staging API. |

The `jobs` Compose profile is disabled by default, allowing scanner-only validation
without application credentials. Missing worker configuration is never a successful
startup. Compose supplies `NODE_ENV=production`, `PUBLISH_ENABLED=false` and
`CLAMAV_SOCKET=/run/onesa-scanner/clamd.sock`. Leave `CLAMAV_HOST` and `CLAMAV_PORT` unset; the Unix socket has no TCP port.
Do not expose the scanner at this public IP. The Render API keeps its initial uploads quarantined; the worker retrieves them
privately and updates scan status only after the existing bounded scanner protocol
returns an explicit result. Do not enable publication or manually mark uploads clean.

## Production binding inspection

Production preparation uses `scripts/oracle_production.py --commit <qualified-staging-SHA>`
with the owner's private `RENDER_API_KEY` process environment. It accepts only the
existing production API `srv-db4j1igm7kps73c13s4g`, production database endpoint and
production branch object endpoint. It refuses owner database logins, unverified TLS,
staging credential collisions and incomplete provider inventories. It installs only
the supported inventory above into `/etc/onesa/portal-production.env`, root-owned
mode `0600`, preserving an existing file rather than silently overwriting it. No
credential value is displayed, committed or put in an SSH command argument.

If the API has no usable mail profile but the retained production Render worker has
one, `--reuse-production-mail` reuses that worker's existing Resend identity in the
Oracle file. It validates the exact production worker and refuses staging token
reuse. Only a file matching the previously inspected production configuration can
be atomically extended with those supported mail fields. Unrelated configuration,
existing configured API mail credentials and all Render settings remain preserved.

The production Compose artifact is `compose.oracle-production.yaml`. It requires an
exact qualified `PORTAL_WORKER_IMAGE`, the separate production environment file and
`PORTAL_SCANNER_SOCKET_VOLUME`. On the current VM the already qualified scanner's
socket volume is `onesa-portal-oracle-staging_scanner_socket`. Reusing this private
scanner avoids a second 4 GB signature database on the 6 GB VM. Scanning is transient;
each worker retains its own database, object credentials and egress network. The
scanner socket is read-only to both workers and has no host TCP binding. Production
has a 512 MB/0.1 CPU limit; measure combined consumption before long-running use.

Preparation verifies the production schema/role and authenticated bucket metadata
using a bounded, one-shot process. It does **not** enable the jobs profile, submit
jobs, grant publication approval or qualify the complete production release.
Record real synthetic production scan/quarantine, job/retry, restart, mail delivery,
backup/restore and monitoring results separately. Preserve the existing Render
production worker until its Oracle replacement passes the actual release gates.
Never create a second scanner or delete shared database/bucket resources as cleanup.

`scripts/oracle_production.py --action qualify --commit <qualified-staging-SHA>`
then exercises the real ARM64 executor and private production bucket with disposable
synthetic UUIDs only. It refuses an existing business dataset, disables email delivery
inside the test process, verifies anonymous/quarantine/rejected download denial,
clean download integrity, EICAR detection, scanner failure containment, deduplication,
actual queue execution and bounded retries. The storage retry test injects a runtime
transport failure; it does not claim a hosted provider outage. Cleanup removes only
run-owned records/objects. The private receipt explicitly retains remaining mail,
backup/restore, rollback, monitoring and long-running restart/capacity checks. A
successful bounded qualification is never full production acceptance or permission
to process real applicant documents.

`--action recover` then starts one disposable, two-minute recovery probe with the
production environment. It refuses business rows before each executor tick, verifies
the process's own health, restarts that container, verifies fresh health, measures a
resource sample and checks graceful shutdown/OOM state before removing it. It checks
Docker boot activation and the restart policy; it does not reboot the shared VM or
claim sustained production capacity. No permanent production service is enabled.

`--action mail` sends exactly one synthetic qualification notification to the
approved company inbox `info@onesa.eu` through the real encrypted queue and existing
production Resend profile. It observes provider acceptance from that Oracle process,
checks an accepted job is not repeated and removes its own queue row. The application
credential may be sending-only: HTTP 401/403 when querying the delivery receipt is
not evidence that the accepted send failed. Record provider acceptance separately
from inbox delivery; confirm the actual delivery event or owner inbox receipt before
marking delivery verified. Repeating this command creates a new test notification.

`scripts/oracle_production_backup.py --commit <qualified-staging-SHA>` rehearses
recovery of the actual production database **only while its business tables are
empty**. It holds a read-only repeatable-read snapshot while collecting table
counts/content hashes and running `pg_dump --snapshot`. Verified TLS uses the
restricted application role; the temporary service file is root-only and removed
afterward. The official PostgreSQL 18 ARM64 client is pinned by digest in the script.
It creates an AES-256-GCM encrypted archive without writing plaintext dumps to disk,
verifies tamper rejection, retains ciphertext locally and on the existing Oracle VM,
and keeps the encryption key only on the owner's machine at
`private/oracle/worker/production-backup-encryption.key`, mode `0600`. Preserve that
key through the owner's existing private recovery custody process; do not commit,
upload, display or discard it during cleanup.

The restore target is a new disposable, resource-limited container with no external
network or public ports. Restoration verifies every table's count and content hash,
the existing migration revision, restricted role/sequence permissions and actual
application readiness. Only run-owned temporary containers/configuration are removed.
This proves database recovery for the current empty-business target. It excludes
object/key recovery, scheduled retention, future business data, a production cutover,
approved RPO/RTO and sustained operations; never present it as complete operational
acceptance. PostgreSQL documents [snapshot coordination](https://www.postgresql.org/docs/current/app-pgdump.html)
and [snapshot export](https://www.postgresql.org/docs/current/functions-admin.html).

The existing `repair-hosting.yml` owner action `inspect-role` reads the production
Render runtime binding and tests its actual login using read-only transactions. It
does not use `PORTAL_MIGRATION_DATABASE_URL`, apply migrations, change roles or update
provider settings. A stale maintenance credential is not evidence of a runtime role
regression. Preserve all credentials; actual TLS/schema/permissions/role results remain
required before a production worker is bound to that database. This inspection does
not establish the production bucket identity or authorize a database cutover.

## Qualified deployment and validation

Use a reviewed archive of the exact staging commit only after current source CI,
hygiene and applicable PR checks pass. Keep its SHA and built image digests in the
private deployment receipt. Install under a private, root-controlled release directory.
The reviewed owner operator performs the exact-commit CI/hygiene gate, creates a
source-only archive, builds both images natively on the VM, and applies the existing
HIGH/CRITICAL/secret image gate to both actual ARM64 images. Its default action is
read-only. It never provisions resources or reads credential values into its output.
Use `python3 scripts/oracle_worker.py --action verify`, then `--action scanner
--commit <qualified-full-staging-SHA>`. Starting jobs instead requires `--action worker
--commit <qualified-full-staging-SHA> --synthetic-data-approved` and the owner-created
root-only environment file. Do not supply this flag before verifying that the entire
staging dataset is synthetic; real candidate records remain prohibited. Source-bound
private receipts and logs are written under `private/oracle/worker`. Image overrides
`PORTAL_WORKER_IMAGE` and `PORTAL_SCANNER_IMAGE` are supported by Compose and supplied
as commit-tagged local images by this operator, never as credentials.

For maintenance of that already qualified deployment, export only the nonsecret
configuration **path**, then use that reviewed directory:

```sh
export PORTAL_ORACLE_ENV_FILE=/etc/onesa/portal-staging.env
sudo --preserve-env=PORTAL_ORACLE_ENV_FILE docker compose -f compose.oracle-staging.yaml config --quiet
sudo --preserve-env=PORTAL_ORACLE_ENV_FILE docker compose -f compose.oracle-staging.yaml build
sudo --preserve-env=PORTAL_ORACLE_ENV_FILE docker compose -f compose.oracle-staging.yaml --profile jobs up -d
sudo --preserve-env=PORTAL_ORACLE_ENV_FILE docker compose -f compose.oracle-staging.yaml ps
sudo --preserve-env=PORTAL_ORACLE_ENV_FILE docker compose -f compose.oracle-staging.yaml exec -T scanner clamdscan --ping=1
sudo --preserve-env=PORTAL_ORACLE_ENV_FILE docker compose -f compose.oracle-staging.yaml exec -T worker node dist/src/jobs/health.js
sudo docker stats --no-stream
```

Do not run `compose config` without `--quiet`, or inspect full worker environment
output: these disclose secrets. The health command reports only a boolean and exit
status, requiring this container's own recent successful tick, a recent database heartbeat, a restricted role and scanner PONG.
It does not qualify mail delivery, backups or actual malware detection.

Before PASS, record real current signatures, benign and EICAR outcomes through the
private scanner, authenticated synthetic upload/quarantine/clean/download integrity,
malware rejection, disabled scanner denial, restart recovery, durable job retries,
approved mail delivery and bounded resource usage. The hosted acceptance suite polls
only the exact run-owned synthetic file; it cannot use another file's clean result.
Protocol mocks and a binary version check are never hosted scan evidence.

Monitor both container health states, failed jobs/storage deletion retries, heartbeat
age, signature age, disk free space and OOM/restart counts through the existing private
operations channel. Alert on unhealthy containers and stale signatures; independently
verify receipt of alerts and restore of signatures/configuration. Configure rotation
and bounded Docker logs before enabling long-running jobs. Persist the signature and
socket volumes across container restarts. Stop with `compose stop`; do not use `down
-v`, delete the database, clear pending jobs or discard the bucket during rollback.

Free eligibility and idle-instance reclamation remain operational prerequisites;
verify aggregate tenancy allocation/usage, not merely this VM's shape. Oracle's
[Always Free limits](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
and [ClamAV container guidance](https://docs.clamav.net/manual/Installing/Docker.html)
must be reviewed again before promotion. Production, DNS and paid upgrades remain
owner-controlled.

## Private configuration installation and read-only data checks

Keep job processing disabled until the owner confirms both configuration and data
isolation. On the VM, use the existing key-only administrative SSH session:

```sh
sudo install -d -o root -g root -m 700 /etc/onesa
sudoedit /etc/onesa/portal-staging.env
sudo chown root:root /etc/onesa/portal-staging.env
sudo chmod 600 /etc/onesa/portal-staging.env
sudo test ! -L /etc/onesa/portal-staging.env
sudo stat -c '%U:%G %a %n' /etc/onesa /etc/onesa/portal-staging.env
```

Expected metadata is `root:root 700` for the directory and `root:root 600` for the
file. Enter staging values only in the private editor, with one `NAME=value` per
line. Omit unused optional keys instead of supplying blank credentials. Do not use
shell commands containing secret literals, print the file, upload it to CI or run
`docker inspect` against the full environment. An existing empty file is not configured.
The source-derived names-only inventory is:

```sh
python3 scripts/oracle_worker_inventory.py
```

It includes optional backend defaults (`MAX_FILE_STORAGE_BYTES`,
`MAX_OWNER_FILE_STORAGE_BYTES`, `METRICS_TOKEN`, `PORT`, `STORAGE_DIR`,
`CLAMAV_HOST`, `CLAMAV_PORT`) and the `RENDER` platform indicator. These do not
require new resources or tokens. On Oracle, keep the shared bucket and Unix socket;
local `STORAGE_DIR` and public TCP scanning are unsuitable substitutes. Backend
secrets belong in this root-only runtime file, never Vercel public configuration.

Retrieve the expected **nonsecret** database endpoint and bucket identifier from
the existing Portal **staging** Render service/environment groups and private-storage
provider. Compare resource identity and staging scope in those dashboards; do not
copy an AI Platform database binding or create another database/bucket. With the
qualified native images present, run this owner-only read-only check locally:

```sh
python3 scripts/oracle_worker_inventory.py --remote \
  --expected-database-endpoint <actual-Portal-staging-Neon-hostname> \
  --expected-bucket <actual-existing-private-staging-bucket>
```

This command does not enable the worker. It rejects different configured targets,
opens a read-only database transaction, checks restricted-role safety and returns
aggregate file/application/queue counts. It requests at most one object-list entry
but prints no object keys and downloads no document bytes. Failure emits a fixed
reason; no URL, token, password, CV, candidate name or email is printed. Private
readback is stored in `private/oracle/worker/staging-data-inventory.json`.

Counts and successful access do **not** establish synthetic provenance or bucket
privacy. The owner must compare the existing approved fixture manifest/import
records and database/bucket inventories, confirm no real candidate documents or
jobs are present, and review the bucket's actual public-access restrictions and
credential scope. If provenance is unclear, leave processing disabled and report
the specific evidence missing; do not open CVs or silently delete/reclassify records.
After explicit confirmation, test only new run-owned synthetic jobs/uploads, their
quarantine transitions, retry limits, failure recovery and authorized download hashes.

Scanner-only acceptance after source-bound deployment:

```sh
python3 scripts/oracle_scanner_test.py
```

It uses the actual compiled Portal scanner client with synthetic bytes and EICAR,
without a database connection, object access or email provider. It checks benign
clean, infected rejected, unavailable scanner denial and unconfigured quarantine.
Its receipt explicitly leaves database jobs/private uploads/production unqualified.

## Current staging SQL scope correction

The verified runtime target is Neon project `gentle-mud-16323345`
(`onesa-ai-company-portal-backend-db-staging`), branch `br-little-boat-b9fg0rqq`, pooled
SQL host `ep-morning-shadow-b9jkzgsz-pooler.c-7.eu-central-1.aws.neon.tech`, database
`neondb`, role `onesa_portal_app`. This matches the existing staging bucket namespace.
The previous autumn-glade SQL project is a non-staging migrations project and must
not be used by fixture or worker activation guards. Historical tests on it were real
but do not qualify the corrected staging binding. Jobs remain stopped until fresh
bucket provenance/isolation and exact-source qualification pass. Production uses the
separate morning-mode project/dark-boat endpoint; no production worker is activated.

## Scheduled production recovery and monitoring

`scripts/oracle_operations.py install --commit <qualified-staging-SHA>` checks live
CI/hygiene and identical qualified backend/scanner trees before installing operations
on the existing VM. It does not start the production worker. The default schedule is
hourly with seven-day retention; only expired archives inside the dedicated
`.onesa-portal-backups/v1/` prefix are eligible for removal. Key escrow objects are
retained separately and are never deleted by archive retention. No new bucket, VM,
paid service or public monitoring port is introduced.

The root-only backup service exports a PostgreSQL read-only consistent snapshot and
captures table counts/content hashes, the custom-format dump and associated file
objects. Each file's size/hash must match the snapshot. Missing or changed objects
fail the backup; none is silently omitted. Backups currently support at most 1,000
objects and 64 MiB of combined source bytes. Exceeding a bound produces a failure
alert and requires reviewed streaming/archive capacity work before increasing it.
The cadence describes the configured recovery target, not guaranteed RPO or RTO.

Each archive uses a random AES-256-GCM key, authenticated metadata and an RSA-3072
OAEP SHA-256 wrapped key. Only the public RSA key is installed on Oracle. The private
key stays on the owner host and is escrowed off instance after encryption with the
existing owner-held AES recovery master. The backup includes the application
SESSION_KEY inside the encrypted payload, so encrypted outbox data remains
recoverable. Dumps, object bytes, credentials and plaintext keys are never logged.

`scripts/oracle_recovery.py --commit <qualified-staging-SHA>` retrieves the encrypted
archive and key escrow directly from the existing private storage provider using
authorized owner access. It recovers the RSA key using the owner-held master without
reading the original private-key file or contacting Oracle, rejects tampering,
restores PostgreSQL in a disposable local container with no network/public ports,
compares every table hash/count, restores associated objects into a private temporary
directory and checks the recovered SESSION_KEY. Only its own container/files are
removed. Installation includes one run-owned synthetic PDF/database fixture to make
object recovery observable; that source fixture is removed after backup execution.

Keep the recovery master and private key mode 0600 in the ignored private directory.
An independent secure offline copy of the master is required for recovery after loss
of the owner machine; the encrypted escrow alone cannot recover a lost master.
For key rotation, create a new RSA pair/ID, escrow it using the retained master,
verify a new archive and independent restore, then replace the VM's public key.
Preserve old private keys/escrows/master until every dependent archive has expired.
Never overwrite the sole master or claim a lost master can be reconstructed.
The current backup prefix shares the existing storage provider and credential scope;
this does not establish immutable storage or an independent-provider disaster copy.

The monitor samples aggregate database/queue state, private scanner health/signature
freshness, Docker health/restart counts, disk usage, available memory and backup
execution state every minute. It covers worker stopped, exhausted job retries,
stalled queue, ClamAV unavailable, signature updates failed, backup failure, resource
pressure, database unavailable and unexpected worker restart. Notifications use the
existing sending-only Resend credential and approved NOTIFY_EMAIL, with a 30-minute
cooldown. Production-worker absence is not an incident before cutover; activate that
specific expectation only when the managed production worker is enabled.

`scripts/oracle_operations.py simulate --commit <qualified-staging-SHA>` injects all
nine metric failures into an isolated evaluation and sends one explicitly labelled
synthetic alert. It never stops services, fills disks, changes queues or disconnects
databases. Preserve the actual samples, rule evaluations, provider receipt and
recipient delivery evidence. A notification accepted by Resend is not a delivered
alert, and simulated metrics do not prove actual destructive failures occurred.

These services are prepared until exact-source CI, real execution, independent
DB/object/key restoration, timer readback and recipient delivery have passed.
Their receipts live under `private/oracle/worker/`; do not publish secrets or raw logs.

## Measured synthetic staging capacity

On 2026-10-13, a 901-second workload processed 150 synthetic 256 KiB PDFs in 30
batches of five through actual private object storage and ClamAV. Queue latency was
465 ms p50, 779 ms p95 and 1,205 ms maximum; the final direct benign scan took 3 ms.
Twenty-eight samples per container measured peak memory of approximately 50.9 MiB
for the driver, 41.7 MiB for the existing worker and 946.6 MiB for ClamAV. Observed
peak Docker CPU percentages were 6.70%, 3.74% and 2.61%, respectively. All run-owned
objects, users and file/audit records were removed. These are sample peaks, not
continuous CPU averages or a production throughput guarantee.

Keep five-file batches, sequential scanning, 10 MiB per-document limits and private
quarantine during failures. The test used the staging Compose resource allocation;
the separately limited production profile still needs its own observation after
controlled cutover. Fifteen minutes does not establish multi-day reliability,
maximum saturation throughput or a verified disk/memory exhaustion event.
