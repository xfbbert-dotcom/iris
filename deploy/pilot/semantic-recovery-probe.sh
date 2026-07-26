#!/usr/bin/env bash
set -euo pipefail

repo="${IRIS_REPOSITORY_DIR:-$(pwd)}"
env_file="${IRIS_PILOT_ENV_FILE:-$repo/.env.pilot}"
compose_file="${IRIS_COMPOSE_FILE:-$repo/deploy/pilot/docker-compose.yml}"
compose=(docker compose --env-file "$env_file" --file "$compose_file")

"${compose[@]}" exec -T core node --input-type=module <<'NODE'
const internalToken = requireNonEmptyEnv("IRIS_INTERNAL_API_TOKEN");
const aiWorkerToken = requireNonEmptyEnv("IRIS_AI_WORKER_TOKEN");
const aiWorkerBaseUrl = requireNonEmptyEnv("IRIS_AI_WORKER_BASE_URL").replace(/\/+$/u, "");
const headers = { authorization: `Bearer ${internalToken}` };

const status = await getJson("http://127.0.0.1:3000/internal/status", headers);
const runtime = await getJson("http://127.0.0.1:3000/internal/runtime-control/status", headers);
const extraction = await getJson("http://127.0.0.1:3000/internal/memory-extraction/status", headers);
const dlq = await getJson("http://127.0.0.1:3000/internal/memory-extraction/dead-letters?limit=20", headers);

assertFailClosed({ status, runtime, extraction, dlq });

const probe = await fetch(`${aiWorkerBaseUrl}/v1/memory/extract`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${aiWorkerToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(minimalV2ProbeRequest()),
});

const probeBody = await safeJson(probe);
if (!probe.ok) {
  console.log(JSON.stringify({
    ok: false,
    phase: "gemini_probe",
    status: probe.status,
    classification: classifyProbeFailure(probe.status, probeBody),
    retryAfterSeconds: readRetryAfter(probe),
  }));
  process.exit(2);
}

console.log(JSON.stringify({
  ok: true,
  phase: "gemini_probe",
  status: probe.status,
  semanticDlqCount: dlq.deadLetters.length,
}));

function minimalV2ProbeRequest() {
  return {
    schema_version: 2,
    run_id: "semantic-recovery-probe",
    group_id: "semantic-recovery-probe-group",
    input_fingerprint: "0".repeat(64),
    messages: [
      {
        id: "semantic-recovery-probe-message",
        sender_open_id: "semantic-recovery-probe-sender",
        sent_at: "2026-07-26T00:00:00.000Z",
        text: "Readiness probe. Return no candidates.",
        mentions: [],
      },
    ],
    evidence_message_ids: ["semantic-recovery-probe-message"],
    existing_memories: [],
    existing_threads: [],
    existing_actions: [],
    enabled_operation_families: ["memory", "thread", "action"],
  };
}

async function getJson(url, requestHeaders) {
  const response = await fetch(url, { headers: requestHeaders });
  const body = await safeJson(response);
  if (!response.ok) {
    throw new Error(`Preflight request failed: ${new URL(url).pathname} ${response.status}`);
  }
  return body;
}

async function safeJson(response) {
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: "invalid_json_response" };
  }
}

function assertFailClosed({ status, runtime, extraction, dlq }) {
  if (status.ok !== true || status.status !== "healthy") {
    throw new Error("Core internal status is not healthy");
  }
  if (runtime.globalEnabled !== false || runtime.desiredGlobalEnabled !== false) {
    throw new Error("Runtime is not globally fail-closed");
  }
  if (runtime.capabilities?.proactiveSpeech !== false) {
    throw new Error("proactiveSpeech is not disabled");
  }
  const counts = {
    pendingJobCount: extraction.pendingJobCount,
    processingJobCount: extraction.processingJobCount,
    delayedJobCount: extraction.delayedJobCount,
  };
  for (const [name, value] of Object.entries(counts)) {
    if (value !== 0) throw new Error(`Memory extraction ${name} is not zero`);
  }
  if (!Array.isArray(dlq.deadLetters) || dlq.deadLetters.length !== 6) {
    throw new Error("Expected exactly six preserved semantic DLQ records before recovery probe");
  }
}

function classifyProbeFailure(statusCode, body) {
  if (statusCode === 429) return "provider_rate_limited";
  if (statusCode === 503) return "provider_unavailable";
  if (statusCode === 504) return "provider_timeout";
  if (statusCode === 502 && body?.error === "invalid_model_response") return "invalid_model_response";
  if (typeof body?.error === "string") return body.error;
  return "probe_failed";
}

function readRetryAfter(response) {
  const raw = response.headers.get("retry-after");
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function requireNonEmptyEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}
NODE
