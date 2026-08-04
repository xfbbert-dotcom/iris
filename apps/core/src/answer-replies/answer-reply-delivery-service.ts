import { AsyncLocalStorage } from "node:async_hooks";

import type { FeishuMessageReplier } from "../feishu/feishu-message-replier.js";
import type {
  AnswerReplyDelivery,
  AnswerReplyDeliveryEvent,
  AnswerReplyReceipt,
  AnswerReplyRepository,
} from "./answer-reply-repository.js";
import {
  createAnswerReplyDeliveryId,
  createAnswerReplySafeNoticeUuid,
  createAnswerReplyUuid,
} from "./answer-reply-repository.js";
import {
  createAnswerReplyEventId,
  createAnswerReplyRenderedFingerprint,
  createAnswerReplySemanticFingerprint,
  requireValidAnswerReplyReceipt,
} from "./answer-reply-receipt-validator.js";
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
  inspectPromptPermissions(): Promise<{
    blockedDocumentSourceIds: readonly string[];
    checkedAt: Date;
  }>;
  prepareAnswer(): Promise<{
    renderedText: string;
    sourceTraces: AnswerReplySourceTraceInput[];
    blockedDocumentSourceIds?: readonly string[];
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
  const responseTails = new Map<string, Promise<void>>();
  const invocationContext = new AsyncLocalStorage<ReadonlyMap<string, symbol>>();
  const activeInvocationTokens = new Set<symbol>();

  return {
    respond(input) {
      const key = responseKey(input);
      const inheritedToken = invocationContext.getStore()?.get(key);
      if (inheritedToken !== undefined && activeInvocationTokens.has(inheritedToken)) {
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
    const response = previous.then(async () => {
      const token = Symbol(key);
      const context = new Map(invocationContext.getStore() ?? []);
      context.set(key, token);
      activeInvocationTokens.add(token);
      try {
        return await invocationContext.run(context, () => respondOnce(input));
      } finally {
        activeInvocationTokens.delete(token);
      }
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
      : await recheckExistingPromptPermissions(
          input,
          requireRequestReceipt(existing, input),
        );

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

  async function recheckExistingPromptPermissions(
    input: AnswerReplyDeliveryRequest,
    receipt: AnswerReplyReceipt,
  ): Promise<AnswerReplyReceipt> {
    if (receipt.delivery.state !== "prepared") {
      return receipt;
    }

    const inspection = await input.inspectPromptPermissions();
    if (
      !isRecord(inspection)
      || !(inspection.checkedAt instanceof Date)
      || !Number.isFinite(inspection.checkedAt.getTime())
    ) {
      throw contractError();
    }
    const blockedDocumentSourceIds = normalizeInspectedBlockedDocumentSourceIds(
      inspection.blockedDocumentSourceIds,
    );
    if (blockedDocumentSourceIds.length === 0) {
      return receipt;
    }

    const authoritativeDocumentSourceIds = new Set(
      receipt.sources.map(({ documentSourceId }) => documentSourceId),
    );
    const tracedBlockedDocumentSourceIds = blockedDocumentSourceIds.filter(
      (documentSourceId) => authoritativeDocumentSourceIds.has(documentSourceId),
    );
    if (tracedBlockedDocumentSourceIds.length > 0) {
      return requireBlockForPermissionReceipt(
        await repository.blockForPermission({
          deliveryId: receipt.delivery.id,
          expectedVersion: receipt.delivery.version,
          documentSourceIds: tracedBlockedDocumentSourceIds,
          at: inspection.checkedAt,
        }),
        receipt,
        inspection.checkedAt,
        tracedBlockedDocumentSourceIds,
      );
    }

    if (receipt.delivery.preparedReplyText === undefined) {
      throw contractError();
    }
    const prepared: PreparedAnswer = {
      renderedText: receipt.delivery.preparedReplyText,
      sourceTraces: toPreparedSourceTraceInputs(receipt),
      blockedDocumentSourceIds,
      preparedAt: inspection.checkedAt,
    };
    const result: unknown = await repository.prepare({
      provider: input.provider,
      incomingMessageId: input.incomingMessageId,
      chatId: input.chatId,
      replyUuid: input.replyUuid,
      safeNoticeUuid: input.safeNoticeUuid,
      renderedText: prepared.renderedText,
      sourceTraces: prepared.sourceTraces,
      blockedDocumentSourceIds,
      at: prepared.preparedAt,
    });
    if (
      !isRecord(result)
      || (result.outcome !== "applied" && result.outcome !== "already_applied")
      || !("receipt" in result)
    ) {
      throw contractError();
    }
    return requirePreparedReceipt(result.receipt, result.outcome, input, prepared);
  }

  async function prepareReceipt(
    input: AnswerReplyDeliveryRequest,
  ): Promise<AnswerReplyReceipt> {
    const preparedCandidate = await input.prepareAnswer();
    const blockedDocumentSourceIds = normalizePreflightBlockedDocumentSourceIds(
      preparedCandidate.blockedDocumentSourceIds,
      preparedCandidate.sourceTraces,
    );
    const prepared: PreparedAnswer = {
      ...preparedCandidate,
      ...(blockedDocumentSourceIds.length === 0 ? {} : { blockedDocumentSourceIds }),
    };
    const result: unknown = await repository.prepare({
      provider: input.provider,
      incomingMessageId: input.incomingMessageId,
      chatId: input.chatId,
      replyUuid: input.replyUuid,
      safeNoticeUuid: input.safeNoticeUuid,
      renderedText: prepared.renderedText,
      sourceTraces: prepared.sourceTraces,
      ...(blockedDocumentSourceIds.length === 0 ? {} : { blockedDocumentSourceIds }),
      at: prepared.preparedAt,
    });
    if (
      !isRecord(result)
      || (result.outcome !== "applied" && result.outcome !== "already_applied")
      || !("receipt" in result)
    ) {
      throw contractError();
    }
    return requirePreparedReceipt(result.receipt, result.outcome, input, prepared);
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
        blockedDocumentSourceIds,
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
  try {
    return requireValidAnswerReplyReceipt(value);
  } catch {
    throw contractError();
  }
}

function requireRequestReceipt(
  value: unknown,
  input: AnswerReplyDeliveryRequest,
): AnswerReplyReceipt {
  const receipt = requireReceipt(value);
  const expectedDeliveryId = createAnswerReplyDeliveryId(
    input.provider,
    input.incomingMessageId,
  );
  const expectedReplyUuid = createAnswerReplyUuid(input.incomingMessageId);
  const expectedSafeNoticeUuid = createAnswerReplySafeNoticeUuid(input.incomingMessageId);
  if (
    receipt.delivery.provider !== input.provider
    || receipt.delivery.incomingMessageId !== input.incomingMessageId
    || receipt.delivery.chatId !== input.chatId
    || receipt.delivery.id !== expectedDeliveryId
    || input.replyUuid !== expectedReplyUuid
    || receipt.delivery.replyUuid !== expectedReplyUuid
    || input.safeNoticeUuid !== expectedSafeNoticeUuid
    || receipt.delivery.safeNoticeUuid !== expectedSafeNoticeUuid
  ) {
    throw contractError();
  }
  return receipt;
}

function requirePreparedReceipt(
  value: unknown,
  outcome: "applied" | "already_applied",
  input: AnswerReplyDeliveryRequest,
  prepared: PreparedAnswer,
): AnswerReplyReceipt {
  const receipt = requireRequestReceipt(value, input);
  const renderedReplyFingerprint = createAnswerReplyRenderedFingerprint(
    prepared.renderedText,
  );
  const semanticFingerprint = createAnswerReplySemanticFingerprint({
    provider: input.provider,
    incomingMessageId: input.incomingMessageId,
    chatId: input.chatId,
    renderedReplyFingerprint,
    sourceTraces: prepared.sourceTraces,
  });
  const blockedDocumentSourceIds = prepared.blockedDocumentSourceIds ?? [];
  const permissionEvent = receipt.events.find(
    ({ eventType }) => eventType === "permission_blocked",
  );
  const blockedReceiptMatches = blockedDocumentSourceIds.length === 0
    || receipt.delivery.state === "permission_blocked"
      && receipt.delivery.version >= 2
      && receipt.delivery.preparedReplyText === undefined
      && receipt.delivery.attemptCount === 0
      && receipt.delivery.permissionBlockedAt !== undefined
      && permissionEvent !== undefined
      && areStringArraysEqual(
        permissionEvent.documentSourceIds,
        blockedDocumentSourceIds,
      );
  const appliedReceiptMatches = blockedDocumentSourceIds.length === 0
    ? receipt.delivery.state === "prepared"
      && receipt.delivery.version === 1
      && receipt.delivery.preparedReplyText === prepared.renderedText
      && isSameDate(receipt.delivery.createdAt, prepared.preparedAt)
      && isSameDate(receipt.delivery.updatedAt, prepared.preparedAt)
      && receipt.events.length === 1
      && receipt.events[0]?.eventType === "prepared"
      && isSameDate(receipt.events[0].createdAt, prepared.preparedAt)
    : blockedReceiptMatches
      && receipt.delivery.version === 2
      && isSameDate(receipt.delivery.updatedAt, prepared.preparedAt)
      && isSameDate(receipt.delivery.permissionBlockedAt, prepared.preparedAt)
      && receipt.events.length === 2
      && receipt.events[0]?.eventType === "prepared"
      && receipt.events[1]?.eventType === "permission_blocked"
      && isSameDate(receipt.events[0].createdAt, receipt.delivery.createdAt)
      && isSameDate(receipt.events[1].createdAt, prepared.preparedAt);
  if (
    receipt.delivery.renderedReplyFingerprint !== renderedReplyFingerprint
    || receipt.delivery.semanticFingerprint !== semanticFingerprint
    || (
      receipt.delivery.preparedReplyText !== undefined
      && receipt.delivery.preparedReplyText !== prepared.renderedText
    )
    || !arePreparedSourceFactsEqual(receipt.sources, prepared.sourceTraces)
    || !blockedReceiptMatches
    || (outcome === "applied" && !appliedReceiptMatches)
  ) {
    throw contractError();
  }
  return receipt;
}

function normalizePreflightBlockedDocumentSourceIds(
  value: readonly string[] | undefined,
  sourceTraces: readonly AnswerReplySourceTraceInput[],
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 1000 - sourceTraces.length) {
    throw contractError();
  }
  const authoritative = new Set(sourceTraces.map(({ documentSourceId }) => documentSourceId));
  const result = value.map((documentSourceId) => {
    if (
      typeof documentSourceId !== "string"
      || documentSourceId.length < 1
      || documentSourceId.length > 512
      || documentSourceId.trim() !== documentSourceId
      || authoritative.has(documentSourceId)
    ) {
      throw contractError();
    }
    return documentSourceId;
  });
  if (new Set(result).size !== result.length) {
    throw contractError();
  }
  return result;
}

function normalizeInspectedBlockedDocumentSourceIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000) {
    throw contractError();
  }
  const result = value.map((documentSourceId) => {
    if (
      typeof documentSourceId !== "string"
      || documentSourceId.length < 1
      || documentSourceId.length > 512
      || documentSourceId.trim() !== documentSourceId
    ) {
      throw contractError();
    }
    return documentSourceId;
  });
  if (new Set(result).size !== result.length) {
    throw contractError();
  }
  return result;
}

function toPreparedSourceTraceInputs(
  receipt: AnswerReplyReceipt,
): AnswerReplySourceTraceInput[] {
  return receipt.sources.map((source) => ({
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
  }));
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
  const receipt = requireTransitionReceipt(value, previous, {
    eventType: "send_started",
    at,
    attemptNumber: previous.delivery.attemptCount + 1,
    documentSourceIds: uniqueDocumentSourceIds(previous),
  });
  if (receipt.delivery.preparedReplyText !== previous.delivery.preparedReplyText) {
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
  const receipt = requireTransitionReceipt(value, previous, {
    eventType: "sent",
    at,
    documentSourceIds: uniqueDocumentSourceIds(previous),
  });
  if (receipt.delivery.replyMessageId !== replyMessageId) {
    throw contractError();
  }
  return receipt;
}

function requireBlockForPermissionReceipt(
  value: unknown,
  previous: AnswerReplyReceipt,
  at: Date,
  documentSourceIds: readonly string[],
): AnswerReplyReceipt {
  return requireTransitionReceipt(value, previous, {
    eventType: previous.delivery.attemptCount === 0
      ? "permission_blocked"
      : "reconciliation_required",
    at,
    documentSourceIds,
  });
}

function requireSafeNoticeSendingReceipt(
  value: unknown,
  previous: AnswerReplyReceipt,
  at: Date,
): AnswerReplyReceipt {
  return requireTransitionReceipt(value, previous, {
    eventType: "safe_notice_send_started",
    at,
    attemptNumber: previous.delivery.safeNoticeAttemptCount + 1,
    documentSourceIds: uniqueDocumentSourceIds(previous),
  });
}

function requireCompletedSafeNoticeReceipt(
  value: unknown,
  previous: AnswerReplyReceipt,
  safeNoticeMessageId: string | undefined,
  at: Date,
): AnswerReplyReceipt {
  const receipt = requireTransitionReceipt(value, previous, {
    eventType: "safe_notice_sent",
    at,
    documentSourceIds: uniqueDocumentSourceIds(previous),
  });
  if (receipt.delivery.safeNoticeMessageId !== safeNoticeMessageId) {
    throw contractError();
  }
  return receipt;
}

function requireBlockedState(receipt: AnswerReplyReceipt): void {
  if (
    receipt.delivery.state !== "permission_blocked"
    && receipt.delivery.state !== "reconciliation_required"
  ) {
    throw contractError();
  }
}

interface ExpectedTransitionEvent {
  eventType: AnswerReplyDeliveryEvent["eventType"];
  at: Date;
  attemptNumber?: number;
  documentSourceIds: readonly string[];
}

function requireTransitionReceipt(
  value: unknown,
  previous: AnswerReplyReceipt,
  expected: ExpectedTransitionEvent,
): AnswerReplyReceipt {
  const prior = requireReceipt(previous);
  const receipt = requireReceipt(value);
  if (
    !isSameDelivery(receipt.delivery, prior.delivery)
    || receipt.delivery.version !== prior.delivery.version + 1
    || receipt.delivery.renderedReplyFingerprint
      !== prior.delivery.renderedReplyFingerprint
    || receipt.delivery.semanticFingerprint !== prior.delivery.semanticFingerprint
    || !isSameDate(receipt.delivery.createdAt, prior.delivery.createdAt)
    || !areSourceFactsEqual(receipt.sources, prior.sources)
    || receipt.events.length !== prior.events.length + 1
    || !prior.events.every((event, index) => areEventsEqual(receipt.events[index], event))
  ) {
    throw contractError();
  }

  const event = receipt.events.at(-1);
  if (
    event === undefined
    || event.id !== createAnswerReplyEventId(
      prior.delivery.id,
      prior.delivery.version + 1,
    )
    || event.deliveryId !== prior.delivery.id
    || event.sequence !== prior.delivery.version + 1
    || event.eventType !== expected.eventType
    || event.attemptNumber !== expected.attemptNumber
    || event.sourceCount !== prior.sources.length
    || !areStringArraysEqual(event.documentSourceIds, expected.documentSourceIds)
    || !isSameDate(event.createdAt, expected.at)
  ) {
    throw contractError();
  }
  return receipt;
}

function areEventsEqual(
  current: AnswerReplyDeliveryEvent | undefined,
  previous: AnswerReplyDeliveryEvent,
): boolean {
  return current !== undefined
    && current.id === previous.id
    && current.deliveryId === previous.deliveryId
    && current.sequence === previous.sequence
    && current.eventType === previous.eventType
    && current.attemptNumber === previous.attemptNumber
    && current.sourceCount === previous.sourceCount
    && areStringArraysEqual(current.documentSourceIds, previous.documentSourceIds)
    && isSameDate(current.createdAt, previous.createdAt);
}

function areStringArraysEqual(
  current: readonly string[],
  previous: readonly string[],
): boolean {
  return current.length === previous.length
    && current.every((value, index) => value === previous[index]);
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

function responseKey(input: AnswerReplyDeliveryRequest): string {
  return JSON.stringify([input.provider, input.incomingMessageId]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSameDate(current: unknown, previous: unknown): boolean {
  return current instanceof Date
    && previous instanceof Date
    && current.getTime() === previous.getTime();
}

function contractError(): Error {
  return new Error("answer reply delivery contract invalid");
}
