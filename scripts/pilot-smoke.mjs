import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertDurableRuntimeMutation,
  assertFastFeishuAcknowledgement,
  assertKnowledgeCardOutboxReady,
  assertPilotActivationReady,
} from "./pilot-smoke-lib.mjs";

const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 5_000;
const FEISHU_ACK_DEADLINE_MS = 2_500;
const CLEANUP_RETRY_COUNT = 3;
const PROCESS_KILL_GRACE_MS = 250;

const { postRestore, timeoutMs } = readSmokeOptions(process.argv.slice(2));
const publicBaseUrl = normalizeBaseUrl(
  process.env.IRIS_PILOT_PUBLIC_BASE_URL ?? "http://127.0.0.1",
);
const coreBaseUrl = normalizeBaseUrl(
  process.env.IRIS_PILOT_CORE_BASE_URL ?? "http://127.0.0.1:3000",
);
const internalApiToken =
  process.env.IRIS_PILOT_INTERNAL_API_TOKEN ?? "ci-internal-token";
const feishuVerificationToken =
  process.env.IRIS_PILOT_FEISHU_VERIFICATION_TOKEN ?? "ci-verification-token";
const cleanupRetryDelayMs = readBoundedDecimal(
  process.env.IRIS_PILOT_CLEANUP_RETRY_DELAY_MS,
  200,
  0,
  10_000,
  "IRIS_PILOT_CLEANUP_RETRY_DELAY_MS",
);
const composeCommandTimeoutMs = readBoundedDecimal(
  process.env.IRIS_PILOT_COMPOSE_COMMAND_TIMEOUT_MS,
  30_000,
  50,
  300_000,
  "IRIS_PILOT_COMPOSE_COMMAND_TIMEOUT_MS",
);
const dockerCommand = process.env.IRIS_PILOT_DOCKER_COMMAND ?? "docker";
const dockerCommandArgs = readStringArrayJson(
  process.env.IRIS_PILOT_DOCKER_COMMAND_ARGS_JSON,
  "IRIS_PILOT_DOCKER_COMMAND_ARGS_JSON",
);
const composeEnvFile =
  process.env.IRIS_PILOT_ENV_FILE ?? process.env.IRIS_ENV_FILE ?? "deploy/pilot/ci.env";
const composeArguments = [
  ...dockerCommandArgs,
  "compose",
  "--env-file",
  composeEnvFile,
  "--file",
  process.env.IRIS_PILOT_COMPOSE_FILE ??
    process.env.IRIS_COMPOSE_FILE ??
    "deploy/pilot/docker-compose.yml",
];

let runtimeEnableAttempted = false;
let completedChecks;
let primaryError;
let cleanupError;
let publicCallbackBoundaries;

try {
  assertKnowledgeCardDefaults();
  if (postRestore) {
    await assertCaddyRunning(false);
  } else {
    publicCallbackBoundaries = await runPublicBoundaryChecks();
  }
  await expectStatus(`${coreBaseUrl}/internal/status`, 401);
  await expectStatus(`${coreBaseUrl}/internal/ingress-readiness`, 401);
  await expectStatus(`${coreBaseUrl}/internal/status`, 401, {
    authorization: "Bearer wrong-token",
  });
  const internalStatusResponse = await expectStatus(`${coreBaseUrl}/internal/status`, 200, {
    authorization: `Bearer ${internalApiToken}`,
  });
  const internalStatus = await internalStatusResponse.json();
  assertPilotActivationReady(internalStatus);
  const knowledgeCardOutbox = assertKnowledgeCardOutboxReady(internalStatus.knowledgeCards);
  const knowledgeCardReadiness = await assertKnowledgeCardReadiness();
  const ingressReadinessResponse = await expectStatus(
    `${coreBaseUrl}/internal/ingress-readiness`,
    200,
    { authorization: `Bearer ${internalApiToken}` },
  );
  const ingressReadiness = await ingressReadinessResponse.json();
  if (ingressReadiness.ok !== true || ingressReadiness.status !== "ready") {
    throw new Error("Expected Iris ingress readiness to be ready");
  }

  runtimeEnableAttempted = true;
  await setGlobalRuntime(true);

  if (postRestore) {
    await startCaddyVerified();
    publicCallbackBoundaries = await runPublicBoundaryChecks();
  }

  const callbackStartedAt = Date.now();
  const callbackResponse = await requestJson(`${publicBaseUrl}/feishu/events`, {
    token: feishuVerificationToken,
    header: {
      event_id: "pilot-smoke-event",
      event_type: "im.message.receive_v1",
      token: feishuVerificationToken,
    },
    event: {
      message: {
        message_id: "pilot-smoke-message",
        chat_id: "pilot-smoke-chat",
        message_type: "text",
        content: JSON.stringify({ text: "pilot smoke" }),
      },
    },
  });
  const callbackElapsedMs = Date.now() - callbackStartedAt;
  assertFastFeishuAcknowledgement({
    status: callbackResponse.status,
    body: await callbackResponse.json(),
    elapsedMs: callbackElapsedMs,
    deadlineMs: FEISHU_ACK_DEADLINE_MS,
  });
  await waitForPendingEvent(coreBaseUrl, internalApiToken, timeoutMs);

  completedChecks = {
    publicHealth: 200,
    publicInternalStatus: 404,
    publicInternalReadiness: 404,
    publicIngressReadiness: 404,
    privateInternalStatusWithoutToken: 401,
    privateInternalStatusWithWrongToken: 401,
    privateInternalStatusWithToken: 200,
    privateInternalStatusHealth: "healthy",
    privateIngressReadiness: "ready",
    knowledgeCardDefaults: "disabled-empty-allowlist",
    knowledgeCardReadiness,
    knowledgeCardStatus: "unavailable-while-disabled",
    knowledgeCardOutbox,
    runtimeStartup: "disabled",
    runtimeEnablement: "explicit",
    smokeMode: postRestore ? "post-restore" : "ordinary",
    ...publicCallbackBoundaries,
    feishuCallback: 200,
    feishuCallbackAckUnderMs: FEISHU_ACK_DEADLINE_MS,
    durableRawEventQueue: "persisted",
  };
} catch (error) {
  primaryError = error;
} finally {
  if (runtimeEnableAttempted) {
    try {
      await disableGlobalRuntimeDurably();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError !== undefined || (postRestore && primaryError !== undefined)) {
    try {
      await stopCaddyVerified();
    } catch (error) {
      cleanupError = combineCleanupErrors(cleanupError, error);
    }
  }
}

const failure = combineErrors(primaryError, cleanupError);
if (failure !== undefined) {
  console.error(formatError(failure));
  process.exitCode = 1;
} else if (completedChecks !== undefined) {
  console.log(
    JSON.stringify({
      ok: true,
      checks: { ...completedChecks, runtimeRestored: "disabled" },
    }),
  );
}

function combineErrors(primary, cleanup) {
  if (primary !== undefined && cleanup !== undefined) {
    return new AggregateError(
      [primary, cleanup],
      "Pilot smoke failed and compensating disable also failed",
      { cause: primary },
    );
  }
  return primary ?? cleanup;
}

function combineCleanupErrors(first, second) {
  if (first === undefined) {
    return second;
  }
  return new AggregateError(
    [first, second],
    "Pilot smoke durable-disable and Caddy cleanup both failed",
  );
}

function formatError(error) {
  if (error instanceof AggregateError) {
    return [
      `${error.name}: ${sanitizeErrorText(error.message)}`,
      ...error.errors.map((nestedError) => formatError(nestedError)),
    ].join("\n");
  }
  return error instanceof Error
    ? `${error.name}: ${sanitizeErrorText(error.message)}`
    : sanitizeErrorText(String(error));
}

function sanitizeErrorText(value) {
  let sanitized = value
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/(authorization\s*[:=]\s*)\S+/giu, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[redacted]@");
  if (internalApiToken.length > 0) {
    sanitized = sanitized.split(internalApiToken).join("[redacted]");
  }
  return sanitized.slice(0, 1_024);
}

function assertKnowledgeCardDefaults() {
  const envFileValues = readComposeEnvFile(composeEnvFile);
  const enabled = readEffectiveComposeEnvValue(
    "IRIS_KNOWLEDGE_CARD_ENABLED",
    envFileValues,
    "false",
  );
  const groupIds = readEffectiveComposeEnvValue(
    "IRIS_KNOWLEDGE_CARD_GROUP_IDS",
    envFileValues,
    "",
  );
  if (enabled !== "false" || groupIds !== "") {
    throw new Error(
      "Pilot smoke requires IRIS_KNOWLEDGE_CARD_ENABLED=false and an empty IRIS_KNOWLEDGE_CARD_GROUP_IDS allowlist",
    );
  }
}

function readComposeEnvFile(path) {
  let contents;
  try {
    contents = readFileSync(resolve(path), "utf8");
  } catch {
    throw new Error(`Pilot smoke could not read selected Compose env file: ${path}`);
  }

  const values = new Map();
  for (const line of contents.split(/\r?\n/u)) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (match === null) continue;
    const [, name, value] = match;
    if (values.has(name)) {
      throw new Error(`Selected Compose env file repeats ${name}`);
    }
    values.set(name, value);
  }
  return values;
}

function readEffectiveComposeEnvValue(name, envFileValues, fallback) {
  const value = Object.hasOwn(process.env, name) ? process.env[name] : envFileValues.get(name);
  return value === undefined || value === "" ? fallback : value;
}

async function assertKnowledgeCardReadiness() {
  const readinessResponse = await expectStatus(`${coreBaseUrl}/internal/readiness`, 200, {
    authorization: `Bearer ${internalApiToken}`,
  });
  const readiness = await readinessResponse.json();
  const knowledgeCards = readiness?.checks?.find?.((check) => check?.id === "knowledgeCards");
  if (
    readiness?.ok !== true ||
    readiness?.status !== "ready" ||
    knowledgeCards?.status !== "pass" ||
    knowledgeCards?.detail !== "Knowledge cards are safely disabled."
  ) {
    throw new Error("Expected knowledge-card readiness to prove the default-off configuration");
  }
  assertContentFreeKnowledgeCardResponse(
    { ok: readiness.ok, status: readiness.status, knowledgeCards },
    "knowledge-card readiness",
  );

  const statusResponse = await expectStatus(
    `${coreBaseUrl}/internal/approval-interactions/status`,
    503,
    { authorization: `Bearer ${internalApiToken}` },
  );
  const status = await statusResponse.json();
  if (status?.ok !== false || status?.error !== "knowledge_card_runtime_unavailable") {
    throw new Error("Expected the disabled knowledge-card status route to remain content-free");
  }
  assertContentFreeKnowledgeCardResponse(status, "knowledge-card status");
  return "safe-disabled";
}

function assertContentFreeKnowledgeCardResponse(value, label, key = undefined) {
  if (typeof value === "string") {
    if (key === "detail" && value === "Knowledge cards are safely disabled.") return;
    if (key === "envVars" && /^[A-Z][A-Z0-9_]*$/u.test(value)) return;
    if (/(draft|body|content|evidence|reason|actoropenid|token|secret)/iu.test(value)) {
      throw new Error(`Expected ${label} to be content-free`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertContentFreeKnowledgeCardResponse(item, label, key);
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    if (/(draft|body|content|evidence|reason|actoropenid|token|secret)/iu.test(nestedKey)) {
      throw new Error(`Expected ${label} to be content-free`);
    }
    assertContentFreeKnowledgeCardResponse(nestedValue, label, nestedKey);
  }
}

async function runPublicBoundaryChecks() {
  await waitForStatus(`${publicBaseUrl}/health`, 200, timeoutMs);
  const events = await expectPublicCallbackRoute("/feishu/events");
  const cardActions = await expectPublicCallbackRoute("/feishu/card-actions");
  await expectStatus(`${publicBaseUrl}/internal/status`, 404);
  await expectStatus(`${publicBaseUrl}/internal/readiness`, 404);
  await expectStatus(`${publicBaseUrl}/internal/ingress-readiness`, 404);
  return {
    feishuEventsBoundary: events,
    feishuCardActionsBoundary: cardActions,
  };
}

async function expectPublicCallbackRoute(path) {
  const response = await requestJson(`${publicBaseUrl}${path}`, { pilotBoundaryProbe: true });
  if (response.status === 404) {
    throw new Error(`Expected public callback ${path} to reach Iris Core`);
  }
  return "non-404";
}

async function waitForStatus(url, expectedStatus, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let latestFailure = "no response";

  while (Date.now() < deadline) {
    try {
      const response = await request(url);
      if (response.status === expectedStatus) {
        return;
      }
      latestFailure = `status ${response.status}`;
    } catch (error) {
      latestFailure = error instanceof Error ? error.message : String(error);
    }

    await delay(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }

  throw new Error(
    `Timed out waiting for ${url} to return ${expectedStatus}: ${latestFailure}`,
  );
}

async function expectStatus(url, expectedStatus, headers = undefined) {
  const response = await request(url, headers);
  if (response.status !== expectedStatus) {
    throw new Error(
      `Expected ${url} to return ${expectedStatus}, received ${response.status}`,
    );
  }
  return response;
}

function request(url, headers = undefined) {
  return fetch(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function requestJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function setGlobalRuntime(enabled) {
  const response = await fetch(`${coreBaseUrl}/internal/runtime-control/global`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${internalApiToken}`,
      "content-type": "application/json",
      "x-iris-operator": "pilot-smoke",
    },
    body: JSON.stringify({ enabled }),
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json();
  assertDurableRuntimeMutation({ responseStatus: response.status, body, enabled });
}

async function disableGlobalRuntimeDurably() {
  const errors = [];
  for (let attempt = 1; attempt <= CLEANUP_RETRY_COUNT; attempt += 1) {
    try {
      await setGlobalRuntime(false);
      return;
    } catch (error) {
      errors.push(
        new Error(
          `Durable disable attempt ${attempt} failed: ${errorMessage(error)}`,
        ),
      );
    }
    if (attempt < CLEANUP_RETRY_COUNT) {
      await delay(cleanupRetryDelayMs);
    }
  }
  throw new AggregateError(
    errors,
    `Unable to prove durable runtime disable after ${CLEANUP_RETRY_COUNT} attempts`,
  );
}

function errorMessage(error) {
  return sanitizeErrorText(error instanceof Error ? error.message : String(error));
}

async function startCaddyVerified() {
  await runCompose("up", "--detach", "--wait", "--wait-timeout", "120", "caddy");
  await assertCaddyRunning(true);
}

async function stopCaddyVerified() {
  const errors = [];
  for (let attempt = 1; attempt <= CLEANUP_RETRY_COUNT; attempt += 1) {
    try {
      await runCompose("stop", "caddy");
    } catch (error) {
      errors.push(
        new Error(`Caddy stop attempt ${attempt} failed: ${errorMessage(error)}`),
      );
    }
    try {
      if (!(await readCaddyRunning())) {
        return;
      }
      errors.push(new Error(`Caddy remained running after stop attempt ${attempt}`));
    } catch (error) {
      errors.push(
        new Error(
          `Caddy stop verification attempt ${attempt} failed: ${errorMessage(error)}`,
        ),
      );
    }
    if (attempt < CLEANUP_RETRY_COUNT) {
      await delay(cleanupRetryDelayMs);
    }
  }

  try {
    await runCompose("kill", "caddy");
  } catch (error) {
    errors.push(new Error(`Caddy kill failed: ${errorMessage(error)}`));
  }
  try {
    if (!(await readCaddyRunning())) {
      return;
    }
    errors.push(new Error("Caddy remained running after bounded stop and kill"));
  } catch (error) {
    errors.push(new Error(`Final Caddy verification failed: ${errorMessage(error)}`));
  }
  throw new AggregateError(errors, "Unable to verify Caddy stopped");
}

async function assertCaddyRunning(expected) {
  const actual = await readCaddyRunning();
  if (actual !== expected) {
    throw new Error(
      expected
        ? "Expected Caddy to be running"
        : "Expected Caddy to be stopped before private post-restore gates",
    );
  }
}

async function readCaddyRunning() {
  const output = await runCompose("ps", "--status", "running", "--services");
  return output.split(/\r?\n/u).some((service) => service.trim() === "caddy");
}

function runCompose(...args) {
  return runProcessTree(
    dockerCommand,
    [...composeArguments, ...args],
    composeCommandTimeoutMs,
    args[0] ?? "command",
  );
}

function runProcessTree(command, args, deadlineMs, operation) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let timedOut = false;
    let settled = false;
    let killTimer;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 65_536) {
        stdout += chunk.slice(0, 65_536 - stdout.length);
      }
    });
    child.stderr.resume();

    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        terminateProcessTree(child, "SIGKILL");
      }, PROCESS_KILL_GRACE_MS);
    }, deadlineMs);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      rejectPromise(
        new Error(`Docker Compose ${operation} could not start: ${errorMessage(error)}`),
      );
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (timedOut) {
        rejectPromise(
          new Error(`Docker Compose ${operation} timed out after ${deadlineMs}ms`),
        );
      } else if (code !== 0) {
        clearTimeout(killTimer);
        rejectPromise(
          new Error(`Docker Compose ${operation} failed with exit status ${code ?? "unknown"}`),
        );
      } else {
        clearTimeout(killTimer);
        resolvePromise(stdout);
      }
    });
  });
}

function terminateProcessTree(child, signal) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const taskkill = spawn(
      "taskkill",
      ["/pid", String(child.pid), "/t", "/f"],
      { stdio: "ignore", windowsHide: true },
    );
    taskkill.unref();
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      child.kill(signal);
    }
  }
}

async function waitForPendingEvent(baseUrl, token, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const response = await request(`${baseUrl}/internal/status`, {
      authorization: `Bearer ${token}`,
    });
    if (response.ok) {
      const body = await response.json();
      if (body.components?.eventWorker?.pendingEventCount >= 1) {
        return;
      }
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error("Timed out waiting for the Feishu callback to persist in the raw event queue");
}

function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Pilot smoke base URLs must use http or https");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error("Pilot smoke base URLs must not include credentials");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/u, "");
}

function readSmokeOptions(args) {
  const remaining = [...args];
  const postRestore = remaining[0] === "--post-restore";
  if (postRestore) {
    remaining.shift();
  }
  if (remaining.length > 1) {
    throw new Error("usage: pilot-smoke.mjs [--post-restore] [timeout-ms]");
  }
  return {
    postRestore,
    timeoutMs: readPositiveInteger(remaining[0], DEFAULT_TIMEOUT_MS),
  };
}

function readPositiveInteger(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error("Pilot smoke timeout must be a positive integer");
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Pilot smoke timeout must be a positive safe integer");
  }
  return parsed;
}

function readBoundedDecimal(value, fallback, minimum, maximum, name) {
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} must be a decimal integer between ${minimum} and ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a decimal integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function readStringArrayJson(value, name) {
  if (value === undefined) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be a JSON array of command arguments`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 16 ||
    parsed.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error(`${name} must be a JSON array of command arguments`);
  }
  return parsed;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
