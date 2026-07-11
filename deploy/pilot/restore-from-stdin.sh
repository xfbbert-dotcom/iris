#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if [[ "${1:-}" != "--confirm-replace-database" || "$#" -ne 1 ]]; then
  echo "usage: restore-from-stdin.sh --confirm-replace-database < backup.dump" >&2
  exit 2
fi

repository_dir="${IRIS_REPOSITORY_DIR:-/opt/iris/repository}"
environment_file="${IRIS_ENV_FILE:-$repository_dir/.env.pilot}"
compose_file="${IRIS_COMPOSE_FILE:-$repository_dir/deploy/pilot/docker-compose.yml}"

command -v docker >/dev/null
test -r "$environment_file"
test -r "$compose_file"

cd "$repository_dir"
compose=(docker compose --env-file "$environment_file" --file "$compose_file")

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
staging_database="iris_restore_${timestamp}_$$"
previous_database="iris_previous_${timestamp}_$$"
temporary_dump="$(mktemp "${TMPDIR:-/tmp}/iris-restore.XXXXXX.dump")"
staging_database_active=false

cleanup() {
  rm -f -- "$temporary_dump"
  if [[ "$staging_database_active" == true ]]; then
    "${compose[@]}" exec -T -e IRIS_RESTORE_DATABASE="$staging_database" postgres \
      sh -eu -c 'dropdb --username "$POSTGRES_USER" --if-exists --force "$IRIS_RESTORE_DATABASE"' \
      >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

cat > "$temporary_dump"
test -s "$temporary_dump"
"${compose[@]}" exec -T postgres sh -eu -c 'exec pg_restore --list' \
  < "$temporary_dump" > /dev/null

"${compose[@]}" exec -T -e IRIS_RESTORE_DATABASE="$staging_database" postgres sh -eu -c '
  createdb --username "$POSTGRES_USER" --owner "$POSTGRES_USER" "$IRIS_RESTORE_DATABASE"
'
staging_database_active=true

"${compose[@]}" exec -T -e IRIS_RESTORE_DATABASE="$staging_database" postgres sh -eu -c '
  exec pg_restore \
    --username "$POSTGRES_USER" \
    --dbname "$IRIS_RESTORE_DATABASE" \
    --exit-on-error \
    --single-transaction \
    --no-owner \
    --no-privileges
' < "$temporary_dump"

"${compose[@]}" run --rm -e IRIS_RESTORE_DATABASE="$staging_database" migrate sh -eu -c '
  DATABASE_URL="${DATABASE_URL%/*}/$IRIS_RESTORE_DATABASE"
  export DATABASE_URL
  exec node apps/core/dist/database/migrate.js
'

echo "Staging restore and migrations passed; stopping Iris for database swap" >&2
"${compose[@]}" stop caddy core

"${compose[@]}" exec -T \
  -e IRIS_RESTORE_DATABASE="$staging_database" \
  -e IRIS_PREVIOUS_DATABASE="$previous_database" \
  postgres sh -eu -c '
    exec psql --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=on \
      --set "target_database=$POSTGRES_DB" \
      --set "staging_database=$IRIS_RESTORE_DATABASE" \
      --set "previous_database=$IRIS_PREVIOUS_DATABASE" \
      --file /opt/iris/swap-databases.sql
  '
staging_database_active=false

"${compose[@]}" run --rm --no-deps core \
  node apps/core/dist/admin/internal-rollout-readiness-cli.js
"${compose[@]}" up --detach --wait --wait-timeout 120 core caddy

echo "Restore completed; previous database retained as $previous_database" >&2
echo "Repeat private status, DLQ, database, and Feishu smoke checks before deleting it" >&2
