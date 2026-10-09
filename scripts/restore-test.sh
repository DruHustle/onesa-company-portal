#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
backup_file="${1:?Pass a verified dump file}"
test -s "$backup_file"
shasum -a 256 -c "$backup_file.sha256"
# Create a new isolated rehearsal database; never overwrite production/development.
restore_database="portal_restore_$(date -u +%Y%m%d%H%M%S)"
docker compose exec -T database createdb -U onesa_portal "$restore_database"
docker compose exec -T database pg_restore -U onesa_portal --exit-on-error -d "$restore_database" < "$backup_file"
docker compose exec -T database psql -U onesa_portal -d "$restore_database" -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS migrations FROM schema_migrations; SELECT count(*) AS templates FROM templates; SELECT count(*) AS facts FROM facts;'
printf 'Restored into isolated database: %s\n' "$restore_database"
