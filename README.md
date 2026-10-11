# Onesa UG Company Portal

Corporate website and authenticated company operations portal. The Next.js frontend
and Fastify/TypeScript backend are independent deployable applications in this one
repository. PostgreSQL, private document storage and background processing belong
to the backend boundary. Public website content requires editorial approval.

| Directory | Responsibility |
| --- | --- |
| `onesa-company-portal-frontend/` | Next.js application and typed API client |
| `onesa-company-portal-backend/` | Fastify API, migrations, documents and worker |
| `infra/` | Proxy, storage and monitoring configuration |
| `scripts/` | Contracts, local setup and verification |

Use Node 24 for consistency with containers/CI (packages require at least Node 22).
Copy `.env.example` to an ignored `.env` and replace placeholders privately, or use
`python3 scripts/bootstrap-env.py` for local development. Never use sample keys in
production. Build each application separately; see the [build/test guide](docs/engineering/BUILD_AND_TEST.md).

The portal stores corporate and personal data. `assets/documents/`, backend storage,
backups and local environments are excluded from Git. Do not upload those files as
CI artifacts. Existing PDFs are locally retained for owner classification.

[Deployment](docs/engineering/DEPLOYMENT.md) · [GitHub setup and protections](GITHUB_SETUP.md)
· [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

This preparation does not claim production acceptance. See `IMPLEMENTATION_STATUS.md`
and `SESSION_HANDOFF.md` for prior implementation evidence. No software license is
assigned pending an ownership decision.

## Selected cloud deployment

Vercel hosts the frontend; Render hosts the backend. See
[provider setup](docs/engineering/VERCEL_RENDER.md) and root `render.yaml`.
Configuration is prepared; account provisioning and remote acceptance are not yet verified.

[Domain routing, Zoho Mail and Resend setup](docs/engineering/DOMAINS_AND_EMAIL.md).

[Local Actions runner setup and maintenance](docs/engineering/SELF_HOSTED_RUNNER.md).
