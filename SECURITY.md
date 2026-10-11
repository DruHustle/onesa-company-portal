# Security

The authoritative security policy is the [Security policy section in AGENTS.md](AGENTS.md#security-policy). Report vulnerabilities privately through GitHub private vulnerability reporting if enabled or an owner through an existing private channel. Do not disclose credentials, personal data or exploit details in public issues. No dedicated contact or response SLA is asserted.

Support is limited to the latest reviewed main revision; no historical release support is promised. Store secrets and private records outside Git and CI artifacts. Ordinary feature/PR CI must not use production secrets. Production approval, storage, backup, credential and release qualification require verified deployment-specific evidence.

The [branch protection report](docs/development/BRANCH_PROTECTION_REPORT.md) records actual enforcement. Main is currently unprotected because GitHub rejects private-repository protection under the account's eligibility. [Emergency recovery](docs/development/branch-protection/ACTIVATION.md#emergency-recovery) requires a recorded, temporary administrator correction; broad permanent bypass is prohibited.
