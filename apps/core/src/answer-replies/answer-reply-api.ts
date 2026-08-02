import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  AnswerReplyReceipt,
  AnswerReplyRepository,
} from "./answer-reply-repository.js";

const MAX_INCOMING_MESSAGE_ID_CHARS = 512;

export function registerAnswerReplyApi(
  app: FastifyInstance,
  repository: Pick<AnswerReplyRepository, "findByIncomingMessage"> | undefined,
): void {
  app.get<{ Params: { provider?: string; incomingMessageId?: string } }>(
    "/internal/answer-replies/:provider/:incomingMessageId",
    (request, reply) => handleFind(request.params, reply, repository),
  );
  app.get<{ Params: { "*": string } }>(
    "/internal/answer-replies/*",
    (request, reply) => handleFind(parseWildcardParams(request.params["*"]), reply, repository),
  );
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
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_INCOMING_MESSAGE_ID_CHARS
    ? normalized
    : undefined;
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
