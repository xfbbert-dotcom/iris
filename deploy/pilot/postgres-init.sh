#!/usr/bin/env bash
set -Eeuo pipefail

required=(
  POSTGRES_USER
  POSTGRES_DB
  IRIS_MIGRATOR_USER
  IRIS_MIGRATOR_PASSWORD
  IRIS_APP_USER
  IRIS_APP_PASSWORD
)
for variable_name in "${required[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "$variable_name is required" >&2
    exit 1
  fi
done

psql --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=on \
  --set "database_name=$POSTGRES_DB" \
  --set "migrator_user=$IRIS_MIGRATOR_USER" \
  --set "migrator_password=$IRIS_MIGRATOR_PASSWORD" \
  --set "app_user=$IRIS_APP_USER" \
  --set "app_password=$IRIS_APP_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'migrator_user', :'migrator_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'migrator_user') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'database_name', :'migrator_user') \gexec
SQL

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=on \
  --set "database_name=$POSTGRES_DB" \
  --set "migrator_user=$IRIS_MIGRATOR_USER" \
  --set "app_user=$IRIS_APP_USER" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database_name', :'app_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_user') \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
  :'migrator_user',
  :'app_user'
) \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
  :'migrator_user',
  :'app_user'
) \gexec
SQL
