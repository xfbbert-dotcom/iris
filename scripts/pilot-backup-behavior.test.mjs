import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const backupPath = resolve("deploy/pilot/backup.sh");
const gitBash = bashPath();

test(
  "successful planned backup restores enabled runtime and running Caddy after publication",
  { skip: gitBash === undefined },
  () => {
    const result = runBackup({ runtimeEnabled: true, caddyRunning: true });
    try {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.runtimeEnabled, true);
      assert.equal(result.caddyRunning, true);
      assert.equal(result.backups.length, 1);
      assert.ok(result.backupSize > 0);

      const publishIndex = result.log.indexOf("publish");
      assert.ok(publishIndex >= 0);
      assert.ok(publishIndex < result.log.lastIndexOf("set-runtime true"));
      assert.ok(publishIndex < result.log.lastIndexOf("start-caddy"));
    } finally {
      result.cleanup();
    }
  },
);

test(
  "successful planned backup preserves a disabled runtime and stopped Caddy",
  { skip: gitBash === undefined },
  () => {
    const result = runBackup({ runtimeEnabled: false, caddyRunning: false });
    try {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.runtimeEnabled, false);
      assert.equal(result.caddyRunning, false);
      assert.doesNotMatch(result.log, /set-runtime true/u);
      assert.doesNotMatch(result.log, /start-caddy/u);
    } finally {
      result.cleanup();
    }
  },
);

test(
  "durable desired enablement never reopens a live gate that was disabled before maintenance",
  { skip: gitBash === undefined },
  () => {
    const result = runBackup({
      runtimeEnabled: false,
      desiredGlobalEnabled: true,
      caddyRunning: true,
    });
    try {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.runtimeEnabled, false);
      assert.equal(result.caddyRunning, true);
      assert.doesNotMatch(result.log, /set-runtime true/u);
    } finally {
      result.cleanup();
    }
  },
);

for (const gateFailure of [
  {
    name: "runtime persistence",
    persistenceOk: false,
    error: /healthy Postgres persistence/u,
  },
  { name: "worker health", workersHealthy: false, error: /healthy workers/u },
  { name: "pending queue", queuesEmpty: false, error: /zero DLQs/u },
]) {
  test(
    `failed ${gateFailure.name} gate leaves runtime disabled and Caddy stopped`,
    { skip: gitBash === undefined },
    () => {
      const result = runBackup({
        runtimeEnabled: true,
        caddyRunning: true,
        ...gateFailure,
      });
      try {
        assert.notEqual(result.status, 0);
        assert.equal(result.runtimeEnabled, false, result.stderr || result.stdout);
        assert.equal(result.caddyRunning, false, result.stderr || result.stdout);
        assert.match(result.stderr, gateFailure.error);
      } finally {
        result.cleanup();
      }
    },
  );
}

for (const failurePoint of [
  "capture",
  "snapshot",
  "restart",
  "status",
  "encrypt",
  "publish",
  "restore",
  "caddy",
  "cleanup",
  "rm-cleanup",
]) {
  test(
    `backup failure at ${failurePoint} leaves runtime disabled and Caddy stopped`,
    { skip: gitBash === undefined },
    () => {
      const result = runBackup({
        runtimeEnabled: true,
        caddyRunning: true,
        failurePoint,
      });
      try {
        assert.notEqual(result.status, 0, "the injected failure must fail the backup command");
        assert.equal(result.runtimeEnabled, false, result.stderr || result.stdout);
        assert.equal(result.caddyRunning, false, result.stderr || result.stdout);
      } finally {
        result.cleanup();
      }
    },
  );
}

test(
  "failed Caddy state verification is reported as incomplete recovery",
  { skip: gitBash === undefined },
  () => {
    const result = runBackup({
      runtimeEnabled: true,
      caddyRunning: true,
      failurePoint: "ps",
    });
    try {
      assert.notEqual(result.status, 0);
      assert.equal(result.runtimeEnabled, false);
      assert.match(result.stderr, /FAIL-CLOSED RECOVERY INCOMPLETE/u);
    } finally {
      result.cleanup();
    }
  },
);

test(
  "persistent cleanup failure is reported as incomplete fail-closed recovery",
  { skip: gitBash === undefined },
  () => {
    const result = runBackup({
      runtimeEnabled: true,
      caddyRunning: true,
      failurePoint: "cleanup-persistent",
    });
    try {
      assert.notEqual(result.status, 0);
      assert.equal(result.runtimeEnabled, false);
      assert.match(result.stderr, /FAIL-CLOSED RECOVERY INCOMPLETE/u);
      assert.ok(result.log.match(/fail cleanup-stop/gu)?.length >= 3);
    } finally {
      result.cleanup();
    }
  },
);

for (const [networkMode, expectedError] of [
  ["malformed-json", /SyntaxError|JSON/u],
  ["missing-durable", /expected durable runtime state false/u],
  ["wrong-storage", /healthy Postgres persistence/u],
]) {
  test(
    `${networkMode} Core response is parsed and fails closed`,
    { skip: gitBash === undefined },
    () => {
      const result = runBackup({
        runtimeEnabled: true,
        caddyRunning: true,
        networkMode,
      });
      try {
        assert.notEqual(result.status, 0);
        assert.equal(result.error, undefined, "the backup must exit without harness termination");
        assert.equal(result.runtimeEnabled, false, result.stderr || result.stdout);
        assert.equal(result.caddyRunning, false, result.stderr || result.stdout);
        assert.match(result.stderr, expectedError);
      } finally {
        result.cleanup();
      }
    },
  );
}

test(
  "status timeout exits on the script deadline and fails closed",
  { skip: gitBash === undefined },
  () => {
    const result = runBackup({
      runtimeEnabled: true,
      caddyRunning: true,
      networkMode: "status-timeout",
    });
    try {
      assert.notEqual(result.status, 0);
      assert.equal(result.error, undefined, "the backup must exit before the harness timeout");
      assert.ok(result.elapsedMs < 5_000, `status timeout took ${result.elapsedMs}ms`);
      assert.doesNotMatch(result.log, /mock transport watchdog/u);
      assert.equal(result.runtimeEnabled, false, result.stderr || result.stdout);
      assert.equal(result.caddyRunning, false, result.stderr || result.stdout);
    } finally {
      result.cleanup();
    }
  },
);

test(
  "enable committed before response timeout is compensated before Caddy can start",
  { skip: gitBash === undefined },
  () => {
    const result = runBackup({
      runtimeEnabled: true,
      caddyRunning: true,
      networkMode: "enable-committed-response-timeout",
    });
    try {
      assert.notEqual(result.status, 0);
      assert.equal(result.error, undefined, "the backup must exit before the harness timeout");
      assert.ok(result.elapsedMs < 12_000, `ambiguous enable took ${result.elapsedMs}ms`);
      assert.match(result.log, /set-runtime true/u);
      assert.match(result.log, /set-runtime false/u);
      assert.doesNotMatch(result.log, /mock transport watchdog/u);
      assert.equal(result.runtimeEnabled, false, result.stderr || result.stdout);
      assert.equal(result.caddyRunning, false, result.stderr || result.stdout);
      assert.doesNotMatch(result.log, /start-caddy/u);
    } finally {
      result.cleanup();
    }
  },
);

for (const [networkMode, cleanupError] of [
  ["cleanup-disable-503", /runtime update request failed with HTTP 503/u],
  ["cleanup-disable-not-durable", /expected durable runtime state false after update/u],
  ["cleanup-disable-transport", /cleanup disable transport disconnected/u],
  ["cleanup-disable-malformed", /SyntaxError|JSON/u],
]) {
  test(
    `primary backup failure preserves ${networkMode} cleanup evidence`,
    { skip: gitBash === undefined },
    () => {
      const result = runBackup({
        runtimeEnabled: true,
        caddyRunning: true,
        failurePoint: "snapshot",
        networkMode,
      });
      try {
        assert.notEqual(result.status, 0);
        assert.equal(result.error, undefined, "cleanup must finish before the harness timeout");
        assert.match(result.stderr, /injected primary failure at snapshot/u);
        assert.match(result.stderr, cleanupError);
        assert.match(result.stderr, /durable disable mutation failed/u);
        assert.match(result.stderr, /FAIL-CLOSED RECOVERY INCOMPLETE/u);
        assert.equal(result.caddyRunning, false, result.stderr || result.stdout);
      } finally {
        result.cleanup();
      }
    },
  );
}

test(
  "primary failure reports durable cleanup failure when desired intent returns after restart",
  { skip: gitBash === undefined },
  () => {
    const result = runBackup({
      runtimeEnabled: true,
      caddyRunning: true,
      failurePoint: "snapshot",
      networkMode: "cleanup-desired-true-after-restart",
    });
    try {
      assert.notEqual(result.status, 0);
      assert.equal(result.error, undefined, "cleanup must finish before the harness timeout");
      assert.match(result.stderr, /injected primary failure at snapshot/u);
      assert.match(result.stderr, /durable disabled runtime state/u);
      assert.match(result.stderr, /desiredGlobalEnabled=true/u);
      assert.match(result.stderr, /FAIL-CLOSED RECOVERY INCOMPLETE/u);
      assert.equal(result.runtimeEnabled, false);
      assert.equal(result.caddyRunning, false);
    } finally {
      result.cleanup();
    }
  },
);

test(
  "leading-zero HTTP timeouts are normalized as decimal before bounds checks",
  { skip: gitBash === undefined },
  () => {
    const accepted = runBackup({
      runtimeEnabled: false,
      caddyRunning: false,
      httpTimeoutMs: "000100",
    });
    try {
      assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    } finally {
      accepted.cleanup();
    }

    const rejected = runBackup({
      runtimeEnabled: false,
      caddyRunning: false,
      httpTimeoutMs: "0100000",
    });
    try {
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /integer between 100 and 60000/u);
      assert.equal(rejected.log, "");
    } finally {
      rejected.cleanup();
    }
  },
);

for (const timeoutCase of [
  { name: "signed HTTP timeout", httpTimeoutMs: "+100" },
  { name: "whitespace HTTP timeout", httpTimeoutMs: " 100" },
  { name: "non-digit HTTP timeout", httpTimeoutMs: "100ms" },
  { name: "signed command timeout", commandTimeoutSeconds: "+1" },
  { name: "excessive cleanup retry delay", cleanupRetryDelaySeconds: "11" },
]) {
  test(
    `rejects ${timeoutCase.name} before maintenance`,
    { skip: gitBash === undefined },
    () => {
      const result = runBackup({
        runtimeEnabled: false,
        caddyRunning: false,
        ...timeoutCase,
      });
      try {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /must be an integer between/u);
        assert.equal(result.log, "");
      } finally {
        result.cleanup();
      }
    },
  );
}

for (const hangCase of [
  { name: "status exec", hangPoint: "status-command", failurePoint: "" },
  { name: "cleanup exec", hangPoint: "cleanup-exec", failurePoint: "snapshot" },
  { name: "cleanup stop", hangPoint: "cleanup-stop", failurePoint: "capture" },
]) {
  test(
    `outer command deadline bounds a fake Docker ${hangCase.name} hang`,
    { skip: gitBash === undefined },
    () => {
      const result = runBackup({
        runtimeEnabled: true,
        caddyRunning: true,
        ...hangCase,
      });
      try {
        assert.notEqual(result.status, 0);
        assert.equal(result.error, undefined, "the script must beat the harness watchdog");
        assert.ok(result.elapsedMs < 12_000, `${hangCase.name} took ${result.elapsedMs}ms`);
        assert.match(result.stderr, /docker compose .* timed out after 1s/u);
        assert.equal(result.caddyRunning, false, result.stderr || result.stdout);
      } finally {
        result.cleanup();
      }
    },
  );
}

function runBackup({
  runtimeEnabled,
  desiredGlobalEnabled = runtimeEnabled,
  caddyRunning,
  cleanupRetryDelaySeconds = "0",
  commandTimeoutSeconds = "1",
  failurePoint = "",
  hangPoint = "",
  httpTimeoutMs = "100",
  networkMode = "",
  persistenceOk = true,
  workersHealthy = true,
  queuesEmpty = true,
}) {
  const root = mkdtempSync(resolve(".tmp-iris-backup-test-"));
  const fakeBin = resolve(root, "bin");
  const stateDir = resolve(root, "state");
  const backupDir = resolve(root, "backups");
  mkdirSync(fakeBin);
  mkdirSync(stateDir);
  mkdirSync(backupDir);

  writeFileSync(resolve(root, ".env.pilot"), "IRIS_IMAGE_TAG=test\n");
  writeFileSync(resolve(root, "compose.yml"), "services: {}\n");
  writeFileSync(resolve(root, "recipient"), `age1${"q".repeat(58)}\n`);
  writeFileSync(resolve(stateDir, "runtime"), String(runtimeEnabled));
  writeFileSync(resolve(stateDir, "desired-runtime"), String(desiredGlobalEnabled));
  writeFileSync(resolve(stateDir, "revision"), "7");
  writeFileSync(resolve(stateDir, "persistence-ok"), String(persistenceOk));
  writeFileSync(resolve(stateDir, "workers-healthy"), String(workersHealthy));
  writeFileSync(resolve(stateDir, "queues-empty"), String(queuesEmpty));
  writeFileSync(resolve(stateDir, "core"), "true");
  writeFileSync(resolve(stateDir, "caddy"), String(caddyRunning));
  writeFileSync(resolve(stateDir, "operations.log"), "");
  const fetchMockPath = resolve(root, "mock-fetch.mjs");
  writeFileSync(fetchMockPath, backupFetchPreload);
  writeFileSync(
    resolve(root, "bash-env"),
    'install() { local destination="${!#}"; mkdir -p "$destination"; }\n' +
      'chmod() { return 0; }\n' +
      'mv() { printf \'publish\\n\' >> "$IRIS_TEST_STATE_DIR/operations.log"; ' +
      'if [[ "$IRIS_TEST_FAIL_POINT" == publish ]]; then return 42; fi; ' +
      'command /usr/bin/mv "$@"; }\n' +
      'rm() { if [[ "$IRIS_TEST_FAIL_POINT" == rm-cleanup ]]; then ' +
      'printf \'fail rm\\n\' >> "$IRIS_TEST_STATE_DIR/operations.log"; return 42; fi; ' +
      'command /usr/bin/rm "$@"; }\n',
  );

  writeExecutable(resolve(fakeBin, "docker"), fakeDockerScript);
  writeExecutable(resolve(fakeBin, "age"), fakeAgeScript);
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
    IRIS_BACKUP_RECIPIENT_FILE: toBashPath(resolve(root, "recipient")),
    IRIS_TEST_STATE_DIR: toBashPath(stateDir),
    IRIS_TEST_FAIL_POINT: failurePoint,
    IRIS_TEST_HANG_POINT: hangPoint,
    IRIS_TEST_NETWORK_MODE: networkMode,
    IRIS_TEST_NODE_PATH: toBashPath(process.execPath),
    IRIS_TEST_FETCH_MOCK: pathToFileURL(fetchMockPath).href,
    IRIS_INTERNAL_API_TOKEN: "test-internal-token",
    IRIS_BACKUP_CLEANUP_RETRY_DELAY_SECONDS: cleanupRetryDelaySeconds,
    IRIS_BACKUP_COMMAND_TIMEOUT_SECONDS: commandTimeoutSeconds,
    IRIS_BACKUP_HTTP_TIMEOUT_MS: httpTimeoutMs,
    BASH_ENV: toBashPath(resolve(root, "bash-env")),
  });

  const startedAt = Date.now();
  const result = spawnSync(gitBash, [toBashPath(backupPath)], {
    cwd: root,
    encoding: "utf8",
    env: environment,
    timeout:
      hangPoint !== ""
        ? 15_000
        : networkMode === "status-timeout"
        ? 8_000
        : networkMode === "enable-committed-response-timeout"
          ? 12_000
          : 15_000,
  });
  const elapsedMs = Date.now() - startedAt;

  const backups = readdirSync(backupDir).filter((name) => name.endsWith(".bundle.tar.age"));
  const backupSize =
    backups.length === 1
      ? readFileSync(resolve(backupDir, backups[0])).byteLength
      : 0;

  return {
    status: result.status,
    error: result.error,
    elapsedMs,
    stderr: result.stderr,
    stdout: result.stdout,
    runtimeEnabled: readFileSync(resolve(stateDir, "runtime"), "utf8").trim() === "true",
    caddyRunning: readFileSync(resolve(stateDir, "caddy"), "utf8").trim() === "true",
    log: readFileSync(resolve(stateDir, "operations.log"), "utf8"),
    backups,
    backupSize,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
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
  if (process.platform !== "win32") {
    return "bash";
  }
  const path = "C:\\Program Files\\Git\\bin\\bash.exe";
  return existsSync(path) ? path : undefined;
}

const fakeDockerScript = `#!/usr/bin/env bash
set -Eeuo pipefail

state_dir="$IRIS_TEST_STATE_DIR"
fail_point="\${IRIS_TEST_FAIL_POINT:-}"
hang_point="\${IRIS_TEST_HANG_POINT:-}"
network_mode="\${IRIS_TEST_NETWORK_MODE:-}"
log_file="$state_dir/operations.log"

log() {
  printf '%s\n' "$*" >> "$log_file"
}

fail_once() {
  local point="$1"
  local marker="$state_dir/failed-$point"
  if [[ "$fail_point" == "$point" && ! -e "$marker" ]]; then
    : > "$marker"
    log "fail $point"
    printf 'injected primary failure at %s\n' "$point" >&2
    return 0
  fi
  return 1
}

hang_forever() {
  log "hang $1"
  while :; do :; done
}

[[ "$1" == compose ]]
shift
while [[ "\${1:-}" == --env-file || "\${1:-}" == --file ]]; do
  shift 2
done

operation="$1"
shift
case "$operation" in
  ps)
    if [[ "$fail_point" == ps ]]; then
      log "fail ps"
      exit 42
    fi
    [[ "$(cat "$state_dir/core")" == true ]] && printf 'core\n'
    [[ "$(cat "$state_dir/caddy")" == true ]] && printf 'caddy\n'
    true
    ;;
  stop)
    for service in "$@"; do
      case "$service" in
        core)
          printf 'false' > "$state_dir/core"
          printf 'false' > "$state_dir/runtime"
          log "stop-core"
          ;;
        caddy)
          if [[ "$hang_point" == cleanup-stop && -e "$state_dir/failed-$fail_point" ]]; then
            hang_forever cleanup-stop
          fi
          if [[ -e "$state_dir/caddy-started" ]]; then
            if [[ "$fail_point" == cleanup && ! -e "$state_dir/failed-cleanup-stop" ]]; then
              : > "$state_dir/failed-cleanup-stop"
              log "fail cleanup-stop"
              exit 42
            fi
            if [[ "$fail_point" == cleanup-persistent ]]; then
              log "fail cleanup-stop"
              exit 42
            fi
          fi
          printf 'false' > "$state_dir/caddy"
          log "stop-caddy"
          ;;
      esac
    done
    ;;
  up)
    service="\${!#}"
    if [[ "$service" == core ]]; then
      if fail_once restart; then exit 42; fi
      printf 'true' > "$state_dir/core"
      printf 'false' > "$state_dir/runtime"
      if [[ "$network_mode" == cleanup-desired-true-after-restart && -e "$state_dir/failed-snapshot" ]]; then
        printf 'true' > "$state_dir/desired-runtime"
        log "restore-desired-runtime true"
      fi
      log "start-core-disabled"
    elif [[ "$service" == caddy ]]; then
      printf 'true' > "$state_dir/caddy"
      : > "$state_dir/caddy-started"
      log "start-caddy"
      if fail_once caddy; then exit 42; fi
      if [[ "$fail_point" == cleanup || "$fail_point" == cleanup-persistent || "$fail_point" == rm-cleanup ]]; then
        log "fail caddy"
        exit 42
      fi
    else
      echo "unexpected up target: $service" >&2
      exit 64
    fi
    ;;
  kill)
    service="\${!#}"
    if [[ "$service" == caddy ]]; then
      if [[ "$fail_point" == cleanup-persistent ]]; then
        log "fail cleanup-stop"
        exit 42
      fi
      printf 'false' > "$state_dir/caddy"
      log "kill-caddy"
    fi
    ;;
  exec)
    [[ "\${1:-}" == -T ]] && shift
    service="$1"
    shift
    case "$service" in
      core)
        [[ "\${1:-}" == node ]] || { echo "unexpected Core exec" >&2; exit 64; }
        shift
        arguments="$*"
        if [[ "$hang_point" == status-command && "$arguments" == *runtime-control/status* && ! -e "$state_dir/hung-status-command" ]]; then
          : > "$state_dir/hung-status-command"
          hang_forever status-command
        fi
        if [[ "$hang_point" == cleanup-exec && "$arguments" == *runtime-control/global* ]]; then
          count_file="$state_dir/global-exec-count"
          count=0
          [[ -e "$count_file" ]] && count="$(cat "$count_file")"
          count=$((count + 1))
          printf '%s' "$count" > "$count_file"
          if ((count >= 2)); then
            hang_forever cleanup-exec
          fi
        fi
        "$IRIS_TEST_NODE_PATH" --import "$IRIS_TEST_FETCH_MOCK" "$@"
        ;;
      postgres)
        if fail_once snapshot; then exit 42; fi
        printf 'fake-postgres-dump'
        log "snapshot-postgres"
        ;;
      redis)
        log "snapshot-redis"
        ;;
      *)
        echo "unexpected exec service: $service" >&2
        exit 64
        ;;
    esac
    ;;
  cp)
    destination="\${!#}"
    printf 'fake-redis-rdb' > "$destination"
    log "copy-redis"
    ;;
  *)
    echo "unexpected compose operation: $operation" >&2
    exit 64
    ;;
esac
`;

const fakeAgeScript = `#!/usr/bin/env bash
set -Eeuo pipefail
output=
while (($#)); do
  case "$1" in
    --output)
      output="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if [[ "$IRIS_TEST_FAIL_POINT" == encrypt ]]; then
  printf 'fail encrypt\n' >> "$IRIS_TEST_STATE_DIR/operations.log"
  exit 42
fi
cat > "$output"
printf 'encrypt\n' >> "$IRIS_TEST_STATE_DIR/operations.log"
`;

const backupFetchPreload = `
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const stateDir = process.env.IRIS_TEST_STATE_DIR;
const failPoint = process.env.IRIS_TEST_FAIL_POINT ?? "";
const networkMode = process.env.IRIS_TEST_NETWORK_MODE ?? "";
const readState = (name) => readFileSync(resolve(stateDir, name), "utf8").trim();
const writeState = (name, value) => writeFileSync(resolve(stateDir, name), String(value));
const log = (message) => appendFileSync(resolve(stateDir, "operations.log"), message + "\\n");
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

function failOnce(point) {
  const marker = resolve(stateDir, "failed-" + point);
  if (failPoint !== point || existsSync(marker)) return false;
  writeFileSync(marker, "");
  log("fail " + point);
  return true;
}

function once(name) {
  const marker = resolve(stateDir, "once-" + name);
  if (existsSync(marker)) return false;
  writeFileSync(marker, "");
  return true;
}

function abortingResponse(signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const keepAlive = setInterval(() => {}, 1_000);
    const watchdog = setTimeout(() => {
      clearInterval(keepAlive);
      log("mock transport watchdog");
      rejectPromise(new Error("mock transport watchdog expired"));
    }, 1_500);
    const reject = () => {
      clearInterval(keepAlive);
      clearTimeout(watchdog);
      rejectPromise(signal?.reason ?? new Error("request aborted"));
    };
    if (signal?.aborted) return reject();
    signal?.addEventListener("abort", reject, { once: true });
  });
}

function runtimeStatusBody() {
  const globalEnabled = readState("runtime") === "true";
  const desiredGlobalEnabled = readState("desired-runtime") === "true";
  return {
    ok: true,
    globalEnabled,
    desiredGlobalEnabled,
    activationRequired: !globalEnabled && desiredGlobalEnabled,
    revision: Number(readState("revision")),
    persistence: {
      storage: networkMode === "wrong-storage" ? "in_memory" : "postgres",
      ok: readState("persistence-ok") === "true",
    },
  };
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.pathname === "/internal/runtime-control/status") {
    if (networkMode === "status-timeout" && once("network-status-timeout")) {
      return abortingResponse(init.signal);
    }
    if (failOnce("capture")) return json({ error: "status_failed" }, 503);
    if (networkMode === "malformed-json") {
      return new Response("{", { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = runtimeStatusBody();
    log(
      "read-runtime " + body.globalEnabled +
      " desired=" + body.desiredGlobalEnabled +
      " revision=" + body.revision +
      " storage=" + body.persistence.storage +
      " persistence=" + body.persistence.ok,
    );
    return json(body);
  }

  if (url.pathname === "/internal/status") {
    if (failOnce("status")) return json({ error: "status_failed" }, 503);
    const workersHealthy = readState("workers-healthy") === "true";
    const queuesEmpty = readState("queues-empty") === "true";
    const runtime = runtimeStatusBody();
    log("read-activation-gates workers=" + workersHealthy + " queues=" + queuesEmpty);
    const worker = (eventWorker = false) => ({
      ok: workersHealthy,
      enabled: true,
      running: workersHealthy,
      ...(eventWorker
        ? { pendingEventCount: queuesEmpty ? 0 : 1, deadLetterEventCount: 0 }
        : { pendingJobCount: queuesEmpty ? 0 : 1, deadLetterJobCount: 0 }),
    });
    return json({
      ok: workersHealthy,
      status: workersHealthy ? "healthy" : "degraded",
      summary: {
        degradedComponentCount: workersHealthy ? 0 : 1,
        stoppedEnabledRuntimeComponentCount: workersHealthy ? 0 : 1,
      },
      components: {
        runtimeControl: { ...runtime, enabled: runtime.globalEnabled },
        eventWorker: worker(true),
        documentSync: worker(),
        reindex: worker(),
      },
    });
  }

  if (url.pathname === "/internal/runtime-control/global") {
    const enabled = JSON.parse(init.body).enabled;
    let disableCount = 0;
    if (!enabled) {
      const countPath = resolve(stateDir, "disable-count");
      disableCount = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;
      writeFileSync(countPath, String(disableCount));
      if (disableCount >= 2 && networkMode === "cleanup-disable-503") {
        return json({ globalEnabled: true, durable: false }, 503);
      }
    }
    if (enabled && failOnce("restore")) return json({ error: "restore_failed" }, 503);
    writeState("runtime", enabled);
    writeState("desired-runtime", enabled);
    writeState("revision", Number(readState("revision")) + 1);
    log("set-runtime " + enabled);
    if (!enabled && disableCount >= 2) {
      if (networkMode === "cleanup-disable-transport") {
        throw new Error("cleanup disable transport disconnected");
      }
      if (networkMode === "cleanup-disable-malformed") {
        return new Response("{", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (networkMode === "cleanup-disable-not-durable") {
        return json({ globalEnabled: false, durable: false });
      }
    }
    if (enabled && networkMode === "enable-committed-response-timeout") {
      return abortingResponse(init.signal);
    }
    const body = { globalEnabled: enabled };
    if (networkMode !== "missing-durable") body.durable = true;
    return json(body);
  }

  throw new Error("Unexpected backup URL: " + url);
};
`;
