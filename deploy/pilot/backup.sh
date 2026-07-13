#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

repository_dir="${IRIS_REPOSITORY_DIR:-/opt/iris/repository}"
environment_file="${IRIS_ENV_FILE:-$repository_dir/.env.pilot}"
compose_file="${IRIS_COMPOSE_FILE:-$repository_dir/deploy/pilot/docker-compose.yml}"
backup_dir="${IRIS_BACKUP_DIR:-$repository_dir/backups}"
recipient_file="${IRIS_BACKUP_RECIPIENT_FILE:-/etc/iris/backup-recipient}"

for command_name in docker age flock mktemp tar; do
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

cd "$repository_dir"
compose=(docker compose --env-file "$environment_file" --file "$compose_file")

read_runtime_enabled() {
  "${compose[@]}" exec -T core node --input-type=module --eval '
    const token = process.env.IRIS_INTERNAL_API_TOKEN?.trim();
    if (!token) throw new Error("IRIS_INTERNAL_API_TOKEN is unavailable inside Core");
    const response = await fetch("http://127.0.0.1:3000/internal/runtime-control/status", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`runtime status request failed with HTTP ${response.status}`);
    const body = await response.json();
    if (typeof body.globalEnabled !== "boolean") {
      throw new Error("runtime status did not contain a boolean globalEnabled value");
    }
    process.stdout.write(String(body.globalEnabled));
  '
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
    if (body.globalEnabled !== expected) {
      throw new Error(`expected runtime state ${expectedText} after update`);
    }
  ' "$expected"
}

start_core_disabled() {
  "${compose[@]}" stop core >/dev/null
  "${compose[@]}" up --detach --wait --wait-timeout 120 core
  assert_runtime_state false
}

restore_runtime_state() {
  if [[ "$runtime_was_enabled" == true ]]; then
    set_runtime_enabled true
    assert_runtime_state true
  fi
}

cleanup() {
  local exit_status=$?
  trap - EXIT
  rm -rf -- "$snapshot_dir"
  rm -f -- "$temporary_file"
  if [[ "$maintenance_started" == true && "$maintenance_complete" != true ]]; then
    echo "Backup failed; keeping Iris disabled and Caddy stopped" >&2
    "${compose[@]}" stop caddy >/dev/null 2>&1 || true
    if ! start_core_disabled >/dev/null 2>&1; then
      echo "Backup recovery could not verify a healthy disabled Core" >&2
    fi
  fi
  return "$exit_status"
}
trap cleanup EXIT

runtime_was_enabled="$(read_runtime_enabled)"
if [[ "$runtime_was_enabled" != true && "$runtime_was_enabled" != false ]]; then
  echo "Core returned an invalid global runtime state" >&2
  exit 1
fi

running_services="$("${compose[@]}" ps --status running --services)"
while IFS= read -r service_name; do
  if [[ "$service_name" == caddy ]]; then
    caddy_was_running=true
  fi
done <<< "$running_services"

echo "Stopping Iris briefly for a consistent Postgres and Redis snapshot" >&2
maintenance_started=true
"${compose[@]}" stop caddy core

"${compose[@]}" exec -T postgres sh -eu -c \
  'PGPASSWORD="$IRIS_MIGRATOR_PASSWORD" exec pg_dump --host 127.0.0.1 --username "$IRIS_MIGRATOR_USER" --dbname "$POSTGRES_DB" --format custom' \
  > "$snapshot_dir/postgres.dump"
"${compose[@]}" exec -T redis redis-cli SAVE > /dev/null
"${compose[@]}" cp redis:/data/dump.rdb "$snapshot_dir/redis.rdb"
printf 'created_at=%s\nformat=iris-pilot-paired-v1\n' "$timestamp" \
  > "$snapshot_dir/manifest.txt"

start_core_disabled

tar --create --directory "$snapshot_dir" \
  --file - manifest.txt postgres.dump redis.rdb \
  | age --recipient "$recipient" --output "$temporary_file"

test -s "$temporary_file"
chmod 600 "$temporary_file"
mv -- "$temporary_file" "$backup_file"

restore_runtime_state
if [[ "$caddy_was_running" == true ]]; then
  "${compose[@]}" up --detach --wait --wait-timeout 120 caddy
fi

find "$backup_dir" -type f -name 'iris-*.bundle.tar.age' -mtime +7 -delete
maintenance_complete=true
printf '%s\n' "$backup_file"
