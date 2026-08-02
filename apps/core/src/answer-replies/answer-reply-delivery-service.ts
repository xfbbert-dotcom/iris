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

export function createAnswerReplyDeliveryService({
  repository,
  verifier,
  replier,
  now = () => new Date(),
}: AnswerReplyDeliveryServiceDependencies): AnswerReplyDeliveryService {
  return {
    async respond(input) {
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
    },
  };

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
      const blocked = requireBlockedReceipt(
        await repository.blockForPermission({
          deliveryId: receipt.delivery.id,
          expectedVersion: receipt.delivery.version,
          documentSourceIds: blockedDocumentSourceIds,
          at: now(),
        }),
        receipt.delivery,
      );
      return sendOrResumeSafeNotice(blocked);
    }

    const sending = requireSendingReceipt(
      await repository.beginAnswerSend({
        deliveryId: receipt.delivery.id,
        expectedVersion: receipt.delivery.version,
        at: now(),
      }),
      receipt.delivery,
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
      sending.delivery,
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
    requireBlockedReceipt(receipt, receipt.delivery);
    if (receipt.delivery.safeNoticeSentAt !== undefined) {
      return optionalReplyId(receipt.delivery.safeNoticeMessageId);
    }

    const sending = requireSafeNoticeSendingReceipt(
      await repository.beginSafeNoticeSend({
        deliveryId: receipt.delivery.id,
        expectedVersion: receipt.delivery.version,
        at: now(),
      }),
      receipt.delivery,
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
      sending.delivery,
      reply.replyMessageId,
    );
    return optionalReplyId(completed.delivery.safeNoticeMessageId);
  }
}

function requireReceipt(value: unknown): AnswerReplyReceipt {
  if (!isRecord(value) || !isRecord(value.delivery) || !Array.isArray(value.sources)) {
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
    || typeof delivery.state !== "string"
    || !DELIVERY_STATES.has(delivery.state as AnswerReplyDelivery["state"])
    || !Number.isSafeInteger(delivery.version)
    || (delivery.version as number) < 0
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
    isRecord(source) && isRequiredString(source.documentSourceId)
  ))) {
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
  previous: AnswerReplyDelivery,
): AnswerReplyReceipt {
  const receipt = requireReceipt(value);
  if (
    receipt.delivery.state !== "sending"
    || !isSameDelivery(receipt.delivery, previous)
    || receipt.delivery.preparedReplyText !== previous.preparedReplyText
  ) {
    throw contractError();
  }
  return receipt;
}

function requireSentReceipt(
  value: unknown,
  previous: AnswerReplyDelivery,
  replyMessageId: string | undefined,
): AnswerReplyReceipt {
  const receipt = requireReceipt(value);
  if (
    receipt.delivery.state !== "sent"
    || !isSameDelivery(receipt.delivery, previous)
    || receipt.delivery.replyMessageId !== replyMessageId
  ) {
    throw contractError();
  }
  return receipt;
}

function requireBlockedReceipt(
  value: unknown,
  previous: AnswerReplyDelivery,
): AnswerReplyReceipt {
  const receipt = requireReceipt(value);
  if (
    (receipt.delivery.state !== "permission_blocked"
      && receipt.delivery.state !== "reconciliation_required")
    || !isSameDelivery(receipt.delivery, previous)
  ) {
    throw contractError();
  }
  return receipt;
}

function requireSafeNoticeSendingReceipt(
  value: unknown,
  previous: AnswerReplyDelivery,
): AnswerReplyReceipt {
  const receipt = requireBlockedReceipt(value, previous);
  if (receipt.delivery.safeNoticeSentAt !== undefined) {
    throw contractError();
  }
  return receipt;
}

function requireCompletedSafeNoticeReceipt(
  value: unknown,
  previous: AnswerReplyDelivery,
  safeNoticeMessageId: string | undefined,
): AnswerReplyReceipt {
  const receipt = requireBlockedReceipt(value, previous);
  if (
    !(receipt.delivery.safeNoticeSentAt instanceof Date)
    || receipt.delivery.safeNoticeMessageId !== safeNoticeMessageId
  ) {
    throw contractError();
  }
  return receipt;
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

function contractError(): Error {
  return new Error("answer reply delivery contract invalid");
}
