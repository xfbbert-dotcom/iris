#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

repository_dir="${IRIS_REPOSITORY_DIR:-/opt/iris/repository}"
environment_file="${IRIS_ENV_FILE:-$repository_dir/.env.pilot}"
compose_file="${IRIS_COMPOSE_FILE:-$repository_dir/deploy/pilot/docker-compose.yml}"
backup_dir="${IRIS_BACKUP_DIR:-$repository_dir/backups}"
recipient_file="${IRIS_BACKUP_RECIPIENT_FILE:-/etc/iris/backup-recipient}"
cleanup_retry_delay_seconds="${IRIS_BACKUP_CLEANUP_RETRY_DELAY_SECONDS:-2}"

for command_name in docker age flock mktemp tar; do
  command -v "$command_name" >/dev/null
done
test -r "$environment_file"
test -r "$compose_file"
test -r "$recipient_file"
if [[ ! "$cleanup_retry_delay_seconds" =~ ^[0-9]+$ ]]; then
  echo "IRIS_BACKUP_CLEANUP_RETRY_DELAY_SECONDS must be a non-negative integer" >&2
  exit 1
fi

recipient="$(tr -d '[:space:]' < "$recipient_file")"
if [[ ! "$recipient" =~ ^age1[0-9a-z]+$ ]]; then
  echo "backup recipient file does not contain one valid age recipient" >&2
  exit 1
fi

install -d -m 700 "$backup_dir"
exec 9> "$backup_dir/.backup.lock"
if ! flock -n 9; then
  echo "another Iris backup is already running" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$backup_dir/iris-$timestamp.bundle.tar.age"
temporary_file="$(mktemp "$backup_dir/.iris-$timestamp.XXXXXX.bundle.tar.age.tmp")"
snapshot_dir="$(mktemp -d "${TMPDIR:-/tmp}/iris-backup.XXXXXX")"
maintenance_started=false
maintenance_complete=false
caddy_was_running=false
runtime_was_enabled=
runtime_desired_enabled=
runtime_revision=
runtime_persistence_storage=
runtime_persistence_ok=
runtime_activation_required=

cd "$repository_dir"
compose=(docker compose --env-file "$environment_file" --file "$compose_file")

read_runtime_status() {
  "${compose[@]}" exec -T core node --input-type=module --eval '
    const token = process.env.IRIS_INTERNAL_API_TOKEN?.trim();
    if (!token) throw new Error("IRIS_INTERNAL_API_TOKEN is unavailable inside Core");
    const response = await fetch("http://127.0.0.1:3000/internal/runtime-control/status", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`runtime status request failed with HTTP ${response.status}`);
    const body = await response.json();
    if (
      typeof body.globalEnabled !== "boolean" ||
      typeof body.desiredGlobalEnabled !== "boolean" ||
      typeof body.activationRequired !== "boolean" ||
      !Number.isSafeInteger(body.revision) ||
      body.revision < 0
    ) {
      throw new Error("runtime status did not contain valid live and durable state");
    }
    if (body.activationRequired !== (!body.globalEnabled && body.desiredGlobalEnabled)) {
      throw new Error("runtime status contained inconsistent activation state");
    }
    if (body.persistence?.storage !== "postgres" || body.persistence.ok !== true) {
      throw new Error("runtime status did not prove healthy Postgres persistence");
    }
    process.stdout.write([
      body.globalEnabled,
      body.desiredGlobalEnabled,
      body.revision,
      body.persistence.storage,
      body.persistence.ok,
      body.activationRequired,
    ].join("\t"));
  '
}

read_runtime_enabled() {
  local status
  local global_enabled
  status="$(read_runtime_status)"
  IFS=$'\t' read -r global_enabled _ <<< "$status"
  printf '%s' "$global_enabled"
}

assert_runtime_state() {
  local expected="$1"
  local actual
  actual="$(read_runtime_enabled)"
  if [[ "$actual" != "$expected" ]]; then
    echo "expected runtime state $expected but Core reported $actual" >&2
    return 1
  fi
}

read_service_running() {
  local target_service="$1"
  local running_services
  local service_name
  local is_running=false

  if ! running_services="$("${compose[@]}" ps --status running --services)"; then
    return 1
  fi
  while IFS= read -r service_name; do
    if [[ "$service_name" == "$target_service" ]]; then
      is_running=true
    fi
  done <<< "$running_services"
  printf '%s' "$is_running"
}

set_runtime_enabled() {
  local expected="$1"
  "${compose[@]}" exec -T core node --input-type=module --eval '
    const expectedText = process.argv[1];
    if (expectedText !== "true" && expectedText !== "false") {
      throw new Error("runtime target must be true or false");
    }
    const token = process.env.IRIS_INTERNAL_API_TOKEN?.trim();
    if (!token) throw new Error("IRIS_INTERNAL_API_TOKEN is unavailable inside Core");
    const expected = expectedText === "true";
    const response = await fetch("http://127.0.0.1:3000/internal/runtime-control/global", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-iris-operator": "planned-backup",
      },
      body: JSON.stringify({ enabled: expected }),
    });
    if (!response.ok) throw new Error(`runtime update request failed with HTTP ${response.status}`);
    const body = await response.json();
    if (body.globalEnabled !== expected || body.durable !== true) {
      throw new Error(`expected durable runtime state ${expectedText} after update`);
    }
  ' "$expected"
}

assert_runtime_activation_ready() {
  "${compose[@]}" exec -T core node --input-type=module --eval '
    const token = process.env.IRIS_INTERNAL_API_TOKEN?.trim();
    if (!token) throw new Error("IRIS_INTERNAL_API_TOKEN is unavailable inside Core");
    const response = await fetch("http://127.0.0.1:3000/internal/status", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`internal status request failed with HTTP ${response.status}`);
    const body = await response.json();
    if (
      body.ok !== true ||
      body.status !== "healthy" ||
      body.summary?.degradedComponentCount !== 0 ||
      body.summary?.stoppedEnabledRuntimeComponentCount !== 0
    ) {
      throw new Error("internal status did not prove healthy pilot services");
    }
    const runtime = body.components?.runtimeControl;
    if (
      runtime?.globalEnabled !== false ||
      typeof runtime.desiredGlobalEnabled !== "boolean" ||
      runtime.activationRequired !== runtime.desiredGlobalEnabled ||
      !Number.isSafeInteger(runtime.revision) ||
      runtime.revision < 0
    ) {
      throw new Error("runtime status did not prove a disabled live gate after restart");
    }
    if (runtime.persistence?.storage !== "postgres" || runtime.persistence.ok !== true) {
      throw new Error("runtime status did not prove healthy Postgres persistence");
    }
    const workers = [
      [body.components?.eventWorker, "pendingEventCount", "deadLetterEventCount"],
      [body.components?.documentSync, "pendingJobCount", "deadLetterJobCount"],
      [body.components?.reindex, "pendingJobCount", "deadLetterJobCount"],
    ];
    if (workers.some(([worker, pendingName, deadLetterName]) =>
      worker?.ok !== true ||
      worker.enabled !== true ||
      worker.running !== true ||
      worker[pendingName] !== 0 ||
      worker[deadLetterName] !== 0
    )) {
      throw new Error("internal status did not prove healthy workers and queues with zero DLQs");
    }
  '
}

start_core_disabled() {
  "${compose[@]}" stop core >/dev/null
  "${compose[@]}" up --detach --wait --wait-timeout 120 core
  assert_runtime_state false
}

stop_caddy_verified() {
  local attempt
  local caddy_running

  for attempt in 1 2 3; do
    "${compose[@]}" stop caddy >/dev/null 2>&1 || true
    if caddy_running="$(read_service_running caddy)" && [[ "$caddy_running" == false ]]; then
      return 0
    fi
    if ((attempt < 3)); then
      sleep "$cleanup_retry_delay_seconds"
    fi
  done

  "${compose[@]}" kill caddy >/dev/null 2>&1 || true
  caddy_running="$(read_service_running caddy)" || return 1
  [[ "$caddy_running" == false ]]
}

recover_failed_maintenance() {
  local caddy_closed=true
  local core_disabled=true
  local caddy_running

  set_runtime_enabled false >/dev/null 2>&1 || true
  stop_caddy_verified || caddy_closed=false
  start_core_disabled >/dev/null 2>&1 || core_disabled=false
  assert_runtime_state false >/dev/null 2>&1 || core_disabled=false
  if ! caddy_running="$(read_service_running caddy)" || [[ "$caddy_running" != false ]]; then
    caddy_closed=false
  fi

  if [[ "$caddy_closed" != true || "$core_disabled" != true ]]; then
    return 1
  fi
}

restore_runtime_state() {
  if [[ "$runtime_was_enabled" == true ]]; then
    assert_runtime_activation_ready
    set_runtime_enabled true
    assert_runtime_state true
  fi
}

cleanup() {
  local exit_status=$?
  trap - EXIT
  if [[ "$maintenance_started" == true && "$maintenance_complete" != true ]]; then
    echo "Backup failed; keeping Iris disabled and Caddy stopped" >&2
    if ! recover_failed_maintenance; then
      echo "FAIL-CLOSED RECOVERY INCOMPLETE: verify Core is disabled and Caddy is stopped" >&2
    fi
  fi
  rm -rf -- "$snapshot_dir" || echo "Warning: could not remove backup snapshot directory" >&2
  rm -f -- "$temporary_file" || echo "Warning: could not remove temporary backup file" >&2
  return "$exit_status"
}
trap cleanup EXIT

maintenance_started=true
runtime_status="$(read_runtime_status)"
IFS=$'\t' read -r \
  runtime_was_enabled \
  runtime_desired_enabled \
  runtime_revision \
  runtime_persistence_storage \
  runtime_persistence_ok \
  runtime_activation_required <<< "$runtime_status"
if [[
  "$runtime_was_enabled" != true && "$runtime_was_enabled" != false ||
  "$runtime_desired_enabled" != true && "$runtime_desired_enabled" != false ||
  ! "$runtime_revision" =~ ^[0-9]+$ ||
  "$runtime_persistence_storage" != postgres ||
  "$runtime_persistence_ok" != true ||
  "$runtime_activation_required" != true && "$runtime_activation_required" != false
]]; then
  echo "Core returned invalid live or durable runtime state" >&2
  exit 1
fi

caddy_was_running="$(read_service_running caddy)"

echo "Stopping Iris briefly for a consistent Postgres and Redis snapshot" >&2
set_runtime_enabled false
assert_runtime_state false
stop_caddy_verified
assert_runtime_activation_ready
"${compose[@]}" stop core

"${compose[@]}" exec -T postgres sh -eu -c \
  'PGPASSWORD="$IRIS_MIGRATOR_PASSWORD" exec pg_dump --host 127.0.0.1 --username "$IRIS_MIGRATOR_USER" --dbname "$POSTGRES_DB" --format custom' \
  > "$snapshot_dir/postgres.dump"
"${compose[@]}" exec -T redis redis-cli SAVE > /dev/null
"${compose[@]}" cp redis:/data/dump.rdb "$snapshot_dir/redis.rdb"
printf 'created_at=%s\nformat=iris-pilot-paired-v1\nruntime_global_enabled=%s\nruntime_desired_global_enabled=%s\nruntime_revision=%s\nruntime_persistence_storage=%s\nruntime_persistence_ok=%s\n' \
  "$timestamp" \
  "$runtime_was_enabled" \
  "$runtime_desired_enabled" \
  "$runtime_revision" \
  "$runtime_persistence_storage" \
  "$runtime_persistence_ok" \
  > "$snapshot_dir/manifest.txt"

start_core_disabled

tar --create --directory "$snapshot_dir" \
  --file - manifest.txt postgres.dump redis.rdb \
  | age --recipient "$recipient" --output "$temporary_file"

test -s "$temporary_file"
chmod 600 "$temporary_file"
mv -- "$temporary_file" "$backup_file"

assert_runtime_activation_ready
if [[ "$caddy_was_running" == true ]]; then
  "${compose[@]}" up --detach --wait --wait-timeout 120 caddy
fi
restore_runtime_state

find "$backup_dir" -type f -name 'iris-*.bundle.tar.age' -mtime +7 -delete
maintenance_complete=true
printf '%s\n' "$backup_file"
