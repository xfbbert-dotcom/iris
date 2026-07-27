#!/usr/bin/env bash
set -euo pipefail

repo="${IRIS_REPOSITORY_DIR:-$(pwd)}"
env_file="${IRIS_PILOT_ENV_FILE:-$repo/.env.pilot}"
compose_file="${IRIS_COMPOSE_FILE:-$repo/deploy/pilot/docker-compose.yml}"
compose=(docker compose --env-file "$env_file" --file "$compose_file")

if [[ "${IRIS_SEMANTIC_RESEED_CONFIRM:-}" != "RESET_SEMANTIC_MESSAGES_ONE_BY_ONE" ]]; then
  echo "Set IRIS_SEMANTIC_RESEED_CONFIRM=RESET_SEMANTIC_MESSAGES_ONE_BY_ONE to reset and replay semantic marker messages." >&2
  exit 64
fi

pilot_group_id="${IRIS_SEMANTIC_RESEED_PILOT_GROUP_ID:-}"
if [[ -z "$pilot_group_id" || "$pilot_group_id" == *"<"* || "$pilot_group_id" == *">"* ]]; then
  echo "Set IRIS_SEMANTIC_RESEED_PILOT_GROUP_ID to the approved real pilot group id." >&2
  exit 64
fi

marker="${IRIS_SEMANTIC_RESEED_MARKER:-}"
if [[ -z "$marker" ]]; then
  echo "Set IRIS_SEMANTIC_RESEED_MARKER to a nonblank literal marker." >&2
  exit 64
fi

limit="${IRIS_SEMANTIC_RESEED_LIMIT:-12}"
if [[ ! "$limit" =~ ^[0-9]+$ ]] || (( limit < 1 || limit > 40 )); then
  echo "IRIS_SEMANTIC_RESEED_LIMIT must be an integer between 1 and 40." >&2
  exit 64
fi

"${compose[@]}" stop caddy >/dev/null

"${compose[@]}" exec -T \
  -e IRIS_SEMANTIC_RESEED_PILOT_GROUP_ID="$pilot_group_id" \
  -e IRIS_SEMANTIC_RESEED_MARKER="$marker" \
  -e IRIS_SEMANTIC_RESEED_LIMIT="$limit" \
  core node --input-type=module <<'NODE'
import { createClient } from "redis";
import { createPostgresPool } from "/app/apps/core/dist/database/postgres.js";
import {
  createMemoryExtractionJob,
} from "/app/apps/core/dist/memory-extraction/memory-extraction-queue.js";
import { createRedisMemoryExtractionQueue } from "/app/apps/core/dist/memory-extraction/redis-memory-extraction-queue.js";
import { assertSemanticEvidenceIntegrity } from "/app/apps/core/dist/memory-extraction/semantic-evidence-integrity.js";

const internalToken = requireEnv("IRIS_INTERNAL_API_TOKEN");
const groupId = requireEnv("IRIS_SEMANTIC_RESEED_PILOT_GROUP_ID");
const marker = requireEnv("IRIS_SEMANTIC_RESEED_MARKER");
const escapedMarker = escapeSqlLikePattern(marker);
const limit = readLimit(requireEnv("IRIS_SEMANTIC_RESEED_LIMIT"));
const headers = {
  authorization: `Bearer ${internalToken}`,
  "content-type": "application/json",
  "x-iris-operator": "iris-semantic-reseed",
};

const pool = createPostgresPool({ databaseUrl: requireEnv("DATABASE_URL") });
const redis = createClient({
  url: requireEnv("REDIS_URL"),
  socket: { reconnectStrategy: false },
});
redis.on("error", () => undefined);
await redis.connect();

let privateWindowOpened = false;

try {
  await assertFailClosedBeforeReplay();
  const messages = await resetMarkerRequests();
  if (messages.length === 0) {
    throw new Error("No semantic marker extraction requests were found to reseed");
  }

  const queue = createRedisMemoryExtractionQueue({ client: redis });
  await setGlobal(false);
  await setCapability({ proactiveSpeech: false });
  await setGroup(groupId, true);
  await setGlobal(true);
  privateWindowOpened = true;

  let enqueuedCount = 0;
  for (const row of messages) {
    await queue.enqueue(
      createMemoryExtractionJob({
        requestId: row.request_id,
        groupId: row.group_id,
        now: new Date(),
      }),
    );
    enqueuedCount += 1;
    try {
      await waitForMemoryDrain();
    } catch (error) {
      await markRequestSkipped(row.request_id, "replay_drain_timeout");
      throw error;
    }
    await assertNoMemoryDlq();
  }

  console.log(JSON.stringify({
    ok: true,
    groupId,
    marker,
    resetCount: messages.length,
    enqueuedCount,
  }));
} finally {
  if (privateWindowOpened) {
    await safeMutation(() => setGlobal(false));
    await safeMutation(() => setGroup(groupId, false));
  }
  await safeMutation(() => setCapability({ proactiveSpeech: false }));
  await safeMutation(() => assertFinalFailClosed());
  await redis.quit();
  await pool.end();
}

async function resetMarkerRequests() {
  return pool.connect().then(async (client) => {
    try {
      await client.query("BEGIN");
      const messagesResult = await client.query(
        `
        SELECT
          cm.id AS message_id,
          cm.provider_message_id,
          cm.chat_id AS group_id,
          cm.text AS message_text,
          r.id AS request_id,
          r.run_id
        FROM conversation_messages cm
        JOIN group_memory_extraction_requests r ON r.conversation_message_id = cm.id
        WHERE cm.chat_id = $1
          AND cm.text IS NOT NULL
          AND cm.text LIKE '%' || $2 || '%' ESCAPE '\\'
        ORDER BY cm.sent_at ASC, cm.created_at ASC, cm.id ASC
        LIMIT $3
        FOR UPDATE
        `,
        [groupId, escapedMarker, limit],
      );
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
          request_id: requireString(row.request_id, "request_id"),
          run_id: typeof row.run_id === "string" && row.run_id.trim() !== "" ? row.run_id : undefined,
        };
      });
      const requestIds = messages.map((row) => row.request_id);
      const runIds = [...new Set(messages.map((row) => row.run_id).filter(Boolean))];
      if (requestIds.length === 0) {
        await client.query("COMMIT");
        return [];
      }

      if (runIds.length > 0) {
        const unsafeRuns = await client.query(
          `
          SELECT DISTINCT run_id
          FROM group_memory_extraction_requests
          WHERE run_id = ANY($1::text[])
            AND id <> ALL($2::text[])
          `,
          [runIds, requestIds],
        );
        if (unsafeRuns.rows.length > 0) {
          throw new Error("Refusing to reseed runs that include non-marker requests");
        }
      }

      await client.query(
        `
        UPDATE group_memory_extraction_requests
        SET status = 'pending', run_id = NULL, skip_reason = NULL, updated_at = NOW()
        WHERE id = ANY($1::text[])
        `,
        [requestIds],
      );

      if (runIds.length > 0) {
        await client.query("DELETE FROM group_memory_extraction_conflict_evidence WHERE run_id = ANY($1::text[])", [runIds]);
        await client.query("DELETE FROM group_memory_extraction_conflict_candidates WHERE run_id = ANY($1::text[])", [runIds]);
        await client.query("DELETE FROM group_memory_extraction_run_actions WHERE run_id = ANY($1::text[])", [runIds]);
        await client.query("DELETE FROM group_memory_extraction_run_threads WHERE run_id = ANY($1::text[])", [runIds]);
        await client.query("DELETE FROM group_memory_extraction_run_mentions WHERE run_id = ANY($1::text[])", [runIds]);
        await client.query("DELETE FROM group_memory_extraction_run_memories WHERE run_id = ANY($1::text[])", [runIds]);
        await client.query("DELETE FROM group_memory_extraction_run_context WHERE run_id = ANY($1::text[])", [runIds]);
        await client.query("DELETE FROM group_memory_extraction_run_evidence WHERE run_id = ANY($1::text[])", [runIds]);
        await client.query("DELETE FROM group_memory_extraction_runs WHERE id = ANY($1::text[])", [runIds]);
      }

      await client.query("COMMIT");
      return messages;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

async function assertFailClosedBeforeReplay() {
  const runtime = await getJson("http://127.0.0.1:3000/internal/runtime-control/status");
  if (runtime.globalEnabled !== false || runtime.desiredGlobalEnabled !== false) {
    throw new Error("Runtime must start globally fail-closed");
  }
  if (runtime.capabilities?.proactiveSpeech !== false) {
    throw new Error("proactiveSpeech must start disabled");
  }
  await waitForMemoryDrain({ timeoutMs: 1000 });
  await assertNoMemoryDlq();
}

async function waitForMemoryDrain({ timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  do {
    latest = await getJson("http://127.0.0.1:3000/internal/memory-extraction/status");
    const counts = [
      latest.pendingJobCount ?? 0,
      latest.processingJobCount ?? 0,
      latest.delayedJobCount ?? 0,
      latest.pendingProjectionRepairCount ?? 0,
      latest.failedProjectionRepairCount ?? 0,
    ];
    if (counts.every((count) => count === 0)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  } while (Date.now() < deadline);
  throw new Error("Memory extraction did not drain after single reseed replay");
}

async function markRequestSkipped(requestId, skipReason) {
  await pool.query(
    `
    WITH target AS (
      SELECT id, run_id
      FROM group_memory_extraction_requests
      WHERE id = $1
      FOR UPDATE
    ),
    request_update AS (
      UPDATE group_memory_extraction_requests request
      SET status = 'skipped',
          skip_reason = $2,
          updated_at = NOW()
      FROM target
      WHERE request.id = target.id
        AND request.status IN ('pending', 'processing')
      RETURNING target.run_id
    )
    UPDATE group_memory_extraction_runs run
    SET status = 'failed',
        failure_classification = $2,
        failure_count = failure_count + 1,
        completed_at = NULL,
        updated_at = NOW()
    FROM request_update
    WHERE run.id = request_update.run_id
      AND run.status = 'processing'
    `,
    [requestId, skipReason],
  );
}

async function assertNoMemoryDlq() {
  const dlq = await getJson("http://127.0.0.1:3000/internal/memory-extraction/dead-letters?limit=20");
  if ((dlq.deadLetters ?? []).length !== 0) {
    throw new Error("Semantic reseed produced a memory extraction DLQ entry");
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
  const response = await fetch(url, { headers });
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
  });
  const parsed = await safeJson(response);
  if (!response.ok || parsed.ok === false) {
    throw new Error(`Mutation failed: ${new URL(url).pathname} ${response.status}`);
  }
  if (parsed.durable === false) {
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

function readLimit(value) {
  if (!/^[0-9]+$/u.test(value)) throw new Error("IRIS_SEMANTIC_RESEED_LIMIT must be decimal");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 40) {
    throw new Error("IRIS_SEMANTIC_RESEED_LIMIT must be between 1 and 40");
  }
  return parsed;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a nonblank string`);
  }
  return value;
}

function escapeSqlLikePattern(value) {
  return value.replace(/[\\%_]/gu, "\\$&");
}
NODE

"${compose[@]}" stop caddy >/dev/null
echo "semantic_reseed_finished_fail_closed=true"
