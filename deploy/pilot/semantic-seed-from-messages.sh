#!/usr/bin/env bash
set -euo pipefail

repo="${IRIS_REPOSITORY_DIR:-$(pwd)}"
env_file="${IRIS_PILOT_ENV_FILE:-$repo/.env.pilot}"
compose_file="${IRIS_COMPOSE_FILE:-$repo/deploy/pilot/docker-compose.yml}"
compose=(docker compose --env-file "$env_file" --file "$compose_file")

if [[ "${IRIS_SEMANTIC_SEED_CONFIRM:-}" != "SEED_SEMANTIC_MESSAGES" ]]; then
  echo "Set IRIS_SEMANTIC_SEED_CONFIRM=SEED_SEMANTIC_MESSAGES to backfill semantic extraction jobs." >&2
  exit 64
fi

pilot_group_id="${IRIS_SEMANTIC_SEED_PILOT_GROUP_ID:-}"
if [[ -z "$pilot_group_id" || "$pilot_group_id" == *"<"* || "$pilot_group_id" == *">"* ]]; then
  echo "Set IRIS_SEMANTIC_SEED_PILOT_GROUP_ID to the approved real pilot group id." >&2
  exit 64
fi

marker="${IRIS_SEMANTIC_SEED_MARKER:-}"
if [[ -z "$marker" || "$marker" == *"%"* || "$marker" == *"_"* ]]; then
  echo "Set IRIS_SEMANTIC_SEED_MARKER to a nonblank literal marker without SQL wildcards." >&2
  exit 64
fi

limit="${IRIS_SEMANTIC_SEED_LIMIT:-12}"
if [[ ! "$limit" =~ ^[0-9]+$ ]] || (( limit < 1 || limit > 40 )); then
  echo "IRIS_SEMANTIC_SEED_LIMIT must be an integer between 1 and 40." >&2
  exit 64
fi

"${compose[@]}" exec -T \
  -e IRIS_SEMANTIC_SEED_PILOT_GROUP_ID="$pilot_group_id" \
  -e IRIS_SEMANTIC_SEED_MARKER="$marker" \
  -e IRIS_SEMANTIC_SEED_LIMIT="$limit" \
  core node --input-type=module <<'NODE'
import { createClient } from "redis";
import { createPostgresPool } from "/app/apps/core/dist/database/postgres.js";
import { createPostgresMemoryExtractionRepository } from "/app/apps/core/dist/memory-extraction/postgres-memory-extraction-repository.js";
import {
  createMemoryExtractionJob,
} from "/app/apps/core/dist/memory-extraction/memory-extraction-queue.js";
import { createRedisMemoryExtractionQueue } from "/app/apps/core/dist/memory-extraction/redis-memory-extraction-queue.js";

const groupId = requireEnv("IRIS_SEMANTIC_SEED_PILOT_GROUP_ID");
const marker = requireEnv("IRIS_SEMANTIC_SEED_MARKER");
const limit = readLimit(requireEnv("IRIS_SEMANTIC_SEED_LIMIT"));

const pool = createPostgresPool({ databaseUrl: requireEnv("DATABASE_URL") });
const redis = createClient({
  url: requireEnv("REDIS_URL"),
  socket: { reconnectStrategy: false },
});
redis.on("error", () => undefined);
await redis.connect();

try {
  const repository = createPostgresMemoryExtractionRepository({ dataSource: pool });
  const queue = createRedisMemoryExtractionQueue({ client: redis });
  const messages = await pool.query(
    `
    SELECT id, provider_message_id, chat_id
    FROM conversation_messages
    WHERE chat_id = $1
      AND text IS NOT NULL
      AND text LIKE '%' || $2 || '%'
    ORDER BY sent_at ASC, created_at ASC, id ASC
    LIMIT $3
    `,
    [groupId, marker, limit],
  );

  let createdCount = 0;
  let existingCount = 0;
  let enqueuedCount = 0;
  for (const row of messages.rows) {
    const result = await repository.registerRequest({
      groupId: requireString(row.chat_id, "chat_id"),
      conversationMessageId: requireString(row.id, "id"),
      providerMessageId: requireString(row.provider_message_id, "provider_message_id"),
    });
    if (result.created) {
      createdCount += 1;
    } else {
      existingCount += 1;
    }
    if (result.request.status === "pending") {
      await queue.enqueue(
        createMemoryExtractionJob({
          requestId: result.request.id,
          groupId: result.request.groupId,
          now: new Date(),
        }),
      );
      enqueuedCount += 1;
    }
  }

  console.log(JSON.stringify({
    ok: true,
    groupId,
    marker,
    scannedCount: messages.rows.length,
    createdCount,
    existingCount,
    enqueuedCount,
  }));
} finally {
  await redis.quit();
  await pool.end();
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readLimit(value) {
  if (!/^[0-9]+$/u.test(value)) throw new Error("IRIS_SEMANTIC_SEED_LIMIT must be decimal");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 40) {
    throw new Error("IRIS_SEMANTIC_SEED_LIMIT must be between 1 and 40");
  }
  return parsed;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a nonblank string`);
  }
  return value;
}
NODE
