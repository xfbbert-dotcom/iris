#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const restorePath = resolve("deploy/pilot/restore-from-stdin.sh");
const gitBash = bashPath();

for (const hangPoint of ["daemon", "process-tree"]) {
  test(
    `restore bounds a fake Docker ${hangPoint} hang and leaves Caddy stopped`,
    { skip: gitBash === undefined },
    async () => {
      const result = runRestore({ hangPoint });
      try {
        assert.notEqual(result.status, 0);
        assert.equal(result.error, undefined, "restore must beat the harness watchdog");
        assert.ok(result.elapsedMs < 10_000, `${hangPoint} hang took ${result.elapsedMs}ms`);
        assert.equal(result.caddyRunning, false, result.stderr || result.stdout);
        assert.match(result.stderr, /timed out after 1s/u);
        assert.ok(result.processTreePids.length >= 1);
        assert.deepEqual(
          await waitForPidsToExit(result.processTreePids, 2_000),
          [],
          `restore left ${hangPoint} PIDs alive`,
        );
      } finally {
        killResidualPids(result.processTreePids.filter(isPidAlive));
        result.cleanup();
      }
    },
  );
}

test(
  "restore retries a partial Caddy stop and proves stopped before database swap",
  { skip: gitBash === undefined },
  async () => {
    const result = runRestore({ partialStopCount: 3 });
    try {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.caddyRunning, false);
      assert.equal(result.stopCaddyCount, 3);
      assert.ok(result.log.indexOf("verify-caddy-stopped") < result.log.indexOf("swap-database"));
      assert.deepEqual(await waitForPidsToExit(result.processTreePids, 500), []);
    } finally {
      killResidualPids(result.processTreePids.filter(isPidAlive));
      result.cleanup();
    }
  },
);

test(
  "migration failure exits bounded without swapping the database and stops Caddy",
  { skip: gitBash === undefined },
  async () => {
    const result = runRestore({ failurePoint: "migration" });
    try {
      assert.notEqual(result.status, 0);
      assert.equal(result.error, undefined);
      assert.ok(result.elapsedMs < 10_000);
      assert.equal(result.caddyRunning, false, result.stderr || result.stdout);
      assert.doesNotMatch(result.log, /swap-database/u);
      assert.deepEqual(await waitForPidsToExit(result.processTreePids, 500), []);
    } finally {
      killResidualPids(result.processTreePids.filter(isPidAlive));
      result.cleanup();
    }
  },
);

test(
  "Core restart failure reruns verified fail-closed Caddy cleanup",
  { skip: gitBash === undefined },
  async () => {
    const result = runRestore({ failurePoint: "restart" });
    try {
      assert.notEqual(result.status, 0);
      assert.equal(result.error, undefined);
      assert.ok(result.elapsedMs < 10_000);
      assert.equal(result.caddyRunning, false, result.stderr || result.stdout);
      assert.match(result.log, /swap-database/u);
      assert.ok(result.stopCaddyCount >= 2, result.log);
      assert.deepEqual(await waitForPidsToExit(result.processTreePids, 500), []);
    } finally {
      killResidualPids(result.processTreePids.filter(isPidAlive));
      result.cleanup();
    }
  },
);

function runRestore({ failurePoint = "", hangPoint = "", partialStopCount = 0 }) {
  const root = mkdtempSync(resolve(".tmp-iris-restore-test-"));
  const fakeBin = resolve(root, "bin");
  const stateDir = resolve(root, "state");
  const backupDir = resolve(root, "backups");
  const bundleDir = resolve(root, "bundle");
  mkdirSync(fakeBin);
  mkdirSync(stateDir);
  mkdirSync(backupDir);
  mkdirSync(bundleDir);

  writeFileSync(resolve(root, ".env.pilot"), "IRIS_IMAGE_TAG=test\n");
  writeFileSync(resolve(root, "compose.yml"), "services: {}\n");
  writeFileSync(
    resolve(root, "bash-env"),
    'install() { local destination="${!#}"; mkdir -p "$destination"; }\n' +
      'chmod() { return 0; }\n',
  );
  writeFileSync(resolve(stateDir, "caddy"), "true");
  writeFileSync(resolve(stateDir, "core"), "true");
  writeFileSync(resolve(stateDir, "redis"), "true");
  writeFileSync(resolve(stateDir, "operations.log"), "");
  writeFileSync(resolve(stateDir, "stop-caddy-count"), "0");
  writeFileSync(resolve(bundleDir, "manifest.txt"), "format=iris-pilot-paired-v1\n");
  writeFileSync(resolve(bundleDir, "postgres.dump"), "fake-postgres-dump");
  writeFileSync(resolve(bundleDir, "redis.rdb"), "fake-redis-rdb");
  const bundlePath = resolve(root, "restore.bundle.tar");
  const tarResult = spawnSync(
    "tar",
    ["--create", "--file", bundlePath, "manifest.txt", "postgres.dump", "redis.rdb"],
    { cwd: bundleDir, encoding: "utf8" },
  );
  assert.equal(tarResult.status, 0, tarResult.stderr || tarResult.stdout);

  writeExecutable(resolve(fakeBin, "docker"), fakeDockerScript);
  writeExecutable(resolve(fakeBin, "flock"), "#!/usr/bin/env bash\nexit 0\n");

  const environment = { ...process.env };
  delete environment.Path;
  delete environment.PATH;
  Object.assign(environment, {
    PATH: `${toBashPath(fakeBin)}:/mingw64/bin:/usr/bin:/bin`,
    IRIS_REPOSITORY_DIR: toBashPath(root),
    IRIS_ENV_FILE: toBashPath(resolve(root, ".env.pilot")),
    IRIS_COMPOSE_FILE: toBashPath(resolve(root, "compose.yml")),
    IRIS_BACKUP_DIR: toBashPath(backupDir),
    IRIS_RESTORE_COMMAND_TIMEOUT_SECONDS: "1",
    IRIS_RESTORE_CLEANUP_RETRY_DELAY_SECONDS: "0",
    IRIS_TEST_FAIL_POINT: failurePoint,
    IRIS_TEST_HANG_POINT: hangPoint,
    IRIS_TEST_PARTIAL_STOP_COUNT: String(partialStopCount),
    IRIS_TEST_STATE_DIR: toBashPath(stateDir),
    BASH_ENV: toBashPath(resolve(root, "bash-env")),
  });

  const startedAt = Date.now();
  const result = spawnSync(
    gitBash,
    [toBashPath(restorePath), "--confirm-replace-database"],
    {
      cwd: root,
      encoding: "utf8",
      env: environment,
      input: readFileSync(bundlePath),
      timeout: 12_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const elapsedMs = Date.now() - startedAt;
  const processTreePids = ["process-parent.pid", "process-child.pid"]
    .map((name) => resolve(stateDir, name))
    .filter(existsSync)
    .map((path) => Number(readFileSync(path, "utf8").trim()))
    .filter(Number.isSafeInteger);

  return {
    status: result.status,
    error: result.error,
    elapsedMs,
    stderr: result.stderr,
    stdout: result.stdout,
    caddyRunning: readFileSync(resolve(stateDir, "caddy"), "utf8").trim() === "true",
    stopCaddyCount: Number(readFileSync(resolve(stateDir, "stop-caddy-count"), "utf8")),
    log: readFileSync(resolve(stateDir, "operations.log"), "utf8"),
    processTreePids,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }),
  };
}

function writeExecutable(path, content) {
  writeFileSync(path, content.replaceAll("\r\n", "\n"));
  chmodSync(path, 0o755);
}

function toBashPath(path) {
  return path
    .replace(/^([A-Za-z]):[\\/]/u, (_, drive) => `/${drive.toLowerCase()}/`)
    .replaceAll("\\", "/");
}

function bashPath() {
  if (process.platform !== "win32") return "bash";
  const path = "C:\\Program Files\\Git\\bin\\bash.exe";
  return existsSync(path) ? path : undefined;
}

async function waitForPidsToExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let survivors = pids.filter(isPidAlive);
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    survivors = pids.filter(isPidAlive);
  }
  return survivors;
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    return spawnSync(gitBash, ["-lc", `kill -0 ${pid} 2>/dev/null`]).status === 0;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function killResidualPids(pids) {
  if (pids.length === 0) return;
  if (process.platform === "win32") {
    spawnSync(gitBash, ["-lc", `kill -KILL ${pids.join(" ")} 2>/dev/null || true`]);
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

const fakeDockerScript = `#!/usr/bin/env bash
set -Eeuo pipefail

state_dir="$IRIS_TEST_STATE_DIR"
fail_point="\${IRIS_TEST_FAIL_POINT:-}"
hang_point="\${IRIS_TEST_HANG_POINT:-}"
partial_stop_count="\${IRIS_TEST_PARTIAL_STOP_COUNT:-0}"
log_file="$state_dir/operations.log"

log() { printf '%s\\n' "$*" >> "$log_file"; }

hang_command() {
  local with_child="$1"
  trap '' TERM
  printf '%s' "$BASHPID" > "$state_dir/process-parent.pid"
  if [[ "$with_child" == true ]]; then
    (
      trap '' TERM
      while :; do sleep 1; done
    ) &
    child_pid=$!
    printf '%s' "$child_pid" > "$state_dir/process-child.pid"
    wait "$child_pid"
  else
    while :; do sleep 1; done
  fi
}

[[ "$1" == compose ]]
shift
while [[ "\${1:-}" == --env-file || "\${1:-}" == --file ]]; do shift 2; done
operation="$1"
shift
arguments=" $* "

if [[ "$operation" == exec && "$arguments" == *" pg_restore --list"* && ! -e "$state_dir/hang-complete" ]]; then
  : > "$state_dir/hang-complete"
  if [[ "$hang_point" == daemon ]]; then hang_command false; fi
  if [[ "$hang_point" == process-tree ]]; then hang_command true; fi
fi

case "$operation" in
  ps)
    [[ "$(cat "$state_dir/caddy")" == true ]] && printf 'caddy\\n'
    [[ "$(cat "$state_dir/core")" == true ]] && printf 'core\\n'
    [[ "$(cat "$state_dir/redis")" == true ]] && printf 'redis\\n'
    ;;
  stop)
    for service in "$@"; do
      case "$service" in
        caddy)
          count=$(( $(cat "$state_dir/stop-caddy-count") + 1 ))
          printf '%s' "$count" > "$state_dir/stop-caddy-count"
          if ((count < partial_stop_count)); then
            log "partial-stop-caddy $count"
          else
            printf 'false' > "$state_dir/caddy"
            log "stop-caddy $count"
          fi
          ;;
        core) printf 'false' > "$state_dir/core"; log stop-core ;;
        redis) printf 'false' > "$state_dir/redis"; log stop-redis ;;
      esac
    done
    ;;
  kill)
    if [[ "\${!#}" == caddy ]]; then
      printf 'false' > "$state_dir/caddy"
      log kill-caddy
    fi
    ;;
  cp)
    destination="\${!#}"
    printf 'previous-redis' > "$destination"
    log copy-redis
    ;;
  up)
    service="\${!#}"
    if [[ "$service" == redis ]]; then
      printf 'true' > "$state_dir/redis"
      log start-redis
    elif [[ "$service" == core ]]; then
      if [[ "$fail_point" == restart ]]; then
        log fail-restart
        exit 42
      fi
      printf 'true' > "$state_dir/core"
      log start-core
    fi
    ;;
  run)
    if [[ "$arguments" == *" migrate sh "* ]]; then
      log migrate
      if [[ "$fail_point" == migration ]]; then exit 42; fi
    elif [[ "$arguments" == *" --entrypoint sh redis "* ]]; then
      log restore-redis
    elif [[ "$arguments" == *" core node "* ]]; then
      log readiness
    fi
    ;;
  exec)
    if [[ "$arguments" == *"IRIS_PREVIOUS_DATABASE="* || "$arguments" == *"target_database="* ]]; then
      if [[ "$(cat "$state_dir/caddy")" == true ]]; then
        log swap-while-caddy-running
        exit 45
      fi
      log verify-caddy-stopped
      log swap-database
    elif [[ "$arguments" == *" dropdb "* ]]; then
      log drop-staging
    elif [[ "$arguments" == *" redis-cli SAVE"* ]]; then
      log save-redis
    elif [[ "$arguments" == *" createdb "* ]]; then
      log create-staging
    elif [[ "$arguments" == *" pg_restore "* ]]; then
      log restore-staging
    elif [[ "$arguments" == *" grant-app-access.sql"* ]]; then
      log verify-staging
    fi
    ;;
  *)
    printf 'unexpected fake Docker operation: %s\\n' "$operation" >&2
    exit 64
    ;;
esac
`;
