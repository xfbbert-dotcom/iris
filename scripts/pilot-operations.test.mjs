import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const backupPath = "deploy/pilot/backup.sh";
const restorePath = "deploy/pilot/restore-from-stdin.sh";
const postgresInitPath = "deploy/pilot/postgres-init.sh";

test("pilot operation scripts are valid Bash", { skip: bashPath() === undefined }, () => {
  for (const scriptPath of [backupPath, restorePath, postgresInitPath]) {
    const result = spawnSync(bashPath(), ["-n", scriptPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test("Postgres initialization separates admin, migrator, and app roles", () => {
  const script = readFileSync(postgresInitPath, "utf8");
  assert.match(script, /IRIS_MIGRATOR_USER/u);
  assert.match(script, /IRIS_APP_USER/u);
  assert.match(script, /ALTER DEFAULT PRIVILEGES/u);
  assert.match(script, /CREATE EXTENSION IF NOT EXISTS vector/u);
});

test("backup is encrypted, atomic, and cannot mask pipeline failure", () => {
  const script = readFileSync(backupPath, "utf8");
  assert.match(script, /set -Eeuo pipefail/u);
  assert.match(script, /IRIS_BACKUP_RECIPIENT_FILE/u);
  assert.match(script, /flock -n/u);
  assert.match(script, /mktemp/u);
  assert.match(script, /pg_dump/u);
  assert.match(script, /stop caddy core/u);
  assert.match(script, /redis-cli SAVE/u);
  assert.match(script, /redis\.rdb/u);
  assert.match(script, /tar --create/u);
  assert.match(script, /age --recipient/u);
  assert.match(script, /\.tmp/u);
  assert.match(script, /mv -- "\$temporary_file" "\$backup_file"/u);
});

test("restore requires confirmation and fails closed through transactional restore", () => {
  const script = readFileSync(restorePath, "utf8");
  assert.match(script, /--confirm-replace-database/u);
  assert.match(script, /mktemp/u);
  assert.match(script, /pg_restore --list/u);
  assert.match(script, /staging_database/u);
  assert.match(script, /previous_database/u);
  assert.match(script, /redis_previous/u);
  assert.match(script, /grant-app-access\.sql/u);
  assert.match(script, /UPDATE document_sources/u);
  assert.match(script, /iris_forbidden_app_ddl/u);
  assert.match(script, /stop caddy core/u);
  assert.match(script, /createdb/u);
  assert.match(script, /--exit-on-error/u);
  assert.match(script, /--single-transaction/u);
  assert.match(script, /--no-comments/u);
  assert.match(script, /stop redis/u);
  assert.match(script, /appendonlydir/u);
  assert.match(script, /run --rm .* migrate/u);
  assert.match(script, /up --detach --wait/u);
  const swapSql = readFileSync("deploy/pilot/swap-databases.sql", "utf8");
  assert.match(swapSql, /ALTER DATABASE %I RENAME TO %I/u);
  assert.ok(
    script.indexOf("--dbname \"$IRIS_RESTORE_DATABASE\"") <
      script.indexOf("stop caddy core"),
    "the staging database must be fully restored before traffic stops",
  );
  assert.ok(
    script.indexOf("exec node apps/core/dist/database/migrate.js") <
      script.indexOf("stop caddy core"),
    "the staging database must be migrated before traffic stops",
  );
});

function bashPath() {
  if (process.platform !== "win32") {
    return "bash";
  }

  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  return existsSync(gitBash) ? gitBash : undefined;
}
