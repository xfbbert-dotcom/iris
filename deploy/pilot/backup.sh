#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

repository_dir="${IRIS_REPOSITORY_DIR:-/opt/iris/repository}"
environment_file="${IRIS_ENV_FILE:-$repository_dir/.env.pilot}"
compose_file="${IRIS_COMPOSE_FILE:-$repository_dir/deploy/pilot/docker-compose.yml}"
backup_dir="${IRIS_BACKUP_DIR:-$repository_dir/backups}"
recipient_file="${IRIS_BACKUP_RECIPIENT_FILE:-/etc/iris/backup-recipient}"

command -v docker >/dev/null
command -v age >/dev/null
test -r "$environment_file"
test -r "$compose_file"
test -r "$recipient_file"

recipient="$(tr -d '[:space:]' < "$recipient_file")"
if [[ ! "$recipient" =~ ^age1[0-9a-z]+$ ]]; then
  echo "backup recipient file does not contain one valid age recipient" >&2
  exit 1
fi

install -d -m 700 "$backup_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$backup_dir/iris-$timestamp.dump.age"
temporary_file="$backup_dir/.iris-$timestamp.dump.age.tmp"

cleanup() {
  rm -f -- "$temporary_file"
}
trap cleanup EXIT

cd "$repository_dir"
compose=(docker compose --env-file "$environment_file" --file "$compose_file")

"${compose[@]}" exec -T postgres sh -eu -c \
  'exec pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format custom' \
  | age --recipient "$recipient" --output "$temporary_file"

test -s "$temporary_file"
chmod 600 "$temporary_file"
mv -- "$temporary_file" "$backup_file"
trap - EXIT

find "$backup_dir" -type f -name 'iris-*.dump.age' -mtime +7 -delete
printf '%s\n' "$backup_file"
