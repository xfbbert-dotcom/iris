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
import type { AnswerDraftOrchestrator } from "./agent/answer-draft-orchestrator.js";
import type { LiveChatMessage } from "./memory/context-assembly.js";

export type BuildAppDependencies = {
  queue?: EventQueue;
  verifyFeishuRequest?: (request: FeishuCallbackRequest) => Promise<boolean> | boolean;
  answerDraftOrchestrator?: Pick<AnswerDraftOrchestrator, "generateDraft">;
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

export function buildApp(dependencies: BuildAppDependencies = {}) {
  const queue = dependencies.queue ?? new InMemoryEventQueue();
  const feishuAuthConfig = readFeishuAuthConfig();
  const verifyFeishuRequest =
    dependencies.verifyFeishuRequest ??
    (feishuAuthConfig.verificationToken || feishuAuthConfig.encryptKey
      ? createFeishuRequestVerifier(feishuAuthConfig)
      : undefined);
  const gateway = createFeishuGateway({
    queue,
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
    if (dependencies.answerDraftOrchestrator === undefined) {
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
      return await dependencies.answerDraftOrchestrator.generateDraft(parsedRequest);
    } catch {
      return reply.code(500).send({ ok: false, error: "answer_draft_failed" });
    }
  });

  app.get("/health", async () => ({ ok: true, service: "iris-core" }));

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
