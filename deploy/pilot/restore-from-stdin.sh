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
command -v tar >/dev/null
test -r "$environment_file"
test -r "$compose_file"

cd "$repository_dir"
compose=(docker compose --env-file "$environment_file" --file "$compose_file")

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
staging_database="iris_restore_${timestamp}_$$"
previous_database="iris_previous_${timestamp}_$$"
temporary_bundle="$(mktemp "${TMPDIR:-/tmp}/iris-restore.XXXXXX.bundle.tar")"
restore_dir="$(mktemp -d "${TMPDIR:-/tmp}/iris-restore.XXXXXX")"
staging_database_active=false

cleanup() {
  rm -f -- "$temporary_bundle"
  rm -rf -- "$restore_dir"
  if [[ "$staging_database_active" == true ]]; then
    "${compose[@]}" exec -T -e IRIS_RESTORE_DATABASE="$staging_database" postgres \
      sh -eu -c 'dropdb --username "$POSTGRES_USER" --if-exists --force "$IRIS_RESTORE_DATABASE"' \
      >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

cat > "$temporary_bundle"
test -s "$temporary_bundle"
archive_entries="$(tar --list --file "$temporary_bundle" | sort)"
expected_entries="$(printf '%s\n' manifest.txt postgres.dump redis.rdb | sort)"
if [[ "$archive_entries" != "$expected_entries" ]]; then
  echo "restore bundle must contain exactly manifest.txt, postgres.dump, and redis.rdb" >&2
  exit 1
fi
tar --extract --file "$temporary_bundle" --directory "$restore_dir" --no-same-owner
grep -Fx 'format=iris-pilot-paired-v1' "$restore_dir/manifest.txt" > /dev/null
test -s "$restore_dir/postgres.dump"
test -s "$restore_dir/redis.rdb"
"${compose[@]}" exec -T postgres sh -eu -c 'exec pg_restore --list' \
  < "$restore_dir/postgres.dump" > /dev/null

"${compose[@]}" exec -T -e IRIS_RESTORE_DATABASE="$staging_database" postgres sh -eu -c '
  createdb --username "$POSTGRES_USER" --owner "$IRIS_MIGRATOR_USER" "$IRIS_RESTORE_DATABASE"
  psql --username "$POSTGRES_USER" --dbname "$IRIS_RESTORE_DATABASE" \
    --set ON_ERROR_STOP=on --command "CREATE EXTENSION IF NOT EXISTS vector"
'
staging_database_active=true

"${compose[@]}" exec -T -e IRIS_RESTORE_DATABASE="$staging_database" postgres sh -eu -c '
  PGPASSWORD="$IRIS_MIGRATOR_PASSWORD" exec pg_restore \
    --host 127.0.0.1 \
    --username "$IRIS_MIGRATOR_USER" \
    --dbname "$IRIS_RESTORE_DATABASE" \
    --exit-on-error \
    --single-transaction \
    --no-owner \
    --no-privileges
' < "$restore_dir/postgres.dump"

"${compose[@]}" run --rm -e IRIS_RESTORE_DATABASE="$staging_database" migrate sh -eu -c '
  DATABASE_URL="${DATABASE_URL%/*}/$IRIS_RESTORE_DATABASE"
  export DATABASE_URL
  exec node apps/core/dist/database/migrate.js
'

echo "Staging restore and migrations passed; stopping Iris for database swap" >&2
"${compose[@]}" stop caddy core

install -d -m 700 "$repository_dir/backups"
previous_redis_file="$repository_dir/backups/redis_previous_${timestamp}_$$.rdb"
"${compose[@]}" exec -T redis redis-cli SAVE > /dev/null
"${compose[@]}" cp redis:/data/dump.rdb "$previous_redis_file"
chmod 600 "$previous_redis_file"

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

"${compose[@]}" stop redis
"${compose[@]}" run --rm --no-deps \
  --volume "$restore_dir/redis.rdb:/restore/redis.rdb:ro" \
  --entrypoint sh redis -eu -c '
    rm -rf /data/appendonlydir
    cp /restore/redis.rdb /data/dump.rdb
    chown redis:redis /data/dump.rdb
  '
"${compose[@]}" up --detach --wait --wait-timeout 120 redis

"${compose[@]}" run --rm --no-deps core \
  node apps/core/dist/admin/internal-rollout-readiness-cli.js
"${compose[@]}" up --detach --wait --wait-timeout 120 core caddy

echo "Restore completed; previous database retained as $previous_database" >&2
echo "Previous Redis retained as $previous_redis_file" >&2
echo "Repeat private status, DLQ, database, and Feishu smoke checks before deleting either" >&2
