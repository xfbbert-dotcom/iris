import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { createClient } from "redis";

import { RuntimeController } from "../src/admin/runtime-controller.js";
import { buildApp } from "../src/app.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";
import { createMemoryExtractionWorker } from "../src/memory-extraction/memory-extraction-worker.js";
import { createAnswerDraftRuntime } from "../src/runtime/answer-draft-runtime.js";
import { createEventWorkerRuntime } from "../src/runtime/event-worker-runtime.js";
import { createMemoryExtractionRuntime } from "../src/runtime/memory-extraction-runtime.js";
import { createPostgresConversationStateInspectionStore } from "../src/conversation-state/conversation-state-api.js";

const { Pool } = pg;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const composeFile = resolve(repositoryRoot, "docker-compose.acceptance.yml");
const pythonWorkerDirectory = resolve(repositoryRoot, "workers/ai");
const internalApiToken = "acceptance-internal-token";
const workerToken = "acceptance-worker-token";
const fakeApiKey = "acceptance-fake-key";
const groupA = "oc_acceptance_group_a";
const groupB = "oc_acceptance_group_b";
const botOpenId = "ou_acceptancebot";
const candidateTitle = "Atlas launch window";
const candidateSummary = "The Atlas launch window may be Tuesday at 10:00 UTC.";
const openSummary = "The Atlas launch window is Tuesday at 10:00 UTC.";
const correctedSummary = "The corrected Atlas launch window is Wednesday at 11:00 UTC.";

type JsonRecord = Record<string, unknown>;
type Scenario =
  | "noop"
  | "candidate_create"
  | "candidate_promote"
  | "thread_resolve"
  | "thread_reopen"
  | "merge_candidate_create"
  | "merge_candidates"
  | "action_create"
  | "action_complete"
  | "suggestion_action"
  | "answer_action_create"
  | "concurrent_candidate_create"
  | "disabled_candidate_create"
  | "thread_correct";

type FakeProvider = {
  baseUrl: string;
  close(): Promise<void>;
  extractionCallCount(): number;
  answerCallCount(): number;
  setScenario(scenario: Scenario): void;
  setRateLimit(): void;
  armHeldScenario(scenario: Scenario): {
    entered: Promise<void>;
    release(): void;
  };
};

type RunOutcome = {
  requestStatus: string;
  skipReason: string | null;
  runStatus: string | null;
  failureClassification: string | null;
  failureCount: number | null;
};

type QueueStatus = {
  pendingJobCount: number;
  processingJobCount: number;
  delayedJobCount: number;
  deadLetterJobCount: number;
  providerCooldownUntil?: string;
};

const startedAt = Date.now();
sanitizeInheritedProviderEnvironment();

const projectName = `iris-conversation-state-acceptance-${Date.now()}-${randomUUID().slice(0, 8)}`;
const compose = (...args: string[]) => [
  "compose",
  "-p",
  projectName,
  "-f",
  composeFile,
  ...args,
];

let app: ReturnType<typeof buildApp> | undefined;
let pythonWorker: ChildProcess | undefined;
let fakeProvider: FakeProvider | undefined;
let pool: pg.Pool | undefined;
let redisInspector: ReturnType<typeof createClient> | undefined;
let primaryError: unknown;

try {
  logGate("starting isolated Postgres and Redis");
  await runCommand("docker", compose("up", "-d", "postgres", "redis"));
  await waitFor("Postgres readiness", async () => {
    await runCommand("docker", compose("exec", "-T", "postgres", "pg_isready", "-U", "iris", "-d", "iris"));
    return true;
  });
  await waitFor("Redis readiness", async () => {
    const output = await runCommand(
      "docker",
      compose("exec", "-T", "redis", "redis-cli", "ping"),
    );
    return output.trim() === "PONG";
  });

  const postgresPort = parsePublishedPort(
    await runCommand("docker", compose("port", "postgres", "5432")),
  );
  const redisPort = parsePublishedPort(
    await runCommand("docker", compose("port", "redis", "6379")),
  );
  const databaseUrl = `postgres://iris:iris@127.0.0.1:${postgresPort}/iris`;
  const redisUrl = `redis://127.0.0.1:${redisPort}`;

  pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const migrationClient = await pool.connect();
  try {
    await runMigrations({ client: migrationClient, migrationsDir: defaultMigrationsDir() });
  } finally {
    migrationClient.release();
  }

  fakeProvider = await startFakeProvider();
  const pythonPort = await findAvailablePort();
  pythonWorker = startPythonWorker({
    port: pythonPort,
    providerBaseUrl: `${fakeProvider.baseUrl}/v1`,
  });
  await waitFor("Python AI Worker health", async () => {
    const response = await fetch(`http://127.0.0.1:${pythonPort}/health`);
    return response.ok;
  });

  const clock = createMutableClock();
  const runtimeEnv = {
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    IRIS_EVENT_WORKER_ENABLED: "true",
    IRIS_EVENT_WORKER_INTERVAL_MS: "20",
    IRIS_EVENT_WORKER_BATCH_LIMIT: "20",
    IRIS_MEMORY_EXTRACTION_ENABLED: "true",
    IRIS_MEMORY_EXTRACTION_INTERVAL_MS: "20",
    IRIS_MEMORY_EXTRACTION_BATCH_LIMIT: "20",
    IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE: "0.85",
    IRIS_THREAD_CANDIDATE_CONFIDENCE_FLOOR: "0.65",
    IRIS_THREAD_EXTRACTION_GROUP_IDS: `${groupA},${groupB}`,
    IRIS_ACTION_EXTRACTION_GROUP_IDS: `${groupA},${groupB}`,
    IRIS_AI_WORKER_BASE_URL: `http://127.0.0.1:${pythonPort}`,
    IRIS_AI_WORKER_TOKEN: workerToken,
    IRIS_FEISHU_BOT_OPEN_ID: botOpenId,
    IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "true",
    IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "allow-indexed",
    IRIS_MODEL_PROVIDER: "openai-compatible",
    IRIS_MODEL_BASE_URL: `${fakeProvider.baseUrl}/v1`,
    IRIS_MODEL_API_KEY: fakeApiKey,
    IRIS_MODEL_NAME: "fixture-answer",
    IRIS_MODEL_TIMEOUT_MS: "5000",
  };
  const runtimeController = new RuntimeController(
    createDefaultRuntimeConfig({ IRIS_RUNTIME_GLOBAL_ENABLED: "true" }),
  );

  app = buildApp({
    internalApiToken,
    runtimeController,
    conversationStateInspectionStore: createPostgresConversationStateInspectionStore({
      dataSource: pool,
    }),
    verifyFeishuRequest: () => true,
    createAnswerDraftRuntime(input) {
      return createAnswerDraftRuntime({
        env: runtimeEnv,
        runtimeController: input?.runtimeController,
        dependencies: input?.dependencies,
      });
    },
    createMemoryExtractionRuntime(input) {
      return createMemoryExtractionRuntime({
        env: runtimeEnv,
        runtimeController: input?.runtimeController,
        auditLog: input?.auditLog,
        dependencies: {
          createWorker(workerInput) {
            return createMemoryExtractionWorker({ ...workerInput, now: clock.now });
          },
        },
      });
    },
    createEventWorkerRuntime(input) {
      return createEventWorkerRuntime({ env: runtimeEnv, ...input });
    },
    createDocumentSyncRuntime: () => undefined,
    createReindexWorkerRuntime: () => undefined,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const coreAddress = app.server.address() as AddressInfo;
  const coreBaseUrl = `http://127.0.0.1:${coreAddress.port}`;

  redisInspector = createClient({ url: redisUrl, socket: { reconnectStrategy: false } });
  redisInspector.on("error", () => undefined);
  await redisInspector.connect();

  await waitFor("Core runtimes", async () => {
    const [events, extraction] = await Promise.all([
      getJson(coreBaseUrl, "/internal/events/status"),
      getJson(coreBaseUrl, "/internal/memory-extraction/status"),
    ]);
    return events.running === true && extraction.running === true && extraction.workerHealthy === true;
  });

  logGate("1/8 ordinary evidence promotes a candidate thread to open");
  fakeProvider.setScenario("candidate_create");
  const candidateEvent = feishuMessageEvent({
    eventId: "conversation-event-candidate",
    messageId: "conversation-message-candidate",
    groupId: groupA,
    senderOpenId: "ou_acceptancealice",
    text: candidateSummary,
  });
  await sendAndDrain(coreBaseUrl, candidateEvent);
  const candidate = findBy(
    await readEntities(coreBaseUrl, `/internal/conversation-state/groups/${groupA}/threads`),
    "title",
    candidateTitle,
  );
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.version, 1);
  assert.deepEqual(candidate.evidenceMessageIds, ["feishu:conversation-message-candidate"]);

  fakeProvider.setScenario("candidate_promote");
  await sendAndDrain(coreBaseUrl, feishuMessageEvent({
    eventId: "conversation-event-promote",
    messageId: "conversation-message-promote",
    groupId: groupA,
    senderOpenId: "ou_acceptancebob",
    text: openSummary,
  }));
  const promoted = findBy(
    await readEntities(coreBaseUrl, `/internal/conversation-state/groups/${groupA}/threads`),
    "id",
    requireString(candidate.id, "candidate id"),
  );
  assert.equal(promoted.status, "open");
  assert.equal(promoted.version, 2);

  logGate("2/8 explicit completion resolves and later discussion reopens the thread");
  fakeProvider.setScenario("thread_resolve");
  await sendAndDrain(coreBaseUrl, feishuMessageEvent({
    eventId: "conversation-event-resolve",
    messageId: "conversation-message-resolve",
    groupId: groupA,
    senderOpenId: "ou_acceptancealice",
    text: "The Atlas launch-window discussion is explicitly complete.",
  }));
  let atlas = findBy(
    await readEntities(coreBaseUrl, `/internal/conversation-state/groups/${groupA}/threads`),
    "id",
    requireString(candidate.id, "candidate id"),
  );
  assert.equal(atlas.status, "resolved");
  assert.equal(atlas.version, 3);

  fakeProvider.setScenario("thread_reopen");
  await sendAndDrain(coreBaseUrl, feishuMessageEvent({
    eventId: "conversation-event-reopen",
    messageId: "conversation-message-reopen",
    groupId: groupA,
    senderOpenId: "ou_acceptancealice",
    text: "We explicitly need to discuss the Atlas launch window again.",
  }));
  atlas = findBy(
    await readEntities(coreBaseUrl, `/internal/conversation-state/groups/${groupA}/threads`),
    "id",
    requireString(candidate.id, "candidate id"),
  );
  assert.equal(atlas.status, "open");
  assert.equal(atlas.version, 4);

  logGate("3/8 two candidates merge canonically without cycles or cross-group joins");
  fakeProvider.setScenario("merge_candidate_create");
  await sendAndDrain(coreBaseUrl, feishuMessageEvent({
    eventId: "conversation-event-group-b-candidate",
    messageId: "conversation-message-group-b-candidate",
    groupId: groupB,
    senderOpenId: "ou_acceptancebob",
    text: "Merge target private Group B budget topic.",
  }));
  await sendAndDrain(coreBaseUrl, feishuMessageEvent({
    eventId: "conversation-event-merge-target",
    messageId: "conversation-message-merge-target",
    groupId: groupA,
    senderOpenId: "ou_acceptancealice",
    text: "Merge target release budget topic.",
  }));
  await sendAndDrain(coreBaseUrl, feishuMessageEvent({
    eventId: "conversation-event-merge-source",
    messageId: "conversation-message-merge-source",
    groupId: groupA,
    senderOpenId: "ou_acceptancealice",
    text: "Merge source release budget topic.",
  }));
  const beforeMerge = await readEntities(
    coreBaseUrl,
    `/internal/conversation-state/groups/${groupA}/threads?limit=100`,
  );
  const mergeTarget = findBy(beforeMerge, "title", "Merge target release budget topic");
  const mergeSource = findBy(beforeMerge, "title", "Merge source release budget topic");
  assert.equal(mergeTarget.status, "candidate");
  assert.equal(mergeSource.status, "candidate");

  fakeProvider.setScenario("merge_candidates");
  await sendAndDrain(coreBaseUrl, feishuMessageEvent({
    eventId: "conversation-event-merge",
    messageId: "conversation-message-merge",
    groupId: groupA,
    senderOpenId: "ou_acceptancealice",
    text: "These release budget topics are the same discussion.",
  }));
  const afterMerge = await readEntities(
    coreBaseUrl,
    `/internal/conversation-state/groups/${groupA}/threads?limit=100`,
  );
  const canonicalTarget = findBy(afterMerge, "id", requireString(mergeTarget.id, "merge target id"));
  const mergedSource = findBy(afterMerge, "id", requireString(mergeSource.id, "merge source id"));
  assert.equal(canonicalTarget.status, "candidate");
  assert.equal(mergedSource.status, "merged");
  assert.equal(mergedSource.mergedIntoThreadId, canonicalTarget.id);
  assert.notEqual(canonicalTarget.mergedIntoThreadId, mergedSource.id);
  const groupBThreads = await readEntities(
    coreBaseUrl,
    `/internal/conversation-state/groups/${groupB}/threads?limit=100`,
  );
  assert.equal(groupBThreads.length, 1);
  assert.equal(groupBThreads[0]?.status, "candidate");
  assert.equal(groupBThreads[0]?.mergedIntoThreadId, undefined);

  logGate("4/8 one commitment creates one action and completion updates it");
  fakeProvider.setScenario("action_create");
  await sendAndDrain(coreBaseUrl, feishuMessageEvent({
    eventId: "conversation-event-action-create",
    messageId: "conversation-message-action-create",
    groupId: groupA,
    senderOpenId: "ou_acceptancealice",
    text: "I will publish the Atlas rollout note tomorrow.",
  }));
  let actions = await readEntities(
    coreBaseUrl,
    `/internal/conversation-state/groups/${groupA}/actions?limit=100`,
  );
  const createdAction = findBy(actions, "description", "Publish the Atlas rollout note");
  assert.equal(createdAction.status, "open");
  assert.equal(createdAction.version, 1);
  assert.equal(actions.filter((action) => action.description === createdAction.description).length, 1);

  fakeProvider.setScenario("action_complete");
  await sendAndDrain(coreBaseUrl, feishuMessageEvent({
    eventId: "conversation-event-action-complete",
    messageId: "conversation-message-action-complete",
    groupId: groupA,
    senderOpenId: "ou_acceptancealice",
    text: "I explicitly completed publishing the Atlas rollout note.",
  }));
  actions = await readEntities(
    coreBaseUrl,
    `/internal/conversation-state/groups/${groupA}/actions?limit=100`,
  );
  const completedAction = findBy(actions, "id", requireString(createdAction.id, "created action id"));
  assert.equal(completedAction.status, "completed");
  assert.equal(completedAction.version, 2);
  assert.equal(actions.filter((action) => action.id === completedAction.id).length, 1);

  logGate("5/8 suggestions and brainstorming create zero actions");
  const extractionBeforeSuggestions = await getJson(coreBaseUrl, "/internal/memory-extraction/status");
  const rejectedActionsBefore = requireNumber(
    extractionBeforeSuggestions.rejectedActionOperationCount,
    "rejected action count before suggestions",
  );
  const actionCountBeforeSuggestions = actions.length;
  fakeProvider.setScenario("suggestion_action");
  await sendAndDrain(coreBaseUrl, feishuMessageEvent({
    eventId: "conversation-event-suggestion",
    messageId: "conversation-message-suggestion",
    groupId: groupA,
    senderOpenId: "ou_acceptancealice",
    text: "Maybe Alice should publish another rollout note?",
  }));
  await sendAndDrain(coreBaseUrl, feishuMessageEvent({
    eventId: "conversation-event-brainstorm",
    messageId: "conversation-message-brainstorm",
    groupId: groupA,
    senderOpenId: "ou_acceptancealice",
    text: "Let us brainstorm who could publish the launch checklist.",
  }));
  actions = await readEntities(
    coreBaseUrl,
    `/internal/conversation-state/groups/${groupA}/actions?limit=100`,
  );
  const extractionAfterSuggestions = await getJson(coreBaseUrl, "/internal/memory-extraction/status");
  assert.equal(actions.length, actionCountBeforeSuggestions);
  assert.equal(
    requireNumber(
      extractionAfterSuggestions.rejectedActionOperationCount,
      "rejected action count after suggestions",
    ),
    rejectedActionsBefore + 2,
  );

  logGate("6/8 candidate content stays out of answers while open state is present");
  fakeProvider.setScenario("answer_action_create");
  await sendAndDrain(coreBaseUrl, feishuMessageEvent({
    eventId: "conversation-event-answer-action",
    messageId: "conversation-message-answer-action",
    groupId: groupA,
    senderOpenId: "ou_acceptancealice",
    text: "I will prepare the Atlas launch-window checklist.",
  }));
  const answerActionDescription = "Prepare the Atlas launch-window checklist";
  const answer = await postJson(coreBaseUrl, "/internal/answer-drafts", {
    chatId: groupA,
    question: "What is the Atlas launch window and launch-window checklist?",
    liveChatMessages: [],
    fragmentLimit: 0,
    liveChatLimit: 0,
  });
  const answerThreads = requireRecordArray(answer.usedDiscussionThreads, "answer threads");
  const answerActions = requireRecordArray(answer.usedActionItems, "answer actions");
  assert.ok(answerThreads.some((thread) => thread.id === atlas.id && thread.summary === openSummary));
  assert.ok(answerActions.some((action) => action.description === answerActionDescription));
  const serializedAnswer = JSON.stringify(answer);
  assert.ok(!serializedAnswer.includes("Merge target release budget topic"));
  assert.ok(!serializedAnswer.includes("Merge source release budget topic"));
  assert.ok(!serializedAnswer.includes("Merge target private Group B budget topic"));

  logGate("7/8 replay, concurrency, cooldown, and disablement stay authorized and idempotent");
  const replaySnapshot = await readConversationStateCounts(pool, groupA);
  const replayCalls = fakeProvider.extractionCallCount();
  await sendAndDrain(coreBaseUrl, candidateEvent);
  assert.deepEqual(await readConversationStateCounts(pool, groupA), replaySnapshot);
  assert.equal(fakeProvider.extractionCallCount(), replayCalls);

  fakeProvider.setScenario("concurrent_candidate_create");
  const concurrentEvent = feishuMessageEvent({
    eventId: "conversation-event-concurrent",
    messageId: "conversation-message-concurrent",
    groupId: groupA,
    senderOpenId: "ou_acceptancealice",
    text: "Concurrent delivery should create one candidate topic.",
  });
  const beforeConcurrent = await readConversationStateCounts(pool, groupA);
  const concurrentCalls = fakeProvider.extractionCallCount();
  await Promise.all([
    postFeishuEvent(coreBaseUrl, concurrentEvent),
    postFeishuEvent(coreBaseUrl, concurrentEvent),
  ]);
  await waitFor("concurrent extraction completion", async () =>
    (await readRunOutcome(pool!, "conversation-message-concurrent"))?.requestStatus === "completed",
  );
  await drainAndAssert(coreBaseUrl);
  assertCountDeltas(await readConversationStateCounts(pool, groupA), beforeConcurrent, {
    messages: 1,
    requests: 1,
    runs: 1,
    threads: 1,
    threadEvents: 1,
    threadEvidence: 1,
    operationClaims: 1,
  });
  assert.equal(fakeProvider.extractionCallCount(), concurrentCalls + 1);
  const afterConcurrent = await readConversationStateCounts(pool, groupA);
  const callsAfterConcurrent = fakeProvider.extractionCallCount();
  await sendAndDrain(coreBaseUrl, concurrentEvent);
  assert.deepEqual(await readConversationStateCounts(pool, groupA), afterConcurrent);
  assert.equal(fakeProvider.extractionCallCount(), callsAfterConcurrent);

  const beforeCooldownA = await readConversationStateCounts(pool, groupA);
  const beforeCooldownB = await readConversationStateCounts(pool, groupB);
  fakeProvider.setRateLimit();
  const callsBeforeRateLimit = fakeProvider.extractionCallCount();
  await postFeishuEvent(coreBaseUrl, feishuMessageEvent({
    eventId: "conversation-event-rate-1",
    messageId: "conversation-message-rate-1",
    groupId: groupA,
    senderOpenId: "ou_acceptancealice",
    text: "Cooldown candidate topic one.",
  }));
  const firstCooldown = await waitFor("first delayed rate-limit job", async () => {
    const status = await readQueueStatus(coreBaseUrl);
    return status.delayedJobCount === 1 && status.providerCooldownUntil !== undefined
      ? status
      : undefined;
  });
  assert.equal(firstCooldown.pendingJobCount, 0);
  assert.equal(fakeProvider.extractionCallCount(), callsBeforeRateLimit + 1);
  assert.deepEqual(await readQueuedAttempts(redisInspector), [1]);

  const callsDuringCooldown = fakeProvider.extractionCallCount();
  await postFeishuEvent(coreBaseUrl, feishuMessageEvent({
    eventId: "conversation-event-rate-2",
    messageId: "conversation-message-rate-2",
    groupId: groupA,
    senderOpenId: "ou_acceptancealice",
    text: "Cooldown candidate topic two.",
  }));
  await waitFor("second job deferred by shared cooldown", async () =>
    (await readQueueStatus(coreBaseUrl)).delayedJobCount === 2,
  );
  assert.equal(fakeProvider.extractionCallCount(), callsDuringCooldown);
  assert.deepEqual(await readQueuedAttempts(redisInspector), [0, 1]);
  await delay(120);
  assert.equal(fakeProvider.extractionCallCount(), callsDuringCooldown);

  fakeProvider.setScenario("concurrent_candidate_create");
  clock.advance(61_000);
  const firstPostCooldownCompletion = await waitFor(
    "first rate-limit request completes after clock advance",
    async () => {
      const outcomes = await Promise.all([
        readRunOutcome(pool!, "conversation-message-rate-1"),
        readRunOutcome(pool!, "conversation-message-rate-2"),
      ]);
      return outcomes.some((outcome) => outcome?.requestStatus === "completed")
        ? outcomes
        : undefined;
    },
    30_000,
  );
  if (!firstPostCooldownCompletion.every((outcome) => outcome?.requestStatus === "completed")) {
    const settled = await waitFor("remaining cooldown job reaches a stable state", async () => {
      const outcomes = await Promise.all([
        readRunOutcome(pool!, "conversation-message-rate-1"),
        readRunOutcome(pool!, "conversation-message-rate-2"),
      ]);
      if (outcomes.every((outcome) => outcome?.requestStatus === "completed")) {
        return { completed: true, delayed: [] };
      }
      const queue = await readQueueStatus(coreBaseUrl);
      if (queue.processingJobCount !== 0 || queue.delayedJobCount !== 1) return undefined;
      const delayed = await readDelayedJobs(redisInspector!);
      return delayed.length === 1 ? { completed: false, delayed } : undefined;
    }, 30_000);
    if (!settled.completed) {
      const retryAt = requireNumber(settled.delayed[0]?.score, "remaining delayed retry score");
      const retryAdvanceMs = retryAt - clock.now().getTime() + 1;
      assert.ok(retryAdvanceMs > 0 && retryAdvanceMs <= 300_000, "bounded stale retry delay");
      clock.advance(retryAdvanceMs);
    }
  }
  await waitFor("rate-limit requests complete after bounded clock advances", async () => {
    const [first, second] = await Promise.all([
      readRunOutcome(pool!, "conversation-message-rate-1"),
      readRunOutcome(pool!, "conversation-message-rate-2"),
    ]);
    if (first?.requestStatus === "completed" && second?.requestStatus === "completed") {
      return true;
    }
    const queue = await readQueueStatus(coreBaseUrl);
    throw new Error(JSON.stringify({
      first,
      second,
      queue,
      syntheticNow: clock.now().toISOString(),
      delayedJobs: await readDelayedJobs(redisInspector!),
      providerCalls: fakeProvider!.extractionCallCount(),
    }));
  }, 30_000);
  await drainAndAssert(coreBaseUrl);
  assert.equal(fakeProvider.extractionCallCount(), callsBeforeRateLimit + 3);
  const afterCooldownA = await readConversationStateCounts(pool, groupA);
  assertCountDeltas(afterCooldownA, beforeCooldownA, {
    messages: 2,
    requests: 2,
    threads: 2,
    threadEvents: 2,
    threadEvidence: 2,
    operationClaims: 2,
  });
  const cooldownRunDelta = requireNumber(afterCooldownA.runs, "runs after cooldown") -
    requireNumber(beforeCooldownA.runs, "runs before cooldown");
  assert.ok(cooldownRunDelta === 2 || cooldownRunDelta === 3, "bounded cooldown run delta");
  assert.deepEqual(await readConversationStateCounts(pool, groupB), beforeCooldownB);

  const beforeDisabledA = await readProjectionCounts(pool, groupA);
  const beforeDisabledB = await readProjectionCounts(pool, groupB);
  const held = fakeProvider.armHeldScenario("disabled_candidate_create");
  await postFeishuEvent(coreBaseUrl, feishuMessageEvent({
    eventId: "conversation-event-disabled",
    messageId: "conversation-message-disabled",
    groupId: groupA,
    senderOpenId: "ou_acceptancealice",
    text: "This candidate must not be written while the group is disabled.",
  }));
  await withTimeout(held.entered, 10_000, "held conversation-state provider request");
  await setGroupEnabled(coreBaseUrl, groupA, false);
  held.release();
  const disabledOutcome = await waitFor("disabled-before-apply outcome", async () => {
    const outcome = await readRunOutcome(pool!, "conversation-message-disabled");
    return outcome?.requestStatus === "skipped" ? outcome : undefined;
  });
  assert.equal(disabledOutcome.skipReason, "runtime_disabled_before_apply");
  assert.equal(disabledOutcome.failureClassification, "runtime_disabled_before_apply");
  await drainAndAssert(coreBaseUrl);
  assert.deepEqual(await readProjectionCounts(pool, groupA), beforeDisabledA);
  assert.deepEqual(await readProjectionCounts(pool, groupB), beforeDisabledB);
  await setGroupEnabled(coreBaseUrl, groupA, true);
  await delay(120);
  await drainAndAssert(coreBaseUrl);
  assert.deepEqual(await readProjectionCounts(pool, groupA), beforeDisabledA);

  logGate("8/8 correction updates canonical state and preserves prior event evidence");
  const atlasId = requireString(atlas.id, "Atlas thread id");
  const eventsBeforeCorrection = await readEntities(
    coreBaseUrl,
    `/internal/conversation-state/threads/${encodeURIComponent(atlasId)}/events?limit=100`,
  );
  assert.equal(eventsBeforeCorrection.length, 4);
  const priorEventSnapshot = eventsBeforeCorrection.map((event) => ({
    id: requireString(event.id, "prior thread event id"),
    toVersion: requireNumber(event.toVersion, "prior thread event version"),
    evidenceMessageIds: [...requireStringArray(
      event.evidenceMessageIds,
      "prior thread event evidence",
    )],
  }));
  fakeProvider.setScenario("thread_correct");
  await sendAndDrain(coreBaseUrl, feishuMessageEvent({
    eventId: "conversation-event-correct",
    messageId: "conversation-message-correct",
    groupId: groupA,
    senderOpenId: "ou_acceptancealice",
    text: correctedSummary,
  }));
  atlas = findBy(
    await readEntities(coreBaseUrl, `/internal/conversation-state/groups/${groupA}/threads`),
    "id",
    atlasId,
  );
  assert.equal(atlas.summary, correctedSummary);
  assert.equal(atlas.status, "open");
  assert.equal(atlas.version, 5);
  const eventsAfterCorrection = await readEntities(
    coreBaseUrl,
    `/internal/conversation-state/threads/${encodeURIComponent(atlasId)}/events?limit=100`,
  );
  assert.equal(eventsAfterCorrection.length, 5);
  for (const prior of priorEventSnapshot) {
    const persisted = findBy(eventsAfterCorrection, "id", prior.id);
    assert.equal(persisted.toVersion, prior.toVersion);
    assert.deepEqual(persisted.evidenceMessageIds, prior.evidenceMessageIds);
  }
  const correctionEvent = findBy(eventsAfterCorrection, "eventType", "corrected");
  assert.equal(correctionEvent.fromVersion, 4);
  assert.equal(correctionEvent.toVersion, 5);
  assert.deepEqual(correctionEvent.evidenceMessageIds, ["feishu:conversation-message-correct"]);

  console.log(`[acceptance] PASS: gates 1-8 in ${formatSeconds(Date.now() - startedAt)}`);
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  const cleanupErrors: unknown[] = [];
  await cleanupStep(cleanupErrors, async () => app?.close());
  await cleanupStep(cleanupErrors, async () => stopChild(pythonWorker));
  await cleanupStep(cleanupErrors, async () => fakeProvider?.close());
  await cleanupStep(cleanupErrors, async () => {
    if (redisInspector?.isOpen) await redisInspector.quit();
  });
  await cleanupStep(cleanupErrors, async () => pool?.end());
  await cleanupStep(cleanupErrors, async () => {
    await runCommand(
      "docker",
      compose("down", "-v", "--remove-orphans", "--timeout", "5"),
    );
  });
  await cleanupStep(cleanupErrors, async () => {
    const remaining = await runCommand("docker", compose("ps", "-q"));
    assert.equal(remaining.trim(), "", "acceptance containers were not removed");
  });
  await cleanupStep(cleanupErrors, async () => {
    const remaining = await runCommand("docker", [
      "volume",
      "ls",
      "--filter",
      `label=com.docker.compose.project=${projectName}`,
      "-q",
    ]);
    assert.equal(remaining.trim(), "", "acceptance volumes were not removed");
  });
  if (primaryError === undefined && cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "conversation state acceptance cleanup failed");
  }
}

async function sendAndDrain(baseUrl: string, event: JsonRecord): Promise<void> {
  await postFeishuEvent(baseUrl, event);
  const eventBody = requireRecord(event.event, "Feishu event body");
  const eventMessage = requireRecord(eventBody.message, "Feishu event message");
  const providerMessageId = requireString(eventMessage.message_id, "Feishu message id");
  await waitFor(`extraction request for ${providerMessageId}`, async () => {
    const outcome = pool === undefined ? undefined : await readRunOutcome(pool, providerMessageId);
    if (outcome?.requestStatus === "completed" || outcome?.requestStatus === "skipped") return true;
    if (outcome?.failureClassification !== null && outcome?.failureClassification !== undefined) {
      throw new Error(JSON.stringify(outcome));
    }
    return undefined;
  }, 30_000);
  await drainAndAssert(baseUrl);
}

async function drainAndAssert(baseUrl: string): Promise<void> {
  await waitFor("all conversation-state queues and repairs to drain", async () => {
    const [events, extraction, state] = await Promise.all([
      getJson(baseUrl, "/internal/events/status"),
      readQueueStatus(baseUrl),
      getJson(baseUrl, "/internal/conversation-state/status"),
    ]);
    const repairs = requireRecord(state.projectionRepairs, "projection repairs");
    const drained = events.pendingEventCount === 0 &&
      events.deadLetterEventCount === 0 &&
      extraction.pendingJobCount === 0 &&
      extraction.processingJobCount === 0 &&
      extraction.delayedJobCount === 0 &&
      extraction.deadLetterJobCount === 0 &&
      repairs.pending === 0 &&
      repairs.processing === 0 &&
      repairs.failed === 0;
    if (!drained) {
      const diagnostics = pool === undefined
        ? []
        : (await pool.query(
            "SELECT status, failure_classification, failure_count FROM group_memory_extraction_runs ORDER BY created_at DESC LIMIT 1",
          )).rows;
      throw new Error(JSON.stringify({ events, extraction, repairs, diagnostics }));
    }
    return true;
  });
}

async function readEntities(baseUrl: string, path: string): Promise<JsonRecord[]> {
  const response = await getJson(baseUrl, path);
  return requireRecordArray(response.threads ?? response.actions ?? response.events, `${path} entities`);
}

function findBy(rows: JsonRecord[], key: string, expected: unknown): JsonRecord {
  const row = rows.find((candidate) => candidate[key] === expected);
  assert.ok(row !== undefined, `missing entity with ${key}=${String(expected)}`);
  return row;
}

function sanitizeInheritedProviderEnvironment(): void {
  const forbidden = /(?:FEISHU|GEMINI|OPENAI|GOOGLE_API_KEY|GOOGLE_GENAI|IRIS_MODEL|IRIS_EMBEDDING|IRIS_AI_WORKER)/iu;
  for (const key of Object.keys(process.env)) {
    if (forbidden.test(key)) delete process.env[key];
  }
}

function createMutableClock() {
  let timestamp = Date.now();
  return {
    now: () => new Date(timestamp),
    advance(milliseconds: number) {
      timestamp += milliseconds;
    },
  };
}

async function startFakeProvider(): Promise<FakeProvider> {
  let mode: "scenario" | "rate_limit" | "hold" = "scenario";
  let scenario: Scenario = "noop";
  let extractionCalls = 0;
  let answerCalls = 0;
  let heldEntered: (() => void) | undefined;
  let heldRelease: Promise<void> | undefined;
  let releaseHeld: (() => void) | undefined;

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      console.error("[acceptance] fake provider failure", error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }
    const payload = await readBoundedJsonRequest(request);
    const model = requireString(payload.model, "provider model");
    if (model === "fixture-answer") {
      answerCalls += 1;
      sendJson(response, 200, completionPayload(model, "Acceptance answer."));
      return;
    }
    assert.equal(model, "fixture-extractor");
    extractionCalls += 1;
    if (mode === "rate_limit") {
      sendJson(response, 429, { error: "rate_limited" }, { "Retry-After": "60" });
      return;
    }

    const userContent = readUserContent(payload);
    const runId = readXmlTag(userContent, "run_id");
    const evidenceMessageId = readEvidenceEligibleMessageId(userContent);
    if (mode === "hold") {
      heldEntered?.();
      await heldRelease;
    }
    const operations = buildScenarioOperations(scenario, userContent, evidenceMessageId);
    const extraction = {
      schema_version: 2,
      run_id: runId,
      candidates: [],
      thread_operations: operations.threadOperations,
      action_operations: operations.actionOperations,
    };
    sendJson(response, 200, completionPayload(model, JSON.stringify(extraction)));
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error === undefined ? resolveClose() : reject(error)));
    }),
    extractionCallCount: () => extractionCalls,
    answerCallCount: () => answerCalls,
    setScenario(nextScenario) {
      mode = "scenario";
      scenario = nextScenario;
    },
    setRateLimit() {
      mode = "rate_limit";
    },
    armHeldScenario(nextScenario) {
      mode = "hold";
      scenario = nextScenario;
      const entered = new Promise<void>((resolveEntered) => {
        heldEntered = resolveEntered;
      });
      heldRelease = new Promise<void>((resolveRelease) => {
        releaseHeld = resolveRelease;
      });
      return {
        entered,
        release() {
          releaseHeld?.();
          releaseHeld = undefined;
        },
      };
    },
  };
}

function buildScenarioOperations(
  scenario: Scenario,
  prompt: string,
  evidenceMessageId: string,
): { threadOperations: JsonRecord[]; actionOperations: JsonRecord[] } {
  if (scenario === "candidate_create") {
    return {
      threadOperations: [{
        operation: "create",
        operation_key: `candidate:create:${evidenceMessageId}`,
        confidence: 0.7,
        evidence_message_ids: [evidenceMessageId],
        evidence_span: candidateSummary,
        title: candidateTitle,
        summary: candidateSummary,
        initial_status: "candidate",
      }],
      actionOperations: [],
    };
  }
  if (scenario === "candidate_promote") {
    const thread = findPromptEntity(prompt, "thread", "title", candidateTitle);
    return {
      threadOperations: [{
        operation: "promote",
        operation_key: `candidate:promote:${evidenceMessageId}`,
        confidence: 0.96,
        evidence_message_ids: [evidenceMessageId],
        evidence_span: openSummary,
        thread_id: readXmlTag(thread, "id"),
        expected_version: Number(readXmlTag(thread, "version")),
        summary: openSummary,
      }],
      actionOperations: [],
    };
  }
  if (scenario === "thread_resolve" || scenario === "thread_reopen") {
    const thread = findPromptEntity(prompt, "thread", "title", candidateTitle);
    const operation = scenario === "thread_resolve" ? "resolve" : "reopen";
    const evidenceSpan = scenario === "thread_resolve"
      ? "The Atlas launch-window discussion is explicitly complete."
      : "We explicitly need to discuss the Atlas launch window again.";
    return {
      threadOperations: [{
        operation,
        operation_key: `thread:${operation}:${evidenceMessageId}`,
        confidence: 0.97,
        evidence_message_ids: [evidenceMessageId],
        evidence_span: evidenceSpan,
        thread_id: readXmlTag(thread, "id"),
        expected_version: Number(readXmlTag(thread, "version")),
      }],
      actionOperations: [],
    };
  }
  if (scenario === "merge_candidate_create") {
    const evidenceText = readXmlTag(readEvidenceEligibleMessageBlock(prompt), "text");
    const title = evidenceText.replace(/\.$/u, "");
    return {
      threadOperations: [{
        operation: "create",
        operation_key: `merge:create:${evidenceMessageId}`,
        confidence: 0.72,
        evidence_message_ids: [evidenceMessageId],
        evidence_span: evidenceText,
        title,
        summary: title,
        initial_status: "candidate",
      }],
      actionOperations: [],
    };
  }
  if (scenario === "merge_candidates") {
    const source = findPromptEntity(prompt, "thread", "title", "Merge source release budget topic");
    const target = findPromptEntity(prompt, "thread", "title", "Merge target release budget topic");
    return {
      threadOperations: [{
        operation: "merge",
        operation_key: `merge:apply:${evidenceMessageId}`,
        confidence: 0.97,
        evidence_message_ids: [evidenceMessageId],
        evidence_span: "These release budget topics are the same discussion.",
        source_thread_id: readXmlTag(source, "id"),
        target_thread_id: readXmlTag(target, "id"),
        expected_version: Number(readXmlTag(source, "version")),
      }],
      actionOperations: [],
    };
  }
  if (scenario === "action_create") {
    return {
      threadOperations: [],
      actionOperations: [{
        operation: "create",
        operation_key: `action:create:${evidenceMessageId}`,
        confidence: 0.98,
        evidence_message_ids: [evidenceMessageId],
        evidence_span: "I will publish the Atlas rollout note tomorrow.",
        description: "Publish the Atlas rollout note",
        owner: { owner_type: "sender", message_id: evidenceMessageId },
      }],
    };
  }
  if (scenario === "action_complete") {
    const action = findPromptEntity(
      prompt,
      "action",
      "description",
      "Publish the Atlas rollout note",
    );
    return {
      threadOperations: [],
      actionOperations: [{
        operation: "complete",
        operation_key: `action:complete:${evidenceMessageId}`,
        confidence: 0.98,
        evidence_message_ids: [evidenceMessageId],
        evidence_span: "I explicitly completed publishing the Atlas rollout note.",
        action_id: readXmlTag(action, "id"),
        expected_version: Number(readXmlTag(action, "version")),
      }],
    };
  }
  if (scenario === "suggestion_action") {
    const evidenceText = readXmlTag(readEvidenceEligibleMessageBlock(prompt), "text");
    return {
      threadOperations: [],
      actionOperations: [{
        operation: "create",
        operation_key: `suggestion:create:${evidenceMessageId}`,
        confidence: 0.98,
        evidence_message_ids: [evidenceMessageId],
        evidence_span: evidenceText,
        description: evidenceText,
        owner: { owner_type: "sender", message_id: evidenceMessageId },
      }],
    };
  }
  if (scenario === "answer_action_create") {
    const thread = findPromptEntity(prompt, "thread", "title", candidateTitle);
    return {
      threadOperations: [],
      actionOperations: [{
        operation: "create",
        operation_key: `answer-action:create:${evidenceMessageId}`,
        confidence: 0.98,
        evidence_message_ids: [evidenceMessageId],
        evidence_span: "I will prepare the Atlas launch-window checklist.",
        thread_id: readXmlTag(thread, "id"),
        description: "Prepare the Atlas launch-window checklist",
        owner: { owner_type: "sender", message_id: evidenceMessageId },
      }],
    };
  }
  if (scenario === "concurrent_candidate_create" || scenario === "disabled_candidate_create") {
    const evidenceText = readXmlTag(readEvidenceEligibleMessageBlock(prompt), "text");
    return {
      threadOperations: [{
        operation: "create",
        operation_key: `gate-seven:create:${evidenceMessageId}`,
        confidence: 0.72,
        evidence_message_ids: [evidenceMessageId],
        evidence_span: evidenceText,
        title: evidenceText.replace(/\.$/u, ""),
        summary: evidenceText,
        initial_status: "candidate",
      }],
      actionOperations: [],
    };
  }
  if (scenario === "thread_correct") {
    const thread = findPromptEntity(prompt, "thread", "title", candidateTitle);
    return {
      threadOperations: [{
        operation: "correct",
        operation_key: `thread:correct:${evidenceMessageId}`,
        confidence: 0.98,
        evidence_message_ids: [evidenceMessageId],
        evidence_span: correctedSummary,
        thread_id: readXmlTag(thread, "id"),
        expected_version: Number(readXmlTag(thread, "version")),
        corrected_fields: ["summary"],
        summary: correctedSummary,
      }],
      actionOperations: [],
    };
  }
  return { threadOperations: [], actionOperations: [] };
}

function findPromptEntity(
  prompt: string,
  tag: "thread" | "action",
  field: string,
  expected: string,
): string {
  const blocks = prompt.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "gu")) ?? [];
  const block = blocks.find((candidate) => readXmlTag(candidate, field) === expected);
  assert.ok(block !== undefined, `missing prompt ${tag} with ${field}=${expected}`);
  return block;
}

function completionPayload(model: string, content: string): JsonRecord {
  return {
    id: `fixture-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, refusal: null },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(serialized),
    ...headers,
  });
  response.end(serialized);
}

async function readBoundedJsonRequest(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 512 * 1024) throw new Error("fake provider request is oversized");
    chunks.push(buffer);
  }
  return requireRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")), "provider request");
}

function readUserContent(payload: JsonRecord): string {
  const messages = requireRecordArray(payload.messages, "provider messages");
  const userMessage = messages.find((message) => message.role === "user");
  return requireString(userMessage?.content, "provider user content");
}

function readXmlTag(content: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "u").exec(content);
  return requireString(match?.[1], `XML ${tag}`);
}

function readEvidenceEligibleMessageId(content: string): string {
  return readXmlTag(readEvidenceEligibleMessageBlock(content), "id");
}

function readEvidenceEligibleMessageBlock(content: string): string {
  const blocks = content.match(/<message>[\s\S]*?<\/message>/gu) ?? [];
  for (const block of blocks) {
    if (block.includes("<evidence_eligible>true</evidence_eligible>")) {
      return block;
    }
  }
  throw new Error("provider request has no evidence-eligible message");
}

function startPythonWorker(input: {
  port: number;
  providerBaseUrl: string;
}): ChildProcess {
  const python = resolvePythonCommand();
  const childEnvironment = { ...process.env };
  sanitizeEnvironmentRecord(childEnvironment);
  Object.assign(childEnvironment, {
    IRIS_AI_WORKER_TOKEN: workerToken,
    IRIS_AI_WORKER_PORT: String(input.port),
    IRIS_MODEL_BASE_URL: input.providerBaseUrl,
    IRIS_MODEL_API_KEY: fakeApiKey,
    IRIS_MODEL_NAME: "fixture-extractor",
    IRIS_MODEL_TIMEOUT_MS: "5000",
    IRIS_MODEL_MAX_RESPONSE_BYTES: "65536",
  });
  const child = spawn(python, ["-m", "iris_worker"], {
    cwd: pythonWorkerDirectory,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return child;
}

function sanitizeEnvironmentRecord(environment: NodeJS.ProcessEnv): void {
  const forbidden = /(?:FEISHU|GEMINI|OPENAI|GOOGLE_API_KEY|GOOGLE_GENAI|IRIS_MODEL|IRIS_EMBEDDING|IRIS_AI_WORKER)/iu;
  for (const key of Object.keys(environment)) {
    if (forbidden.test(key)) delete environment[key];
  }
}

function resolvePythonCommand(): string {
  const candidates = [process.env.PYTHON?.trim(), process.platform === "win32" ? "python" : "python3", "python"]
    .filter((candidate, index, all): candidate is string =>
      candidate !== undefined && candidate.length > 0 && all.indexOf(candidate) === index,
    );
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.status === 0) return candidate;
  }
  throw new Error("Python interpreter was not found (set PYTHON, or install python/python3)");
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)));
  });
  return port;
}

function feishuMessageEvent(input: {
  eventId: string;
  messageId: string;
  groupId: string;
  senderOpenId: string;
  text: string;
}): JsonRecord {
  return {
    header: {
      event_id: input.eventId,
      event_type: "im.message.receive_v1",
    },
    event: {
      sender: { sender_id: { open_id: input.senderOpenId } },
      message: {
        message_id: input.messageId,
        chat_id: input.groupId,
        message_type: "text",
        content: JSON.stringify({ text: input.text }),
        create_time: String(Date.now()),
      },
    },
  };
}

async function postFeishuEvent(baseUrl: string, event: JsonRecord): Promise<void> {
  const response = await fetch(`${baseUrl}/feishu/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
}

async function getJson(baseUrl: string, path: string): Promise<JsonRecord> {
  return requestJson(baseUrl, path, { method: "GET" });
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<JsonRecord> {
  return requestJson(baseUrl, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function requestJson(
  baseUrl: string,
  path: string,
  init: RequestInit,
): Promise<JsonRecord> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${internalApiToken}`);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const body = requireRecord(await response.json(), `HTTP ${path} response`);
  assert.ok(response.ok, `${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function setGroupEnabled(baseUrl: string, groupId: string, enabled: boolean): Promise<void> {
  const response = await postJson(
    baseUrl,
    `/internal/runtime-control/groups/${encodeURIComponent(groupId)}`,
    { enabled },
  );
  assert.equal(response.ok, true);
}

async function readRunOutcome(
  pool: pg.Pool,
  providerMessageId: string,
): Promise<RunOutcome | undefined> {
  const result = await pool.query<{
    request_status: string;
    skip_reason: string | null;
    run_status: string | null;
    failure_classification: string | null;
    failure_count: number | null;
  }>(
    `
    SELECT
      request.status AS request_status,
      request.skip_reason,
      run.status AS run_status,
      run.failure_classification,
      run.failure_count::int
    FROM conversation_messages message
    JOIN group_memory_extraction_requests request
      ON request.conversation_message_id = message.id
    LEFT JOIN group_memory_extraction_runs run ON run.id = request.run_id
    WHERE message.provider_message_id = $1
    `,
    [providerMessageId],
  );
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : {
        requestStatus: row.request_status,
        skipReason: row.skip_reason,
        runStatus: row.run_status,
        failureClassification: row.failure_classification,
        failureCount: row.failure_count,
      };
}

async function readConversationStateCounts(pool: pg.Pool, groupId: string): Promise<JsonRecord> {
  const result = await pool.query<JsonRecord>(
    `
    SELECT
      (SELECT COUNT(*)::int FROM conversation_messages WHERE chat_id = $1) AS messages,
      (SELECT COUNT(*)::int FROM group_memory_extraction_requests WHERE group_id = $1) AS requests,
      (SELECT COUNT(*)::int FROM group_memory_extraction_runs WHERE group_id = $1) AS runs,
      (SELECT COUNT(*)::int FROM discussion_threads WHERE group_id = $1) AS threads,
      (SELECT COUNT(*)::int FROM discussion_thread_events WHERE group_id = $1) AS "threadEvents",
      (SELECT COUNT(*)::int FROM discussion_thread_evidence WHERE group_id = $1) AS "threadEvidence",
      (SELECT COUNT(*)::int FROM action_items WHERE group_id = $1) AS actions,
      (SELECT COUNT(*)::int FROM action_item_events WHERE group_id = $1) AS "actionEvents",
      (SELECT COUNT(*)::int FROM action_item_event_evidence WHERE group_id = $1) AS "actionEvidence",
      (SELECT COUNT(*)::int FROM conversation_state_operation_claims WHERE group_id = $1) AS "operationClaims"
    `,
    [groupId],
  );
  return requireRecord(result.rows[0], "conversation state counts");
}

async function readProjectionCounts(pool: pg.Pool, groupId: string): Promise<JsonRecord> {
  const counts = await readConversationStateCounts(pool, groupId);
  const { messages: _messages, requests: _requests, runs: _runs, ...projectionCounts } = counts;
  return projectionCounts;
}

function assertCountDeltas(
  actual: JsonRecord,
  before: JsonRecord,
  expectedDeltas: Record<string, number>,
): void {
  for (const [field, expectedDelta] of Object.entries(expectedDeltas)) {
    assert.equal(
      requireNumber(actual[field], `${field} after`),
      requireNumber(before[field], `${field} before`) + expectedDelta,
      `${field} delta`,
    );
  }
}

async function readQueueStatus(baseUrl: string): Promise<QueueStatus> {
  const status = await getJson(baseUrl, "/internal/memory-extraction/status");
  return {
    pendingJobCount: requireNumber(status.pendingJobCount, "pendingJobCount"),
    processingJobCount: requireNumber(status.processingJobCount, "processingJobCount"),
    delayedJobCount: requireNumber(status.delayedJobCount, "delayedJobCount"),
    deadLetterJobCount: requireNumber(status.deadLetterJobCount, "deadLetterJobCount"),
    ...(typeof status.providerCooldownUntil === "string"
      ? { providerCooldownUntil: status.providerCooldownUntil }
      : {}),
  };
}

async function waitForQueuesIdle(baseUrl: string): Promise<void> {
  await waitFor("event and extraction queues to become idle", async () => {
    const [events, extraction] = await Promise.all([
      getJson(baseUrl, "/internal/events/status"),
      readQueueStatus(baseUrl),
    ]);
    return events.pendingEventCount === 0 &&
      extraction.pendingJobCount === 0 &&
      extraction.processingJobCount === 0 &&
      extraction.delayedJobCount === 0;
  });
}

async function readQueuedAttempts(
  redis: ReturnType<typeof createClient>,
): Promise<number[]> {
  const payloads = await redis.hGetAll("iris:memory:extraction:payloads");
  return Object.values(payloads)
    .map((payload) => requireNumber(requireRecord(JSON.parse(payload), "queued job").attempts, "attempts"))
    .sort((left, right) => left - right);
}

async function readDelayedJobs(
  redis: ReturnType<typeof createClient>,
): Promise<JsonRecord[]> {
  const [delayed, payloads] = await Promise.all([
    redis.zRangeWithScores("iris:memory:extraction:delayed", 0, -1),
    redis.hGetAll("iris:memory:extraction:payloads"),
  ]);
  return delayed.map(({ value, score }) => {
    const payload = requireRecord(JSON.parse(requireString(payloads[value], "delayed payload")), "delayed job");
    return {
      idempotencyKey: value,
      score,
      requestId: payload.requestId,
      attempts: payload.attempts,
      notBefore: payload.notBefore,
    };
  });
}

async function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise<string>((resolveCommand, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      if (code === 0) {
        resolveCommand(output);
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim().slice(-2000);
      reject(new Error(`${command} exited with ${String(code)}${detail ? `: ${detail}` : ""}`));
    });
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill();
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(3_000).then(() => false),
  ]);
  if (graceful) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    await runCommand("taskkill", ["/pid", String(child.pid), "/T", "/F"]).catch(() => undefined);
  } else {
    child.kill("SIGKILL");
  }
  await withTimeout(exited, 3_000, "Python worker termination");
}

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result !== undefined && result !== false) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`${label} timed out${detail}`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error(`${label} timed out`);
    }),
  ]);
}

async function cleanupStep(errors: unknown[], step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (error) {
    errors.push(error);
  }
}

function parsePublishedPort(output: string): number {
  const match = /:([0-9]+)\s*$/u.exec(output.trim().split(/\r?\n/u)[0] ?? "");
  const port = Number(match?.[1]);
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65_535, "invalid published port");
  return port;
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function requireRecordArray(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item) => requireRecord(item, label));
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => requireString(item, `${label}[${index}]`));
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function logGate(message: string): void {
  console.log(`[acceptance] ${message}`);
}
