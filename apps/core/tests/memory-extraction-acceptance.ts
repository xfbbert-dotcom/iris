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
const acceptedDecision = "The accepted deployment window is Tuesday at 10:00 UTC.";
const otherGroupDecision = "Group B keeps its private launch codename ORCHID-B.";

type JsonRecord = Record<string, unknown>;
type ProviderMode = "success" | "cross_group" | "hold_success" | "rate_limit";

type FakeProvider = {
  baseUrl: string;
  close(): Promise<void>;
  extractionCallCount(): number;
  answerCallCount(): number;
  setSuccess(content: string): void;
  setCrossGroupEvidence(messageId: string): void;
  setRateLimit(): void;
  armHeldSuccess(content: string): {
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

type SuccessRecord = {
  conversationMessageId: string;
  memoryId: string;
  content: string;
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

const projectName = `iris-memory-acceptance-${Date.now()}-${randomUUID().slice(0, 8)}`;
const compose = (...args: string[]) => [
  "compose",
  "-p",
  projectName,
  "-f",
  composeFile,
  ...args,
];

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
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

  app = await buildApp({
    internalApiToken,
    runtimeController,
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

  logGate("1/6 non-mention event reaches memory and evidence atomically");
  fakeProvider.setSuccess(acceptedDecision);
  const eventA = feishuMessageEvent({
    eventId: "acceptance-event-a-1",
    messageId: "acceptance-message-a-1",
    groupId: groupA,
    senderOpenId: "ou_acceptancealice",
    text: "We accepted Tuesday at 10:00 UTC as the deployment window.",
  });
  await postFeishuEvent(coreBaseUrl, eventA);
  const successA = await waitForSuccess(pool, "acceptance-message-a-1");
  assert.equal(successA.content, acceptedDecision);

  logGate("2/6 replay is idempotent");
  const replaySnapshot = await readDataCounts(pool);
  const replayProviderCalls = fakeProvider.extractionCallCount();
  await postFeishuEvent(coreBaseUrl, eventA);
  await waitForQueuesIdle(coreBaseUrl);
  await delay(120);
  assert.deepEqual(await readDataCounts(pool), replaySnapshot);
  assert.equal(fakeProvider.extractionCallCount(), replayProviderCalls);

  fakeProvider.setSuccess(otherGroupDecision);
  await postFeishuEvent(
    coreBaseUrl,
    feishuMessageEvent({
      eventId: "acceptance-event-b-1",
      messageId: "acceptance-message-b-1",
      groupId: groupB,
      senderOpenId: "ou_acceptancebob",
      text: "Our private launch codename remains ORCHID-B.",
    }),
  );
  const successB = await waitForSuccess(pool, "acceptance-message-b-1");

  logGate("3/6 answer draft reads only the current group's memory");
  const answer = await postJson(coreBaseUrl, "/internal/answer-drafts", {
    chatId: groupA,
    question: "What deployment window was accepted?",
    liveChatMessages: [],
    fragmentLimit: 0,
    liveChatLimit: 0,
  });
  const serializedAnswer = JSON.stringify(answer);
  assert.match(serializedAnswer, new RegExp(escapeRegExp(successA.memoryId), "u"));
  assert.match(serializedAnswer, new RegExp(escapeRegExp(acceptedDecision), "u"));
  assert.ok(!serializedAnswer.includes(successB.memoryId));
  assert.ok(!serializedAnswer.includes(otherGroupDecision));
  assert.deepEqual(answer.allowedFragments, []);

  logGate("4/6 disabled-before-apply skips a held response without later backfill");
  fakeProvider.setSuccess("placeholder");
  const beforeDisabled = await readGroupCounts(pool, groupA);
  const held = fakeProvider.armHeldSuccess("This candidate must never be written.");
  await postFeishuEvent(
    coreBaseUrl,
    feishuMessageEvent({
      eventId: "acceptance-event-disabled",
      messageId: "acceptance-message-disabled",
      groupId: groupA,
      senderOpenId: "ou_acceptancealice",
      text: "This message is held while the group is disabled.",
    }),
  );
  await withTimeout(held.entered, 10_000, "held provider request");
  await setGroupEnabled(coreBaseUrl, groupA, false);
  held.release();
  const disabledOutcome = await waitFor("disabled-before-apply outcome", async () => {
    const outcome = await readRunOutcome(pool!, "acceptance-message-disabled");
    return outcome?.requestStatus === "skipped" ? outcome : undefined;
  });
  assert.equal(disabledOutcome.skipReason, "runtime_disabled_before_apply");
  assert.equal(disabledOutcome.runStatus, "completed");
  assert.equal(disabledOutcome.failureClassification, "runtime_disabled_before_apply");
  assert.deepEqual(await readGroupCounts(pool, groupA), beforeDisabled);
  await setGroupEnabled(coreBaseUrl, groupA, true);
  await delay(120);
  assert.deepEqual(await readGroupCounts(pool, groupA), beforeDisabled);

  logGate("5/6 cross-group evidence becomes terminal DLQ without a write");
  const beforeCrossA = await readGroupCounts(pool, groupA);
  const beforeCrossB = await readGroupCounts(pool, groupB);
  fakeProvider.setCrossGroupEvidence(successB.conversationMessageId);
  await postFeishuEvent(
    coreBaseUrl,
    feishuMessageEvent({
      eventId: "acceptance-event-cross",
      messageId: "acceptance-message-cross",
      groupId: groupA,
      senderOpenId: "ou_acceptancealice",
      text: "Attempt to attach evidence from another group.",
    }),
  );
  await waitFor("first invalid-response classification", async () => {
    const outcome = await readRunOutcome(pool!, "acceptance-message-cross");
    return outcome?.failureClassification === "invalid_model_response_retry";
  });
  clock.advance(30_001);
  const terminalOutcome = await waitFor("terminal invalid-response DLQ", async () => {
    const outcome = await readRunOutcome(pool!, "acceptance-message-cross");
    const status = await readQueueStatus(coreBaseUrl);
    return outcome?.failureClassification === "invalid_model_response_terminal" &&
      status.deadLetterJobCount === 1
      ? outcome
      : undefined;
  });
  assert.equal(terminalOutcome.runStatus, "failed");
  assert.ok((terminalOutcome.failureCount ?? 0) >= 2);
  assert.deepEqual(await readGroupCounts(pool, groupA), beforeCrossA);
  assert.deepEqual(await readGroupCounts(pool, groupB), beforeCrossB);
  const deadLetterList = await getJson(
    coreBaseUrl,
    "/internal/memory-extraction/dead-letters?limit=20",
  );
  const deadLetters = requireRecordArray(deadLetterList.deadLetters, "deadLetters");
  assert.equal(deadLetters.length, 1);
  const deadLetterId = requireString(deadLetters[0]?.id, "dead letter id");
  const deleted = await deleteJson(
    coreBaseUrl,
    `/internal/memory-extraction/dead-letters/${encodeURIComponent(deadLetterId)}`,
  );
  assert.equal(deleted.status, "deleted");
  await waitFor("empty memory extraction DLQ", async () =>
    (await readQueueStatus(coreBaseUrl)).deadLetterJobCount === 0,
  );

  logGate("6/6 429 cooldown defers without extra calls or attempts, then drains on clock advance");
  fakeProvider.setRateLimit();
  const callsBeforeRateLimit = fakeProvider.extractionCallCount();
  await postFeishuEvent(
    coreBaseUrl,
    feishuMessageEvent({
      eventId: "acceptance-event-rate-1",
      messageId: "acceptance-message-rate-1",
      groupId: groupA,
      senderOpenId: "ou_acceptancealice",
      text: "Rate-limit acceptance message one.",
    }),
  );
  const firstCooldownStatus = await waitFor("first delayed rate-limit job", async () => {
    const status = await readQueueStatus(coreBaseUrl);
    return status.delayedJobCount === 1 && status.providerCooldownUntil !== undefined
      ? status
      : undefined;
  });
  assert.equal(firstCooldownStatus.pendingJobCount, 0);
  assert.equal(fakeProvider.extractionCallCount(), callsBeforeRateLimit + 1);
  assert.deepEqual(await readQueuedAttempts(redisInspector), [1]);

  const callsDuringCooldown = fakeProvider.extractionCallCount();
  await postFeishuEvent(
    coreBaseUrl,
    feishuMessageEvent({
      eventId: "acceptance-event-rate-2",
      messageId: "acceptance-message-rate-2",
      groupId: groupA,
      senderOpenId: "ou_acceptancealice",
      text: "Rate-limit acceptance message two.",
    }),
  );
  await waitFor("second job deferred by shared cooldown", async () =>
    (await readQueueStatus(coreBaseUrl)).delayedJobCount === 2,
  );
  assert.equal(fakeProvider.extractionCallCount(), callsDuringCooldown);
  assert.deepEqual(await readQueuedAttempts(redisInspector), [0, 1]);
  await delay(120);
  assert.equal(fakeProvider.extractionCallCount(), callsDuringCooldown);
  assert.deepEqual(await readQueuedAttempts(redisInspector), [0, 1]);

  fakeProvider.setSuccess("A rate-limited message was processed after cooldown.");
  clock.advance(61_000);
  await waitFor("rate-limit jobs drain after synthetic clock advance", async () => {
    const status = await readQueueStatus(coreBaseUrl);
    return status.pendingJobCount === 0 &&
      status.processingJobCount === 0 &&
      status.delayedJobCount === 0;
  });
  await waitForQueuesIdle(coreBaseUrl);

  assert.equal(fakeProvider.answerCallCount(), 1);
  const finalEventStatus = await getJson(coreBaseUrl, "/internal/events/status");
  const finalExtractionStatus = await readQueueStatus(coreBaseUrl);
  assert.equal(finalEventStatus.pendingEventCount, 0);
  assert.equal(finalEventStatus.deadLetterEventCount, 0);
  assert.equal(finalExtractionStatus.deadLetterJobCount, 0);

  console.log(
    `[acceptance] PASS: 6 Phase 3B first-slice gates in ${formatSeconds(Date.now() - startedAt)}`,
  );
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
  if (primaryError === undefined && cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "memory extraction acceptance cleanup failed");
  }
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
  let mode: ProviderMode = "success";
  let successContent = acceptedDecision;
  let crossGroupEvidenceId: string | undefined;
  let extractionCalls = 0;
  let answerCalls = 0;
  let heldEntered: (() => void) | undefined;
  let heldRelease: Promise<void> | undefined;
  let releaseHeld: (() => void) | undefined;

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
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
    if (mode === "hold_success") {
      heldEntered?.();
      await heldRelease;
    }
    const selectedEvidenceId = mode === "cross_group"
      ? requireString(crossGroupEvidenceId, "cross-group evidence id")
      : evidenceMessageId;
    const extraction = {
      schema_version: 1,
      run_id: runId,
      candidates: [
        {
          category: "decision",
          content: successContent,
          importance: 4,
          confidence: 0.98,
          evidence_message_ids: [selectedEvidenceId],
          relation: "new",
        },
      ],
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
    setSuccess(content) {
      mode = "success";
      successContent = content;
      crossGroupEvidenceId = undefined;
    },
    setCrossGroupEvidence(messageId) {
      mode = "cross_group";
      successContent = "This cross-group candidate must be rejected.";
      crossGroupEvidenceId = messageId;
    },
    setRateLimit() {
      mode = "rate_limit";
    },
    armHeldSuccess(content) {
      mode = "hold_success";
      successContent = content;
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
  const blocks = content.match(/<message>[\s\S]*?<\/message>/gu) ?? [];
  for (const block of blocks) {
    if (block.includes("<evidence_eligible>true</evidence_eligible>")) {
      return readXmlTag(block, "id");
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
  return spawn(python, ["-m", "iris_worker"], {
    cwd: pythonWorkerDirectory,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
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

async function deleteJson(baseUrl: string, path: string): Promise<JsonRecord> {
  return requestJson(baseUrl, path, { method: "DELETE" });
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

async function waitForSuccess(pool: pg.Pool, providerMessageId: string): Promise<SuccessRecord> {
  return waitFor(`memory extraction success for ${providerMessageId}`, async () => {
    const result = await pool.query<{
      conversation_message_id: string;
      request_status: string;
      run_status: string;
      memory_id: string;
      content: string;
      origin: string;
      created_by: string;
      evidence_count: number;
    }>(
      `
      SELECT
        message.id AS conversation_message_id,
        request.status AS request_status,
        run.status AS run_status,
        memory.id AS memory_id,
        memory.content,
        memory.origin,
        memory.created_by,
        COUNT(evidence.conversation_message_id)::int AS evidence_count
      FROM conversation_messages message
      JOIN group_memory_extraction_requests request
        ON request.conversation_message_id = message.id
      JOIN group_memory_extraction_runs run ON run.id = request.run_id
      JOIN group_memory_message_evidence evidence
        ON evidence.conversation_message_id = message.id
      JOIN group_memories memory ON memory.id = evidence.memory_id
      WHERE message.provider_message_id = $1
      GROUP BY message.id, request.status, run.status, memory.id
      `,
      [providerMessageId],
    );
    const row = result.rows[0];
    if (row === undefined || row.request_status !== "completed" || row.run_status !== "completed") {
      return undefined;
    }
    assert.equal(row.origin, "extractor");
    assert.equal(row.created_by, "memory-extraction-worker");
    assert.ok(row.evidence_count >= 1);
    return {
      conversationMessageId: row.conversation_message_id,
      memoryId: row.memory_id,
      content: row.content,
    };
  });
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

async function readDataCounts(pool: pg.Pool): Promise<JsonRecord> {
  const result = await pool.query<JsonRecord>(`
    SELECT
      (SELECT COUNT(*)::int FROM conversation_messages) AS messages,
      (SELECT COUNT(*)::int FROM group_memory_extraction_requests) AS requests,
      (SELECT COUNT(*)::int FROM group_memory_extraction_runs) AS runs,
      (SELECT COUNT(*)::int FROM group_memories) AS memories,
      (SELECT COUNT(*)::int FROM group_memory_message_evidence) AS evidence
  `);
  return requireRecord(result.rows[0], "data counts");
}

async function readGroupCounts(pool: pg.Pool, groupId: string): Promise<JsonRecord> {
  const result = await pool.query<JsonRecord>(
    `
    SELECT
      (SELECT COUNT(*)::int FROM group_memories WHERE group_id = $1) AS memories,
      (
        SELECT COUNT(*)::int
        FROM group_memory_message_evidence evidence
        JOIN group_memories memory ON memory.id = evidence.memory_id
        WHERE memory.group_id = $1
      ) AS evidence
    `,
    [groupId],
  );
  return requireRecord(result.rows[0], "group counts");
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

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
