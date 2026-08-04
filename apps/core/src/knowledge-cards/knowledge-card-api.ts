import type { FastifyInstance, FastifyReply } from "fastify";

import type { ApprovalInteractionDeadLetter } from "./approval-interaction-queue.js";
import {
  KnowledgeDraftPresentationServiceError,
  presentKnowledgeDraft,
} from "./knowledge-draft-presentation-service.js";
import type { KnowledgeDraftPresentation } from "./knowledge-card-repository.js";
import type { KnowledgeCardRuntime } from "../runtime/knowledge-card-runtime.js";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const MAX_IDENTIFIER_CHARS = 512;

export function registerKnowledgeCardApi(
  app: FastifyInstance,
  runtime: KnowledgeCardRuntime | undefined,
  { now = () => new Date() }: { now?: () => Date } = {},
): void {
  app.post("/feishu/card-actions", async (request, reply) => {
    if (runtime === undefined) {
      return reply.code(200).send(unavailableToast());
    }
    const parsed = readParsedBody(request.body);
    const response = await runtime.gateway.handleCallback({
      headers: normalizeHeaders(request.headers),
      body: parsed.body,
      ...(parsed.rawBody === undefined ? {} : { rawBody: parsed.rawBody }),
    });
    return reply.code(response.statusCode).send(response.body);
  });

  app.post("/internal/knowledge-drafts/:id/presentations", async (request, reply) => {
    if (runtime === undefined) return unavailable(reply);
    const draftId = readIdentifier((request.params as { id?: unknown }).id);
    const input = parseCreatePresentationInput(readParsedBody(request.body).body);
    if (draftId === undefined || input === undefined) return invalid(reply);

    try {
      const result = await presentKnowledgeDraft({
        runtime,
        draftId,
        expectedVersion: input.expectedVersion,
        operationKey: input.operationKey,
        at: now(),
      });
      return {
        ok: true,
        outcome: result.outcome,
        presentation: toPresentationResponse(result.presentation),
      };
    } catch (error) {
      if (error instanceof KnowledgeDraftPresentationServiceError) {
        switch (error.code) {
          case "knowledge_draft_not_found":
            return reply.code(404).send({ ok: false, error: error.code });
          case "iris_runtime_disabled":
            return reply.code(403).send({ ok: false, error: error.code });
          case "knowledge_card_conflict":
          case "knowledge_draft_evidence_invalid":
          case "review_surface_required":
            return reply.code(409).send({ ok: false, error: error.code });
        }
      }
      return reply.code(500).send({ ok: false, error: "knowledge_card_presentation_failed" });
    }
  });

  app.get("/internal/knowledge-drafts/:id/presentations", async (request, reply) => {
    if (runtime === undefined) return unavailable(reply);
    const draftId = readIdentifier((request.params as { id?: unknown }).id);
    const limit = parseListLimit(request.query);
    if (draftId === undefined || limit === undefined) return invalid(reply);
    try {
      const presentations = await runtime.repository.listPresentations({ draftId, limit });
      return { ok: true, presentations: presentations.map(toPresentationResponse) };
    } catch {
      return reply.code(500).send({ ok: false, error: "knowledge_card_list_failed" });
    }
  });

  app.get("/internal/approval-interactions/status", async (_request, reply) => {
    if (runtime === undefined) return unavailable(reply);
    try {
      return { ok: true, ...(await runtime.getStatus()) };
    } catch {
      return reply.code(500).send({ ok: false, error: "approval_interaction_status_failed" });
    }
  });

  app.get("/internal/approval-interactions/dead-letters", async (request, reply) => {
    if (runtime === undefined) return unavailable(reply);
    const limit = parseListLimit(request.query);
    if (limit === undefined) return invalid(reply);
    try {
      const deadLetters = await runtime.deadLetters.list({ limit });
      const proactiveFeedbackDeadLetterCount = deadLetters.filter(
        isProactiveFeedbackDeadLetter,
      ).length;
      return {
        ok: true,
        deadLetters: deadLetters
          .filter((deadLetter) => !isProactiveFeedbackDeadLetter(deadLetter))
          .map(toDeadLetterResponse),
        proactiveFeedbackDeadLetterCount,
      };
    } catch {
      return deadLetterFailure(reply);
    }
  });

  app.post("/internal/approval-interactions/dead-letters/:id/replay", async (request, reply) => {
    if (runtime === undefined) return unavailable(reply);
    const id = readIdentifier((request.params as { id?: unknown }).id);
    if (id === undefined) return invalid(reply);
    try {
      return { ok: true, status: await runtime.deadLetters.replay(id) };
    } catch {
      return deadLetterFailure(reply);
    }
  });

  app.delete("/internal/approval-interactions/dead-letters/:id", async (request, reply) => {
    if (runtime === undefined) return unavailable(reply);
    const id = readIdentifier((request.params as { id?: unknown }).id);
    if (id === undefined) return invalid(reply);
    try {
      return { ok: true, status: await runtime.deadLetters.delete(id) };
    } catch {
      return deadLetterFailure(reply);
    }
  });
}

function parseCreatePresentationInput(value: unknown): {
  expectedVersion: number;
  operationKey: string;
} | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "expectedVersion" || keys[1] !== "operationKey") {
    return undefined;
  }
  if (!Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1) {
    return undefined;
  }
  const operationKey = readIdentifier(value.operationKey);
  return operationKey === undefined
    ? undefined
    : { expectedVersion: Number(value.expectedVersion), operationKey };
}

function parseListLimit(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "limit") || keys.length > 1) return undefined;
  if (value.limit === undefined) return DEFAULT_LIST_LIMIT;
  if (typeof value.limit !== "string" || !/^\d+$/u.test(value.limit)) return undefined;
  const parsed = Number(value.limit);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_LIST_LIMIT
    ? parsed
    : undefined;
}

function toPresentationResponse(presentation: KnowledgeDraftPresentation) {
  return {
    id: presentation.id,
    draftId: presentation.draftId,
    revisionNumber: presentation.revisionNumber,
    draftVersion: presentation.draftVersion,
    chatId: presentation.chatId,
    contentHash: presentation.contentHash,
    state: presentation.state,
    ...(presentation.messageId === undefined ? {} : { messageId: presentation.messageId }),
    createdAt: presentation.createdAt.toISOString(),
    ...(presentation.activatedAt === undefined
      ? {}
      : { activatedAt: presentation.activatedAt.toISOString() }),
    ...(presentation.closedAt === undefined
      ? {}
      : { closedAt: presentation.closedAt.toISOString() }),
    version: presentation.version,
    suggestedPublicationApproved: false,
  };
}

function toDeadLetterResponse(deadLetter: ApprovalInteractionDeadLetter) {
  if (!deadLetter.replayable) {
    const response = {
      id: deadLetter.id,
      replayable: false,
      errorCode: deadLetter.errorCode,
      failedAt: deadLetter.failedAt.toISOString(),
    };
    if (deadLetter.errorCode === "invalid_queue_payload") {
      return {
        ...response,
        payloadDigest: deadLetter.payloadDigest,
        payloadBytes: deadLetter.payloadBytes,
      };
    }
    return {
      ...response,
      attempts: deadLetter.attempts,
    };
  }
  const common = {
    id: deadLetter.id,
    replayable: true,
    errorCode: deadLetter.errorCode,
    failedAt: deadLetter.failedAt.toISOString(),
    kind: deadLetter.job.kind,
    presentationId: deadLetter.job.presentationId,
    action: deadLetter.job.action,
    attempts: deadLetter.job.attempts,
  };
  if (deadLetter.job.kind === "knowledge_draft_confirmation") {
    return {
      ...common,
      kind: deadLetter.job.kind,
      draftId: deadLetter.job.draftId,
      revisionNumber: deadLetter.job.revisionNumber,
      draftVersion: deadLetter.job.draftVersion,
    };
  }
  if (deadLetter.job.kind === "proactive_signal_feedback") {
    return { kind: deadLetter.job.kind };
  }
  return {
    ...common,
    kind: deadLetter.job.kind,
    proposalId: deadLetter.job.proposalId,
    requirementId: deadLetter.job.requirementId,
    proposalVersion: deadLetter.job.proposalVersion,
    subjectRevision: deadLetter.job.subjectRevision,
    subjectVersion: deadLetter.job.subjectVersion,
    targetPolicyVersion: deadLetter.job.targetPolicyVersion,
  };
}

function isProactiveFeedbackDeadLetter(deadLetter: ApprovalInteractionDeadLetter): boolean {
  return deadLetter.replayable && deadLetter.job.kind === "proactive_signal_feedback";
}

function readParsedBody(value: unknown): { body: unknown; rawBody?: string } {
  if (isRecord(value) && "parsedBody" in value && typeof value.rawBody === "string") {
    return { body: value.parsedBody, rawBody: value.rawBody };
  }
  return { body: value };
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : undefined,
    ]),
  );
}

function readIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= MAX_IDENTIFIER_CHARS
    ? normalized
    : undefined;
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ ok: false, error: "knowledge_card_runtime_unavailable" });
}

function invalid(reply: FastifyReply) {
  return reply.code(400).send({ ok: false, error: "invalid_request" });
}

function conflict(reply: FastifyReply) {
  return reply.code(409).send({ ok: false, error: "knowledge_card_conflict" });
}

function deadLetterFailure(reply: FastifyReply) {
  return reply.code(500).send({ ok: false, error: "approval_interaction_dead_letter_operation_failed" });
}

function unavailableToast() {
  return {
    toast: {
      type: "error",
      content: "\u64cd\u4f5c\u672a\u63d0\u4ea4\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
