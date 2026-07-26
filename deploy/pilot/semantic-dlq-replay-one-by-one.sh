#!/usr/bin/env bash
set -euo pipefail

repo="${IRIS_REPOSITORY_DIR:-$(pwd)}"
env_file="${IRIS_PILOT_ENV_FILE:-$repo/.env.pilot}"
compose_file="${IRIS_COMPOSE_FILE:-$repo/deploy/pilot/docker-compose.yml}"
compose=(docker compose --env-file "$env_file" --file "$compose_file")

if [[ "${IRIS_SEMANTIC_REPLAY_CONFIRM:-}" != "REPLAY_SEMANTIC_DLQ_ONE_BY_ONE" ]]; then
  echo "Set IRIS_SEMANTIC_REPLAY_CONFIRM=REPLAY_SEMANTIC_DLQ_ONE_BY_ONE to run ordered semantic DLQ replay." >&2
  exit 64
fi

pilot_group_id="${IRIS_SEMANTIC_REPLAY_PILOT_GROUP_ID:-}"
if [[ -z "$pilot_group_id" || "$pilot_group_id" == *"<"* || "$pilot_group_id" == *">"* ]]; then
  echo "Set IRIS_SEMANTIC_REPLAY_PILOT_GROUP_ID to the approved real pilot group id." >&2
  exit 64
fi

"$repo/deploy/pilot/semantic-recovery-probe.sh"
"${compose[@]}" stop caddy >/dev/null

PILOT_GROUP_ID="$pilot_group_id" "${compose[@]}" exec -T core node --input-type=module <<'NODE'
const internalToken = requireNonEmptyEnv("IRIS_INTERNAL_API_TOKEN");
const pilotGroupId = requireNonEmptyEnv("PILOT_GROUP_ID");
const headers = {
  authorization: `Bearer ${internalToken}`,
  "content-type": "application/json",
  "x-iris-operator": "iris-semantic-dlq-replay",
};
let privateWindowOpened = false;

try {
  await assertFailClosedBeforeReplay();
  await setGlobal(false);
  await setCapability({ proactiveSpeech: false });
  await setGroup(pilotGroupId, true);
  await setGlobal(true);
  privateWindowOpened = true;

  const dlq = await getJson(
    "http://127.0.0.1:3000/internal/memory-extraction/dead-letters?limit=20",
  );
  const orderedDeadLetters = [...dlq.deadLetters].sort((a, b) => String(a.enqueuedAt).localeCompare(String(b.enqueuedAt)));
  if (orderedDeadLetters.length !== 6) {
    throw new Error("Expected exactly six semantic DLQ records for ordered replay");
  }

  const remainingAllowedIds = new Set(orderedDeadLetters.map((deadLetter) => deadLetter.id));
  for (const deadLetter of orderedDeadLetters) {
    await replayDeadLetter(deadLetter);
    await waitForMemoryDrain();
    remainingAllowedIds.delete(deadLetter.id);
    await assertOnlyRemainingOriginalDlq(remainingAllowedIds);
  }

  await assertOnlyRemainingOriginalDlq(new Set());
  console.log(JSON.stringify({
    ok: true,
    replayedCount: orderedDeadLetters.length,
    pilotGroupId,
  }));
} finally {
  if (privateWindowOpened) {
    await safeMutation(() => setGlobal(false));
    await safeMutation(() => setGroup(pilotGroupId, false));
  }
  await safeMutation(() => setCapability({ proactiveSpeech: false }));
  await assertFinalFailClosed();
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
}

async function replayDeadLetter(deadLetter) {
  if (!deadLetter?.id || deadLetter.replayable !== true) {
    throw new Error("Encountered a non-replayable semantic DLQ record");
  }
  const response = await postJson(
    `http://127.0.0.1:3000/internal/memory-extraction/dead-letters/${encodeURIComponent(deadLetter.id)}/replay`,
    {},
  );
  if (response.status !== "replayed") {
    throw new Error(`Semantic DLQ replay did not replay ${deadLetter.id}`);
  }
}

async function waitForMemoryDrain({ timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  do {
    latest = await getJson("http://127.0.0.1:3000/internal/memory-extraction/status");
    const counts = [
      latest.pendingJobCount,
      latest.processingJobCount,
      latest.delayedJobCount,
      latest.pendingProjectionRepairCount,
      latest.failedProjectionRepairCount,
    ];
    if (counts.every((count) => count === 0)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  } while (Date.now() < deadline);
  throw new Error("Memory extraction did not drain after single DLQ replay");
}

async function assertOnlyRemainingOriginalDlq(expectedRemainingIds) {
  const dlq = await getJson("http://127.0.0.1:3000/internal/memory-extraction/dead-letters?limit=20");
  if (dlq.deadLetters.length !== expectedRemainingIds.size) {
    throw new Error(`Expected semantic DLQ count ${expectedRemainingIds.size}`);
  }
  const unexpectedIds = dlq.deadLetters
    .map((deadLetter) => deadLetter.id)
    .filter((id) => !expectedRemainingIds.has(id));
  if (unexpectedIds.length > 0) {
    throw new Error("Semantic replay produced an unexpected DLQ entry");
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

function requireNonEmptyEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}
NODE

"${compose[@]}" stop caddy >/dev/null
echo "semantic_dlq_replay_finished_fail_closed=true"
