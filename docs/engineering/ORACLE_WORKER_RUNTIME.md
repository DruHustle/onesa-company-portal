# Oracle staging worker and private scanner

<!-- onesa-protected-source: portal-worker-runtime -->

Detailed operational instructions are maintained in protected Engineering Docs.
This public source is a reference page, not a deployment or recovery runbook.

The prepared Docker process-recovery controller is disabled until separately
installed and enrolled through the owner-controlled runtime procedure. It covers
only explicitly bound Portal API and worker containers, retaining their approved
image/configuration identities and existing shutdown allowances. Process probes
are separate from database/scanner readiness and staging idle polling. Durable
budgets, Linux process identity checks and the shared maintenance/deployment
interlock constrain actions; source tests do not establish live activation.

The dedicated owner adapter now binds its installer, controller, lifecycle helper
and systemd units to the exact qualified source. Enrollment requires signed identity
release observations and a healthy compatible process, including the worker's actual
liveness program. It preserves attempts and unresolved holds during disabled
reenrollment. Production activation requires staging fault acceptance and distinct
ordinary timer observations; the staging owner test never faults production targets.
This implementation does not commission an existing host or replace the protected
runtime procedure.

## Disposable monitoring probes

The metrics client now identifies each disposable container by a fresh invocation
name and ownership label. If its Docker client fails or times out, bounded cleanup
requires that exact name, label, image and metrics command before removing the
inspected container ID. A private, durable intent precedes Docker; interrupted or
ambiguous cleanup retains it and holds new probes across timer ticks. A recovery
tick only reconciles that recorded invocation before ordinary sampling resumes.
An absent name cannot resolve a create request that may still be registering in
the daemon. If the probe never becomes visible, its intent remains held for
explicit reconciliation; repeated absence does not report successful cleanup.
A kernel lock prevents overlapping observers from reconciling a probe that is
still running. An ambiguous result remains an unsuccessful private observation.
Application containers and historical probe leftovers are outside this cleanup scope. Normal automatic
removal, the existing probe timeouts and the one-minute timer remain unchanged.
Source tests do not establish installed behavior; the protected operations
procedure still requires exact-source qualification and ordinary timer readback.

## Prepared private PostgreSQL target

The Oracle API Compose source now contains an inert `x-portal-container-primary`
extension. Ordinary API/worker profiles retain their existing services, networks
and storage. A separate read-only target helper can render a database-only model
from explicitly selected private custody. Its database service stays profile-gated,
uses an already present immutable ARM64 image and existing persistent volume, and
joins the already approved API and worker bridges. Neither application gains a
second network. PostgreSQL starts directly against an initialized cluster; this
source supplies no initialization, seed, migration, external refresh or failover.

The optional root-owned database target binds the database host/name/restricted
role, both runtime-file digests, image and container identity, volume metadata,
network IDs and private TLS/HBA file digests. The backup reader requires matching
API/worker database URLs and trust anchors, verified TLS/SCRAM, the selected private
network, the enrolled data volume and no database port publication. Invalid or
changed custody refuses the backup; it never selects another database. Absence of
the profile keeps the existing Neon backup path. Temporary CA and connection files
are removed after the same bounded client cleanup, and the authenticated encrypted
off-instance archive, object verification and retention remain unchanged.

This is preparatory source, not an installed local primary or a replicated external
database. Persistent volume recovery handles container replacement; VM/disk loss
still requires an independently verified off-instance restore. Activation needs
actual capacity, image/version/TLS checks, restore and restart evidence, one-writer
maintenance/fencing, and coordinated API/worker/backup configuration through the
protected procedure. Never promote an external copy because a connection timed out.
The existing one-network identity/release adapters and other products' databases
are unchanged. See [the focused tests](BUILD_AND_TEST.md#private-postgresql-target-preparation).

[Open the protected guide](https://docs.engineering.onesa.eu/docs/ecosystem/PORTAL_WORKER_RUNTIME).
Sign in through Onesa Portal with an individually approved engineering identity.

Public repository history may contain earlier editions; moving this active copy
does not erase historical exposure. Credentials, records and release evidence
belong in their existing restricted stores, never in this reference page.
