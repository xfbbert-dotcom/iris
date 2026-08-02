import type { FeishuMessageReplier } from "../feishu/feishu-message-replier.js";
import type {
  AnswerReplyDelivery,
  AnswerReplyReceipt,
  AnswerReplyRepository,
} from "./answer-reply-repository.js";
import type { AnswerReplySourceTraceInput } from "./answer-source-citation-renderer.js";
import type {
  AnswerSourcePermissionDecision,
  AnswerSourcePermissionVerifier,
} from "./answer-source-permission-verifier.js";

export const ANSWER_PERMISSION_CHANGED_NOTICE =
  "资料权限已变化，我没有发送原答案。请重新提问。";

export type AnswerReplyDeliveryRequest = {
  provider: "feishu";
  incomingMessageId: string;
  chatId: string;
  replyUuid: string;
  safeNoticeUuid: string;
  prepareAnswer(): Promise<{
    renderedText: string;
    sourceTraces: AnswerReplySourceTraceInput[];
    preparedAt: Date;
  }>;
};

export interface AnswerReplyDeliveryService {
  respond(input: AnswerReplyDeliveryRequest): Promise<{ replyMessageId?: string }>;
}

type AnswerReplyDeliveryServiceDependencies = {
  repository: AnswerReplyRepository;
  verifier: AnswerSourcePermissionVerifier;
  replier: Pick<FeishuMessageReplier, "replyText">;
  now?: () => Date;
};

const DELIVERY_STATES = new Set<AnswerReplyDelivery["state"]>([
  "prepared",
  "sending",
  "sent",
  "permission_blocked",
  "reconciliation_required",
]);
const PERMISSION_OUTCOMES = new Set<AnswerSourcePermissionDecision["outcome"]>([
  "allowed",
  "denied",
  "error",
]);
const SOURCE_TYPES = new Set<AnswerReplyReceipt["sources"][number]["sourceType"]>([
  "feishu_wiki",
  "feishu_group_document",
  "manual_upload",
]);

export function createAnswerReplyDeliveryService({
  repository,
  verifier,
  replier,
  now = () => new Date(),
}: AnswerReplyDeliveryServiceDependencies): AnswerReplyDeliveryService {
  const responseTails = new Map<string, Promise<void>>();

  return {
    respond(input) {
      return serializeResponse(input);
    },
  };

  async function serializeResponse(
    input: AnswerReplyDeliveryRequest,
  ): Promise<{ replyMessageId?: string }> {
    const key = JSON.stringify([input.provider, input.incomingMessageId]);
    const previous = responseTails.get(key) ?? Promise.resolve();
    const response = previous.then(() => respondOnce(input));
    const settled = response.then(() => undefined, () => undefined);
    responseTails.set(key, settled);

    try {
      return await response;
    } finally {
      if (responseTails.get(key) === settled) {
        responseTails.delete(key);
      }
    }
  }

  async function respondOnce(
    input: AnswerReplyDeliveryRequest,
  ): Promise<{ replyMessageId?: string }> {
    const existing = await repository.findByIncomingMessage({
      provider: input.provider,
      incomingMessageId: input.incomingMessageId,
    });
    const receipt = existing === undefined
      ? await prepareReceipt(input)
      : requireReceipt(existing);

    switch (receipt.delivery.state) {
      case "sent":
        return optionalReplyId(receipt.delivery.replyMessageId);
      case "permission_blocked":
      case "reconciliation_required":
        return sendOrResumeSafeNotice(receipt);
      case "prepared":
      case "sending":
        return verifyThenSendPreparedAnswer(receipt);
    }
  }

  async function prepareReceipt(
    input: AnswerReplyDeliveryRequest,
  ): Promise<AnswerReplyReceipt> {
    const prepared = await input.prepareAnswer();
    const result = await repository.prepare({
      provider: input.provider,
      incomingMessageId: input.incomingMessageId,
      chatId: input.chatId,
      replyUuid: input.replyUuid,
      safeNoticeUuid: input.safeNoticeUuid,
      renderedText: prepared.renderedText,
      sourceTraces: prepared.sourceTraces,
      at: prepared.preparedAt,
    });
    return requireReceipt(result.receipt);
  }

  async function verifyThenSendPreparedAnswer(
    receipt: AnswerReplyReceipt,
  ): Promise<{ replyMessageId?: string }> {
    const documentSourceIds = uniqueDocumentSourceIds(receipt);
    const blockedDocumentSourceIds = await findBlockedDocumentSourceIds(
      receipt.delivery.chatId,
      documentSourceIds,
    );

    if (blockedDocumentSourceIds.length > 0) {
      const blocked = requireBlockForPermissionReceipt(
        await repository.blockForPermission({
          deliveryId: receipt.delivery.id,
          expectedVersion: receipt.delivery.version,
          documentSourceIds: blockedDocumentSourceIds,
          at: now(),
        }),
        receipt,
      );
      return sendOrResumeSafeNotice(blocked);
    }

    const sending = requireSendingReceipt(
      await repository.beginAnswerSend({
        deliveryId: receipt.delivery.id,
        expectedVersion: receipt.delivery.version,
        at: now(),
      }),
      receipt,
    );
    const reply = await replier.replyText({
      messageId: sending.delivery.incomingMessageId,
      text: sending.delivery.preparedReplyText!,
      replyInThread: true,
      uuid: sending.delivery.replyUuid,
    });
    const sent = requireSentReceipt(
      await repository.completeAnswerSend({
        deliveryId: sending.delivery.id,
        expectedVersion: sending.delivery.version,
        ...(reply.replyMessageId === undefined
          ? {}
          : { replyMessageId: reply.replyMessageId }),
        at: now(),
      }),
      sending,
      reply.replyMessageId,
    );
    return optionalReplyId(sent.delivery.replyMessageId);
  }

  async function findBlockedDocumentSourceIds(
    chatId: string,
    documentSourceIds: string[],
  ): Promise<string[]> {
    if (documentSourceIds.length === 0) {
      return [];
    }

    let decisions: unknown;
    try {
      decisions = await verifier.verify({ chatId, documentSourceIds });
    } catch {
      return documentSourceIds;
    }

    if (!hasExactPermissionDecisions(decisions, documentSourceIds)) {
      return documentSourceIds;
    }
    return decisions
      .filter(({ outcome }) => outcome !== "allowed")
      .map(({ documentSourceId }) => documentSourceId);
  }

  async function sendOrResumeSafeNotice(
    receipt: AnswerReplyReceipt,
  ): Promise<{ replyMessageId?: string }> {
    requireBlockedState(receipt);
    if (receipt.delivery.safeNoticeSentAt !== undefined) {
      return optionalReplyId(receipt.delivery.safeNoticeMessageId);
    }

    const sending = requireSafeNoticeSendingReceipt(
      await repository.beginSafeNoticeSend({
        deliveryId: receipt.delivery.id,
        expectedVersion: receipt.delivery.version,
        at: now(),
      }),
      receipt,
    );
    const reply = await replier.replyText({
      messageId: sending.delivery.incomingMessageId,
      text: ANSWER_PERMISSION_CHANGED_NOTICE,
      replyInThread: true,
      uuid: sending.delivery.safeNoticeUuid,
    });
    const completed = requireCompletedSafeNoticeReceipt(
      await repository.completeSafeNoticeSend({
        deliveryId: sending.delivery.id,
        expectedVersion: sending.delivery.version,
        ...(reply.replyMessageId === undefined
          ? {}
          : { safeNoticeMessageId: reply.replyMessageId }),
        at: now(),
      }),
      sending,
      reply.replyMessageId,
    );
    return optionalReplyId(completed.delivery.safeNoticeMessageId);
  }
}

function requireReceipt(value: unknown): AnswerReplyReceipt {
  if (
    !isRecord(value)
    || !isRecord(value.delivery)
    || !Array.isArray(value.sources)
    || !Array.isArray(value.events)
  ) {
    throw contractError();
  }

  const delivery = value.delivery;
  if (
    !isRequiredString(delivery.id)
    || delivery.provider !== "feishu"
    || !isRequiredString(delivery.incomingMessageId)
    || !isRequiredString(delivery.chatId)
    || !isRequiredString(delivery.replyUuid)
    || !isRequiredString(delivery.safeNoticeUuid)
    || !isRequiredString(delivery.renderedReplyFingerprint)
    || !isRequiredString(delivery.semanticFingerprint)
    || typeof delivery.state !== "string"
    || !DELIVERY_STATES.has(delivery.state as AnswerReplyDelivery["state"])
    || !isNonnegativeSafeInteger(delivery.version)
    || !isNonnegativeSafeInteger(delivery.attemptCount)
    || !isNonnegativeSafeInteger(delivery.safeNoticeAttemptCount)
    || !isValidDate(delivery.createdAt)
    || !isValidDate(delivery.updatedAt)
  ) {
    throw contractError();
  }

  if (
    (delivery.state === "prepared" || delivery.state === "sending")
    && !isRequiredString(delivery.preparedReplyText)
  ) {
    throw contractError();
  }
  if (!value.sources.every((source) => (
    isRecord(source)
    && isRequiredString(source.id)
    && source.deliveryId === delivery.id
    && isPositiveSafeInteger(source.promptRank)
    && (source.citationRank === undefined || isPositiveSafeInteger(source.citationRank))
    && isRequiredString(source.documentSourceId)
    && isRequiredString(source.documentSnapshotId)
    && isRequiredString(source.fragmentId)
    && isNonnegativeSafeInteger(source.chunkIndex)
    && typeof source.sourceType === "string"
    && SOURCE_TYPES.has(source.sourceType as AnswerReplyReceipt["sources"][number]["sourceType"])
    && isRequiredString(source.sourceUri)
    && (source.sourceTitle === undefined || isRequiredString(source.sourceTitle))
    && isRequiredString(source.contentHash)
    && isRequiredString(source.embeddingProfileId)
    && isValidDate(source.initialPermissionCheckedAt)
  ))) {
    throw contractError();
  }
  if (!value.events.every((event) => (
    isRecord(event)
    && isRequiredString(event.id)
    && event.deliveryId === delivery.id
  ))) {
    throw contractError();
  }

  if (
    delivery.state === "sent"
    && (delivery.preparedReplyText !== undefined || !isValidDate(delivery.sentAt))
  ) {
    throw contractError();
  }
  if (
    delivery.state === "permission_blocked"
    && (
      delivery.preparedReplyText !== undefined
      || !isValidDate(delivery.permissionBlockedAt)
    )
  ) {
    throw contractError();
  }
  if (
    delivery.state === "reconciliation_required"
    && (
      delivery.preparedReplyText !== undefined
      || !isValidDate(delivery.reconciliationRequiredAt)
    )
  ) {
    throw contractError();
  }

  return value as AnswerReplyReceipt;
}

function uniqueDocumentSourceIds(receipt: AnswerReplyReceipt): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const source of receipt.sources) {
    if (!seen.has(source.documentSourceId)) {
      seen.add(source.documentSourceId);
      result.push(source.documentSourceId);
    }
  }
  return result;
}

function hasExactPermissionDecisions(
  value: unknown,
  documentSourceIds: readonly string[],
): value is AnswerSourcePermissionDecision[] {
  return Array.isArray(value)
    && value.length === documentSourceIds.length
    && value.every((decision, index) => (
      isRecord(decision)
      && decision.documentSourceId === documentSourceIds[index]
      && typeof decision.outcome === "string"
      && PERMISSION_OUTCOMES.has(decision.outcome as AnswerSourcePermissionDecision["outcome"])
    ));
}

function requireSendingReceipt(
  value: unknown,
  previous: AnswerReplyReceipt,
): AnswerReplyReceipt {
  const receipt = requireTransitionReceipt(value, previous);
  if (
    receipt.delivery.state !== "sending"
    || receipt.delivery.attemptCount !== previous.delivery.attemptCount + 1
    || receipt.delivery.safeNoticeAttemptCount !== previous.delivery.safeNoticeAttemptCount
    || receipt.delivery.preparedReplyText !== previous.delivery.preparedReplyText
    || receipt.delivery.replyMessageId !== previous.delivery.replyMessageId
    || receipt.delivery.safeNoticeMessageId !== previous.delivery.safeNoticeMessageId
  ) {
    throw contractError();
  }
  return receipt;
}

function requireSentReceipt(
  value: unknown,
  previous: AnswerReplyReceipt,
  replyMessageId: string | undefined,
): AnswerReplyReceipt {
  const receipt = requireTransitionReceipt(value, previous);
  if (
    receipt.delivery.state !== "sent"
    || receipt.delivery.attemptCount !== previous.delivery.attemptCount
    || receipt.delivery.safeNoticeAttemptCount !== previous.delivery.safeNoticeAttemptCount
    || receipt.delivery.preparedReplyText !== undefined
    || receipt.delivery.replyMessageId !== replyMessageId
    || receipt.delivery.safeNoticeMessageId !== previous.delivery.safeNoticeMessageId
    || !isValidDate(receipt.delivery.sentAt)
  ) {
    throw contractError();
  }
  return receipt;
}

function requireBlockForPermissionReceipt(
  value: unknown,
  previous: AnswerReplyReceipt,
): AnswerReplyReceipt {
  const receipt = requireTransitionReceipt(value, previous);
  const expectedState = previous.delivery.attemptCount === 0
    ? "permission_blocked"
    : "reconciliation_required";
  if (
    receipt.delivery.state !== expectedState
    || receipt.delivery.attemptCount !== previous.delivery.attemptCount
    || receipt.delivery.safeNoticeAttemptCount !== previous.delivery.safeNoticeAttemptCount
    || receipt.delivery.preparedReplyText !== undefined
    || receipt.delivery.replyMessageId !== previous.delivery.replyMessageId
    || receipt.delivery.safeNoticeMessageId !== previous.delivery.safeNoticeMessageId
    || (expectedState === "permission_blocked"
      ? !isValidDate(receipt.delivery.permissionBlockedAt)
      : !isValidDate(receipt.delivery.reconciliationRequiredAt))
  ) {
    throw contractError();
  }
  return receipt;
}

function requireSafeNoticeSendingReceipt(
  value: unknown,
  previous: AnswerReplyReceipt,
): AnswerReplyReceipt {
  const receipt = requireTransitionReceipt(value, previous);
  if (
    receipt.delivery.state !== previous.delivery.state
    || (receipt.delivery.state !== "permission_blocked"
      && receipt.delivery.state !== "reconciliation_required")
    || receipt.delivery.attemptCount !== previous.delivery.attemptCount
    || receipt.delivery.safeNoticeAttemptCount
      !== previous.delivery.safeNoticeAttemptCount + 1
    || receipt.delivery.preparedReplyText !== undefined
    || receipt.delivery.replyMessageId !== previous.delivery.replyMessageId
    || receipt.delivery.safeNoticeMessageId !== previous.delivery.safeNoticeMessageId
    || receipt.delivery.safeNoticeSentAt !== undefined
  ) {
    throw contractError();
  }
  return receipt;
}

function requireCompletedSafeNoticeReceipt(
  value: unknown,
  previous: AnswerReplyReceipt,
  safeNoticeMessageId: string | undefined,
): AnswerReplyReceipt {
  const receipt = requireTransitionReceipt(value, previous);
  if (
    receipt.delivery.state !== previous.delivery.state
    || (receipt.delivery.state !== "permission_blocked"
      && receipt.delivery.state !== "reconciliation_required")
    || receipt.delivery.attemptCount !== previous.delivery.attemptCount
    || receipt.delivery.safeNoticeAttemptCount
      !== previous.delivery.safeNoticeAttemptCount
    || receipt.delivery.preparedReplyText !== undefined
    || receipt.delivery.replyMessageId !== previous.delivery.replyMessageId
    || receipt.delivery.safeNoticeMessageId !== safeNoticeMessageId
    || !isValidDate(receipt.delivery.safeNoticeSentAt)
  ) {
    throw contractError();
  }
  return receipt;
}

function requireBlockedState(receipt: AnswerReplyReceipt): void {
  if (
    (receipt.delivery.state !== "permission_blocked"
      && receipt.delivery.state !== "reconciliation_required")
    || receipt.delivery.preparedReplyText !== undefined
  ) {
    throw contractError();
  }
}

function requireTransitionReceipt(
  value: unknown,
  previous: AnswerReplyReceipt,
): AnswerReplyReceipt {
  const receipt = requireReceipt(value);
  if (
    !isSameDelivery(receipt.delivery, previous.delivery)
    || receipt.delivery.version !== previous.delivery.version + 1
    || receipt.delivery.renderedReplyFingerprint
      !== previous.delivery.renderedReplyFingerprint
    || receipt.delivery.semanticFingerprint !== previous.delivery.semanticFingerprint
    || !isSameDate(receipt.delivery.createdAt, previous.delivery.createdAt)
    || !areSourceFactsEqual(receipt.sources, previous.sources)
  ) {
    throw contractError();
  }
  return receipt;
}

function areSourceFactsEqual(
  current: AnswerReplyReceipt["sources"],
  previous: AnswerReplyReceipt["sources"],
): boolean {
  return current.length === previous.length
    && current.every((source, index) => {
      const prior = previous[index];
      return prior !== undefined
        && source.id === prior.id
        && source.deliveryId === prior.deliveryId
        && source.promptRank === prior.promptRank
        && source.citationRank === prior.citationRank
        && source.documentSourceId === prior.documentSourceId
        && source.documentSnapshotId === prior.documentSnapshotId
        && source.fragmentId === prior.fragmentId
        && source.chunkIndex === prior.chunkIndex
        && source.sourceType === prior.sourceType
        && source.sourceUri === prior.sourceUri
        && source.sourceTitle === prior.sourceTitle
        && source.contentHash === prior.contentHash
        && source.embeddingProfileId === prior.embeddingProfileId
        && isSameDate(
          source.initialPermissionCheckedAt,
          prior.initialPermissionCheckedAt,
        );
    });
}

function isSameDelivery(
  current: AnswerReplyDelivery,
  previous: AnswerReplyDelivery,
): boolean {
  return current.id === previous.id
    && current.provider === previous.provider
    && current.incomingMessageId === previous.incomingMessageId
    && current.chatId === previous.chatId
    && current.replyUuid === previous.replyUuid
    && current.safeNoticeUuid === previous.safeNoticeUuid;
}

function optionalReplyId(replyMessageId: string | undefined): { replyMessageId?: string } {
  return replyMessageId === undefined ? {} : { replyMessageId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRequiredString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isSameDate(current: unknown, previous: unknown): boolean {
  return isValidDate(current)
    && isValidDate(previous)
    && current.getTime() === previous.getTime();
}

function contractError(): Error {
  return new Error("answer reply delivery contract invalid");
}
