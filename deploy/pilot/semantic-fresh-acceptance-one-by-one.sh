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
if [[ ! "$expected_count" =~ ^[0-9]+$ ]] || (( expected_count != 6 )); then
  echo "IRIS_SEMANTIC_FRESH_ACCEPTANCE_EXPECTED_COUNT must be exactly 6." >&2
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

IFS=',' read -r -a known_group_inventory <<< "$known_group_ids"
known_group_count="${#known_group_inventory[@]}"
if (( known_group_count < 1 || known_group_count > 100 )); then
  echo "IRIS_SEMANTIC_FRESH_ACCEPTANCE_KNOWN_GROUP_IDS must contain between 1 and 100 groups." >&2
  exit 64
fi
cleanup_operation_count=$((known_group_count + 3))
cleanup_timeout_seconds=$((
  (
    cleanup_operation_count * request_timeout_ms + 999
  ) / 1000 + 15
))
host_command_timeout_seconds=$((command_timeout_seconds + 30))
acceptance_run_token="$(date -u +%s)-$$-${RANDOM}"
acceptance_pid_file="/tmp/iris-semantic-fresh-acceptance-${acceptance_run_token}.json"

stop_caddy_bounded() {
  timeout --kill-after=10s 60s "${compose[@]}" stop caddy >/dev/null
}

terminate_acceptance_process() {
  timeout --kill-after=5s 30s \
    "${compose[@]}" exec -T \
    -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_EXPECTED_RUN_TOKEN="$acceptance_run_token" \
    -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_PID_FILE="$acceptance_pid_file" \
    core node --input-type=module <<'NODE'
import { readdir, readFile, rm } from "node:fs/promises";

const expectedRunToken = requireEnv(
  "IRIS_SEMANTIC_FRESH_ACCEPTANCE_EXPECTED_RUN_TOKEN",
);
const pidFile = requireEnv("IRIS_SEMANTIC_FRESH_ACCEPTANCE_PID_FILE");
let record = null;
try {
  record = JSON.parse(await readFile(pidFile, "utf8"));
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
if (record !== null && (
  typeof record !== "object" ||
  !Number.isSafeInteger(record.pid) ||
  record.pid <= 1 ||
  record.token !== expectedRunToken
)) {
  throw new Error("Fresh semantic acceptance PID record is invalid");
}

let matchingPids = await waitForMatchingProcesses(expectedRunToken, 2_000);
for (const pid of matchingPids) {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}
if (!(await waitForStableAbsence(expectedRunToken, 5_000))) {
  matchingPids = await findMatchingPids(expectedRunToken);
  for (const pid of matchingPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  if (!(await waitForStableAbsence(expectedRunToken, 5_000))) {
    throw new Error("Fresh semantic acceptance process did not terminate");
  }
}
await rm(pidFile, { force: true });

async function waitForMatchingProcesses(runToken, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = await findMatchingPids(runToken);
    if (pids.length > 0) return pids;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return [];
}

async function waitForStableAbsence(runToken, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let absentSince = null;
  while (Date.now() < deadline) {
    if ((await findMatchingPids(runToken)).length === 0) {
      absentSince ??= Date.now();
      if (Date.now() - absentSince >= 500) return true;
    } else {
      absentSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function findMatchingPids(runToken) {
  const entries = await readdir("/proc", { withFileTypes: true });
  const pids = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9]+$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    try {
      const environment = await readFile(`/proc/${pid}/environ`);
      if (
        environment
          .toString("utf8")
          .split("\0")
          .includes(`IRIS_SEMANTIC_FRESH_ACCEPTANCE_RUN_TOKEN=${runToken}`)
      ) {
        pids.push(pid);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return pids;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
NODE
}

force_fail_closed() {
  local original_status=$?
  local terminate_status=0
  local stop_status=0
  local cleanup_status=0
  trap - EXIT
  set +e
  terminate_acceptance_process
  terminate_status=$?
  stop_caddy_bounded
  stop_status=$?
  timeout --kill-after=10s "${cleanup_timeout_seconds}s" \
    "${compose[@]}" exec -T \
    -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_KNOWN_GROUP_IDS="$known_group_ids" \
    -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_REQUEST_TIMEOUT_MS="$request_timeout_ms" \
    core node --input-type=module <<'NODE'
const knownGroupIds = readKnownGroupIds(
  requireEnv("IRIS_SEMANTIC_FRESH_ACCEPTANCE_KNOWN_GROUP_IDS"),
);
const requestTimeoutMs = readTimeout(requireEnv("IRIS_SEMANTIC_FRESH_ACCEPTANCE_REQUEST_TIMEOUT_MS"));
const token = requireEnv("IRIS_INTERNAL_API_TOKEN");
const cleanupFailures = [];
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "x-iris-operator": "iris-semantic-fresh-acceptance-cleanup",
};

await attemptCleanup("disable global runtime", () =>
  request("POST", "http://127.0.0.1:3000/internal/runtime-control/global", { enabled: false }),
);
for (const knownGroupId of knownGroupIds) {
  await attemptCleanup(`disable group ${knownGroupId}`, () =>
    request(
      "POST",
      `http://127.0.0.1:3000/internal/runtime-control/groups/${encodeURIComponent(knownGroupId)}`,
      { enabled: false },
    ),
  );
}
await attemptCleanup("disable proactive speech", () =>
  request("PATCH", "http://127.0.0.1:3000/internal/runtime-control/capabilities", {
    proactiveSpeech: false,
  }),
);
const status = await getJson("http://127.0.0.1:3000/internal/runtime-control/status");
if (status.globalEnabled !== false || status.desiredGlobalEnabled !== false) {
  throw new Error("Cleanup could not prove global fail-closed state");
}
if (status.capabilities?.proactiveSpeech !== false) {
  throw new Error("Cleanup could not prove proactiveSpeech disabled");
}
assertExactDisabledGroupSet(status.disabledGroupIds, knownGroupIds);
if (cleanupFailures.length > 0) {
  console.error(JSON.stringify({
    ok: true,
    cleanup: "fail_closed_after_transient_errors",
    cleanupFailures,
  }));
}

async function attemptCleanup(label, action) {
  try {
    await action();
  } catch (error) {
    cleanupFailures.push({
      label,
      error: error instanceof Error ? error.message : "unknown_error",
    });
  }
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

function readKnownGroupIds(value) {
  const groupIds = [...new Set(value.split(",").map((groupId) => groupId.trim()))];
  if (groupIds.length === 0 || groupIds.some((groupId) =>
    groupId.length === 0 || groupId.includes("<") || groupId.includes(">") || groupId.length > 256
  )) {
    throw new Error("IRIS_SEMANTIC_FRESH_ACCEPTANCE_KNOWN_GROUP_IDS is invalid");
  }
  return groupIds.sort(compareStrings);
}

function assertExactDisabledGroupSet(actualValue, expectedValue) {
  if (!Array.isArray(actualValue) || actualValue.some((groupId) => typeof groupId !== "string")) {
    throw new Error("Runtime disabledGroupIds is invalid");
  }
  const actual = [...new Set(actualValue)].sort(compareStrings);
  const expected = [...new Set(expectedValue)].sort(compareStrings);
  if (actual.length !== expected.length || actual.some((groupId, index) => groupId !== expected[index])) {
    throw new Error("Cleanup could not prove the exact disabled group inventory");
  }
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
NODE
  cleanup_status=$?
  if (( terminate_status != 0 || stop_status != 0 || cleanup_status != 0 )); then
    echo "Fresh semantic acceptance fail-closed cleanup could not be proven." >&2
    exit 1
  fi
  exit "$original_status"
}

trap force_fail_closed EXIT
stop_caddy_bounded

timeout --kill-after=15s "${host_command_timeout_seconds}s" \
  "${compose[@]}" exec -T \
  -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_GROUP_ID="$group_id" \
  -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_MARKER="$marker" \
  -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_EXPECTED_COUNT="$expected_count" \
  -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_KNOWN_GROUP_IDS="$known_group_ids" \
  -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_REQUEST_TIMEOUT_MS="$request_timeout_ms" \
  -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_RUN_TOKEN="$acceptance_run_token" \
  -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_PID_FILE="$acceptance_pid_file" \
  -e IRIS_SEMANTIC_FRESH_ACCEPTANCE_COMMAND_TIMEOUT_SECONDS="$command_timeout_seconds" \
  core sh -c '
    set -eu
    umask 077
    pid_file="$IRIS_SEMANTIC_FRESH_ACCEPTANCE_PID_FILE"
    temporary_pid_file="${pid_file}.tmp.$$"
    printf "{\"pid\":%s,\"token\":\"%s\"}\n" \
      "$$" "$IRIS_SEMANTIC_FRESH_ACCEPTANCE_RUN_TOKEN" > "$temporary_pid_file"
    mv "$temporary_pid_file" "$pid_file"
    exec timeout --signal=TERM --kill-after=15s \
      "${IRIS_SEMANTIC_FRESH_ACCEPTANCE_COMMAND_TIMEOUT_SECONDS}s" \
      node --input-type=module
  ' <<'NODE'
import { rm } from "node:fs/promises";
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
const acceptancePidFile = requireEnv("IRIS_SEMANTIC_FRESH_ACCEPTANCE_PID_FILE");
if (!knownGroupIds.includes(groupId)) {
  throw new Error("Fresh semantic acceptance group is missing from the exhaustive group inventory");
}
const headers = {
  authorization: `Bearer ${internalToken}`,
  "content-type": "application/json",
  "x-iris-operator": "iris-semantic-fresh-acceptance",
};

const pool = createPostgresPool({
  databaseUrl: requireEnv("DATABASE_URL"),
  connectionTimeoutMillis: requestTimeoutMs,
  queryTimeoutMillis: requestTimeoutMs,
  statementTimeoutMillis: requestTimeoutMs,
  lockTimeoutMillis: requestTimeoutMs,
});
const redis = createClient({
  url: requireEnv("REDIS_URL"),
  socket: {
    reconnectStrategy: false,
    connectTimeout: requestTimeoutMs,
  },
});
redis.on("error", () => undefined);
await redis.connect();

let acceptanceSummary;
try {
  await assertFailClosedBeforeAcceptance();
  const messages = await loadFreshMessages();
  const repository = createPostgresMemoryExtractionRepository({ dataSource: pool });

  await setGlobal(false);
  await setCapability({ proactiveSpeech: false });
  await setGroup(groupId, true);
  await assertPrivateGroupIsolation();
  await setGlobal(true);
  await assertPrivateWindowOpen();

  const results = [];
  for (const row of messages) {
    const result = await repository.registerRequest({
      groupId: row.group_id,
      conversationMessageId: row.message_id,
      providerMessageId: row.provider_message_id,
    });
    if (result.created !== true || result.request.status !== "pending") {
      throw new Error("Fresh semantic acceptance message already has an extraction request");
    }

    await enqueueWithRedisDeadline(
      createMemoryExtractionJob({
        requestId: result.request.id,
        groupId: result.request.groupId,
        now: new Date(),
      }),
    );
    const terminal = await waitForRequestTerminal(result.request.id);
    results.push({
      requestId: result.request.id,
      runId: terminal.runId,
      retryObserved: terminal.retryObserved,
    });
    await assertNoMemoryDlq();
    await assertSemanticLifecycleAfterStep(results.length, messages);
  }

  acceptanceSummary = {
    ok: true,
    groupId,
    marker,
    processedCount: results.length,
    retryObservedCount: results.filter((result) => result.retryObserved).length,
  };
} finally {
  try {
    await safeMutation(() => setGlobal(false));
    await disableKnownGroups();
    await safeMutation(() => setCapability({ proactiveSpeech: false }));
    await assertFinalFailClosed();
  } finally {
    if (redis.isOpen) redis.destroy();
    await pool.end();
    await rm(acceptancePidFile, { force: true });
  }
}
console.log(JSON.stringify(acceptanceSummary));

async function loadFreshMessages() {
  const messagesResult = await pool.query(
    `
      SELECT
        id AS message_id,
        provider_message_id,
        chat_id AS group_id,
        sender_open_id,
        text AS message_text
      FROM conversation_messages
      WHERE chat_id = $1
        AND text IS NOT NULL
        AND text LIKE '%' || $2 || '%' ESCAPE '\\'
      ORDER BY sent_at ASC, created_at ASC, id ASC
      LIMIT $3
      `,
    [groupId, escapedMarker, expectedCount + 1],
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
      sender_open_id: row.sender_open_id,
    };
  });
  const messageIds = messages.map((row) => row.message_id);
  const existingRequests = await pool.query(
    `
      SELECT COUNT(*)::integer AS count
      FROM group_memory_extraction_requests
      WHERE conversation_message_id = ANY($1::text[])
      `,
    [messageIds],
  );
  if (existingRequests.rows[0]?.count !== 0) {
    throw new Error("Fresh semantic acceptance messages already have extraction history");
  }

  const existingState = await pool.query(
    `
      SELECT
        (SELECT COUNT(*)::integer FROM discussion_threads WHERE group_id = $1) AS thread_count,
        (SELECT COUNT(*)::integer FROM action_items WHERE group_id = $1) AS action_count
      `,
    [groupId],
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
      pool.query(
        `
          SELECT
            request.status,
            request.skip_reason,
            request.run_id,
            run.status AS run_status,
            run.failure_classification,
            run.enabled_operation_families
          FROM group_memory_extraction_requests request
          LEFT JOIN group_memory_extraction_runs run ON run.id = request.run_id
          WHERE request.id = $1
          `,
        [requestId],
      ),
      getJson("http://127.0.0.1:3000/internal/memory-extraction/status"),
      getJson("http://127.0.0.1:3000/internal/memory-extraction/dead-letters?limit=20"),
    ]);
    const request = requestResult.rows[0];
    if (request === undefined) {
      throw new Error("Fresh semantic acceptance request disappeared");
    }
    if (requireDeadLetters(deadLetters).length !== 0) {
      throw new Error("Fresh semantic acceptance produced a memory extraction DLQ entry");
    }
    if (request.failure_classification === "invalid_model_response_retry") {
      retryObserved = true;
    }
    const queueCounts = [
      requireQueueCount(queueStatus.pendingJobCount, "pendingJobCount"),
      requireQueueCount(queueStatus.processingJobCount, "processingJobCount"),
      requireQueueCount(queueStatus.delayedJobCount, "delayedJobCount"),
    ];
    const queueDrained = queueCounts.every((count) => count === 0);
    if (request.status === "completed" && queueDrained) {
      assertEnabledOperationFamilies(request.enabled_operation_families);
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

async function enqueueWithRedisDeadline(job) {
  const queue = createRedisMemoryExtractionQueue({ client: redis });
  let redisTimedOut = false;
  let timeoutId;
  try {
    await Promise.race([
      queue.enqueue(job),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          redisTimedOut = true;
          redis.destroy();
          reject(new Error("Fresh semantic acceptance Redis enqueue timed out"));
        }, requestTimeoutMs);
      }),
    ]);
  } catch (error) {
    if (redisTimedOut) {
      throw new Error("Fresh semantic acceptance Redis enqueue exceeded its transport deadline", {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function assertSemanticLifecycleAfterStep(step, evidenceMessages) {
  const expectedByStep = [
    {
      stepName: "candidate_creation",
      threadStatus: "candidate",
      threadVersion: 1,
      threadEvents: [{ type: "created", version: 1, triggerIndex: 0 }],
      action: undefined,
    },
    {
      stepName: "thread_promotion",
      threadStatus: "open",
      threadVersion: 2,
      threadEvents: [
        { type: "created", version: 1, triggerIndex: 0 },
        { type: "promoted", version: 2, triggerIndex: 1 },
      ],
      action: undefined,
    },
    {
      stepName: "action_commitment",
      threadStatus: "open",
      threadVersion: 2,
      threadEvents: [
        { type: "created", version: 1, triggerIndex: 0 },
        { type: "promoted", version: 2, triggerIndex: 1 },
      ],
      action: {
        status: "open",
        version: 1,
        events: [{ type: "created", version: 1, triggerIndex: 2 }],
      },
    },
    {
      stepName: "mention_question",
      threadStatus: "open",
      threadVersion: 2,
      threadEvents: [
        { type: "created", version: 1, triggerIndex: 0 },
        { type: "promoted", version: 2, triggerIndex: 1 },
      ],
      action: {
        status: "open",
        version: 1,
        events: [{ type: "created", version: 1, triggerIndex: 2 }],
      },
    },
    {
      stepName: "completion_and_resolution",
      threadStatus: "resolved",
      threadVersion: 3,
      threadEvents: [
        { type: "created", version: 1, triggerIndex: 0 },
        { type: "promoted", version: 2, triggerIndex: 1 },
        { type: "resolved", version: 3, triggerIndex: 4 },
      ],
      action: {
        status: "completed",
        version: 2,
        events: [
          { type: "created", version: 1, triggerIndex: 2 },
          { type: "completed", version: 2, triggerIndex: 4 },
        ],
      },
    },
    {
      stepName: "thread_reopening",
      threadStatus: "open",
      threadVersion: 4,
      threadEvents: [
        { type: "created", version: 1, triggerIndex: 0 },
        { type: "promoted", version: 2, triggerIndex: 1 },
        { type: "resolved", version: 3, triggerIndex: 4 },
        { type: "reopened", version: 4, triggerIndex: 5 },
      ],
      action: {
        status: "completed",
        version: 2,
        events: [
          { type: "created", version: 1, triggerIndex: 2 },
          { type: "completed", version: 2, triggerIndex: 4 },
        ],
      },
    },
  ];
  const expected = expectedByStep[step - 1];
  if (expected === undefined || evidenceMessages.length !== 6) {
    throw new Error("Semantic lifecycle assertion received an invalid step");
  }
  const evidenceMessageIds = evidenceMessages.map((message) =>
    requireString(message.message_id, "evidence message id")
  );
  const processedEvidenceIds = evidenceMessageIds.slice(0, step);

  const threadResult = await pool.query(
    `
    SELECT id, status, version
    FROM discussion_threads
    WHERE group_id = $1
    ORDER BY id
    `,
    [groupId],
  );
  if (threadResult.rows.length !== 1) {
    throw new Error("Expected exactly one semantic acceptance thread");
  }
  const thread = threadResult.rows[0];
  const threadId = requireString(thread.id, "thread id");
  assertEntityState(
    "Thread",
    thread.status,
    thread.version,
    expected.threadStatus,
    expected.threadVersion,
  );

  const threadEvents = await pool.query(
    `
    SELECT
      event.event_type,
      event.to_version,
      COUNT(evidence.conversation_message_id)::integer AS evidence_count,
      ARRAY_AGG(evidence.conversation_message_id ORDER BY evidence.conversation_message_id)
        FILTER (WHERE evidence.conversation_message_id IS NOT NULL) AS evidence_ids
    FROM discussion_thread_events event
    LEFT JOIN discussion_thread_event_evidence evidence
      ON evidence.event_id = event.id
     AND evidence.group_id = event.group_id
    WHERE event.group_id = $1
      AND event.thread_id = $2
    GROUP BY event.id
    ORDER BY event.to_version, event.id
    `,
    [groupId, threadId],
  );
  assertLifecycleEvents(
    "Thread",
    threadEvents.rows,
    expected.threadEvents,
    processedEvidenceIds,
    evidenceMessageIds,
  );

  const threadEvidence = await pool.query(
    `
    SELECT conversation_message_id
    FROM discussion_thread_evidence
    WHERE group_id = $1
      AND thread_id = $2
    ORDER BY conversation_message_id
    `,
    [groupId, threadId],
  );
  const threadEvidenceIds = threadEvidence.rows.map((row) =>
    requireString(row.conversation_message_id, "thread evidence message id")
  );
  assertEvidenceSubset("Thread", threadEvidenceIds, processedEvidenceIds);
  for (const event of expected.threadEvents) {
    if (!threadEvidenceIds.includes(evidenceMessageIds[event.triggerIndex])) {
      throw new Error(`Thread evidence is missing lifecycle trigger ${event.type}`);
    }
  }

  const actionResult = await pool.query(
    `
    SELECT id, thread_id, status, version, owner_ref_type, owner_ref
    FROM action_items
    WHERE group_id = $1
    ORDER BY id
    `,
    [groupId],
  );
  if (expected.action === undefined) {
    if (actionResult.rows.length !== 0) {
      throw new Error("Action appeared before its semantic acceptance creation step");
    }
    return;
  }
  if (actionResult.rows.length !== 1) {
    throw new Error("Expected exactly one action bound to the semantic acceptance thread");
  }
  const action = actionResult.rows[0];
  const actionId = requireString(action.id, "action id");
  if (action.thread_id !== threadId) {
    throw new Error("Semantic acceptance action is not bound to the accepted thread");
  }
  const commitmentOwnerOpenId = requireString(
    evidenceMessages[2].sender_open_id,
    "commitment sender open id",
  );
  if (
    action.owner_ref_type !== "feishu_user" ||
    action.owner_ref !== commitmentOwnerOpenId
  ) {
    throw new Error("Semantic acceptance action owner differs from the commitment sender");
  }
  if (step >= 5) {
    const completionOwnerOpenId = requireString(
      evidenceMessages[4].sender_open_id,
      "completion sender open id",
    );
    if (completionOwnerOpenId !== commitmentOwnerOpenId) {
      throw new Error("The action was not completed by its committed owner");
    }
  }
  assertEntityState(
    "Action",
    action.status,
    action.version,
    expected.action.status,
    expected.action.version,
  );

  const actionEvents = await pool.query(
    `
    SELECT
      event.event_type,
      event.to_version,
      COUNT(evidence.conversation_message_id)::integer AS evidence_count,
      ARRAY_AGG(evidence.conversation_message_id ORDER BY evidence.conversation_message_id)
        FILTER (WHERE evidence.conversation_message_id IS NOT NULL) AS evidence_ids
    FROM action_item_events event
    LEFT JOIN action_item_event_evidence evidence
      ON evidence.event_id = event.id
     AND evidence.group_id = event.group_id
    WHERE event.group_id = $1
      AND event.action_item_id = $2
    GROUP BY event.id
    ORDER BY event.to_version, event.id
    `,
    [groupId, actionId],
  );
  assertLifecycleEvents(
    "Action",
    actionEvents.rows,
    expected.action.events,
    processedEvidenceIds,
    evidenceMessageIds,
  );
}

function assertLifecycleEvents(label, actualRows, expectedEvents, processedIds, allEvidenceIds) {
  if (actualRows.length !== expectedEvents.length) {
    throw new Error(`${label} lifecycle event count differs from the six-step contract`);
  }
  for (const [index, expected] of expectedEvents.entries()) {
    const actual = actualRows[index];
    if (
      actual.event_type !== expected.type ||
      readVersion(actual.to_version, `${label} event version`) !== expected.version
    ) {
      throw new Error(`${label} lifecycle differs from the six-step contract`);
    }
    const evidenceIds = Array.isArray(actual.evidence_ids) ? actual.evidence_ids : [];
    if (actual.evidence_count < 1 || evidenceIds.length < 1) {
      throw new Error(`${label} lifecycle event ${expected.type} has no evidence`);
    }
    assertEvidenceSubset(`${label} lifecycle event ${expected.type}`, evidenceIds, processedIds);
    if (!evidenceIds.includes(allEvidenceIds[expected.triggerIndex])) {
      throw new Error(`${label} lifecycle event ${expected.type} is missing its trigger evidence`);
    }
  }
}

function assertEvidenceSubset(label, actualIds, allowedIds) {
  if (
    actualIds.length === 0 ||
    actualIds.some((messageId) => typeof messageId !== "string" || !allowedIds.includes(messageId))
  ) {
    throw new Error(`${label} evidence is empty or outside the ordered acceptance messages`);
  }
}

function assertEntityState(label, actualStatus, actualVersion, expectedStatus, expectedVersion) {
  if (
    actualStatus !== expectedStatus ||
    readVersion(actualVersion, `${label} version`) !== expectedVersion
  ) {
    throw new Error(`${label} state differs from the six-step contract`);
  }
}

function assertEnabledOperationFamilies(value) {
  if (!Array.isArray(value) || value.some((family) => typeof family !== "string")) {
    throw new Error("Extraction run enabled operation families are invalid");
  }
  const actual = [...new Set(value)].sort(compareStrings);
  const expected = ["action", "memory", "thread"];
  if (actual.length !== expected.length || actual.some((family, index) => family !== expected[index])) {
    throw new Error("Extraction run did not enable memory, thread, and action operations");
  }
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
    requireQueueCount(extraction.pendingJobCount, "pendingJobCount"),
    requireQueueCount(extraction.processingJobCount, "processingJobCount"),
    requireQueueCount(extraction.delayedJobCount, "delayedJobCount"),
    requireQueueCount(
      extraction.pendingProjectionRepairCount,
      "pendingProjectionRepairCount",
    ),
    requireQueueCount(
      extraction.failedProjectionRepairCount,
      "failedProjectionRepairCount",
    ),
  ];
  if (counts.some((count) => count !== 0)) {
    throw new Error("Memory extraction must start fully drained");
  }
  if (requireDeadLetters(deadLetters).length !== 0) {
    throw new Error("Memory extraction DLQ must start empty");
  }
}

async function assertKnownGroupInventory() {
  const result = await pool.query(
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
  if (requireDeadLetters(deadLetters).length !== 0) {
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

async function disableKnownGroups() {
  for (const knownGroupId of knownGroupIds) {
    await safeMutation(() => setGroup(knownGroupId, false));
  }
}

async function setGlobal(enabled) {
  return postJson("http://127.0.0.1:3000/internal/runtime-control/global", { enabled });
}

async function setGroup(groupId, enabled) {
  return postJson(
    `http://127.0.0.1:3000/internal/runtime-control/groups/${encodeURIComponent(groupId)}`,
    { enabled },
  );
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
  if (!Number.isSafeInteger(parsed) || parsed !== 6) {
    throw new Error("IRIS_SEMANTIC_FRESH_ACCEPTANCE_EXPECTED_COUNT must be exactly 6");
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

function requireQueueCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Memory extraction ${name} is missing or invalid`);
  }
  return value;
}

function requireDeadLetters(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray(value.deadLetters)
  ) {
    throw new Error("Memory extraction deadLetters is missing or invalid");
  }
  return value.deadLetters;
}

function readVersion(value, label) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeSqlLikePattern(value) {
  return value.replace(/[\\%_]/gu, "\\$&");
}
NODE

echo "semantic_fresh_acceptance_finished_fail_closed=true"
