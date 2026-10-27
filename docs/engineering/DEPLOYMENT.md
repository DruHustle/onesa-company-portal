# Deployment and independent releases

<!-- onesa-protected-source: portal-deployment -->

Hosted browser observations check the existing Company and Portal access boundaries
independently. Staging retains its protected preview boundary.

Runtime preservation snapshots wait a bounded time for temporary Docker clients
to finish. Every persistent and unknown workload remains in the snapshot; actual
identity changes, missing services and incomplete observations still block release.

Static artifact verification accepts generated Next.js catch-all filenames while
retaining canonical path, response-size and byte-digest checks. A verifier fix
requires new source qualification and commissioning; failed contexts stay consumed.

The owner-run backup readback uses a source-pinned transport that drains its output
under pipe backpressure. A truncated read remains a failed check. Installing a fix
requires the normal source qualification and separate commissioning; it does not
replace backup evidence or authorize an application deployment.
Public transport source is copied temporarily for the existing unprivileged
container; installed tools and credentials retain their private custody modes.

Detailed operational instructions are maintained in protected Engineering Docs.
This public source is a reference page, not a deployment or recovery runbook.

[Open the protected guide](https://docs.engineering.onesa.eu/docs/ecosystem/PORTAL_DEPLOYMENT).
Sign in through Onesa Portal with an individually approved engineering identity.

Public repository history may contain earlier editions; moving this active copy
does not erase historical exposure. Credentials, records and release evidence
belong in their existing restricted stores, never in this reference page.

## Oracle owner-run evidence bridge

The new `scripts/release/oracle_owner.py` adapter preserves owner-run receipts
with workflow run ID `0` and genuine CI run references. It requires a separately
commissioned, pinned external verifier and owner-controlled signing custody.
Repository code or an unsigned JSON file supplies no release authority.
The protected guide contains installation, qualification and recovery instructions;
source implementation alone does not establish commissioning or deployment.

The Portal-specific frontend extension is new source, not a commissioned service.
It binds public presentation artifacts and existing provider configuration while
retaining the independently deployed API, workers and scanner. Its limited copy scope additionally accepts only the exact default-prefetch
change that prevents speculative page requests. It rejects authentication, hero
or other navigation changes requiring broader qualification. Separate installation, owner commissioning, genuine hosted evidence
and exact-source authorization remain required before release.
