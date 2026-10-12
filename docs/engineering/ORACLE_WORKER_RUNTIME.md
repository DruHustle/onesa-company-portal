# Oracle staging worker and private scanner

Use the existing owner-provisioned `onesa-portal-worker`. Provisioning and SSH
configuration are documented in [DEPLOYMENT](DEPLOYMENT.md); do not create another VM
or resize any resource as part of runtime deployment. Private inventory and SSH
receipts stay outside Git. The current target is Ubuntu 24.04 ARM64, 1 OCPU, 6 GB RAM
and a 50 GB boot volume in Frankfurt. Runtime installation is separate from release
qualification: Docker being available does not prove a working Portal worker.

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
`CLAMAV_SOCKET=/run/onesa-scanner/clamd.sock`. Do not set `CLAMAV_HOST` to this public
IP. The Render API keeps its initial uploads quarantined; the worker retrieves them
privately and updates scan status only after the existing bounded scanner protocol
returns an explicit result. Do not enable publication or manually mark uploads clean.

## Production binding inspection

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
