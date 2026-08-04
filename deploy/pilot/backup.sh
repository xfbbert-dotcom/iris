#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

repository_dir="${IRIS_REPOSITORY_DIR:-/opt/iris/repository}"
environment_file="${IRIS_ENV_FILE:-$repository_dir/.env.pilot}"
compose_file="${IRIS_COMPOSE_FILE:-$repository_dir/deploy/pilot/docker-compose.yml}"
backup_dir="${IRIS_BACKUP_DIR:-$repository_dir/backups}"
recipient_file="${IRIS_BACKUP_RECIPIENT_FILE:-/etc/iris/backup-recipient}"
cleanup_retry_delay_seconds_raw="${IRIS_BACKUP_CLEANUP_RETRY_DELAY_SECONDS:-2}"
command_timeout_seconds_raw="${IRIS_BACKUP_COMMAND_TIMEOUT_SECONDS:-30}"
http_timeout_ms_raw="${IRIS_BACKUP_HTTP_TIMEOUT_MS:-10000}"
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
  echo "IRIS_BACKUP_CLEANUP_RETRY_DELAY_SECONDS must be an integer between 0 and 10" >&2
  exit 1
fi
if ! command_timeout_seconds="$(normalize_decimal "$command_timeout_seconds_raw")" ||
  ! decimal_between "$command_timeout_seconds" 1 300; then
  echo "IRIS_BACKUP_COMMAND_TIMEOUT_SECONDS must be an integer between 1 and 300" >&2
  exit 1
fi
if ! http_timeout_ms="$(normalize_decimal "$http_timeout_ms_raw")" ||
  ! decimal_between "$http_timeout_ms" 100 60000; then
  echo "IRIS_BACKUP_HTTP_TIMEOUT_MS must be an integer between 100 and 60000" >&2
  exit 1
fi

for command_name in docker age flock mktemp tar timeout; do
  command -v "$command_name" >/dev/null
done
test -r "$environment_file"
test -r "$compose_file"
test -r "$recipient_file"

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
runtime_enable_attempted=false

cd "$repository_dir"
compose=(docker compose --env-file "$environment_file" --file "$compose_file")

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

read_runtime_status() {
  run_compose exec -T core node --input-type=module --eval '
    const timeoutMs = Number(process.argv[1]);
    const token = process.env.IRIS_INTERNAL_API_TOKEN?.trim();
    if (!token) throw new Error("IRIS_INTERNAL_API_TOKEN is unavailable inside Core");
    const response = await fetch("http://127.0.0.1:3000/internal/runtime-control/status", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
      throw new Error(`runtime status request failed with HTTP ${response.status}`);
    }
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
  ' "$http_timeout_ms"
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

assert_runtime_disabled_durable() {
  local status
  local global_enabled
  local desired_global_enabled
  local revision
  local persistence_storage
  local persistence_ok
  local activation_required

  status="$(read_runtime_status)" || return 1
  IFS=$'\t' read -r \
    global_enabled \
    desired_global_enabled \
    revision \
    persistence_storage \
    persistence_ok \
    activation_required <<< "$status"
  if [[
    "$global_enabled" != false ||
    "$desired_global_enabled" != false ||
    "$activation_required" != false ||
    "$persistence_storage" != postgres ||
    "$persistence_ok" != true
  ]]; then
    echo "runtime status did not prove durable disabled runtime state: globalEnabled=$global_enabled desiredGlobalEnabled=$desired_global_enabled activationRequired=$activation_required persistence.storage=$persistence_storage persistence.ok=$persistence_ok" >&2
    return 1
  fi
}

read_service_running() {
  local target_service="$1"
  local running_services
  local service_name
  local is_running=false

  if ! running_services="$(run_compose ps --status running --services)"; then
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
  run_compose exec -T core node --input-type=module --eval '
    const expectedText = process.argv[1];
    const timeoutMs = Number(process.argv[2]);
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
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
      throw new Error(`runtime update request failed with HTTP ${response.status}`);
    }
    const body = await response.json();
    if (body.globalEnabled !== expected || body.durable !== true) {
      throw new Error(`expected durable runtime state ${expectedText} after update`);
    }
  ' "$expected" "$http_timeout_ms"
}

assert_runtime_activation_ready() {
  run_compose exec -T core node --input-type=module --eval '
    const timeoutMs = Number(process.argv[1]);
    const token = process.env.IRIS_INTERNAL_API_TOKEN?.trim();
    if (!token) throw new Error("IRIS_INTERNAL_API_TOKEN is unavailable inside Core");
    const response = await fetch("http://127.0.0.1:3000/internal/status", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
      throw new Error(`internal status request failed with HTTP ${response.status}`);
    }
    const body = await response.json();
    if (
      body.ok !== true ||
      body.status !== "healthy" ||
      body.summary?.degradedComponentCount !== 0 ||
      body.summary?.stoppedEnabledRuntimeComponentCount !== 0
    ) {
      throw new Error("internal status did not prove healthy pilot services and healthy workers");
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
  ' "$http_timeout_ms"
}

start_core_disabled() {
  run_compose stop core >/dev/null
  run_compose up --detach --wait --wait-timeout 120 core
  assert_runtime_state false
}

stop_caddy_verified() {
  local attempt
  local caddy_running

  for ((attempt = 1; attempt <= cleanup_retry_count; attempt += 1)); do
    if ! run_compose stop caddy >/dev/null; then
      echo "Caddy stop attempt $attempt failed during fail-closed cleanup" >&2
    fi
    if caddy_running="$(read_service_running caddy)" && [[ "$caddy_running" == false ]]; then
      return 0
    fi
    if ((attempt < cleanup_retry_count)); then
      sleep "$cleanup_retry_delay_seconds"
    fi
  done

  if ! run_compose kill caddy >/dev/null; then
    echo "Caddy kill failed during fail-closed cleanup" >&2
  fi
  caddy_running="$(read_service_running caddy)" || return 1
  [[ "$caddy_running" == false ]]
}

recover_failed_maintenance() {
  local caddy_closed=true
  local durable_disable_proven=true
  local caddy_running

  if ! set_runtime_enabled false; then
    echo "FAIL-CLOSED durable disable mutation failed" >&2
    durable_disable_proven=false
  fi
  if ! stop_caddy_verified; then
    echo "FAIL-CLOSED Caddy stop verification failed" >&2
    caddy_closed=false
  fi
  if ! start_core_disabled; then
    echo "FAIL-CLOSED Core restart in disabled mode failed" >&2
    durable_disable_proven=false
  fi
  if ! assert_runtime_disabled_durable; then
    echo "FAIL-CLOSED durable disabled status verification failed" >&2
    durable_disable_proven=false
  fi
  if ! caddy_running="$(read_service_running caddy)" || [[ "$caddy_running" != false ]]; then
    echo "FAIL-CLOSED final Caddy stopped-state verification failed" >&2
    caddy_closed=false
  fi

  if [[ "$caddy_closed" != true || "$durable_disable_proven" != true ]]; then
    return 1
  fi
}

restore_runtime_state() {
  if [[ "$runtime_was_enabled" == true ]]; then
    assert_runtime_activation_ready
    runtime_enable_attempted=true
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
run_compose stop core

run_compose exec -T postgres sh -eu -c \
  'PGPASSWORD="$IRIS_MIGRATOR_PASSWORD" exec pg_dump --host 127.0.0.1 --username "$IRIS_MIGRATOR_USER" --dbname "$POSTGRES_DB" --format custom' \
  > "$snapshot_dir/postgres.dump"
run_compose exec -T redis redis-cli SAVE > /dev/null
run_compose cp redis:/data/dump.rdb "$snapshot_dir/redis.rdb"
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
restore_runtime_state
if [[ "$caddy_was_running" == true ]]; then
  run_compose up --detach --wait --wait-timeout 120 caddy
fi

find "$backup_dir" -type f -name 'iris-*.bundle.tar.age' -mtime +7 -delete
maintenance_complete=true
printf '%s\n' "$backup_file"
