#!/bin/sh
set -eu
umask 077
cd "$(dirname "$0")/.."
mkdir -p backups
backup_file="backups/portal-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T database pg_dump -U onesa_portal -d onesa_portal -Fc > "$backup_file"
test -s "$backup_file"
shasum -a 256 "$backup_file" > "$backup_file.sha256"
printf 'Database backup created: %s\n' "$backup_file"
