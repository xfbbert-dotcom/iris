import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

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
type PreparedAnswer = Awaited<
  ReturnType<AnswerReplyDeliveryRequest["prepareAnswer"]>
>;

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
  const activeResponseKeys = new AsyncLocalStorage<ReadonlySet<string>>();

  return {
    respond(input) {
      const key = responseKey(input);
      if (activeResponseKeys.getStore()?.has(key) === true) {
        return Promise.reject(contractError());
      }
      return serializeResponse(input, key);
    },
  };

  async function serializeResponse(
    input: AnswerReplyDeliveryRequest,
    key: string,
  ): Promise<{ replyMessageId?: string }> {
    const previous = responseTails.get(key) ?? Promise.resolve();
    const response = previous.then(() => {
      const keys = new Set(activeResponseKeys.getStore() ?? []);
      keys.add(key);
      return activeResponseKeys.run(keys, () => respondOnce(input));
    });
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
      : requireRequestReceipt(existing, input);

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
    return requirePreparedReceipt(result.receipt, input, prepared);
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
      const at = now();
      const blocked = requireBlockForPermissionReceipt(
        await repository.blockForPermission({
          deliveryId: receipt.delivery.id,
          expectedVersion: receipt.delivery.version,
          documentSourceIds: blockedDocumentSourceIds,
          at,
        }),
        receipt,
        at,
      );
      return sendOrResumeSafeNotice(blocked);
    }

    const beginAt = now();
    const sending = requireSendingReceipt(
      await repository.beginAnswerSend({
        deliveryId: receipt.delivery.id,
        expectedVersion: receipt.delivery.version,
        at: beginAt,
      }),
      receipt,
      beginAt,
    );
    const reply = await replier.replyText({
      messageId: sending.delivery.incomingMessageId,
      text: sending.delivery.preparedReplyText!,
      replyInThread: true,
      uuid: sending.delivery.replyUuid,
    });
    const completeAt = now();
    const sent = requireSentReceipt(
      await repository.completeAnswerSend({
        deliveryId: sending.delivery.id,
        expectedVersion: sending.delivery.version,
        ...(reply.replyMessageId === undefined
          ? {}
          : { replyMessageId: reply.replyMessageId }),
        at: completeAt,
      }),
      sending,
      reply.replyMessageId,
      completeAt,
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

    const beginAt = now();
    const sending = requireSafeNoticeSendingReceipt(
      await repository.beginSafeNoticeSend({
        deliveryId: receipt.delivery.id,
        expectedVersion: receipt.delivery.version,
        at: beginAt,
      }),
      receipt,
      beginAt,
    );
    const reply = await replier.replyText({
      messageId: sending.delivery.incomingMessageId,
      text: ANSWER_PERMISSION_CHANGED_NOTICE,
      replyInThread: true,
      uuid: sending.delivery.safeNoticeUuid,
    });
    const completeAt = now();
    const completed = requireCompletedSafeNoticeReceipt(
      await repository.completeSafeNoticeSend({
        deliveryId: sending.delivery.id,
        expectedVersion: sending.delivery.version,
        ...(reply.replyMessageId === undefined
          ? {}
          : { safeNoticeMessageId: reply.replyMessageId }),
        at: completeAt,
      }),
      sending,
      reply.replyMessageId,
      completeAt,
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
    || !isOptionalRequiredString(delivery.replyMessageId)
    || !isOptionalRequiredString(delivery.safeNoticeMessageId)
    || !isOptionalDate(delivery.lastSendStartedAt)
    || !isOptionalDate(delivery.sentAt)
    || !isOptionalDate(delivery.permissionBlockedAt)
    || !isOptionalDate(delivery.reconciliationRequiredAt)
    || !isOptionalDate(delivery.safeNoticeSentAt)
  ) {
    throw contractError();
  }

  if (
    (delivery.state === "prepared" || delivery.state === "sending")
    && (
      !isRequiredString(delivery.preparedReplyText)
      || fingerprint(delivery.preparedReplyText) !== delivery.renderedReplyFingerprint
    )
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

  const receipt = value as AnswerReplyReceipt;
  requireDeliveryLifecycle(receipt.delivery);
  return receipt;
}

function requireRequestReceipt(
  value: unknown,
  input: AnswerReplyDeliveryRequest,
): AnswerReplyReceipt {
  const receipt = requireReceipt(value);
  if (
    receipt.delivery.provider !== input.provider
    || receipt.delivery.incomingMessageId !== input.incomingMessageId
  ) {
    throw contractError();
  }
  return receipt;
}

function requirePreparedReceipt(
  value: unknown,
  input: AnswerReplyDeliveryRequest,
  prepared: PreparedAnswer,
): AnswerReplyReceipt {
  const receipt = requireRequestReceipt(value, input);
  if (
    receipt.delivery.chatId !== input.chatId
    || receipt.delivery.replyUuid !== input.replyUuid
    || receipt.delivery.safeNoticeUuid !== input.safeNoticeUuid
    || receipt.delivery.renderedReplyFingerprint !== fingerprint(prepared.renderedText)
    || (
      receipt.delivery.preparedReplyText !== undefined
      && receipt.delivery.preparedReplyText !== prepared.renderedText
    )
    || !arePreparedSourceFactsEqual(receipt.sources, prepared.sourceTraces)
  ) {
    throw contractError();
  }
  return receipt;
}

function arePreparedSourceFactsEqual(
  current: AnswerReplyReceipt["sources"],
  prepared: readonly AnswerReplySourceTraceInput[],
): boolean {
  return current.length === prepared.length
    && current.every((source, index) => {
      const expected = prepared[index];
      return expected !== undefined
        && source.promptRank === expected.promptRank
        && source.citationRank === expected.citationRank
        && source.documentSourceId === expected.documentSourceId
        && source.documentSnapshotId === expected.documentSnapshotId
        && source.fragmentId === expected.fragmentId
        && source.chunkIndex === expected.chunkIndex
        && source.sourceType === expected.sourceType
        && source.sourceUri === expected.sourceUri
        && source.sourceTitle === expected.sourceTitle
        && source.contentHash === expected.contentHash
        && source.embeddingProfileId === expected.embeddingProfileId
        && isSameDate(
          source.initialPermissionCheckedAt,
          expected.initialPermissionCheckedAt,
        );
    });
}

function requireDeliveryLifecycle(delivery: AnswerReplyDelivery): void {
  const lifecycleDates = [
    delivery.lastSendStartedAt,
    delivery.sentAt,
    delivery.permissionBlockedAt,
    delivery.reconciliationRequiredAt,
    delivery.safeNoticeSentAt,
  ];
  if (
    delivery.version < 1
    || delivery.createdAt.getTime() > delivery.updatedAt.getTime()
    || lifecycleDates.some((at) => at !== undefined && (
      at.getTime() < delivery.createdAt.getTime()
      || at.getTime() > delivery.updatedAt.getTime()
    ))
  ) {
    throw contractError();
  }

  const hasPendingSafeNotice = delivery.safeNoticeAttemptCount > 0;
  const hasCompletedSafeNotice = delivery.safeNoticeSentAt !== undefined;
  if (
    (hasCompletedSafeNotice && !hasPendingSafeNotice)
    || (delivery.safeNoticeMessageId !== undefined && !hasCompletedSafeNotice)
    || (
      hasCompletedSafeNotice
      && !isSameDate(delivery.updatedAt, delivery.safeNoticeSentAt)
    )
  ) {
    throw contractError();
  }

  switch (delivery.state) {
    case "prepared":
      if (
        delivery.attemptCount !== 0
        || delivery.safeNoticeAttemptCount !== 0
        || !isSameDate(delivery.updatedAt, delivery.createdAt)
        || hasAnyLifecycleTimestamp(delivery)
        || delivery.replyMessageId !== undefined
        || delivery.safeNoticeMessageId !== undefined
      ) {
        throw contractError();
      }
      return;
    case "sending":
      if (
        delivery.attemptCount < 1
        || delivery.safeNoticeAttemptCount !== 0
        || !isValidDate(delivery.lastSendStartedAt)
        || !isSameDate(delivery.updatedAt, delivery.lastSendStartedAt)
        || delivery.sentAt !== undefined
        || delivery.permissionBlockedAt !== undefined
        || delivery.reconciliationRequiredAt !== undefined
        || delivery.safeNoticeSentAt !== undefined
        || delivery.replyMessageId !== undefined
        || delivery.safeNoticeMessageId !== undefined
      ) {
        throw contractError();
      }
      return;
    case "sent":
      if (
        delivery.preparedReplyText !== undefined
        || delivery.attemptCount < 1
        || delivery.safeNoticeAttemptCount !== 0
        || !isValidDate(delivery.lastSendStartedAt)
        || !isValidDate(delivery.sentAt)
        || !isSameDate(delivery.updatedAt, delivery.sentAt)
        || delivery.permissionBlockedAt !== undefined
        || delivery.reconciliationRequiredAt !== undefined
        || delivery.safeNoticeSentAt !== undefined
        || delivery.safeNoticeMessageId !== undefined
      ) {
        throw contractError();
      }
      return;
    case "permission_blocked":
      if (
        delivery.preparedReplyText !== undefined
        || delivery.attemptCount !== 0
        || !isValidDate(delivery.permissionBlockedAt)
        || delivery.lastSendStartedAt !== undefined
        || delivery.sentAt !== undefined
        || delivery.reconciliationRequiredAt !== undefined
        || delivery.replyMessageId !== undefined
        || (
          delivery.safeNoticeAttemptCount === 0
          && !isSameDate(delivery.updatedAt, delivery.permissionBlockedAt)
        )
      ) {
        throw contractError();
      }
      return;
    case "reconciliation_required":
      if (
        delivery.preparedReplyText !== undefined
        || delivery.attemptCount < 1
        || !isValidDate(delivery.lastSendStartedAt)
        || !isValidDate(delivery.reconciliationRequiredAt)
        || delivery.sentAt !== undefined
        || delivery.permissionBlockedAt !== undefined
        || delivery.replyMessageId !== undefined
        || (
          delivery.safeNoticeAttemptCount === 0
          && !isSameDate(delivery.updatedAt, delivery.reconciliationRequiredAt)
        )
      ) {
        throw contractError();
      }
  }
}

function hasAnyLifecycleTimestamp(delivery: AnswerReplyDelivery): boolean {
  return delivery.lastSendStartedAt !== undefined
    || delivery.sentAt !== undefined
    || delivery.permissionBlockedAt !== undefined
    || delivery.reconciliationRequiredAt !== undefined
    || delivery.safeNoticeSentAt !== undefined;
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
  at: Date,
): AnswerReplyReceipt {
  const receipt = requireTransitionReceipt(value, previous, at);
  if (
    receipt.delivery.state !== "sending"
    || receipt.delivery.attemptCount !== previous.delivery.attemptCount + 1
    || receipt.delivery.safeNoticeAttemptCount !== previous.delivery.safeNoticeAttemptCount
    || receipt.delivery.preparedReplyText !== previous.delivery.preparedReplyText
    || receipt.delivery.replyMessageId !== previous.delivery.replyMessageId
    || receipt.delivery.safeNoticeMessageId !== previous.delivery.safeNoticeMessageId
    || !isSameDate(receipt.delivery.lastSendStartedAt, at)
    || !isSameOptionalDate(receipt.delivery.sentAt, previous.delivery.sentAt)
    || !isSameOptionalDate(
      receipt.delivery.permissionBlockedAt,
      previous.delivery.permissionBlockedAt,
    )
    || !isSameOptionalDate(
      receipt.delivery.reconciliationRequiredAt,
      previous.delivery.reconciliationRequiredAt,
    )
    || !isSameOptionalDate(
      receipt.delivery.safeNoticeSentAt,
      previous.delivery.safeNoticeSentAt,
    )
  ) {
    throw contractError();
  }
  return receipt;
}

function requireSentReceipt(
  value: unknown,
  previous: AnswerReplyReceipt,
  replyMessageId: string | undefined,
  at: Date,
): AnswerReplyReceipt {
  const receipt = requireTransitionReceipt(value, previous, at);
  if (
    receipt.delivery.state !== "sent"
    || receipt.delivery.attemptCount !== previous.delivery.attemptCount
    || receipt.delivery.safeNoticeAttemptCount !== previous.delivery.safeNoticeAttemptCount
    || receipt.delivery.preparedReplyText !== undefined
    || receipt.delivery.replyMessageId !== replyMessageId
    || receipt.delivery.safeNoticeMessageId !== previous.delivery.safeNoticeMessageId
    || !isSameOptionalDate(
      receipt.delivery.lastSendStartedAt,
      previous.delivery.lastSendStartedAt,
    )
    || !isSameDate(receipt.delivery.sentAt, at)
    || !isSameOptionalDate(
      receipt.delivery.permissionBlockedAt,
      previous.delivery.permissionBlockedAt,
    )
    || !isSameOptionalDate(
      receipt.delivery.reconciliationRequiredAt,
      previous.delivery.reconciliationRequiredAt,
    )
    || !isSameOptionalDate(
      receipt.delivery.safeNoticeSentAt,
      previous.delivery.safeNoticeSentAt,
    )
  ) {
    throw contractError();
  }
  return receipt;
}

function requireBlockForPermissionReceipt(
  value: unknown,
  previous: AnswerReplyReceipt,
  at: Date,
): AnswerReplyReceipt {
  const receipt = requireTransitionReceipt(value, previous, at);
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
    || !isSameOptionalDate(
      receipt.delivery.lastSendStartedAt,
      previous.delivery.lastSendStartedAt,
    )
    || !isSameOptionalDate(receipt.delivery.sentAt, previous.delivery.sentAt)
    || !isSameOptionalDate(
      receipt.delivery.safeNoticeSentAt,
      previous.delivery.safeNoticeSentAt,
    )
    || (expectedState === "permission_blocked"
      ? !isSameDate(receipt.delivery.permissionBlockedAt, at)
        || !isSameOptionalDate(
          receipt.delivery.reconciliationRequiredAt,
          previous.delivery.reconciliationRequiredAt,
        )
      : !isSameDate(receipt.delivery.reconciliationRequiredAt, at)
        || !isSameOptionalDate(
          receipt.delivery.permissionBlockedAt,
          previous.delivery.permissionBlockedAt,
        ))
  ) {
    throw contractError();
  }
  return receipt;
}

function requireSafeNoticeSendingReceipt(
  value: unknown,
  previous: AnswerReplyReceipt,
  at: Date,
): AnswerReplyReceipt {
  const receipt = requireTransitionReceipt(value, previous, at);
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
    || !hasSameAnswerLifecycle(receipt.delivery, previous.delivery)
    || !isSameOptionalDate(
      receipt.delivery.permissionBlockedAt,
      previous.delivery.permissionBlockedAt,
    )
    || !isSameOptionalDate(
      receipt.delivery.reconciliationRequiredAt,
      previous.delivery.reconciliationRequiredAt,
    )
  ) {
    throw contractError();
  }
  return receipt;
}

function requireCompletedSafeNoticeReceipt(
  value: unknown,
  previous: AnswerReplyReceipt,
  safeNoticeMessageId: string | undefined,
  at: Date,
): AnswerReplyReceipt {
  const receipt = requireTransitionReceipt(value, previous, at);
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
    || !isSameDate(receipt.delivery.safeNoticeSentAt, at)
    || !hasSameAnswerLifecycle(receipt.delivery, previous.delivery)
    || !isSameOptionalDate(
      receipt.delivery.permissionBlockedAt,
      previous.delivery.permissionBlockedAt,
    )
    || !isSameOptionalDate(
      receipt.delivery.reconciliationRequiredAt,
      previous.delivery.reconciliationRequiredAt,
    )
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
  at: Date,
): AnswerReplyReceipt {
  const receipt = requireReceipt(value);
  if (
    !isSameDelivery(receipt.delivery, previous.delivery)
    || receipt.delivery.version !== previous.delivery.version + 1
    || receipt.delivery.renderedReplyFingerprint
      !== previous.delivery.renderedReplyFingerprint
    || receipt.delivery.semanticFingerprint !== previous.delivery.semanticFingerprint
    || !isSameDate(receipt.delivery.createdAt, previous.delivery.createdAt)
    || !isSameDate(receipt.delivery.updatedAt, at)
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

function hasSameAnswerLifecycle(
  current: AnswerReplyDelivery,
  previous: AnswerReplyDelivery,
): boolean {
  return isSameOptionalDate(current.lastSendStartedAt, previous.lastSendStartedAt)
    && isSameOptionalDate(current.sentAt, previous.sentAt);
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

function responseKey(input: AnswerReplyDeliveryRequest): string {
  return JSON.stringify([input.provider, input.incomingMessageId]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRequiredString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalRequiredString(value: unknown): value is string | undefined {
  return value === undefined || isRequiredString(value);
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

function isOptionalDate(value: unknown): value is Date | undefined {
  return value === undefined || isValidDate(value);
}

function isSameDate(current: unknown, previous: unknown): boolean {
  return isValidDate(current)
    && isValidDate(previous)
    && current.getTime() === previous.getTime();
}

function isSameOptionalDate(current: unknown, previous: unknown): boolean {
  return current === undefined
    ? previous === undefined
    : previous !== undefined && isSameDate(current, previous);
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function contractError(): Error {
  return new Error("answer reply delivery contract invalid");
}
