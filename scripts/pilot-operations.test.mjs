import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const backupPath = "deploy/pilot/backup.sh";
const restorePath = "deploy/pilot/restore-from-stdin.sh";
const semanticRecoveryProbePath = "deploy/pilot/semantic-recovery-probe.sh";
const semanticOrderedReplayPath = "deploy/pilot/semantic-dlq-replay-one-by-one.sh";
const semanticAcceptanceInspectPath = "deploy/pilot/semantic-acceptance-inspect.sh";
const postgresInitPath = "deploy/pilot/postgres-init.sh";
const pilotReadmePath = "deploy/pilot/README.md";
const ciWorkflowPath = ".github/workflows/ci.yml";

test("pilot operation scripts are valid Bash", { skip: bashPath() === undefined }, () => {
  for (const scriptPath of [
    backupPath,
    restorePath,
    semanticRecoveryProbePath,
    semanticOrderedReplayPath,
    semanticAcceptanceInspectPath,
    postgresInitPath,
  ]) {
    const result = spawnSync(bashPath(), ["-n", scriptPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test("pilot shell scripts use LF endings for direct Linux execution", () => {
  for (const scriptPath of [
    backupPath,
    restorePath,
    semanticRecoveryProbePath,
    semanticOrderedReplayPath,
    semanticAcceptanceInspectPath,
    postgresInitPath,
  ]) {
    const script = readFileSync(scriptPath, "utf8");
    assert.equal(script.includes("\r"), false, `${scriptPath} contains a CR byte`);
    assert.ok(script.startsWith("#!/usr/bin/env bash\n"), `${scriptPath} has an invalid shebang`);
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
  assert.match(script, /stop_caddy_verified/u);
  assert.match(script, /stop core/u);
  assert.match(script, /redis-cli SAVE/u);
  assert.match(script, /redis\.rdb/u);
  assert.match(script, /tar --create/u);
  assert.match(script, /age --recipient/u);
  assert.match(script, /\.tmp/u);
  assert.match(script, /mv -- "\$temporary_file" "\$backup_file"/u);
});

test("planned backup restores runtime and ingress state only after publication", () => {
  const script = readFileSync(backupPath, "utf8");
  const captureRuntime = 'runtime_status="$(read_runtime_status)"';
  const disableRuntime = "set_runtime_enabled false";
  const stopCaddy = "stop_caddy_verified";
  const publishBackup = 'mv -- "$temporary_file" "$backup_file"';
  const restoreRuntime = "restore_runtime_state";
  const restoreCaddy = 'if [[ "$caddy_was_running" == true ]]';

  assert.match(script, /\/internal\/runtime-control\/status/u);
  assert.match(script, /\/internal\/runtime-control\/global/u);
  assert.match(script, /IRIS_INTERNAL_API_TOKEN/u);
  assert.match(script, /runtime_status="\$\(read_runtime_status\)"/u);
  assert.match(script, /runtime_revision/u);
  assert.match(script, /runtime_persistence_storage/u);
  assert.match(script, /runtime_persistence_ok/u);
  assert.match(script, /runtime_global_enabled=%s/u);
  assert.match(script, /runtime_revision=%s/u);
  assert.match(script, /caddy_was_running=false/u);
  assert.match(script, /start_core_disabled/u);
  assert.match(script, /expected runtime state/u);
  assert.match(script, /if \[\[ "\$runtime_was_enabled" == true \]\]/u);
  assert.match(script, /if \[\[ "\$caddy_was_running" == true \]\]/u);
  assert.match(script, /body\.durable !== true/u);

  const restoreStart = script.indexOf("restore_runtime_state() {");
  const restoreEnd = script.indexOf("cleanup() {", restoreStart);
  const restore = script.slice(restoreStart, restoreEnd);
  assert.doesNotMatch(restore, /desiredGlobalEnabled|runtime_desired/u);

  const captureRuntimeIndex = script.lastIndexOf(captureRuntime);
  const disableRuntimeIndex = script.lastIndexOf(`\n${disableRuntime}\n`);
  assert.ok(
    captureRuntimeIndex < disableRuntimeIndex,
    "runtime state must be captured before Core stops",
  );
  assert.ok(
    disableRuntimeIndex < script.indexOf(stopCaddy, disableRuntimeIndex),
    "live runtime must be disabled before Caddy stops",
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

test("planned backup gates explicit restoration on durable status, healthy workers, and empty queues", () => {
  const script = readFileSync(backupPath, "utf8");
  assert.match(script, /persistence\?\.storage !== "postgres"/u);
  assert.match(script, /persistence\.ok !== true/u);
  assert.match(script, /pendingEventCount/u);
  assert.match(script, /deadLetterEventCount/u);
  assert.match(script, /pendingJobCount/u);
  assert.match(script, /deadLetterJobCount/u);

  const publishBackup = script.indexOf('mv -- "$temporary_file" "$backup_file"');
  const postRestartGate = script.indexOf("assert_runtime_activation_ready", publishBackup);
  const restoreRuntime = script.lastIndexOf("restore_runtime_state");
  assert.ok(postRestartGate > publishBackup, "post-restart gates must run after backup publication");
  assert.ok(postRestartGate < restoreRuntime, "post-restart gates must pass before restoration");
});

test("backup bounds every embedded HTTP request with a validated operator timeout", () => {
  const script = readFileSync(backupPath, "utf8");
  assert.match(script, /IRIS_BACKUP_HTTP_TIMEOUT_MS/u);
  assert.match(script, /10000/u);
  assert.match(script, /must be an integer between 100 and 60000/u);
  assert.equal(
    script.match(/AbortSignal\.timeout\(timeoutMs\)/gu)?.length,
    3,
    "status, mutation, and aggregate status fetches must all be bounded",
  );
});

test("backup validates decimal deadlines and bounds every Compose command", () => {
  const script = readFileSync(backupPath, "utf8");
  assert.match(script, /IRIS_BACKUP_COMMAND_TIMEOUT_SECONDS/u);
  assert.match(script, /normalize_decimal/u);
  assert.match(script, /IRIS_BACKUP_CLEANUP_RETRY_DELAY_SECONDS must be an integer between 0 and 10/u);
  assert.match(script, /cleanup_retry_count=3/u);
  assert.match(script, /timeout --kill-after=/u);
  assert.doesNotMatch(script, /timeout[^\n]*--foreground/u);
  assert.match(script, /docker compose .* timed out after/u);
  assert.doesNotMatch(script, /\$\(\(http_timeout_ms/u);
});

test("fail-closed cleanup requires durable disabled intent after restart", () => {
  const script = readFileSync(backupPath, "utf8");
  const recoveryStart = script.indexOf("recover_failed_maintenance() {");
  const recoveryEnd = script.indexOf("restore_runtime_state() {", recoveryStart);
  const recovery = script.slice(recoveryStart, recoveryEnd);
  assert.match(recovery, /set_runtime_enabled false/u);
  assert.doesNotMatch(recovery, /set_runtime_enabled false[^\n]*2>&1/u);
  assert.match(recovery, /assert_runtime_disabled_durable/u);
  assert.match(script, /"\$global_enabled" != false/u);
  assert.match(script, /"\$desired_global_enabled" != false/u);
  assert.match(script, /"\$activation_required" != false/u);
});

test("backup verifies explicit restoration before starting Caddy", () => {
  const script = readFileSync(backupPath, "utf8");
  const publishIndex = script.indexOf('mv -- "$temporary_file" "$backup_file"');
  const restorationIndex = script.lastIndexOf("restore_runtime_state");
  const caddyStartIndex = script.lastIndexOf("run_compose up --detach --wait --wait-timeout 120 caddy");
  assert.ok(publishIndex < restorationIndex, "restoration must follow publication");
  assert.ok(restorationIndex < caddyStartIndex, "Caddy must start after verified restoration");

  const restoreStart = script.indexOf("restore_runtime_state() {");
  const restoreEnd = script.indexOf("cleanup() {", restoreStart);
  const restore = script.slice(restoreStart, restoreEnd);
  assert.match(restore, /runtime_enable_attempted=true[\s\S]*set_runtime_enabled true/u);
  assert.match(restore, /set_runtime_enabled true[\s\S]*assert_runtime_state true/u);
});

test("backup failure cleanup keeps Iris disabled and Caddy stopped", () => {
  const script = readFileSync(backupPath, "utf8");
  const cleanupStart = script.indexOf("cleanup() {");
  const cleanupEnd = script.indexOf("trap cleanup EXIT");
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart);

  const cleanup = script.slice(cleanupStart, cleanupEnd);
  assert.match(cleanup, /recover_failed_maintenance/u);
  assert.doesNotMatch(cleanup, /restore_runtime_state/u);
  assert.doesNotMatch(cleanup, /up .*caddy/u);
});

test("pilot runbook defines fail-closed restart, reactivation, and rollback ordering", () => {
  const readme = readFileSync(pilotReadmePath, "utf8");
  const orderedMarkers = [
    "POST global false",
    "Stop Caddy",
    "Verify workers, queues, and DLQs",
    "Create the paired Postgres backup",
    "Deploy migration and Core while Caddy remains stopped",
    "persistence.ok=true, globalEnabled=false",
    "Recheck that all workers are healthy and running and every queue and DLQ count is `0`",
    "Explicitly POST global true",
    "Start Caddy only after authenticated internal gates pass",
    "Run real Feishu acceptance",
  ];
  let previousIndex = -1;
  for (const marker of orderedMarkers) {
    const markerIndex = readme.indexOf(marker);
    assert.ok(markerIndex > previousIndex, `${marker} must appear in restart order`);
    previousIndex = markerIndex;
  }

  assert.match(readme, /durable=true/u);
  assert.match(readme, /desiredGlobalEnabled=true.*never.*auto-enable/isu);
  assert.match(
    readme,
    /restoring the Postgres snapshot\s+restores durable intent but never live activation/iu,
  );
  assert.match(readme, /backup, migration, or status.*Iris disabled and Caddy stopped/isu);
});

test("pilot runbook documents bounded backup cleanup controls", () => {
  const readme = readFileSync(pilotReadmePath, "utf8");
  assert.match(readme, /IRIS_BACKUP_COMMAND_TIMEOUT_SECONDS.*30.*1.*300/isu);
  assert.match(readme, /IRIS_BACKUP_CLEANUP_RETRY_DELAY_SECONDS.*2.*0.*10/isu);
  assert.match(readme, /exactly three Caddy stop attempts/iu);
});

test("semantic recovery probe checks fail-closed state and never replays DLQ entries", () => {
  const script = readFileSync(semanticRecoveryProbePath, "utf8");
  assert.match(script, /docker compose --env-file/u);
  assert.match(script, /exec -T core node --input-type=module/u);
  assert.match(script, /\/internal\/status/u);
  assert.match(script, /\/internal\/runtime-control\/status/u);
  assert.match(script, /\/internal\/memory-extraction\/status/u);
  assert.match(script, /\/internal\/memory-extraction\/dead-letters\?limit=20/u);
  assert.match(script, /\/v1\/memory\/extract/u);
  assert.match(script, /schema_version: 2/u);
  assert.match(script, /globalEnabled !== false/u);
  assert.match(script, /desiredGlobalEnabled !== false/u);
  assert.match(script, /proactiveSpeech !== false/u);
  assert.match(script, /dlq\.deadLetters\.length !== 6/u);
  assert.match(script, /classifyProbeFailure/u);
  assert.doesNotMatch(script, /\/replay/u);
  assert.doesNotMatch(script, /console\.log\(.*internalToken/u);
  assert.doesNotMatch(script, /console\.log\(.*aiWorkerToken/u);
});

test("semantic ordered replay helper gates execution and replays one DLQ at a time", () => {
  const script = readFileSync(semanticOrderedReplayPath, "utf8");
  assert.match(script, /IRIS_SEMANTIC_REPLAY_CONFIRM/u);
  assert.match(script, /semantic-recovery-probe\.sh/u);
  assert.match(script, /\/internal\/runtime-control\/global/u);
  assert.match(script, /\/internal\/runtime-control\/groups\/\$\{groupId\}/u);
  assert.match(script, /\/internal\/memory-extraction\/dead-letters\?limit=20/u);
  assert.match(script, /sort\(\(a, b\) => String\(a\.enqueuedAt/u);
  assert.match(script, /\/internal\/memory-extraction\/dead-letters\/\$\{encodeURIComponent\(deadLetter\.id\)\}\/replay/u);
  assert.match(script, /await waitForMemoryDrain/u);
  assert.match(script, /for \(const deadLetter of orderedDeadLetters\)/u);
  assert.match(script, /remainingAllowedIds\.delete\(deadLetter\.id\)/u);
  assert.match(script, /assertOnlyRemainingOriginalDlq\(remainingAllowedIds\)/u);
  assert.match(script, /unexpectedIds\.length > 0/u);
  assert.match(script, /finally \{/u);
  assert.match(script, /globalEnabled !== false/u);
  assert.match(script, /desiredGlobalEnabled !== false/u);
  assert.match(script, /proactiveSpeech/u);
  assert.match(script, /stop caddy/u);
  assert.doesNotMatch(script, /dead-letters\/replay/u);
  assert.doesNotMatch(script, /\/v1\/memory\/extract/u);
});

test("semantic acceptance inspector validates lifecycle without mutating runtime or public ingress", () => {
  const script = readFileSync(semanticAcceptanceInspectPath, "utf8");
  assert.match(script, /IRIS_SEMANTIC_ACCEPTANCE_PILOT_GROUP_ID/u);
  assert.match(script, /IRIS_SEMANTIC_ACCEPTANCE_CONTROL_GROUP_ID/u);
  assert.match(script, /exec -T core node --input-type=module/u);
  assert.match(script, /\/internal\/runtime-control\/status/u);
  assert.match(script, /\/internal\/status/u);
  assert.match(script, /\/internal\/memory-extraction\/status/u);
  assert.match(script, /\/internal\/memory-extraction\/dead-letters\?limit=20/u);
  assert.match(script, /\/internal\/conversation-state\/groups\/\$\{encodeURIComponent\(pilotGroupId\)\}\/threads/u);
  assert.match(script, /\/internal\/conversation-state\/groups\/\$\{encodeURIComponent\(pilotGroupId\)\}\/actions/u);
  assert.match(script, /\/internal\/conversation-state\/threads\/\$\{encodeURIComponent\(thread\.id\)\}\/events/u);
  assert.match(script, /\/internal\/conversation-state\/actions\/\$\{encodeURIComponent\(action\.id\)\}\/events/u);
  assert.match(script, /created/u);
  assert.match(script, /promoted/u);
  assert.match(script, /resolved/u);
  assert.match(script, /reopened/u);
  assert.match(script, /completed/u);
  assert.match(script, /hasDuplicateLifecycleVersions/u);
  assert.match(script, /projectionRepairs/u);
  assert.match(script, /controlGroupId/u);
  assert.doesNotMatch(script, /\/internal\/runtime-control\/global/u);
  assert.doesNotMatch(script, /\/internal\/memory-extraction\/dead-letters\/.*\/replay/u);
  assert.doesNotMatch(script, /stop caddy/u);
  assert.doesNotMatch(script, /\/v1\/memory\/extract/u);
});

test("pilot rollback documents decrypted stdin restore and Caddy-last reactivation", () => {
  const readme = readFileSync(pilotReadmePath, "utf8");
  const rollback = readme.slice(readme.indexOf("## Rollback"));
  assert.match(rollback, /IRIS_BACKUP_IDENTITY_FILE/u);
  assert.match(
    rollback,
    /age --decrypt --identity "\$IRIS_BACKUP_IDENTITY_FILE" "\$backup_file"\s*\\\s*\| \.\/deploy\/pilot\/restore-from-stdin\.sh --confirm-replace-database/u,
  );
  const pipelineIndex = rollback.indexOf("age --decrypt");
  const localhostGateIndex = rollback.indexOf("authenticated localhost gates");
  const enableIndex = rollback.indexOf("Explicitly POST global true");
  const caddyIndex = rollback.indexOf("Start Caddy last");
  assert.ok(pipelineIndex < localhostGateIndex);
  assert.ok(localhostGateIndex < enableIndex);
  assert.ok(enableIndex < caddyIndex);
});

test("CI runs the private-first post-restore smoke mode after restore", () => {
  const workflow = readFileSync(ciWorkflowPath, "utf8");
  const restore = workflow.indexOf("restore-from-stdin.sh --confirm-replace-database");
  const postRestoreSmoke = workflow.indexOf(
    "npm run pilot:smoke -- --post-restore",
    restore,
  );
  assert.ok(restore >= 0);
  assert.ok(postRestoreSmoke > restore);
});

test("CI keeps the pilot queues empty before the backup drill", () => {
  const workflow = readFileSync(ciWorkflowPath, "utf8");
  const startStack = workflow.indexOf("- name: Start pilot stack");
  const backupDrill = workflow.indexOf(
    "- name: Drill paired pilot backup and restore",
    startStack,
  );

  assert.ok(startStack >= 0);
  assert.ok(backupDrill > startStack);
  assert.doesNotMatch(
    workflow.slice(startStack, backupDrill),
    /npm run pilot:smoke(?:\s|$)/u,
  );
});

test("CI waits for queue drain after Redis recovery before ordinary smoke", () => {
  const workflow = readFileSync(ciWorkflowPath, "utf8");
  const redisRecovery = workflow.indexOf(
    "- name: Reject callbacks while Redis ingress is unavailable",
  );
  const ordinarySmoke = workflow.indexOf("npm run pilot:smoke", redisRecovery);
  const recoveryGate = workflow.slice(redisRecovery, ordinarySmoke);

  assert.ok(redisRecovery >= 0);
  assert.ok(ordinarySmoke > redisRecovery);
  assert.match(recoveryGate, /pendingEventCount/u);
  assert.match(recoveryGate, /pendingJobCount/u);
  assert.match(recoveryGate, /deadLetterEventCount/u);
  assert.match(recoveryGate, /deadLetterJobCount/u);
  assert.match(recoveryGate, /test "\$queues_drained" = true/u);
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
  assert.match(script, /stop_caddy_verified/u);
  assert.match(script, /run_compose stop core/u);
  assert.match(script, /createdb/u);
  assert.match(script, /--exit-on-error/u);
  assert.match(script, /--single-transaction/u);
  assert.match(script, /--no-comments/u);
  assert.match(script, /stop redis/u);
  assert.match(script, /appendonlydir/u);
  assert.match(script, /run --rm .* migrate/u);
  assert.match(script, /up --detach --wait/u);
  const postSwap = script.slice(script.indexOf("stop_caddy_verified"));
  assert.match(postSwap, /run_compose up --detach --wait --wait-timeout 120 core/u);
  assert.doesNotMatch(postSwap, /up --detach[^\n]*caddy/u);
  const swapSql = readFileSync("deploy/pilot/swap-databases.sql", "utf8");
  assert.match(swapSql, /ALTER DATABASE %I RENAME TO %I/u);
  const grantSql = readFileSync("deploy/pilot/grant-app-access.sql", "utf8");
  assert.match(grantSql, /ALTER DEFAULT PRIVILEGES/u);
  const destructiveStop = script.lastIndexOf("\nstop_caddy_verified\n");
  assert.ok(
    script.indexOf("--dbname \"$IRIS_RESTORE_DATABASE\"") <
      destructiveStop,
    "the staging database must be fully restored before traffic stops",
  );
  assert.ok(
    script.indexOf("exec node apps/core/dist/database/migrate.js") <
      destructiveStop,
    "the staging database must be migrated before traffic stops",
  );
});

test("restore validates decimal deadlines and bounds every Compose operation", () => {
  const script = readFileSync(restorePath, "utf8");
  assert.match(script, /IRIS_RESTORE_COMMAND_TIMEOUT_SECONDS/u);
  assert.match(script, /IRIS_RESTORE_CLEANUP_RETRY_DELAY_SECONDS/u);
  assert.match(script, /normalize_decimal/u);
  assert.match(script, /cleanup_retry_count=3/u);
  assert.match(script, /timeout --kill-after=/u);
  assert.doesNotMatch(script, /timeout[^\n]*--foreground/u);
  assert.equal(
    script.match(/"\$\{compose\[@\]\}"/gu)?.length,
    1,
    "only run_compose may invoke the Compose array",
  );
});

test("restore proves Caddy stopped before stopping Core or swapping databases", () => {
  const script = readFileSync(restorePath, "utf8");
  const stopCaddy = script.lastIndexOf("\nstop_caddy_verified\n");
  const stopCore = script.indexOf("run_compose stop core", stopCaddy);
  const swapDatabase = script.indexOf("swap-databases.sql", stopCore);
  assert.ok(stopCaddy >= 0);
  assert.ok(stopCaddy < stopCore);
  assert.ok(stopCore < swapDatabase);
});

function bashPath() {
  if (process.platform !== "win32") {
    return "bash";
  }

  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  return existsSync(gitBash) ? gitBash : undefined;
}
