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

test("planned backup restores runtime and ingress state only after publication", () => {
  const script = readFileSync(backupPath, "utf8");
  const captureRuntime = 'runtime_was_enabled="$(read_runtime_enabled)"';
  const stopServices = '"${compose[@]}" stop caddy core';
  const publishBackup = 'mv -- "$temporary_file" "$backup_file"';
  const restoreRuntime = "restore_runtime_state";
  const restoreCaddy = 'if [[ "$caddy_was_running" == true ]]';

  assert.match(script, /\/internal\/runtime-control\/status/u);
  assert.match(script, /\/internal\/runtime-control\/global/u);
  assert.match(script, /IRIS_INTERNAL_API_TOKEN/u);
  assert.match(script, /runtime_was_enabled="\$\(read_runtime_enabled\)"/u);
  assert.match(script, /caddy_was_running=false/u);
  assert.match(script, /start_core_disabled/u);
  assert.match(script, /expected runtime state/u);
  assert.match(script, /if \[\[ "\$runtime_was_enabled" == true \]\]/u);
  assert.match(script, /if \[\[ "\$caddy_was_running" == true \]\]/u);

  assert.ok(
    script.indexOf(captureRuntime) < script.indexOf(stopServices),
    "runtime state must be captured before Core stops",
  );
  assert.ok(
    script.indexOf(publishBackup) < script.lastIndexOf(restoreRuntime),
    "runtime state must be restored only after atomic backup publication",
  );
  assert.ok(
    script.indexOf(publishBackup) < script.lastIndexOf(restoreCaddy),
    "Caddy must be restored only after atomic backup publication",
  );
});

test("backup failure cleanup keeps Iris disabled and Caddy stopped", () => {
  const script = readFileSync(backupPath, "utf8");
  const cleanupStart = script.indexOf("cleanup() {");
  const cleanupEnd = script.indexOf("trap cleanup EXIT");
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart);

  const cleanup = script.slice(cleanupStart, cleanupEnd);
  assert.match(cleanup, /stop caddy/u);
  assert.match(cleanup, /start_core_disabled/u);
  assert.doesNotMatch(cleanup, /restore_runtime_state/u);
  assert.doesNotMatch(cleanup, /up .*caddy/u);
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
  assert.match(script, /iris_restore_permission_probe/u);
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
  const grantSql = readFileSync("deploy/pilot/grant-app-access.sql", "utf8");
  assert.match(grantSql, /ALTER DEFAULT PRIVILEGES/u);
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
