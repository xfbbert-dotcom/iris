import Fastify from "fastify";
import { pathToFileURL } from "node:url";
import {
  createFeishuGateway,
  type FeishuCallbackRequest
} from "./feishu/feishu-gateway.js";
import { readFeishuAuthConfig } from "./config/env.js";
import { createFeishuRequestVerifier } from "./feishu/feishu-auth.js";
import type { EventQueue } from "./queues/event-queue.js";
import { InMemoryEventQueue } from "./queues/in-memory-event-queue.js";
import type { RawEventQueue } from "./events/raw-event-queue.js";
import type { AnswerDraftOrchestrator } from "./agent/answer-draft-orchestrator.js";
import type { LiveChatMessage } from "./memory/context-assembly.js";
import {
  createAnswerDraftRuntime,
  type AnswerDraftRuntime
} from "./runtime/answer-draft-runtime.js";
import {
  createEventWorkerRuntime,
  type EventWorkerRuntime
} from "./runtime/event-worker-runtime.js";
import {
  createReindexWorkerRuntime,
  type ReindexWorkerRuntime
} from "./runtime/reindex-worker-runtime.js";
import {
  createDocumentSyncRuntime,
  type DocumentSyncRuntime
} from "./runtime/document-sync-runtime.js";

export type BuildAppDependencies = {
  queue?: EventQueue;
  rawEventQueue?: Pick<RawEventQueue, "enqueue">;
  verifyFeishuRequest?: (request: FeishuCallbackRequest) => Promise<boolean> | boolean;
  answerDraftOrchestrator?: Pick<AnswerDraftOrchestrator, "generateDraft">;
  createAnswerDraftRuntime?: () => AnswerDraftRuntime | undefined;
  createEventWorkerRuntime?: () => EventWorkerRuntime | undefined;
  createReindexWorkerRuntime?: () => ReindexWorkerRuntime | undefined;
  createDocumentSyncRuntime?: () => DocumentSyncRuntime | undefined;
};

type ParsedJsonBody = {
  parsedBody: unknown;
  rawBody: string;
};

type AnswerDraftRequest = {
  question: string;
  liveChatMessages: LiveChatMessage[];
  fragmentLimit?: number;
  liveChatLimit?: number;
};

type ReindexDocumentProfileRequest = {
  embeddingProfileId: string;
  limit: number;
};

type ReindexDeadLetterBatchReplayRequest = {
  ids: string[];
};

export function buildApp(dependencies: BuildAppDependencies = {}) {
  const queue = dependencies.queue ?? new InMemoryEventQueue();
  const answerDraftRuntime =
    dependencies.answerDraftOrchestrator === undefined
      ? (dependencies.createAnswerDraftRuntime ?? createAnswerDraftRuntime)()
      : undefined;
  const answerDraftOrchestrator =
    dependencies.answerDraftOrchestrator ?? answerDraftRuntime?.answerDraftOrchestrator;
  const reindexWorkerRuntime =
    (dependencies.createReindexWorkerRuntime ?? createReindexWorkerRuntime)();
  reindexWorkerRuntime?.start();
  const eventWorkerRuntime =
    (dependencies.createEventWorkerRuntime ?? createEventWorkerRuntime)();
  eventWorkerRuntime?.start();
  const documentSyncRuntime =
    (dependencies.createDocumentSyncRuntime ?? createDocumentSyncRuntime)();
  documentSyncRuntime?.start();
  const feishuAuthConfig = readFeishuAuthConfig();
  const verifyFeishuRequest =
    dependencies.verifyFeishuRequest ??
    (feishuAuthConfig.verificationToken || feishuAuthConfig.encryptKey
      ? createFeishuRequestVerifier(feishuAuthConfig)
      : undefined);
  const gateway = createFeishuGateway({
    queue,
    rawEventQueue: dependencies.rawEventQueue,
    verifyRequest: verifyFeishuRequest
  });
  const app = Fastify({ logger: false });

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, payload, done) => {
    const rawBody = typeof payload === "string" ? payload : payload.toString("utf8");
    try {
      done(null, {
        parsedBody: JSON.parse(rawBody),
        rawBody
      });
    } catch (error) {
      done(createBadJsonError());
    }
  });

  app.post("/feishu/events", async (request, reply) => {
    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const rawBody = isParsedJsonBody(request.body) ? request.body.rawBody : undefined;
    const response = await gateway.handleCallback({
      headers: normalizeHeaders(request.headers),
      body,
      rawBody
    });

    return reply.code(response.statusCode).send(response.body);
  });

  app.post("/internal/answer-drafts", async (request, reply) => {
    if (answerDraftOrchestrator === undefined) {
      return reply.code(503).send({
        ok: false,
        error: "answer_draft_orchestrator_unavailable"
      });
    }

    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseAnswerDraftRequest(body);
    if (parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return await answerDraftOrchestrator.generateDraft(parsedRequest);
    } catch {
      return reply.code(500).send({ ok: false, error: "answer_draft_failed" });
    }
  });

  app.post("/internal/reindex/document-profile", async (request, reply) => {
    if (reindexWorkerRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "reindex_worker_unavailable" });
    }

    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseReindexDocumentProfileRequest(
      body,
      reindexWorkerRuntime.activeEmbeddingProfileId,
    );
    if (parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      const result = await reindexWorkerRuntime.planner.planDocumentProfileReindex(parsedRequest);
      return { ok: true, ...result };
    } catch {
      return reply.code(500).send({ ok: false, error: "reindex_plan_failed" });
    }
  });

  app.get("/internal/reindex/status", async (_request, reply) => {
    if (reindexWorkerRuntime === undefined) {
      return { ok: true, enabled: false, running: false };
    }

    try {
      return { ok: true, ...(await reindexWorkerRuntime.getStatus()) };
    } catch {
      return reply.code(500).send({ ok: false, error: "reindex_status_failed" });
    }
  });

  app.get("/internal/events/status", async (_request, reply) => {
    if (eventWorkerRuntime === undefined) {
      return { ok: true, enabled: false, running: false };
    }

    try {
      return { ok: true, ...(await eventWorkerRuntime.getStatus()) };
    } catch {
      return reply.code(500).send({ ok: false, error: "event_worker_status_failed" });
    }
  });

  app.get("/internal/document-sync/status", async (_request, reply) => {
    if (documentSyncRuntime === undefined) {
      return { ok: true, enabled: false, running: false };
    }

    try {
      return { ok: true, ...(await documentSyncRuntime.getStatus()) };
    } catch {
      return reply.code(500).send({ ok: false, error: "document_sync_status_failed" });
    }
  });

  app.get("/internal/reindex/dead-letters", async (request, reply) => {
    if (reindexWorkerRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "reindex_worker_unavailable" });
    }

    const limit = parseDeadLetterLimit((request.query as { limit?: unknown }).limit);
    if (limit === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return { ok: true, deadLetters: await reindexWorkerRuntime.deadLetters.list({ limit }) };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "reindex_dead_letter_operation_failed"
      });
    }
  });

  app.post("/internal/reindex/dead-letters/replay", async (request, reply) => {
    if (reindexWorkerRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "reindex_worker_unavailable" });
    }

    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseReindexDeadLetterBatchReplayRequest(body);
    if (parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return { ok: true, ...(await reindexWorkerRuntime.deadLetters.replayBatch(parsedRequest)) };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "reindex_dead_letter_operation_failed"
      });
    }
  });

  app.post("/internal/reindex/dead-letters/:id/replay", async (request, reply) => {
    if (reindexWorkerRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "reindex_worker_unavailable" });
    }

    const id = readNonBlankId((request.params as { id?: unknown }).id);
    if (id === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return { ok: true, status: await reindexWorkerRuntime.deadLetters.replay(id) };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "reindex_dead_letter_operation_failed"
      });
    }
  });

  app.delete("/internal/reindex/dead-letters/:id", async (request, reply) => {
    if (reindexWorkerRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "reindex_worker_unavailable" });
    }

    const id = readNonBlankId((request.params as { id?: unknown }).id);
    if (id === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      return { ok: true, status: await reindexWorkerRuntime.deadLetters.delete(id) };
    } catch {
      return reply.code(500).send({
        ok: false,
        error: "reindex_dead_letter_operation_failed"
      });
    }
  });

  app.get("/health", async () => ({ ok: true, service: "iris-core" }));

  app.addHook("onClose", async () => {
    await documentSyncRuntime?.close();
    await eventWorkerRuntime?.close();
    await reindexWorkerRuntime?.close();
    await answerDraftRuntime?.close();
  });

  return app;
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? String(value[0]) : typeof value === "string" ? value : undefined
    ])
  );
}

function isParsedJsonBody(value: unknown): value is ParsedJsonBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "parsedBody" in value &&
    typeof (value as { rawBody?: unknown }).rawBody === "string"
  );
}

function parseAnswerDraftRequest(value: unknown): AnswerDraftRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const question = typeof value.question === "string" ? value.question.trim() : "";
  if (question.length === 0 || !Array.isArray(value.liveChatMessages)) {
    return undefined;
  }

  const liveChatMessages = value.liveChatMessages.map(parseLiveChatMessage);
  if (liveChatMessages.some((message) => message === undefined)) {
    return undefined;
  }

  if (!isFiniteNumberOrUndefined(value.fragmentLimit) || !isFiniteNumberOrUndefined(value.liveChatLimit)) {
    return undefined;
  }

  return {
    question,
    liveChatMessages: liveChatMessages as LiveChatMessage[],
    ...(value.fragmentLimit === undefined ? {} : { fragmentLimit: value.fragmentLimit }),
    ...(value.liveChatLimit === undefined ? {} : { liveChatLimit: value.liveChatLimit })
  };
}

function parseReindexDocumentProfileRequest(
  value: unknown,
  activeEmbeddingProfileId: string,
): ReindexDocumentProfileRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const embeddingProfileId =
    typeof value.embeddingProfileId === "string" ? value.embeddingProfileId.trim() : "";
  if (embeddingProfileId.length === 0 || embeddingProfileId !== activeEmbeddingProfileId) {
    return undefined;
  }
  if (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit <= 0) {
    return undefined;
  }

  return { embeddingProfileId, limit: value.limit };
}

function parseDeadLetterLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return 20;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }

  return Math.min(parsed, 100);
}

function parseReindexDeadLetterBatchReplayRequest(
  value: unknown,
): ReindexDeadLetterBatchReplayRequest | undefined {
  if (!isRecord(value) || !Array.isArray(value.ids)) {
    return undefined;
  }
  if (value.ids.length === 0 || value.ids.length > 100) {
    return undefined;
  }

  const ids = value.ids.map(readNonBlankId);
  if (ids.some((id) => id === undefined)) {
    return undefined;
  }

  return { ids: ids as string[] };
}

function readNonBlankId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseLiveChatMessage(value: unknown): LiveChatMessage | undefined {
  if (!isRecord(value) || typeof value.speaker !== "string" || typeof value.text !== "string") {
    return undefined;
  }

  const speaker = value.speaker.trim();
  const text = value.text.trim();
  if (speaker.length === 0 || text.length === 0) {
    return undefined;
  }

  return { speaker, text };
}

function isFiniteNumberOrUndefined(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function createBadJsonError(): Error & { statusCode: number } {
  const error = new Error("Invalid JSON");
  return Object.assign(error, { statusCode: 400 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = buildApp();
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
}
