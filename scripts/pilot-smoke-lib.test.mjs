import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  assertDurableRuntimeMutation,
  assertFastFeishuAcknowledgement,
  assertHealthyInternalStatus,
  assertPilotActivationReady,
  assertRuntimeGloballyDisabled,
} from "./pilot-smoke-lib.mjs";

const activationReadyStatus = {
  ok: true,
  status: "healthy",
  summary: {
    degradedComponentCount: 0,
    stoppedEnabledRuntimeComponentCount: 0,
  },
  components: {
    runtimeControl: {
      ok: true,
      globalEnabled: false,
      desiredGlobalEnabled: true,
      activationRequired: true,
      revision: 7,
      persistence: { storage: "postgres", ok: true },
    },
    eventWorker: {
      ok: true,
      enabled: true,
      running: true,
      pendingEventCount: 0,
      deadLetterEventCount: 0,
    },
    documentSync: {
      ok: true,
      enabled: true,
      running: true,
      pendingJobCount: 0,
      deadLetterJobCount: 0,
    },
    reindex: {
      ok: true,
      enabled: true,
      running: true,
      pendingJobCount: 0,
      deadLetterJobCount: 0,
    },
  },
};

test("accepts a fully healthy internal status snapshot", () => {
  assert.doesNotThrow(() =>
    assertHealthyInternalStatus({
      ok: true,
      status: "healthy",
      summary: {
        degradedComponentCount: 0,
        stoppedEnabledRuntimeComponentCount: 0,
      },
    }),
  );
});

test("rejects a status snapshot with a degraded component", () => {
  assert.throws(
    () =>
      assertHealthyInternalStatus({
        ok: false,
        status: "degraded",
        summary: {
          degradedComponentCount: 1,
          stoppedEnabledRuntimeComponentCount: 0,
        },
      }),
    /healthy internal status/u,
  );
});

test("rejects a status snapshot with a stopped enabled runtime", () => {
  assert.throws(
    () =>
      assertHealthyInternalStatus({
        ok: false,
        status: "degraded",
        summary: {
          degradedComponentCount: 1,
          stoppedEnabledRuntimeComponentCount: 1,
        },
      }),
    /healthy internal status/u,
  );
});

test("rejects a malformed status snapshot", () => {
  assert.throws(() => assertHealthyInternalStatus({ ok: true }), /healthy internal status/u);
});

test("requires the pilot runtime to start globally disabled", () => {
  assert.doesNotThrow(() =>
    assertRuntimeGloballyDisabled({
      components: { runtimeControl: { globalEnabled: false } },
    }),
  );
  assert.throws(
    () =>
      assertRuntimeGloballyDisabled({
        components: { runtimeControl: { globalEnabled: true } },
      }),
    /globally disabled/u,
  );
});

test("accepts durable desired enablement only while the restarted live gate remains disabled", () => {
  assert.doesNotThrow(() => assertPilotActivationReady(activationReadyStatus));
});

test("rejects a live gate that reopened from durable desired enablement", () => {
  assert.throws(
    () =>
      assertPilotActivationReady({
        ...activationReadyStatus,
        components: {
          ...activationReadyStatus.components,
          runtimeControl: {
            ...activationReadyStatus.components.runtimeControl,
            globalEnabled: true,
            activationRequired: false,
          },
        },
      }),
    /globally disabled/u,
  );
});

for (const persistence of [
  { storage: "in_memory", ok: true },
  { storage: "postgres", ok: false },
]) {
  test(`rejects activation without healthy Postgres persistence: ${JSON.stringify(persistence)}`, () => {
    assert.throws(
      () =>
        assertPilotActivationReady({
          ...activationReadyStatus,
          components: {
            ...activationReadyStatus.components,
            runtimeControl: {
              ...activationReadyStatus.components.runtimeControl,
              persistence,
            },
          },
        }),
      /Postgres runtime-control persistence/u,
    );
  });
}

for (const [componentName, countName] of [
  ["eventWorker", "pendingEventCount"],
  ["eventWorker", "deadLetterEventCount"],
  ["documentSync", "pendingJobCount"],
  ["documentSync", "deadLetterJobCount"],
  ["reindex", "pendingJobCount"],
  ["reindex", "deadLetterJobCount"],
]) {
  test(`rejects activation when ${componentName}.${countName} is nonzero`, () => {
    assert.throws(
      () =>
        assertPilotActivationReady({
          ...activationReadyStatus,
          components: {
            ...activationReadyStatus.components,
            [componentName]: {
              ...activationReadyStatus.components[componentName],
              [countName]: 1,
            },
          },
        }),
      /workers and queues/u,
    );
  });
}

test("rejects activation when a required worker is stopped", () => {
  assert.throws(
    () =>
      assertPilotActivationReady({
        ...activationReadyStatus,
        components: {
          ...activationReadyStatus.components,
          documentSync: {
            ...activationReadyStatus.components.documentSync,
            running: false,
          },
        },
      }),
    /workers and queues/u,
  );
});

test("accepts only a durable successful runtime mutation", () => {
  assert.doesNotThrow(() =>
    assertDurableRuntimeMutation({
      responseStatus: 200,
      body: { globalEnabled: true, durable: true },
      enabled: true,
    }),
  );
  assert.throws(
    () =>
      assertDurableRuntimeMutation({
        responseStatus: 200,
        body: { globalEnabled: true },
        enabled: true,
      }),
    /durable runtime mutation/u,
  );
});

test("accepts a successful Feishu acknowledgement inside the deadline", () => {
  assert.doesNotThrow(() =>
    assertFastFeishuAcknowledgement({
      status: 200,
      body: { ok: true },
      elapsedMs: 100,
      deadlineMs: 2_500,
    }),
  );
});

test("rejects a Feishu acknowledgement that misses the deadline", () => {
  assert.throws(
    () =>
      assertFastFeishuAcknowledgement({
        status: 200,
        body: { ok: true },
        elapsedMs: 2_501,
        deadlineMs: 2_500,
      }),
    /Feishu callback acknowledgement/u,
  );
});

for (const [mode, expectedError] of [
  ["transport", /enable transport disconnected/u],
  ["timeout", /enable request timed out/u],
  ["malformed", /JSON/u],
  ["status-mismatch", /durable runtime mutation/u],
]) {
  test(`compensates an ambiguous ${mode} enable without reporting success`, () => {
    const result = runSmokeWithFetchMode(mode);
    try {
      assert.notEqual(result.status, 0);
      assert.deepEqual(result.mutations, ["true", "false"]);
      assert.equal(result.runtimeEnabled, false);
      assert.match(result.stderr, expectedError);
      assert.doesNotMatch(result.stdout, /"ok":true/u);
    } finally {
      result.cleanup();
    }
  });
}

test("preserves ambiguous enable and failed durable disable errors causally", () => {
  const result = runSmokeWithFetchMode("transport-cleanup-missing-durable");
  try {
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.mutations, ["true", "false", "false", "false"]);
    assert.equal(result.runtimeEnabled, false);
    assert.match(result.stderr, /enable transport disconnected/u);
    assert.match(result.stderr, /durable runtime mutation for global enablement false/u);
    assert.match(result.stderr, /AggregateError/u);
    assert.doesNotMatch(result.stdout, /"ok":true/u);
  } finally {
    result.cleanup();
  }
});

test("post-restore smoke gates privately before starting Caddy and public acceptance", () => {
  const result = runSmokeWithFetchMode("post-restore", {
    args: ["--post-restore", "200"],
    caddyRunning: false,
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.runtimeEnabled, false);
    assert.equal(result.caddyRunning, true);
    assert.deepEqual(result.mutations, ["true", "false"]);

    const privateGate = result.log.indexOf("private-status");
    const enable = result.log.indexOf("set-runtime true");
    const startCaddy = result.log.indexOf("start-caddy");
    const publicGate = result.log.indexOf("public-health");
    const disable = result.log.indexOf("set-runtime false");
    assert.ok(privateGate >= 0);
    assert.ok(privateGate < enable);
    assert.ok(enable < startCaddy);
    assert.ok(startCaddy < publicGate);
    assert.ok(publicGate < disable);
  } finally {
    result.cleanup();
  }
});

test("disable transport failure stops Caddy and terminates the Compose process tree", async () => {
  const result = runSmokeWithFetchMode("enable-ambiguous-disable-pre-mutation", {
    composeMode: "hang-first-stop",
  });
  try {
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.mutations, ["true", "false", "false", "false"]);
    assert.equal(result.runtimeEnabled, true, "disable must fail before Core mutates state");
    assert.equal(result.caddyRunning, false, result.stderr || result.stdout);
    assert.match(result.stderr, /enable transport disconnected/u);
    assert.match(result.stderr, /disable transport disconnected/u);
    assert.match(result.stderr, /AggregateError/u);
    assert.doesNotMatch(result.stderr, /ci-internal-token|authorization|Bearer/u);
    assert.doesNotMatch(result.stdout, /"ok":true/u);
    assert.equal(result.processTreePids.length, 2);
    assert.deepEqual(
      await waitForPidsToExit(result.processTreePids, 2_000),
      [],
      "bounded Compose cleanup left a parent or child alive",
    );
  } finally {
    killResidualPids(result.processTreePids.filter(isPidAlive));
    result.cleanup();
  }
});

function runSmokeWithFetchMode(
  mode,
  { args = ["200"], caddyRunning = true, composeMode = "" } = {},
) {
  const root = mkdtempSync(resolve(".tmp-iris-smoke-test-"));
  const stateDir = resolve(root, "state");
  mkdirSync(stateDir);
  writeFileSync(resolve(stateDir, "runtime"), "false");
  writeFileSync(resolve(stateDir, "caddy"), String(caddyRunning));
  writeFileSync(resolve(stateDir, "pending-event"), "false");
  writeFileSync(resolve(stateDir, "mutations.log"), "");
  writeFileSync(resolve(stateDir, "operations.log"), "");
  const preloadPath = resolve(root, "mock-fetch.mjs");
  const fakeDockerPath = resolve(root, "fake-docker.mjs");
  writeFileSync(preloadPath, smokeFetchPreload);
  writeFileSync(fakeDockerPath, fakeSmokeDocker);

  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preloadPath).href, "scripts/pilot-smoke.mjs", ...args],
    {
      cwd: resolve("."),
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        IRIS_TEST_FETCH_MODE: mode,
        IRIS_TEST_COMPOSE_MODE: composeMode,
        IRIS_TEST_STATE_DIR: stateDir,
        IRIS_PILOT_DOCKER_COMMAND: process.execPath,
        IRIS_PILOT_DOCKER_COMMAND_ARGS_JSON: JSON.stringify([fakeDockerPath]),
        IRIS_PILOT_COMPOSE_COMMAND_TIMEOUT_MS: "300",
        IRIS_PILOT_CLEANUP_RETRY_DELAY_MS: "0",
      },
    },
  );

  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
    mutations: readFileSync(resolve(stateDir, "mutations.log"), "utf8")
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean),
    runtimeEnabled: readFileSync(resolve(stateDir, "runtime"), "utf8").trim() === "true",
    caddyRunning: readFileSync(resolve(stateDir, "caddy"), "utf8").trim() === "true",
    log: readFileSync(resolve(stateDir, "operations.log"), "utf8"),
    processTreePids: ["process-parent.pid", "process-child.pid"]
      .map((name) => resolve(stateDir, name))
      .filter(existsSync)
      .map((path) => Number(readFileSync(path, "utf8").trim()))
      .filter(Number.isSafeInteger),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
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
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function killResidualPids(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

const smokeFetchPreload = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const stateDir = process.env.IRIS_TEST_STATE_DIR;
const mode = process.env.IRIS_TEST_FETCH_MODE;
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const authorization = (init) => new Headers(init?.headers).get("authorization");
const log = (message) => appendFileSync(resolve(stateDir, "operations.log"), message + "\\n");

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.pathname === "/health") {
    log("public-health");
    return readFileSync(resolve(stateDir, "caddy"), "utf8").trim() === "true"
      ? json({ ok: true })
      : json({ error: "caddy_stopped" }, 503);
  }
  if (url.pathname === "/internal/status") {
    if (url.port !== "3000") return json({ error: "not_found" }, 404);
    if (authorization(init) !== "Bearer ci-internal-token") {
      return json({ error: "unauthorized" }, 401);
    }
    log("private-status");
    return json({
      ok: true,
      status: "healthy",
      summary: { degradedComponentCount: 0, stoppedEnabledRuntimeComponentCount: 0 },
      components: {
        runtimeControl: {
          ok: true,
          globalEnabled: false,
          desiredGlobalEnabled: false,
          activationRequired: false,
          revision: 7,
          persistence: { storage: "postgres", ok: true },
        },
        eventWorker: {
          ok: true, enabled: true, running: true,
          pendingEventCount:
            readFileSync(resolve(stateDir, "pending-event"), "utf8").trim() === "true" ? 1 : 0,
          deadLetterEventCount: 0,
        },
        documentSync: {
          ok: true, enabled: true, running: true,
          pendingJobCount: 0, deadLetterJobCount: 0,
        },
        reindex: {
          ok: true, enabled: true, running: true,
          pendingJobCount: 0, deadLetterJobCount: 0,
        },
      },
    });
  }
  if (url.pathname === "/internal/readiness") return json({ error: "not_found" }, 404);
  if (url.pathname === "/internal/ingress-readiness") {
    if (url.port !== "3000") return json({ error: "not_found" }, 404);
    if (authorization(init) !== "Bearer ci-internal-token") {
      return json({ error: "unauthorized" }, 401);
    }
    return json({ ok: true, status: "ready" });
  }
  if (url.pathname === "/internal/runtime-control/global") {
    const enabled = JSON.parse(init.body).enabled;
    appendFileSync(resolve(stateDir, "mutations.log"), String(enabled) + "\\n");
    log("set-runtime " + enabled);
    if (!enabled && mode === "enable-ambiguous-disable-pre-mutation") {
      throw new Error("disable transport disconnected");
    }
    writeFileSync(resolve(stateDir, "runtime"), String(enabled));
    if (enabled) {
      if (
        mode === "transport" ||
        mode === "transport-cleanup-missing-durable" ||
        mode === "enable-ambiguous-disable-pre-mutation"
      ) {
        throw new Error("enable transport disconnected");
      }
      if (mode === "timeout") {
        const error = new Error("enable request timed out");
        error.name = "TimeoutError";
        throw error;
      }
      if (mode === "malformed") {
        return new Response("{", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (mode === "status-mismatch") {
        return json({ globalEnabled: true, durable: true }, 202);
      }
    }
    if (!enabled && mode === "transport-cleanup-missing-durable") {
      return json({ globalEnabled: false });
    }
    return json({ globalEnabled: enabled, durable: true });
  }
  if (url.pathname === "/feishu/events") {
    writeFileSync(resolve(stateDir, "pending-event"), "true");
    log("public-feishu");
    return json({ ok: true });
  }
  throw new Error("Unexpected smoke URL: " + url);
};
`;

const fakeSmokeDocker = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const stateDir = process.env.IRIS_TEST_STATE_DIR;
const composeMode = process.env.IRIS_TEST_COMPOSE_MODE ?? "";
const log = (message) => appendFileSync(resolve(stateDir, "operations.log"), message + "\\n");
const args = process.argv.slice(2);
if (args.shift() !== "compose") process.exit(64);
while (args[0] === "--env-file" || args[0] === "--file") args.splice(0, 2);
const operation = args.shift();

if (operation === "ps") {
  if (readFileSync(resolve(stateDir, "caddy"), "utf8").trim() === "true") {
    process.stdout.write("caddy\\n");
  }
  process.exit(0);
}

if (operation === "up" && args.at(-1) === "caddy") {
  writeFileSync(resolve(stateDir, "caddy"), "true");
  log("start-caddy");
  process.exit(0);
}

if (operation === "stop" && args.at(-1) === "caddy") {
  const marker = resolve(stateDir, "hung-caddy-stop");
  if (composeMode === "hang-first-stop" && !existsSync(marker)) {
    writeFileSync(marker, "");
    writeFileSync(resolve(stateDir, "process-parent.pid"), String(process.pid));
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { stdio: "ignore" },
    );
    writeFileSync(resolve(stateDir, "process-child.pid"), String(child.pid));
    log("hang-stop-caddy");
    await new Promise(() => undefined);
  }
  writeFileSync(resolve(stateDir, "caddy"), "false");
  log("stop-caddy");
  process.exit(0);
}

if (operation === "kill" && args.at(-1) === "caddy") {
  writeFileSync(resolve(stateDir, "caddy"), "false");
  log("kill-caddy");
  process.exit(0);
}

process.stderr.write("unexpected fake Docker operation\\n");
process.exit(64);
`;
