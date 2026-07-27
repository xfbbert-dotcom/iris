#!/usr/bin/env bash
set -euo pipefail

repo="${IRIS_REPOSITORY_DIR:-$(pwd)}"
env_file="${IRIS_PILOT_ENV_FILE:-$repo/.env.pilot}"
compose_file="${IRIS_COMPOSE_FILE:-$repo/deploy/pilot/docker-compose.yml}"
compose=(docker compose --env-file "$env_file" --file "$compose_file")

if [[ "${IRIS_SEMANTIC_FRESH_ACCEPTANCE_CONFIRM:-}" != "RUN_FRESH_SEMANTIC_ACCEPTANCE_ONE_BY_ONE" ]]; then
  echo "Set IRIS_SEMANTIC_FRESH_ACCEPTANCE_CONFIRM=RUN_FRESH_SEMANTIC_ACCEPTANCE_ONE_BY_ONE to run fresh semantic acceptance." >&2
  exit 64
fi

group_id="${IRIS_SEMANTIC_FRESH_ACCEPTANCE_GROUP_ID:-}"
if [[ -z "$group_id" || "$group_id" == *"<"* || "$group_id" == *">"* ]]; then
  echo "Set IRIS_SEMANTIC_FRESH_ACCEPTANCE_GROUP_ID to a fresh approved internal group id." >&2
  exit 64
fi

marker="${IRIS_SEMANTIC_FRESH_ACCEPTANCE_MARKER:-}"
if [[ -z "$marker" ]]; then
  echo "Set IRIS_SEMANTIC_FRESH_ACCEPTANCE_MARKER to a nonblank literal marker." >&2
  exit 64
fi

expected_count="${IRIS_SEMANTIC_FRESH_ACCEPTANCE_EXPECTED_COUNT:-6}"
if [[ ! "$expected_count" =~ ^[0-9]+$ ]] || (( expected_count < 1 || expected_count > 12 )); then
  echo "IRIS_SEMANTIC_FRESH_ACCEPTANCE_EXPECTED_COUNT must be an integer between 1 and 12." >&2
  exit 64
fi

known_group_ids="${IRIS_SEMANTIC_FRESH_ACCEPTANCE_KNOWN_GROUP_IDS:-}"
if [[ -z "$known_group_ids" || "$known_group_ids" == *"<"* || "$known_group_ids" == *">"* ]]; then
  echo "Set IRIS_SEMANTIC_FRESH_ACCEPTANCE_KNOWN_GROUP_IDS to the exhaustive comma-separated group inventory." >&2
  exit 64
fi

command_timeout_seconds="${IRIS_SEMANTIC_FRESH_ACCEPTANCE_COMMAND_TIMEOUT_SECONDS:-1800}"
if [[ ! "$command_timeout_seconds" =~ ^[0-9]+$ ]] ||
  (( command_timeout_seconds < 60 || command_timeout_seconds > 3600 )); then
  echo "IRIS_SEMANTIC_FRESH_ACCEPTANCE_COMMAND_TIMEOUT_SECONDS must be an integer between 60 and 3600." >&2
  exit 64
fi

request_timeout_ms="${IRIS_SEMANTIC_FRESH_ACCEPTANCE_REQUEST_TIMEOUT_MS:-10000}"
if [[ ! "$request_timeout_ms" =~ ^[0-9]+$ ]] ||
  (( request_timeout_ms < 1000 || request_timeout_ms > 30000 )); then
  echo "IRIS_SEMANTIC_FRESH_ACCEPTANCE_REQUEST_TIMEOUT_MS must be an integer between 1000 and 30000." >&2
  exit 64
fi

force_fail_closed() {
  local original_status=$?
  local stop_status=0
  local cleanup_status=0
  trap - EXIT
  set +e
  "${compose[@]}" stop caddy >/dev/null
  stop_status=$?
  timeout --kill-after=10s 60s \
    "${compose[@]}" exec -T \
    -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_GROUP_ID="$group_id" \
    -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_REQUEST_TIMEOUT_MS="$request_timeout_ms" \
    core node --input-type=module <<'NODE'
const groupId = requireEnv("IRIS_SEMANTIC_FRESH_ACCEPTANCE_GROUP_ID");
const requestTimeoutMs = readTimeout(requireEnv("IRIS_SEMANTIC_FRESH_ACCEPTANCE_REQUEST_TIMEOUT_MS"));
const token = requireEnv("IRIS_INTERNAL_API_TOKEN");
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "x-iris-operator": "iris-semantic-fresh-acceptance-cleanup",
};

await request("POST", "http://127.0.0.1:3000/internal/runtime-control/global", { enabled: false });
await request("POST", `http://127.0.0.1:3000/internal/runtime-control/groups/${groupId}`, { enabled: false });
await request("PATCH", "http://127.0.0.1:3000/internal/runtime-control/capabilities", { proactiveSpeech: false });
const status = await getJson("http://127.0.0.1:3000/internal/runtime-control/status");
if (status.globalEnabled !== false || status.desiredGlobalEnabled !== false) {
  throw new Error("Cleanup could not prove global fail-closed state");
}
if (status.capabilities?.proactiveSpeech !== false) {
  throw new Error("Cleanup could not prove proactiveSpeech disabled");
}
if (!Array.isArray(status.disabledGroupIds) || !status.disabledGroupIds.includes(groupId)) {
  throw new Error("Cleanup could not prove acceptance group disabled");
}

async function request(method, url, body) {
  const response = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const parsed = await safeJson(response);
  if (!response.ok || parsed.ok === false || parsed.durable !== true) {
    throw new Error(`Cleanup mutation failed: ${new URL(url).pathname} ${response.status}`);
  }
}

async function getJson(url) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const parsed = await safeJson(response);
  if (!response.ok || parsed.ok === false) {
    throw new Error(`Cleanup read failed: ${new URL(url).pathname} ${response.status}`);
  }
  return parsed;
}

async function safeJson(response) {
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false };
  }
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readTimeout(value) {
  if (!/^[0-9]+$/u.test(value)) throw new Error("request timeout must be decimal");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1000 || parsed > 30000) {
    throw new Error("request timeout is out of range");
  }
  return parsed;
}
NODE
  cleanup_status=$?
  if (( stop_status != 0 || cleanup_status != 0 )); then
    echo "Fresh semantic acceptance fail-closed cleanup could not be proven." >&2
    exit 1
  fi
  exit "$original_status"
}

trap force_fail_closed EXIT
"${compose[@]}" stop caddy >/dev/null

timeout --kill-after=15s "${command_timeout_seconds}s" \
  "${compose[@]}" exec -T \
  -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_GROUP_ID="$group_id" \
  -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_MARKER="$marker" \
  -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_EXPECTED_COUNT="$expected_count" \
  -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_KNOWN_GROUP_IDS="$known_group_ids" \
  -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_REQUEST_TIMEOUT_MS="$request_timeout_ms" \
  core node --input-type=module <<'NODE'
import { createClient } from "redis";
import { createPostgresPool } from "/app/apps/core/dist/database/postgres.js";
import { createPostgresMemoryExtractionRepository } from "/app/apps/core/dist/memory-extraction/postgres-memory-extraction-repository.js";
import {
  createMemoryExtractionJob,
} from "/app/apps/core/dist/memory-extraction/memory-extraction-queue.js";
import { createRedisMemoryExtractionQueue } from "/app/apps/core/dist/memory-extraction/redis-memory-extraction-queue.js";
import { assertSemanticEvidenceIntegrity } from "/app/apps/core/dist/memory-extraction/semantic-evidence-integrity.js";

const internalToken = requireEnv("IRIS_INTERNAL_API_TOKEN");
const groupId = requireEnv("IRIS_SEMANTIC_FRESH_ACCEPTANCE_GROUP_ID");
const marker = requireEnv("IRIS_SEMANTIC_FRESH_ACCEPTANCE_MARKER");
const escapedMarker = escapeSqlLikePattern(marker);
const expectedCount = readExpectedCount(requireEnv("IRIS_SEMANTIC_FRESH_ACCEPTANCE_EXPECTED_COUNT"));
const knownGroupIds = readKnownGroupIds(requireEnv("IRIS_SEMANTIC_FRESH_ACCEPTANCE_KNOWN_GROUP_IDS"));
const requestTimeoutMs = readRequestTimeout(requireEnv("IRIS_SEMANTIC_FRESH_ACCEPTANCE_REQUEST_TIMEOUT_MS"));
if (!knownGroupIds.includes(groupId)) {
  throw new Error("Fresh semantic acceptance group is missing from the exhaustive group inventory");
}
const headers = {
  authorization: `Bearer ${internalToken}`,
  "content-type": "application/json",
  "x-iris-operator": "iris-semantic-fresh-acceptance",
};

const pool = createPostgresPool({ databaseUrl: requireEnv("DATABASE_URL") });
const redis = createClient({
  url: requireEnv("REDIS_URL"),
  socket: { reconnectStrategy: false },
});
redis.on("error", () => undefined);
await withDeadline(redis.connect(), "Redis connect");

try {
  await assertFailClosedBeforeAcceptance();
  const messages = await loadFreshMessages();
  const repository = createPostgresMemoryExtractionRepository({ dataSource: pool });
  const queue = createRedisMemoryExtractionQueue({ client: redis });

  await setGlobal(false);
  await setCapability({ proactiveSpeech: false });
  await setGroup(groupId, true);
  await assertPrivateGroupIsolation();
  await setGlobal(true);
  await assertPrivateWindowOpen();

  const results = [];
  for (const row of messages) {
    const result = await withDeadline(
      repository.registerRequest({
        groupId: row.group_id,
        conversationMessageId: row.message_id,
        providerMessageId: row.provider_message_id,
      }),
      "Fresh semantic acceptance request registration",
    );
    if (result.created !== true || result.request.status !== "pending") {
      throw new Error("Fresh semantic acceptance message already has an extraction request");
    }

    await withDeadline(
      queue.enqueue(
        createMemoryExtractionJob({
          requestId: result.request.id,
          groupId: result.request.groupId,
          now: new Date(),
        }),
      ),
      "Fresh semantic acceptance queue enqueue",
    );
    const terminal = await waitForRequestTerminal(result.request.id);
    results.push({
      requestId: result.request.id,
      runId: terminal.runId,
      retryObserved: terminal.retryObserved,
    });
    await assertNoMemoryDlq();
  }

  console.log(JSON.stringify({
    ok: true,
    groupId,
    marker,
    processedCount: results.length,
    retryObservedCount: results.filter((result) => result.retryObserved).length,
  }));
} finally {
  await safeMutation(() => setGlobal(false));
  await safeMutation(() => setGroup(groupId, false));
  await safeMutation(() => setCapability({ proactiveSpeech: false }));
  await assertFinalFailClosed();
  await withDeadline(redis.quit(), "Redis close");
  await withDeadline(pool.end(), "Postgres close");
}

async function loadFreshMessages() {
  const messagesResult = await withDeadline(
    pool.query(
      `
      SELECT
        id AS message_id,
        provider_message_id,
        chat_id AS group_id,
        text AS message_text
      FROM conversation_messages
      WHERE chat_id = $1
        AND text IS NOT NULL
        AND text LIKE '%' || $2 || '%' ESCAPE '\\'
      ORDER BY sent_at ASC, created_at ASC, id ASC
      LIMIT $3
      `,
      [groupId, escapedMarker, expectedCount + 1],
    ),
    "Fresh semantic acceptance message read",
  );
  if (messagesResult.rows.length !== expectedCount) {
    throw new Error(`Expected exactly ${expectedCount} fresh semantic acceptance messages`);
  }

  const messages = messagesResult.rows.map((row) => {
    assertSemanticEvidenceIntegrity({
      text: row.message_text,
      marker,
      messageId: row.message_id,
    });
    return {
      message_id: requireString(row.message_id, "message_id"),
      provider_message_id: requireString(row.provider_message_id, "provider_message_id"),
      group_id: requireString(row.group_id, "group_id"),
    };
  });
  const messageIds = messages.map((row) => row.message_id);
  const existingRequests = await withDeadline(
    pool.query(
      `
      SELECT COUNT(*)::integer AS count
      FROM group_memory_extraction_requests
      WHERE conversation_message_id = ANY($1::text[])
      `,
      [messageIds],
    ),
    "Fresh semantic acceptance history read",
  );
  if (existingRequests.rows[0]?.count !== 0) {
    throw new Error("Fresh semantic acceptance messages already have extraction history");
  }

  const existingState = await withDeadline(
    pool.query(
      `
      SELECT
        (SELECT COUNT(*)::integer FROM discussion_threads WHERE group_id = $1) AS thread_count,
        (SELECT COUNT(*)::integer FROM action_items WHERE group_id = $1) AS action_count
      `,
      [groupId],
    ),
    "Fresh semantic acceptance state read",
  );
  if (existingState.rows[0]?.thread_count !== 0 || existingState.rows[0]?.action_count !== 0) {
    throw new Error("Fresh semantic acceptance group already has semantic state");
  }
  return messages;
}

async function waitForRequestTerminal(requestId, { timeoutMs = 240000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let retryObserved = false;
  let idlePollCount = 0;

  while (Date.now() < deadline) {
    const [requestResult, queueStatus, deadLetters] = await Promise.all([
      withDeadline(
        pool.query(
          `
          SELECT
            request.status,
            request.skip_reason,
            request.run_id,
            run.status AS run_status,
            run.failure_classification
          FROM group_memory_extraction_requests request
          LEFT JOIN group_memory_extraction_runs run ON run.id = request.run_id
          WHERE request.id = $1
          `,
          [requestId],
        ),
        "Fresh semantic acceptance request status read",
      ),
      getJson("http://127.0.0.1:3000/internal/memory-extraction/status"),
      getJson("http://127.0.0.1:3000/internal/memory-extraction/dead-letters?limit=20"),
    ]);
    const request = requestResult.rows[0];
    if (request === undefined) {
      throw new Error("Fresh semantic acceptance request disappeared");
    }
    if ((deadLetters.deadLetters ?? []).length !== 0) {
      throw new Error("Fresh semantic acceptance produced a memory extraction DLQ entry");
    }
    if (request.failure_classification === "invalid_model_response_retry") {
      retryObserved = true;
    }
    const queueCounts = [
      queueStatus.pendingJobCount ?? 0,
      queueStatus.processingJobCount ?? 0,
      queueStatus.delayedJobCount ?? 0,
    ];
    const queueDrained = queueCounts.every((count) => count === 0);
    if (request.status === "completed" && queueDrained) {
      return {
        runId: requireString(request.run_id, "run_id"),
        retryObserved,
      };
    }
    if (request.status === "completed") {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    if (request.status === "skipped") {
      throw new Error(`Fresh semantic acceptance request was skipped: ${request.skip_reason ?? "unknown"}`);
    }
    if (request.status !== "pending" && request.status !== "processing") {
      throw new Error("Fresh semantic acceptance request reached an unknown status");
    }

    if (queueCounts.some((count) => count > 0)) {
      idlePollCount = 0;
    } else {
      idlePollCount += 1;
      if (idlePollCount >= 3) {
        throw new Error("Fresh semantic acceptance request stalled without queued retry work");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("Fresh semantic acceptance request did not reach a terminal state");
}

async function assertFailClosedBeforeAcceptance() {
  await assertKnownGroupInventory();
  const [status, runtime, extraction, deadLetters] = await Promise.all([
    getJson("http://127.0.0.1:3000/internal/status"),
    getJson("http://127.0.0.1:3000/internal/runtime-control/status"),
    getJson("http://127.0.0.1:3000/internal/memory-extraction/status"),
    getJson("http://127.0.0.1:3000/internal/memory-extraction/dead-letters?limit=20"),
  ]);
  if (status.ok !== true || status.status !== "healthy") {
    throw new Error("Core internal status is not healthy");
  }
  if (runtime.globalEnabled !== false || runtime.desiredGlobalEnabled !== false) {
    throw new Error("Runtime must start globally fail-closed");
  }
  if (runtime.capabilities?.proactiveSpeech !== false) {
    throw new Error("proactiveSpeech must start disabled");
  }
  assertExactDisabledGroupSet(runtime.disabledGroupIds, knownGroupIds);
  const counts = [
    extraction.pendingJobCount ?? 0,
    extraction.processingJobCount ?? 0,
    extraction.delayedJobCount ?? 0,
    extraction.pendingProjectionRepairCount ?? 0,
    extraction.failedProjectionRepairCount ?? 0,
  ];
  if (counts.some((count) => count !== 0)) {
    throw new Error("Memory extraction must start fully drained");
  }
  if ((deadLetters.deadLetters ?? []).length !== 0) {
    throw new Error("Memory extraction DLQ must start empty");
  }
}

async function assertKnownGroupInventory() {
  const result = await withDeadline(
    pool.query(
      `
      SELECT DISTINCT group_id
      FROM (
        SELECT chat_id AS group_id FROM conversation_messages
        UNION SELECT group_id FROM group_memories
        UNION SELECT group_id FROM discussion_threads
        UNION SELECT group_id FROM action_items
      ) known_groups
      WHERE group_id IS NOT NULL AND group_id <> ''
      ORDER BY group_id
      `,
    ),
    "Known group inventory read",
  );
  const databaseGroupIds = result.rows.map((row) => requireString(row.group_id, "known group id"));
  const unknownGroupIds = databaseGroupIds.filter((knownGroupId) => !knownGroupIds.includes(knownGroupId));
  if (unknownGroupIds.length > 0) {
    throw new Error("Database contains a group missing from the exhaustive acceptance inventory");
  }
}

async function assertPrivateGroupIsolation() {
  const runtime = await getJson("http://127.0.0.1:3000/internal/runtime-control/status");
  if (runtime.globalEnabled !== false || runtime.desiredGlobalEnabled !== false) {
    throw new Error("Global runtime changed before the private group isolation gate");
  }
  assertExactDisabledGroupSet(
    runtime.disabledGroupIds,
    knownGroupIds.filter((knownGroupId) => knownGroupId !== groupId),
  );
}

async function assertPrivateWindowOpen() {
  const runtime = await getJson("http://127.0.0.1:3000/internal/runtime-control/status");
  if (runtime.globalEnabled !== true || runtime.desiredGlobalEnabled !== true) {
    throw new Error("Private processing window did not open durably");
  }
  if (runtime.capabilities?.proactiveSpeech !== false) {
    throw new Error("proactiveSpeech changed during the private processing window");
  }
  assertExactDisabledGroupSet(
    runtime.disabledGroupIds,
    knownGroupIds.filter((knownGroupId) => knownGroupId !== groupId),
  );
}

async function assertNoMemoryDlq() {
  const deadLetters = await getJson("http://127.0.0.1:3000/internal/memory-extraction/dead-letters?limit=20");
  if ((deadLetters.deadLetters ?? []).length !== 0) {
    throw new Error("Fresh semantic acceptance produced a memory extraction DLQ entry");
  }
}

async function assertFinalFailClosed() {
  const runtime = await getJson("http://127.0.0.1:3000/internal/runtime-control/status");
  if (runtime.globalEnabled !== false || runtime.desiredGlobalEnabled !== false) {
    throw new Error("Final runtime state is not globally fail-closed");
  }
  if (runtime.capabilities?.proactiveSpeech !== false) {
    throw new Error("Final proactiveSpeech state is not disabled");
  }
  assertExactDisabledGroupSet(runtime.disabledGroupIds, knownGroupIds);
}

async function setGlobal(enabled) {
  return postJson("http://127.0.0.1:3000/internal/runtime-control/global", { enabled });
}

async function setGroup(groupId, enabled) {
  return postJson(`http://127.0.0.1:3000/internal/runtime-control/groups/${groupId}`, { enabled });
}

async function setCapability(body) {
  return patchJson("http://127.0.0.1:3000/internal/runtime-control/capabilities", body);
}

async function getJson(url) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const body = await safeJson(response);
  if (!response.ok || body.ok === false) {
    throw new Error(`Request failed: ${new URL(url).pathname} ${response.status}`);
  }
  return body;
}

async function postJson(url, body) {
  return requestJson("POST", url, body);
}

async function patchJson(url, body) {
  return requestJson("PATCH", url, body);
}

async function requestJson(method, url, body) {
  const response = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const parsed = await safeJson(response);
  if (!response.ok || parsed.ok === false) {
    throw new Error(`Mutation failed: ${new URL(url).pathname} ${response.status}`);
  }
  if (parsed.durable !== true) {
    throw new Error(`Mutation was not durable: ${new URL(url).pathname}`);
  }
  return parsed;
}

async function safeMutation(action) {
  try {
    await action();
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      cleanup: "failed",
      error: error instanceof Error ? error.message : "unknown_error",
    }));
  }
}

async function safeJson(response) {
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid_json_response" };
  }
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a nonblank string`);
  }
  return value;
}

function readExpectedCount(value) {
  if (!/^[0-9]+$/u.test(value)) {
    throw new Error("IRIS_SEMANTIC_FRESH_ACCEPTANCE_EXPECTED_COUNT must be decimal");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 12) {
    throw new Error("IRIS_SEMANTIC_FRESH_ACCEPTANCE_EXPECTED_COUNT must be between 1 and 12");
  }
  return parsed;
}

function readKnownGroupIds(value) {
  const groupIds = [...new Set(value.split(",").map((groupId) => groupId.trim()))];
  if (groupIds.length === 0 || groupIds.some((groupId) =>
    groupId.length === 0 || groupId.includes("<") || groupId.includes(">") || groupId.length > 256
  )) {
    throw new Error("IRIS_SEMANTIC_FRESH_ACCEPTANCE_KNOWN_GROUP_IDS is invalid");
  }
  return groupIds.sort(compareStrings);
}

function readRequestTimeout(value) {
  if (!/^[0-9]+$/u.test(value)) {
    throw new Error("IRIS_SEMANTIC_FRESH_ACCEPTANCE_REQUEST_TIMEOUT_MS must be decimal");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1000 || parsed > 30000) {
    throw new Error("IRIS_SEMANTIC_FRESH_ACCEPTANCE_REQUEST_TIMEOUT_MS must be between 1000 and 30000");
  }
  return parsed;
}

function assertExactDisabledGroupSet(actualValue, expectedValue) {
  if (!Array.isArray(actualValue) || actualValue.some((groupId) => typeof groupId !== "string")) {
    throw new Error("Runtime disabledGroupIds is invalid");
  }
  const actual = [...new Set(actualValue)].sort(compareStrings);
  const expected = [...new Set(expectedValue)].sort(compareStrings);
  if (actual.length !== expected.length || actual.some((groupId, index) => groupId !== expected[index])) {
    throw new Error("Runtime disabled group set differs from the exhaustive acceptance inventory");
  }
}

async function withDeadline(promise, label) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          requestTimeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeSqlLikePattern(value) {
  return value.replace(/[\\%_]/gu, "\\$&");
}
NODE

echo "semantic_fresh_acceptance_finished_fail_closed=true"
