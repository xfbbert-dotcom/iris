#!/usr/bin/env bash
set -euo pipefail

repo="${IRIS_REPOSITORY_DIR:-$(pwd)}"
env_file="${IRIS_PILOT_ENV_FILE:-$repo/.env.pilot}"
compose_file="${IRIS_COMPOSE_FILE:-$repo/deploy/pilot/docker-compose.yml}"
compose=(docker compose --env-file "$env_file" --file "$compose_file")

pilot_group_id="${IRIS_SEMANTIC_ACCEPTANCE_PILOT_GROUP_ID:-}"
if [[ -z "$pilot_group_id" || "$pilot_group_id" == *"<"* || "$pilot_group_id" == *">"* ]]; then
  echo "Set IRIS_SEMANTIC_ACCEPTANCE_PILOT_GROUP_ID to the approved real pilot group id." >&2
  exit 64
fi

control_group_id="${IRIS_SEMANTIC_ACCEPTANCE_CONTROL_GROUP_ID:-}"

"${compose[@]}" exec -T \
  -e PILOT_GROUP_ID="$pilot_group_id" \
  -e CONTROL_GROUP_ID="$control_group_id" \
  core node --input-type=module <<'NODE'
const internalToken = requireNonEmptyEnv("IRIS_INTERNAL_API_TOKEN");
const pilotGroupId = requireNonEmptyEnv("PILOT_GROUP_ID");
const controlGroupId = process.env.CONTROL_GROUP_ID?.trim() ?? "";
const headers = {
  authorization: `Bearer ${internalToken}`,
  "content-type": "application/json",
  "x-iris-operator": "iris-semantic-acceptance-inspect",
};

await assertFailClosedRuntime();
await assertQueuesAndDlqClear();

const pilotThreads = await getJson(
  `http://127.0.0.1:3000/internal/conversation-state/groups/${encodeURIComponent(pilotGroupId)}/threads?limit=100`,
);
const pilotActions = await getJson(
  `http://127.0.0.1:3000/internal/conversation-state/groups/${encodeURIComponent(pilotGroupId)}/actions?limit=100`,
);

const candidateThreads = [];
for (const thread of pilotThreads.threads ?? []) {
  const events = await getJson(
    `http://127.0.0.1:3000/internal/conversation-state/threads/${encodeURIComponent(thread.id)}/events?limit=100`,
  );
  if (hasEventLifecycle(events.events, ["created", "promoted", "resolved", "reopened"])) {
    candidateThreads.push({ thread, events: events.events });
  }
}

if (candidateThreads.length !== 1) {
  throw new Error(`Expected exactly one semantic acceptance thread, found ${candidateThreads.length}`);
}

const { thread, events: threadEvents } = candidateThreads[0];
if (thread.groupId !== pilotGroupId || thread.status !== "open" || thread.version < 4) {
  throw new Error("Semantic acceptance thread did not finish reopened and open");
}
if (hasDuplicateLifecycleVersions(threadEvents, ["created", "promoted", "resolved", "reopened"])) {
  throw new Error("Semantic acceptance thread has duplicate event versions");
}
if (!hasEvidence(thread.evidenceMessageIds) || !threadEvents.every((event) => hasEvidence(event.evidenceMessageIds))) {
  throw new Error("Semantic acceptance thread is missing evidence bindings");
}

const boundActions = (pilotActions.actions ?? []).filter((action) => action.threadId === thread.id);
if (boundActions.length !== 1) {
  throw new Error(`Expected exactly one action bound to the semantic acceptance thread, found ${boundActions.length}`);
}

const action = boundActions[0];
const actionEventsResponse = await getJson(
  `http://127.0.0.1:3000/internal/conversation-state/actions/${encodeURIComponent(action.id)}/events?limit=100`,
);
const actionEvents = actionEventsResponse.events ?? [];
if (!hasEventLifecycle(actionEvents, ["created", "completed"])) {
  throw new Error("Semantic acceptance action did not complete its lifecycle");
}
if (action.status !== "completed" || action.version < 2) {
  throw new Error("Semantic acceptance action did not finish completed");
}
if (!hasEvidence(action.evidenceMessageIds) || !actionEvents.every((event) => hasEvidence(event.evidenceMessageIds))) {
  throw new Error("Semantic acceptance action is missing evidence bindings");
}
if (hasDuplicateLifecycleVersions(actionEvents, ["created", "completed"])) {
  throw new Error("Semantic acceptance action has duplicate event versions");
}

if (controlGroupId.length > 0) {
  await assertEmptyControlGroup(controlGroupId);
}

const stateStatus = await getJson("http://127.0.0.1:3000/internal/conversation-state/status");
assertZeroCounts(stateStatus.projectionRepairs, "projectionRepairs");

console.log(JSON.stringify({
  ok: true,
  pilotGroupId,
  controlGroupId: controlGroupId || undefined,
  thread: {
    id: thread.id,
    status: thread.status,
    version: thread.version,
    eventCount: threadEvents.length,
    evidenceCount: thread.evidenceMessageIds.length,
  },
  action: {
    id: action.id,
    status: action.status,
    version: action.version,
    ownerRefType: action.ownerRefType,
    eventCount: actionEvents.length,
    evidenceCount: action.evidenceMessageIds.length,
  },
}));

async function assertFailClosedRuntime() {
  const runtime = await getJson("http://127.0.0.1:3000/internal/runtime-control/status");
  if (runtime.globalEnabled !== false || runtime.desiredGlobalEnabled !== false) {
    throw new Error("Runtime must be globally fail-closed before semantic acceptance inspection");
  }
  if (runtime.capabilities?.proactiveSpeech !== false) {
    throw new Error("proactiveSpeech must remain disabled before semantic acceptance inspection");
  }
}

async function assertQueuesAndDlqClear() {
  const [status, extraction, deadLetters] = await Promise.all([
    getJson("http://127.0.0.1:3000/internal/status"),
    getJson("http://127.0.0.1:3000/internal/memory-extraction/status"),
    getJson("http://127.0.0.1:3000/internal/memory-extraction/dead-letters?limit=20"),
  ]);
  const eventStatus = status.components?.events ?? {};
  const documentSync = status.components?.documentSync ?? {};
  const reindex = status.components?.reindex ?? {};
  const numericFields = {
    pendingEventCount: eventStatus.pendingEventCount,
    deadLetterEventCount: eventStatus.deadLetterEventCount,
    documentPendingJobCount: documentSync.pendingJobCount,
    documentDeadLetterJobCount: documentSync.deadLetterJobCount,
    reindexPendingJobCount: reindex.pendingJobCount,
    reindexDeadLetterJobCount: reindex.deadLetterJobCount,
    memoryPendingJobCount: extraction.pendingJobCount,
    memoryProcessingJobCount: extraction.processingJobCount,
    memoryDelayedJobCount: extraction.delayedJobCount,
    memoryDeadLetterJobCount: extraction.deadLetterJobCount,
    memoryPendingProjectionRepairCount: extraction.pendingProjectionRepairCount,
    memoryFailedProjectionRepairCount: extraction.failedProjectionRepairCount,
    memoryDeadLetters: deadLetters.deadLetters?.length,
  };
  for (const [name, value] of Object.entries(numericFields)) {
    if (value !== 0) throw new Error(`Expected ${name} to be zero`);
  }
}

async function assertEmptyControlGroup(groupId) {
  const [threads, actions] = await Promise.all([
    getJson(`http://127.0.0.1:3000/internal/conversation-state/groups/${encodeURIComponent(groupId)}/threads?limit=100`),
    getJson(`http://127.0.0.1:3000/internal/conversation-state/groups/${encodeURIComponent(groupId)}/actions?limit=100`),
  ]);
  if ((threads.threads ?? []).length !== 0 || (actions.actions ?? []).length !== 0) {
    throw new Error("Control group has semantic conversation state");
  }
}

function hasEventLifecycle(events, expectedTypes) {
  const types = new Set((events ?? []).map((event) => event.eventType));
  return expectedTypes.every((type) => types.has(type));
}

function hasDuplicateLifecycleVersions(events, lifecycleTypes) {
  const lifecycle = (events ?? []).filter((event) => lifecycleTypes.includes(event.eventType));
  return new Set(lifecycle.map((event) => event.toVersion)).size !== lifecycle.length;
}

function hasEvidence(evidenceMessageIds) {
  return Array.isArray(evidenceMessageIds) && evidenceMessageIds.length > 0;
}

function assertZeroCounts(counts, label) {
  for (const [key, value] of Object.entries(counts ?? {})) {
    if (value !== 0) throw new Error(`Expected ${label}.${key} to be zero`);
  }
}

async function getJson(url) {
  const response = await fetch(url, { headers });
  const body = await safeJson(response);
  if (!response.ok || body.ok === false) {
    throw new Error(`Request failed: ${new URL(url).pathname} ${response.status}`);
  }
  return body;
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
