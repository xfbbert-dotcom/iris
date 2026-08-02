import { createHash } from "node:crypto";

import type { AnswerReplySourceTraceInput } from "./answer-source-citation-renderer.js";
import {
  createAnswerReplyDeliveryId,
  createAnswerReplySafeNoticeUuid,
  createAnswerReplyUuid,
  type AnswerReplyDelivery,
  type AnswerReplyDeliveryEventType,
  type AnswerReplyDeliveryState,
  type AnswerReplyProvider,
  type AnswerReplyReceipt,
} from "./answer-reply-repository.js";

const MAX_REFERENCE_CHARS = 512;
const MAX_REPLY_CHARS = 8000;
const MAX_SOURCE_URI_CHARS = 2048;
const MAX_SOURCE_TRACES = 1000;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const DELIVERY_STATES = new Set<AnswerReplyDeliveryState>([
  "prepared",
  "sending",
  "sent",
  "permission_blocked",
  "reconciliation_required",
]);
const EVENT_TYPES = new Set<AnswerReplyDeliveryEventType>([
  "prepared",
  "send_started",
  "sent",
  "permission_blocked",
  "reconciliation_required",
  "safe_notice_send_started",
  "safe_notice_sent",
]);
const SOURCE_TYPES = new Set<AnswerReplyReceipt["sources"][number]["sourceType"]>([
  "feishu_wiki",
  "feishu_group_document",
  "manual_upload",
]);

export function requireValidAnswerReplyReceipt(value: unknown): AnswerReplyReceipt {
  try {
    return validateReceipt(value);
  } catch {
    throw new Error("answer reply receipt invalid");
  }
}

export function createAnswerReplySourceTraceId(
  deliveryId: string,
  promptRank: number,
): string {
  return `answer-reply-source-${sha256(JSON.stringify([deliveryId, promptRank]))}`;
}

export function createAnswerReplyEventId(deliveryId: string, sequence: number): string {
  return `answer-reply-event-${sha256(JSON.stringify([deliveryId, sequence]))}`;
}

export function createAnswerReplyRenderedFingerprint(renderedText: string): string {
  return sha256(renderedText);
}

export function createAnswerReplySemanticFingerprint(input: {
  provider: AnswerReplyProvider;
  incomingMessageId: string;
  chatId: string;
  renderedReplyFingerprint: string;
  sourceTraces: readonly AnswerReplySourceTraceInput[];
}): string {
  return fingerprint({
    provider: input.provider,
    incomingMessageId: input.incomingMessageId,
    chatId: input.chatId,
    renderedReplyFingerprint: input.renderedReplyFingerprint,
    sourceTraces: input.sourceTraces.map((trace) => ({
      promptRank: trace.promptRank,
      citationRank: trace.citationRank,
      documentSourceId: trace.documentSourceId,
      documentSnapshotId: trace.documentSnapshotId,
      fragmentId: trace.fragmentId,
      chunkIndex: trace.chunkIndex,
      sourceType: trace.sourceType,
      sourceUri: trace.sourceUri,
      sourceTitle: trace.sourceTitle,
      contentHash: trace.contentHash,
      embeddingProfileId: trace.embeddingProfileId,
    })),
  });
}

function validateReceipt(value: unknown): AnswerReplyReceipt {
  if (
    !isRecord(value)
    || !isRecord(value.delivery)
    || !Array.isArray(value.sources)
    || value.sources.length > MAX_SOURCE_TRACES
    || !Array.isArray(value.events)
  ) {
    throw new Error();
  }
  const delivery = value.delivery;
  if (
    !isBoundedString(delivery.id, MAX_REFERENCE_CHARS)
    || delivery.provider !== "feishu"
    || !isBoundedString(delivery.incomingMessageId, MAX_REFERENCE_CHARS)
    || !isBoundedString(delivery.chatId, MAX_REFERENCE_CHARS)
    || !isBoundedString(delivery.replyUuid, 50)
    || !isBoundedString(delivery.safeNoticeUuid, 50)
    || typeof delivery.state !== "string"
    || !DELIVERY_STATES.has(delivery.state as AnswerReplyDeliveryState)
    || !isOptionalExactText(delivery.preparedReplyText, MAX_REPLY_CHARS)
    || !isFingerprint(delivery.renderedReplyFingerprint)
    || !isFingerprint(delivery.semanticFingerprint)
    || !isOptionalBoundedString(delivery.replyMessageId, MAX_REFERENCE_CHARS)
    || !isOptionalBoundedString(delivery.safeNoticeMessageId, MAX_REFERENCE_CHARS)
    || !isNonnegativeSafeInteger(delivery.attemptCount)
    || !isNonnegativeSafeInteger(delivery.safeNoticeAttemptCount)
    || !isPositiveSafeInteger(delivery.version)
    || !isValidDate(delivery.createdAt)
    || !isValidDate(delivery.updatedAt)
    || !isOptionalDate(delivery.lastSendStartedAt)
    || !isOptionalDate(delivery.sentAt)
    || !isOptionalDate(delivery.permissionBlockedAt)
    || !isOptionalDate(delivery.reconciliationRequiredAt)
    || !isOptionalDate(delivery.safeNoticeSentAt)
  ) {
    throw new Error();
  }

  const typedDelivery = delivery as AnswerReplyDelivery;
  if (
    typedDelivery.id !== createAnswerReplyDeliveryId(
      typedDelivery.provider,
      typedDelivery.incomingMessageId,
    )
    || typedDelivery.replyUuid !== createAnswerReplyUuid(typedDelivery.incomingMessageId)
    || typedDelivery.safeNoticeUuid
      !== createAnswerReplySafeNoticeUuid(typedDelivery.incomingMessageId)
  ) {
    throw new Error();
  }

  if (!value.sources.every((source, index) => (
    isRecord(source)
    && isBoundedString(source.id, MAX_REFERENCE_CHARS)
    && source.deliveryId === typedDelivery.id
    && source.promptRank === index + 1
    && source.id === createAnswerReplySourceTraceId(typedDelivery.id, index + 1)
    && (source.citationRank === undefined
      || isSafeIntegerBetween(source.citationRank, 1, 3))
    && isBoundedString(source.documentSourceId, MAX_REFERENCE_CHARS)
    && isBoundedString(source.documentSnapshotId, MAX_REFERENCE_CHARS)
    && isBoundedString(source.fragmentId, MAX_REFERENCE_CHARS)
    && isNonnegativeSafeInteger(source.chunkIndex)
    && typeof source.sourceType === "string"
    && SOURCE_TYPES.has(
      source.sourceType as AnswerReplyReceipt["sources"][number]["sourceType"],
    )
    && isBoundedString(source.sourceUri, MAX_SOURCE_URI_CHARS)
    && isOptionalBoundedString(source.sourceTitle, MAX_REFERENCE_CHARS)
    && isFingerprint(source.contentHash)
    && isBoundedString(source.embeddingProfileId, MAX_REFERENCE_CHARS)
    && isValidDate(source.initialPermissionCheckedAt)
  ))) {
    throw new Error();
  }

  if (!value.events.every((event) => {
    if (
      !isRecord(event)
      || !isBoundedString(event.id, MAX_REFERENCE_CHARS)
      || event.deliveryId !== typedDelivery.id
      || !isPositiveSafeInteger(event.sequence)
      || typeof event.eventType !== "string"
      || !EVENT_TYPES.has(event.eventType as AnswerReplyDeliveryEventType)
      || !isNonnegativeSafeInteger(event.sourceCount)
      || !Array.isArray(event.documentSourceIds)
      || event.documentSourceIds.length > MAX_SOURCE_TRACES
      || !event.documentSourceIds.every((item) =>
        isBoundedString(item, MAX_REFERENCE_CHARS))
      || new Set(event.documentSourceIds).size !== event.documentSourceIds.length
      || !isValidDate(event.createdAt)
    ) {
      return false;
    }
    const requiresAttempt = event.eventType === "send_started"
      || event.eventType === "safe_notice_send_started";
    return requiresAttempt
      ? isPositiveSafeInteger(event.attemptNumber)
      : event.attemptNumber === undefined;
  })) {
    throw new Error();
  }

  const receipt = value as AnswerReplyReceipt;
  requireDeliveryContract(receipt.delivery);
  requireFingerprintContract(receipt);
  requireLedgerContract(receipt);
  return receipt;
}

function requireDeliveryContract(delivery: AnswerReplyDelivery): void {
  const timestamps = [
    delivery.lastSendStartedAt,
    delivery.sentAt,
    delivery.permissionBlockedAt,
    delivery.reconciliationRequiredAt,
    delivery.safeNoticeSentAt,
  ].filter((value): value is Date => value !== undefined);
  if (
    delivery.updatedAt.getTime() < delivery.createdAt.getTime()
    || timestamps.some((value) => value.getTime() > delivery.updatedAt.getTime())
    || (delivery.attemptCount === 0) !== (delivery.lastSendStartedAt === undefined)
    || (delivery.safeNoticeMessageId !== undefined && delivery.safeNoticeSentAt === undefined)
    || (delivery.safeNoticeSentAt !== undefined && delivery.safeNoticeAttemptCount === 0)
  ) {
    throw new Error();
  }

  const hasPreparedText = delivery.preparedReplyText !== undefined;
  const isSafeNoticeState = delivery.state === "permission_blocked"
    || delivery.state === "reconciliation_required";
  if (
    !isSafeNoticeState
    && (
      delivery.safeNoticeAttemptCount !== 0
      || delivery.safeNoticeMessageId !== undefined
      || delivery.safeNoticeSentAt !== undefined
    )
  ) {
    throw new Error();
  }

  const validState = delivery.state === "prepared"
    ? hasPreparedText
      && delivery.attemptCount === 0
      && delivery.replyMessageId === undefined
      && delivery.sentAt === undefined
      && delivery.permissionBlockedAt === undefined
      && delivery.reconciliationRequiredAt === undefined
    : delivery.state === "sending"
      ? hasPreparedText
        && delivery.attemptCount > 0
        && delivery.replyMessageId === undefined
        && delivery.sentAt === undefined
        && delivery.permissionBlockedAt === undefined
        && delivery.reconciliationRequiredAt === undefined
      : delivery.state === "sent"
        ? !hasPreparedText
          && delivery.attemptCount > 0
          && delivery.sentAt !== undefined
          && delivery.permissionBlockedAt === undefined
          && delivery.reconciliationRequiredAt === undefined
        : delivery.state === "permission_blocked"
          ? !hasPreparedText
            && delivery.attemptCount === 0
            && delivery.replyMessageId === undefined
            && delivery.sentAt === undefined
            && delivery.permissionBlockedAt !== undefined
            && delivery.reconciliationRequiredAt === undefined
          : !hasPreparedText
            && delivery.attemptCount > 0
            && delivery.replyMessageId === undefined
            && delivery.sentAt === undefined
            && delivery.permissionBlockedAt === undefined
            && delivery.reconciliationRequiredAt !== undefined;
  if (!validState) {
    throw new Error();
  }
}

function requireFingerprintContract(receipt: AnswerReplyReceipt): void {
  const { delivery, sources } = receipt;
  if (
    (
      delivery.preparedReplyText !== undefined
      && createAnswerReplyRenderedFingerprint(delivery.preparedReplyText)
        !== delivery.renderedReplyFingerprint
    )
    || createAnswerReplySemanticFingerprint({
      provider: delivery.provider,
      incomingMessageId: delivery.incomingMessageId,
      chatId: delivery.chatId,
      renderedReplyFingerprint: delivery.renderedReplyFingerprint,
      sourceTraces: sources,
    }) !== delivery.semanticFingerprint
  ) {
    throw new Error();
  }
}

function requireLedgerContract(receipt: AnswerReplyReceipt): void {
  const { delivery, sources, events } = receipt;
  if (events.length !== delivery.version) {
    throw new Error();
  }

  const authoritativeDocumentSourceIds = uniqueDocumentSourceIds(sources);
  let answerAttemptCount = 0;
  let safeNoticeAttemptCount = 0;
  let ledgerState: AnswerReplyDeliveryState | undefined;
  let safeNoticeSent = false;
  let previousEventAt: Date | undefined;
  let lastSendStartedAt: Date | undefined;
  let sentAt: Date | undefined;
  let permissionBlockedAt: Date | undefined;
  let reconciliationRequiredAt: Date | undefined;
  let safeNoticeSentAt: Date | undefined;

  for (const [index, event] of events.entries()) {
    const sequence = index + 1;
    if (
      event.sequence !== sequence
      || event.id !== createAnswerReplyEventId(delivery.id, sequence)
      || event.sourceCount !== sources.length
      || event.createdAt.getTime() < delivery.createdAt.getTime()
      || event.createdAt.getTime() > delivery.updatedAt.getTime()
      || (
        previousEventAt !== undefined
        && event.createdAt.getTime() < previousEventAt.getTime()
      )
    ) {
      throw new Error();
    }

    const isPermissionEvent = event.eventType === "permission_blocked"
      || event.eventType === "reconciliation_required";
    if (
      isPermissionEvent
        ? event.documentSourceIds.length < 1
          || !isTraceOrderedSubset(
            event.documentSourceIds,
            authoritativeDocumentSourceIds,
          )
        : !arraysEqual(event.documentSourceIds, authoritativeDocumentSourceIds)
    ) {
      throw new Error();
    }

    switch (event.eventType) {
      case "prepared":
        if (sequence !== 1 || ledgerState !== undefined) {
          throw new Error();
        }
        ledgerState = "prepared";
        break;
      case "send_started":
        if (
          (ledgerState !== "prepared" && ledgerState !== "sending")
          || safeNoticeSent
        ) {
          throw new Error();
        }
        answerAttemptCount += 1;
        if (event.attemptNumber !== answerAttemptCount) {
          throw new Error();
        }
        ledgerState = "sending";
        lastSendStartedAt = event.createdAt;
        break;
      case "sent":
        if (ledgerState !== "sending" || safeNoticeSent) {
          throw new Error();
        }
        ledgerState = "sent";
        sentAt = event.createdAt;
        break;
      case "permission_blocked":
        if (ledgerState !== "prepared" || answerAttemptCount !== 0 || safeNoticeSent) {
          throw new Error();
        }
        ledgerState = "permission_blocked";
        permissionBlockedAt = event.createdAt;
        break;
      case "reconciliation_required":
        if (ledgerState !== "sending" || answerAttemptCount < 1 || safeNoticeSent) {
          throw new Error();
        }
        ledgerState = "reconciliation_required";
        reconciliationRequiredAt = event.createdAt;
        break;
      case "safe_notice_send_started":
        if (
          (ledgerState !== "permission_blocked"
            && ledgerState !== "reconciliation_required")
          || safeNoticeSent
        ) {
          throw new Error();
        }
        safeNoticeAttemptCount += 1;
        if (event.attemptNumber !== safeNoticeAttemptCount) {
          throw new Error();
        }
        break;
      case "safe_notice_sent":
        if (
          (ledgerState !== "permission_blocked"
            && ledgerState !== "reconciliation_required")
          || safeNoticeAttemptCount < 1
          || safeNoticeSent
        ) {
          throw new Error();
        }
        safeNoticeSent = true;
        safeNoticeSentAt = event.createdAt;
        break;
    }
    previousEventAt = event.createdAt;
  }

  if (
    ledgerState !== delivery.state
    || answerAttemptCount !== delivery.attemptCount
    || safeNoticeAttemptCount !== delivery.safeNoticeAttemptCount
    || safeNoticeSent !== (delivery.safeNoticeSentAt !== undefined)
    || !datesEqual(events[0]?.createdAt, delivery.createdAt)
    || !datesEqual(events.at(-1)?.createdAt, delivery.updatedAt)
    || !datesEqual(lastSendStartedAt, delivery.lastSendStartedAt)
    || !datesEqual(sentAt, delivery.sentAt)
    || !datesEqual(permissionBlockedAt, delivery.permissionBlockedAt)
    || !datesEqual(reconciliationRequiredAt, delivery.reconciliationRequiredAt)
    || !datesEqual(safeNoticeSentAt, delivery.safeNoticeSentAt)
  ) {
    throw new Error();
  }
}

function uniqueDocumentSourceIds(
  traces: readonly Pick<AnswerReplySourceTraceInput, "documentSourceId">[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const trace of traces) {
    if (!seen.has(trace.documentSourceId)) {
      seen.add(trace.documentSourceId);
      result.push(trace.documentSourceId);
    }
  }
  return result;
}

function isTraceOrderedSubset(
  candidate: readonly string[],
  authoritative: readonly string[],
): boolean {
  let authoritativeIndex = 0;
  for (const documentSourceId of candidate) {
    while (
      authoritativeIndex < authoritative.length
      && authoritative[authoritativeIndex] !== documentSourceId
    ) {
      authoritativeIndex += 1;
    }
    if (authoritativeIndex === authoritative.length) {
      return false;
    }
    authoritativeIndex += 1;
  }
  return true;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function datesEqual(left: Date | undefined, right: Date | undefined): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && left.getTime() === right.getTime();
}

function fingerprint(value: unknown): string {
  return sha256(JSON.stringify(canonicalizeFingerprintValue(value)));
}

function canonicalizeFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeFingerprintValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizeFingerprintValue(item)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoundedString(value: unknown, maxChars: number): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maxChars
    && value.trim().length >= 1;
}

function isOptionalBoundedString(value: unknown, maxChars: number): boolean {
  return value === undefined || isBoundedString(value, maxChars);
}

function isOptionalExactText(value: unknown, maxChars: number): boolean {
  return value === undefined || isBoundedString(value, maxChars);
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isSafeIntegerBetween(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value)
    && (value as number) >= minimum
    && (value as number) <= maximum;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isOptionalDate(value: unknown): boolean {
  return value === undefined || isValidDate(value);
}
