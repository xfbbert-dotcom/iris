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

temporary_dump="$(mktemp "${TMPDIR:-/tmp}/iris-restore.XXXXXX.dump")"
cleanup() {
  rm -f -- "$temporary_dump"
}
trap cleanup EXIT

cat > "$temporary_dump"
test -s "$temporary_dump"
"${compose[@]}" exec -T postgres sh -eu -c 'exec pg_restore --list' \
  < "$temporary_dump" > /dev/null

echo "Stopping Iris traffic before replacing the pilot database" >&2
"${compose[@]}" stop caddy core

"${compose[@]}" exec -T postgres sh -eu -c '
  dropdb --username "$POSTGRES_USER" --if-exists --force "$POSTGRES_DB"
  createdb --username "$POSTGRES_USER" --owner "$POSTGRES_USER" "$POSTGRES_DB"
'

"${compose[@]}" exec -T postgres sh -eu -c '
  exec pg_restore \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --exit-on-error \
    --single-transaction \
    --no-owner \
    --no-privileges
' < "$temporary_dump"

"${compose[@]}" run --rm migrate
"${compose[@]}" run --rm --no-deps core \
  node apps/core/dist/admin/internal-rollout-readiness-cli.js
"${compose[@]}" up --detach --wait --wait-timeout 120 core caddy

echo "Restore completed; repeat private status, DLQ, and Feishu smoke checks" >&2
