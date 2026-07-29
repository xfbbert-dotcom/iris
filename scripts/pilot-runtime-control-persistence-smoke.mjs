import assert from "node:assert/strict";

import { readPilotEnv, runPilotCompose } from "./pilot-compose-lib.mjs";

const pilotEnv = readPilotEnv();
const internalApiToken = pilotEnv.IRIS_INTERNAL_API_TOKEN;
const privateBaseUrl =
  process.env.IRIS_PILOT_PRIVATE_BASE_URL ??
  `http://127.0.0.1:${pilotEnv.IRIS_CORE_LOOPBACK_PORT ?? "3000"}`;
const proofGroupId = "chat-runtime-control-restart-proof";

if (!internalApiToken) {
  throw new Error("IRIS_INTERNAL_API_TOKEN is required in deploy/pilot/ci.env");
}

const headers = {
  authorization: `Bearer ${internalApiToken}`,
  "content-type": "application/json",
};

try {
  await updateControl("/internal/runtime-control/global", "POST", { enabled: false });
  await updateControl(
    `/internal/runtime-control/groups/${encodeURIComponent(proofGroupId)}`,
    "POST",
    { enabled: false },
  );
  await updateControl("/internal/runtime-control/capabilities", "PATCH", {
    callExternalTools: true,
  });

  const restart = runPilotCompose(["restart", "core"]);
  if (restart.status !== 0) {
    throw new Error(composeFailure("restart Pilot Core", restart));
  }

  const restored = await waitForRuntimeControlStatus();
  assert.equal(restored.globalEnabled, false);
  assert.equal(restored.disabledGroupIds.includes(proofGroupId), true);
  assert.equal(restored.capabilities.callExternalTools, true);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      checks: {
        globalControlRestored: true,
        groupControlRestored: true,
        capabilityControlRestored: true,
      },
    })}\n`,
  );
} finally {
  await restoreDefaultControls();
}

async function restoreDefaultControls() {
  const failures = [];
  for (const [path, method, body] of [
    ["/internal/runtime-control/global", "POST", { enabled: true }],
    [
      `/internal/runtime-control/groups/${encodeURIComponent(proofGroupId)}`,
      "POST",
      { enabled: true },
    ],
    [
      "/internal/runtime-control/capabilities",
      "PATCH",
      { callExternalTools: false },
    ],
  ]) {
    try {
      await updateControl(path, method, body);
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "failed to restore Pilot runtime controls");
  }
}

async function waitForRuntimeControlStatus() {
  let latestError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await requestJson("/internal/runtime-control/status");
    } catch (error) {
      latestError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error("Pilot Core did not recover after restart", {
    cause: latestError,
  });
}

async function updateControl(path, method, body) {
  return requestJson(path, {
    method,
    body: JSON.stringify(body),
  });
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${privateBaseUrl}${path}`, {
    ...options,
    headers,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

function composeFailure(action, result) {
  const details =
    result.error?.message ||
    result.stderr?.trim() ||
    result.stdout?.trim() ||
    `docker compose exited with status ${String(result.status)}`;
  return `Unable to ${action}: ${details}`;
}
