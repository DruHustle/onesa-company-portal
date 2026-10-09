# Changelog

## 2026-10-09

Prepared the independent company portal repository and private organization remote.
Added publication hygiene, engineering documentation and environment examples.
Production API readiness now rejects database administrator/schema-owner privileges.
Migrations provision a separate CRUD role without changing existing role passwords.
Prepared separate Vercel frontend and Render backend/worker configuration, durable
shared S3 storage requirements and a configurable upload limit for Vercel payloads.
Source publication is authorized; production promotion requires configured services
and verified company facts/notices. Database integration checks include role isolation.
