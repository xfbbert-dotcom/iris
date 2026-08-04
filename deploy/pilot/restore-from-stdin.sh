#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if [[ "${1:-}" != "--confirm-replace-database" || "$#" -ne 1 ]]; then
  echo "usage: age --decrypt ... | restore-from-stdin.sh --confirm-replace-database" >&2
  exit 2
fi

repository_dir="${IRIS_REPOSITORY_DIR:-/opt/iris/repository}"
environment_file="${IRIS_ENV_FILE:-$repository_dir/.env.pilot}"
compose_file="${IRIS_COMPOSE_FILE:-$repository_dir/deploy/pilot/docker-compose.yml}"
backup_dir="${IRIS_BACKUP_DIR:-$repository_dir/backups}"
cleanup_retry_delay_seconds_raw="${IRIS_RESTORE_CLEANUP_RETRY_DELAY_SECONDS:-2}"
command_timeout_seconds_raw="${IRIS_RESTORE_COMMAND_TIMEOUT_SECONDS:-120}"
cleanup_retry_count=3
command_kill_after_seconds=2

normalize_decimal() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  while [[ ${#value} -gt 1 && "${value:0:1}" == 0 ]]; do
    value="${value#0}"
  done
  printf '%s' "$value"
}

decimal_between() {
  local value="$1"
  local minimum="$2"
  local maximum="$3"
  if ((${#value} < ${#minimum} || ${#value} > ${#maximum})); then
    return 1
  fi
  if ((${#value} == ${#minimum})) && [[ "$value" < "$minimum" ]]; then
    return 1
  fi
  if ((${#value} == ${#maximum})) && [[ "$value" > "$maximum" ]]; then
    return 1
  fi
}

if ! cleanup_retry_delay_seconds="$(normalize_decimal "$cleanup_retry_delay_seconds_raw")" ||
  ! decimal_between "$cleanup_retry_delay_seconds" 0 10; then
  echo "IRIS_RESTORE_CLEANUP_RETRY_DELAY_SECONDS must be an integer between 0 and 10" >&2
  exit 1
fi
if ! command_timeout_seconds="$(normalize_decimal "$command_timeout_seconds_raw")" ||
  ! decimal_between "$command_timeout_seconds" 1 1800; then
  echo "IRIS_RESTORE_COMMAND_TIMEOUT_SECONDS must be an integer between 1 and 1800" >&2
  exit 1
fi

for command_name in docker tar flock timeout; do
  command -v "$command_name" >/dev/null
done
test -r "$environment_file"
test -r "$compose_file"

cd "$repository_dir"
compose=(docker compose --env-file "$environment_file" --file "$compose_file")
install -d -m 700 "$backup_dir"
exec 9> "$backup_dir/.backup.lock"
if ! flock -n 9; then
  echo "an Iris backup or restore is already running" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
staging_database="iris_restore_${timestamp}_$$"
previous_database="iris_previous_${timestamp}_$$"
temporary_bundle="$(mktemp "${TMPDIR:-/tmp}/iris-restore.XXXXXX.bundle.tar")"
restore_dir="$(mktemp -d "${TMPDIR:-/tmp}/iris-restore.XXXXXX")"
staging_database_active=false
fail_closed_required=false
restore_complete=false

run_compose() {
  local operation="${1:-command}"
  local command_status

  if timeout --kill-after="${command_kill_after_seconds}s" \
    "${command_timeout_seconds}s" "${compose[@]}" "$@"; then
    return 0
  else
    command_status=$?
  fi
  if [[ "$command_status" == 124 || "$command_status" == 137 ]]; then
    echo "docker compose $operation timed out after ${command_timeout_seconds}s" >&2
  fi
  return "$command_status"
}

read_service_running() {
  local target_service="$1"
  local running_services
  local service_name
  local is_running=false

  running_services="$(run_compose ps --status running --services)" || return 1
  while IFS= read -r service_name; do
    if [[ "$service_name" == "$target_service" ]]; then
      is_running=true
    fi
  done <<< "$running_services"
  printf '%s' "$is_running"
}

stop_caddy_verified() {
  local attempt
  local caddy_running

  for ((attempt = 1; attempt <= cleanup_retry_count; attempt += 1)); do
    if ! run_compose stop caddy >/dev/null; then
      echo "Caddy stop attempt $attempt failed during restore cleanup" >&2
    fi
    if caddy_running="$(read_service_running caddy)" && [[ "$caddy_running" == false ]]; then
      return 0
    fi
    if ((attempt < cleanup_retry_count)); then
      sleep "$cleanup_retry_delay_seconds"
    fi
  done

  if ! run_compose kill caddy >/dev/null; then
    echo "Caddy kill failed during restore cleanup" >&2
  fi
  caddy_running="$(read_service_running caddy)" || return 1
  [[ "$caddy_running" == false ]]
}

cleanup() {
  local exit_status=$?
  trap - EXIT
  if [[ "$fail_closed_required" == true && "$restore_complete" != true ]]; then
    echo "Restore failed; keeping Caddy stopped" >&2
    if ! stop_caddy_verified; then
      echo "FAIL-CLOSED RESTORE CLEANUP INCOMPLETE: verify Caddy is stopped" >&2
    fi
  fi
  rm -f -- "$temporary_bundle"
  rm -rf -- "$restore_dir"
  if [[ "$staging_database_active" == true ]]; then
    run_compose exec -T -e IRIS_RESTORE_DATABASE="$staging_database" postgres \
      sh -eu -c 'dropdb --username "$POSTGRES_USER" --if-exists --force "$IRIS_RESTORE_DATABASE"' \
      >/dev/null 2>&1 || true
  fi
  return "$exit_status"
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
fail_closed_required=true
run_compose exec -T postgres sh -eu -c 'exec pg_restore --list' \
  < "$restore_dir/postgres.dump" > /dev/null

run_compose exec -T -e IRIS_RESTORE_DATABASE="$staging_database" postgres sh -eu -c '
  createdb --username "$POSTGRES_USER" --owner "$IRIS_MIGRATOR_USER" "$IRIS_RESTORE_DATABASE"
  psql --username "$POSTGRES_USER" --dbname "$IRIS_RESTORE_DATABASE" \
    --set ON_ERROR_STOP=on --command "CREATE EXTENSION IF NOT EXISTS vector"
'
staging_database_active=true

run_compose exec -T -e IRIS_RESTORE_DATABASE="$staging_database" postgres sh -eu -c '
  PGPASSWORD="$IRIS_MIGRATOR_PASSWORD" exec pg_restore \
    --host 127.0.0.1 \
    --username "$IRIS_MIGRATOR_USER" \
    --dbname "$IRIS_RESTORE_DATABASE" \
    --exit-on-error \
    --single-transaction \
    --no-owner \
    --no-comments \
    --no-privileges
' < "$restore_dir/postgres.dump"

run_compose run --rm -e IRIS_RESTORE_DATABASE="$staging_database" migrate sh -eu -c '
  DATABASE_URL="${DATABASE_URL%/*}/$IRIS_RESTORE_DATABASE"
  export DATABASE_URL
  exec node apps/core/dist/database/migrate.js
'

run_compose exec -T -e IRIS_RESTORE_DATABASE="$staging_database" postgres sh -eu -c '
  psql --username "$POSTGRES_USER" --dbname "$IRIS_RESTORE_DATABASE" \
    --set ON_ERROR_STOP=on --set "app_user=$IRIS_APP_USER" \
    --set "migrator_user=$IRIS_MIGRATOR_USER" \
    --file /opt/iris/grant-app-access.sql
  PGPASSWORD="$IRIS_MIGRATOR_PASSWORD" psql --host 127.0.0.1 \
    --username "$IRIS_MIGRATOR_USER" --dbname "$IRIS_RESTORE_DATABASE" \
    --set ON_ERROR_STOP=on \
    --command "CREATE TABLE iris_restore_permission_probe(id integer primary key)" \
    > /dev/null
  PGPASSWORD="$IRIS_APP_PASSWORD" psql --host 127.0.0.1 \
    --username "$IRIS_APP_USER" --dbname "$IRIS_RESTORE_DATABASE" \
    --set ON_ERROR_STOP=on \
    --command "INSERT INTO iris_restore_permission_probe(id) VALUES (1); UPDATE iris_restore_permission_probe SET id = id; DELETE FROM iris_restore_permission_probe" \
    > /dev/null
  if PGPASSWORD="$IRIS_APP_PASSWORD" psql --host 127.0.0.1 \
    --username "$IRIS_APP_USER" --dbname "$IRIS_RESTORE_DATABASE" \
    --set ON_ERROR_STOP=on --command "CREATE TABLE iris_forbidden_app_ddl(id integer)" \
    > /dev/null 2>&1; then
    echo "application role unexpectedly has DDL permission on the staging database" >&2
    exit 1
  fi
  PGPASSWORD="$IRIS_MIGRATOR_PASSWORD" psql --host 127.0.0.1 \
    --username "$IRIS_MIGRATOR_USER" --dbname "$IRIS_RESTORE_DATABASE" \
    --set ON_ERROR_STOP=on --command "DROP TABLE iris_restore_permission_probe" \
    > /dev/null
'

echo "Staging restore and migrations passed; stopping Iris for database swap" >&2
stop_caddy_verified
run_compose stop core

previous_redis_file="$backup_dir/redis_previous_${timestamp}_$$.rdb"
run_compose exec -T redis redis-cli SAVE > /dev/null
run_compose cp redis:/data/dump.rdb "$previous_redis_file"
chmod 600 "$previous_redis_file"

run_compose exec -T \
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

run_compose stop redis
run_compose run --rm --no-deps \
  --volume "$restore_dir/redis.rdb:/restore/redis.rdb:ro" \
  --entrypoint sh redis -eu -c '
    rm -rf /data/appendonlydir
    cp /restore/redis.rdb /data/dump.rdb
    chown redis:redis /data/dump.rdb
  '
run_compose up --detach --wait --wait-timeout 120 redis

run_compose run --rm --no-deps core \
  node apps/core/dist/admin/internal-rollout-readiness-cli.js
run_compose up --detach --wait --wait-timeout 120 core

restore_complete=true
echo "Restore completed with Caddy stopped and live activation disabled; previous database retained as $previous_database" >&2
echo "Previous Redis retained as $previous_redis_file" >&2
echo "Run authenticated localhost gates before explicit durable activation, then start Caddy last" >&2
