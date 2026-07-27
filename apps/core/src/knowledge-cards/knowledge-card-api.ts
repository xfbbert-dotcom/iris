import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";

import { KnowledgeDraftEvidenceError } from "../knowledge-governance/postgres-knowledge-draft-evidence.js";
import type { ApprovalInteractionDeadLetter } from "./approval-interaction-queue.js";
import { renderKnowledgeDraftCard } from "./knowledge-card-renderer.js";
import type { KnowledgeDraftPresentation } from "./knowledge-card-repository.js";
import {
  KnowledgeCardOperationConflictError,
  KnowledgeCardPersistenceConflictError,
} from "./postgres-knowledge-card-repository.js";
import {
  KNOWLEDGE_CARD_TARGET_DISPLAY_NAME,
  type KnowledgeCardRuntime,
} from "../runtime/knowledge-card-runtime.js";

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
      const draft = await runtime.repository.getDraft(draftId);
      if (draft === undefined) {
        return reply.code(404).send({ ok: false, error: "knowledge_draft_not_found" });
      }
      if (draft.sourceGroupId === undefined || !readRuntimeGate(runtime, draft.sourceGroupId)) {
        return reply.code(403).send({ ok: false, error: "iris_runtime_disabled" });
      }
      if (
        draft.version !== input.expectedVersion ||
        draft.currentRevision.revisionNumber !== draft.currentRevisionNumber
      ) {
        return conflict(reply);
      }
      if (!("content" in draft.currentRevision)) {
        return reply.code(409).send({ ok: false, error: "knowledge_draft_evidence_invalid" });
      }

      const at = requireValidDate(now());
      const presentationId = stablePresentationId({
        draftId: draft.id,
        revisionNumber: draft.currentRevisionNumber,
        operationKey: input.operationKey,
      });
      const pendingPresentation: KnowledgeDraftPresentation = {
        id: presentationId,
        draftId: draft.id,
        revisionNumber: draft.currentRevisionNumber,
        draftVersion: draft.version,
        chatId: draft.sourceGroupId,
        contentHash: "0".repeat(64),
        state: "pending_send",
        createdAt: at,
        version: 1,
      };
      const rendered = renderKnowledgeDraftCard({
        draft,
        presentation: pendingPresentation,
        targetDisplayName: KNOWLEDGE_CARD_TARGET_DISPLAY_NAME,
      });
      if (rendered.status === "review_required") {
        return reply.code(409).send({ ok: false, error: "review_surface_required" });
      }

      const existing = await runtime.repository.getPresentation(presentationId);
      if (existing !== undefined) {
        if (!matchesPresentation(existing, pendingPresentation, rendered.contentHash)) {
          return conflict(reply);
        }
        return {
          ok: true,
          outcome: "already_applied",
          presentation: toPresentationResponse(existing),
        };
      }

      let result;
      try {
        result = await runtime.repository.createPresentation({
          id: presentationId,
          draftId: draft.id,
          expectedDraftVersion: draft.version,
          expectedRevisionNumber: draft.currentRevisionNumber,
          chatId: draft.sourceGroupId,
          contentHash: rendered.contentHash,
          operationKey: input.operationKey,
          at,
        });
      } catch (error) {
        if (error instanceof KnowledgeCardOperationConflictError) {
          const concurrent = await runtime.repository.getPresentation(presentationId);
          if (
            concurrent !== undefined &&
            matchesPresentation(concurrent, pendingPresentation, rendered.contentHash)
          ) {
            return {
              ok: true,
              outcome: "already_applied",
              presentation: toPresentationResponse(concurrent),
            };
          }
        }
        throw error;
      }
      return {
        ok: true,
        outcome: result.outcome,
        presentation: toPresentationResponse(result.presentation),
      };
    } catch (error) {
      if (
        error instanceof KnowledgeCardPersistenceConflictError ||
        error instanceof KnowledgeCardOperationConflictError
      ) return conflict(reply);
      if (error instanceof KnowledgeDraftEvidenceError) {
        return reply.code(409).send({ ok: false, error: "knowledge_draft_evidence_invalid" });
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
      return { ok: true, deadLetters: deadLetters.map(toDeadLetterResponse) };
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

function matchesPresentation(
  presentation: KnowledgeDraftPresentation,
  expected: KnowledgeDraftPresentation,
  contentHash: string,
): boolean {
  return presentation.draftId === expected.draftId &&
    presentation.revisionNumber === expected.revisionNumber &&
    presentation.draftVersion === expected.draftVersion &&
    presentation.chatId === expected.chatId &&
    presentation.contentHash === contentHash;
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

function stablePresentationId(input: {
  draftId: string;
  revisionNumber: number;
  operationKey: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 40);
  return `knowledge-card-${digest}`;
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
    return {
      ...common,
      kind: deadLetter.job.kind,
      deliveryId: deadLetter.job.deliveryId,
      candidateIdempotencyKey: deadLetter.job.candidateIdempotencyKey,
      entityVersion: deadLetter.job.entityVersion,
      action: deadLetter.job.action,
    };
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

function readRuntimeGate(runtime: KnowledgeCardRuntime, groupId: string): boolean {
  try {
    return runtime.canUseKnowledgeCards(groupId);
  } catch {
    return false;
  }
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

function requireValidDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("knowledge card API time must be a valid date");
  }
  return new Date(value);
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
