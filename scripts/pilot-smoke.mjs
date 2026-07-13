import {
  assertFastFeishuAcknowledgement,
  assertHealthyInternalStatus,
  assertRuntimeGloballyDisabled,
} from "./pilot-smoke-lib.mjs";

const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 5_000;
const FEISHU_ACK_DEADLINE_MS = 2_500;

const timeoutMs = readPositiveInteger(process.argv[2], DEFAULT_TIMEOUT_MS);
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

let runtimeEnabledBySmoke = false;
let completedChecks;

try {
  await waitForStatus(`${publicBaseUrl}/health`, 200, timeoutMs);
  await expectStatus(`${publicBaseUrl}/internal/status`, 404);
  await expectStatus(`${publicBaseUrl}/internal/readiness`, 404);
  await expectStatus(`${publicBaseUrl}/internal/ingress-readiness`, 404);
  await expectStatus(`${coreBaseUrl}/internal/status`, 401);
  await expectStatus(`${coreBaseUrl}/internal/ingress-readiness`, 401);
  await expectStatus(`${coreBaseUrl}/internal/status`, 401, {
    authorization: "Bearer wrong-token",
  });
  const internalStatusResponse = await expectStatus(`${coreBaseUrl}/internal/status`, 200, {
    authorization: `Bearer ${internalApiToken}`,
  });
  const internalStatus = await internalStatusResponse.json();
  assertHealthyInternalStatus(internalStatus);
  assertRuntimeGloballyDisabled(internalStatus);
  const ingressReadinessResponse = await expectStatus(
    `${coreBaseUrl}/internal/ingress-readiness`,
    200,
    { authorization: `Bearer ${internalApiToken}` },
  );
  const ingressReadiness = await ingressReadinessResponse.json();
  if (ingressReadiness.ok !== true || ingressReadiness.status !== "ready") {
    throw new Error("Expected Iris ingress readiness to be ready");
  }

  await setGlobalRuntime(true);
  runtimeEnabledBySmoke = true;

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
    runtimeStartup: "disabled",
    runtimeEnablement: "explicit",
    feishuCallback: 200,
    feishuCallbackAckUnderMs: FEISHU_ACK_DEADLINE_MS,
    durableRawEventQueue: "persisted",
  };
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (runtimeEnabledBySmoke) {
    try {
      await setGlobalRuntime(false);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

if (process.exitCode !== 1 && completedChecks !== undefined) {
  console.log(
    JSON.stringify({
      ok: true,
      checks: { ...completedChecks, runtimeRestored: "disabled" },
    }),
  );
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
  if (response.status !== 200 || body.globalEnabled !== enabled) {
    throw new Error(`Unable to set pilot runtime global enablement to ${enabled}`);
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
