import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  AnswerReplyReceipt,
  AnswerReplyRepository,
} from "./answer-reply-repository.js";
import { AnswerReplyVersionConflictError } from "./answer-reply-repository.js";
import {
  AnswerReplyNotFoundError,
  AnswerReplyTransitionError,
} from "./postgres-answer-reply-repository.js";

const MAX_INCOMING_MESSAGE_ID_CHARS = 512;
type AnswerReplyOperatorRepository = Pick<
  AnswerReplyRepository,
  "findByIncomingMessage" | "reconcileNotSent"
>;

export function registerAnswerReplyApi(
  app: FastifyInstance,
  repository: AnswerReplyOperatorRepository | undefined,
  options: { now?: () => Date } = {},
): void {
  const now = options.now ?? (() => new Date());
  app.get<{ Params: { provider?: string; incomingMessageId?: string } }>(
    "/internal/answer-replies/:provider/:incomingMessageId",
    (request, reply) => handleFind(request.params, reply, repository),
  );
  app.get<{ Params: { "*": string } }>(
    "/internal/answer-replies/*",
    (request, reply) => handleFind(parseWildcardParams(request.params["*"]), reply, repository),
  );
  app.post<{
    Params: { provider?: string; incomingMessageId?: string };
    Body: unknown;
  }>(
    "/internal/answer-replies/:provider/:incomingMessageId/reconcile-not-sent",
    (request, reply) => handleReconcileNotSent(
      request.params,
      request.body,
      reply,
      repository,
      now,
    ),
  );
}

async function handleReconcileNotSent(
  params: { provider?: string; incomingMessageId?: string },
  rawBody: unknown,
  reply: FastifyReply,
  repository: AnswerReplyOperatorRepository | undefined,
  now: () => Date,
) {
  const input = parseFindInput(params);
  const body = readParsedBody(rawBody);
  const expectedVersion = readExpectedVersion(
    isRecord(body) ? body.expectedVersion : undefined,
  );
  if (input === undefined || expectedVersion === undefined) {
    return invalidRequest(reply);
  }
  if (repository === undefined) {
    return unavailable(reply);
  }

  try {
    const current = await repository.findByIncomingMessage(input);
    if (current === undefined) {
      return notFound(reply);
    }
    const receipt = await repository.reconcileNotSent({
      deliveryId: current.delivery.id,
      expectedVersion,
      at: now(),
    });
    return toResponse(receipt);
  } catch (error) {
    if (
      error instanceof AnswerReplyVersionConflictError
      || error instanceof AnswerReplyTransitionError
    ) {
      return reply.code(409).send({ ok: false, error: "answer_reply_reconciliation_conflict" });
    }
    if (error instanceof AnswerReplyNotFoundError) {
      return notFound(reply);
    }
    return reply.code(500).send({ ok: false, error: "answer_reply_reconciliation_failed" });
  }
}

async function handleFind(
  params: { provider?: string; incomingMessageId?: string },
  reply: FastifyReply,
  repository: Pick<AnswerReplyRepository, "findByIncomingMessage"> | undefined,
) {
  const input = parseFindInput(params);
  if (input === undefined) {
    return invalidRequest(reply);
  }
  if (repository === undefined) {
    return unavailable(reply);
  }

  try {
    const receipt = await repository.findByIncomingMessage(input);
    if (receipt === undefined) {
      return notFound(reply);
    }
    return toResponse(receipt);
  } catch {
    return reply.code(500).send({ ok: false, error: "answer_reply_query_failed" });
  }
}

function parseWildcardParams(value: string): {
  provider?: string;
  incomingMessageId?: string;
} {
  const parts = value.split("/");
  return parts.length === 2
    ? { provider: parts[0], incomingMessageId: parts[1] }
    : {};
}

function parseFindInput(value: {
  provider?: string;
  incomingMessageId?: string;
}): { provider: "feishu"; incomingMessageId: string } | undefined {
  if (value.provider !== "feishu") {
    return undefined;
  }
  const incomingMessageId = readIncomingMessageId(value.incomingMessageId);
  return incomingMessageId === undefined ? undefined : { provider: "feishu", incomingMessageId };
}

function readIncomingMessageId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value === value.trim() && value.length > 0 && value.length <= MAX_INCOMING_MESSAGE_ID_CHARS
    ? value
    : undefined;
}

function readExpectedVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : undefined;
}

function readParsedBody(value: unknown): unknown {
  return isRecord(value) && Object.hasOwn(value, "parsedBody")
    ? value.parsedBody
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toResponse(receipt: AnswerReplyReceipt) {
  return {
    ok: true as const,
    delivery: {
      id: receipt.delivery.id,
      provider: receipt.delivery.provider,
      incomingMessageId: receipt.delivery.incomingMessageId,
      chatId: receipt.delivery.chatId,
      state: receipt.delivery.state,
      renderedReplyFingerprint: receipt.delivery.renderedReplyFingerprint,
      semanticFingerprint: receipt.delivery.semanticFingerprint,
      knowledgeConflictCandidateId: receipt.delivery.knowledgeConflictCandidateId,
      replyMessageId: receipt.delivery.replyMessageId,
      safeNoticeMessageId: receipt.delivery.safeNoticeMessageId,
      attemptCount: receipt.delivery.attemptCount,
      safeNoticeAttemptCount: receipt.delivery.safeNoticeAttemptCount,
      version: receipt.delivery.version,
      createdAt: receipt.delivery.createdAt,
      updatedAt: receipt.delivery.updatedAt,
      sentAt: receipt.delivery.sentAt,
      permissionBlockedAt: receipt.delivery.permissionBlockedAt,
      reconciliationRequiredAt: receipt.delivery.reconciliationRequiredAt,
      safeNoticeSentAt: receipt.delivery.safeNoticeSentAt,
    },
    sources: receipt.sources.map((source) => ({
      id: source.id,
      deliveryId: source.deliveryId,
      promptRank: source.promptRank,
      citationRank: source.citationRank,
      documentSourceId: source.documentSourceId,
      documentSnapshotId: source.documentSnapshotId,
      fragmentId: source.fragmentId,
      chunkIndex: source.chunkIndex,
      sourceType: source.sourceType,
      sourceUri: source.sourceUri,
      sourceTitle: source.sourceTitle,
      contentHash: source.contentHash,
      embeddingProfileId: source.embeddingProfileId,
      initialPermissionCheckedAt: source.initialPermissionCheckedAt,
    })),
    events: receipt.events.map((event) => ({
      id: event.id,
      deliveryId: event.deliveryId,
      sequence: event.sequence,
      eventType: event.eventType,
      attemptNumber: event.attemptNumber,
      sourceCount: event.sourceCount,
      documentSourceIds: event.documentSourceIds,
      createdAt: event.createdAt,
    })),
  };
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({ ok: false, error: "invalid_request" });
}

function unavailable(reply: FastifyReply) {
  return reply.code(404).send({ ok: false, error: "answer_reply_unavailable" });
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ ok: false, error: "answer_reply_not_found" });
}
