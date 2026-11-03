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

[Open the protected guide](https://docs.engineering.onesa.eu/docs/ecosystem/PORTAL_WORKER_RUNTIME).
Sign in through Onesa Portal with an individually approved engineering identity.

Public repository history may contain earlier editions; moving this active copy
does not erase historical exposure. Credentials, records and release evidence
belong in their existing restricted stores, never in this reference page.
