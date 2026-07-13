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

function runBackup({
  runtimeEnabled,
  desiredGlobalEnabled = runtimeEnabled,
  caddyRunning,
  failurePoint = "",
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
    IRIS_BACKUP_CLEANUP_RETRY_DELAY_SECONDS: "0",
    BASH_ENV: toBashPath(resolve(root, "bash-env")),
  });

  const result = spawnSync(gitBash, [toBashPath(backupPath)], {
    cwd: root,
    encoding: "utf8",
    env: environment,
  });

  const backups = readdirSync(backupDir).filter((name) => name.endsWith(".bundle.tar.age"));
  const backupSize =
    backups.length === 1
      ? readFileSync(resolve(backupDir, backups[0])).byteLength
      : 0;

  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
    runtimeEnabled: readFileSync(resolve(stateDir, "runtime"), "utf8").trim() === "true",
    caddyRunning: readFileSync(resolve(stateDir, "caddy"), "utf8").trim() === "true",
    log: readFileSync(resolve(stateDir, "operations.log"), "utf8"),
    backups,
    backupSize,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
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
    return 0
  fi
  return 1
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
        arguments="$*"
        if [[ "$arguments" == *runtime-control/status* ]]; then
          if fail_once capture; then exit 42; fi
          runtime="$(cat "$state_dir/runtime")"
          desired="$(cat "$state_dir/desired-runtime")"
          revision="$(cat "$state_dir/revision")"
          persistence_ok="$(cat "$state_dir/persistence-ok")"
          if [[ "$persistence_ok" != true ]]; then
            echo "runtime status did not prove healthy Postgres persistence" >&2
            exit 42
          fi
          activation_required=false
          if [[ "$runtime" == false && "$desired" == true ]]; then
            activation_required=true
          fi
          printf '%s\t%s\t%s\tpostgres\t%s\t%s\n' \
            "$runtime" "$desired" "$revision" "$persistence_ok" "$activation_required"
          log "read-runtime $runtime desired=$desired revision=$revision persistence=$persistence_ok"
        elif [[ "$arguments" == *internal/status* ]]; then
          if fail_once status; then exit 42; fi
          workers_healthy="$(cat "$state_dir/workers-healthy")"
          queues_empty="$(cat "$state_dir/queues-empty")"
          log "read-activation-gates workers=$workers_healthy queues=$queues_empty"
          if [[ "$workers_healthy" != true ]]; then
            echo "internal status did not prove healthy workers" >&2
            exit 42
          fi
          if [[ "$queues_empty" != true ]]; then
            echo "internal status did not prove queues with zero DLQs" >&2
            exit 42
          fi
        elif [[ "$arguments" == *runtime-control/global* ]]; then
          expected="\${!#}"
          if [[ "$expected" == true ]]; then
            if fail_once restore; then exit 42; fi
            printf 'true' > "$state_dir/runtime"
            printf 'true' > "$state_dir/desired-runtime"
            log "set-runtime true"
          elif [[ "$expected" == false ]]; then
            printf 'false' > "$state_dir/runtime"
            printf 'false' > "$state_dir/desired-runtime"
            log "set-runtime false"
          else
            echo "missing runtime target" >&2
            exit 64
          fi
        else
          echo "unexpected Core exec" >&2
          exit 64
        fi
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
