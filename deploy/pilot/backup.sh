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
services_stopped=false

cd "$repository_dir"
compose=(docker compose --env-file "$environment_file" --file "$compose_file")

cleanup() {
  rm -rf -- "$snapshot_dir"
  rm -f -- "$temporary_file"
  if [[ "$services_stopped" == true ]]; then
    "${compose[@]}" up --detach --wait --wait-timeout 120 core caddy >/dev/null || true
  fi
}
trap cleanup EXIT

echo "Stopping Iris briefly for a consistent Postgres and Redis snapshot" >&2
"${compose[@]}" stop caddy core
services_stopped=true

"${compose[@]}" exec -T postgres sh -eu -c \
  'PGPASSWORD="$IRIS_MIGRATOR_PASSWORD" exec pg_dump --host 127.0.0.1 --username "$IRIS_MIGRATOR_USER" --dbname "$POSTGRES_DB" --format custom' \
  > "$snapshot_dir/postgres.dump"
"${compose[@]}" exec -T redis redis-cli SAVE > /dev/null
"${compose[@]}" cp redis:/data/dump.rdb "$snapshot_dir/redis.rdb"
printf 'created_at=%s\nformat=iris-pilot-paired-v1\n' "$timestamp" \
  > "$snapshot_dir/manifest.txt"

"${compose[@]}" up --detach --wait --wait-timeout 120 core caddy
services_stopped=false

tar --create --directory "$snapshot_dir" \
  --file - manifest.txt postgres.dump redis.rdb \
  | age --recipient "$recipient" --output "$temporary_file"

test -s "$temporary_file"
chmod 600 "$temporary_file"
mv -- "$temporary_file" "$backup_file"
trap - EXIT
rm -rf -- "$snapshot_dir"

find "$backup_dir" -type f -name 'iris-*.bundle.tar.age' -mtime +7 -delete
printf '%s\n' "$backup_file"
