import { assertHealthyInternalStatus } from "./pilot-smoke-lib.mjs";

const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 5_000;

const timeoutMs = readPositiveInteger(process.argv[2], DEFAULT_TIMEOUT_MS);
const publicBaseUrl = normalizeBaseUrl(
  process.env.IRIS_PILOT_PUBLIC_BASE_URL ?? "http://127.0.0.1",
);
const coreBaseUrl = normalizeBaseUrl(
  process.env.IRIS_PILOT_CORE_BASE_URL ?? "http://127.0.0.1:3000",
);
const internalApiToken =
  process.env.IRIS_PILOT_INTERNAL_API_TOKEN ?? "ci-internal-token";

try {
  await waitForStatus(`${publicBaseUrl}/health`, 200, timeoutMs);
  await expectStatus(`${publicBaseUrl}/internal/status`, 404);
  await expectStatus(`${publicBaseUrl}/internal/readiness`, 404);
  await expectStatus(`${coreBaseUrl}/internal/status`, 401);
  await expectStatus(`${coreBaseUrl}/internal/status`, 401, {
    authorization: "Bearer wrong-token",
  });
  const internalStatusResponse = await expectStatus(`${coreBaseUrl}/internal/status`, 200, {
    authorization: `Bearer ${internalApiToken}`,
  });
  assertHealthyInternalStatus(await internalStatusResponse.json());

  console.log(
    JSON.stringify({
      ok: true,
      checks: {
        publicHealth: 200,
        publicInternalStatus: 404,
        publicInternalReadiness: 404,
        privateInternalStatusWithoutToken: 401,
        privateInternalStatusWithWrongToken: 401,
        privateInternalStatusWithToken: 200,
        privateInternalStatusHealth: "healthy",
      },
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
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
