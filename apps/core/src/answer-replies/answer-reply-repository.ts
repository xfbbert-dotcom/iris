import { createHash } from "node:crypto";

import type { AnswerReplySourceTraceInput } from "./answer-source-citation-renderer.js";

export type AnswerReplyDeliveryState =
  | "prepared"
  | "sending"
  | "sent"
  | "permission_blocked"
  | "reconciliation_required";

export type AnswerReplyProvider = "feishu";

export type AnswerReplyDelivery = {
  id: string;
  provider: AnswerReplyProvider;
  incomingMessageId: string;
  chatId: string;
  replyUuid: string;
  safeNoticeUuid: string;
  state: AnswerReplyDeliveryState;
  preparedReplyText?: string;
  renderedReplyFingerprint: string;
  semanticFingerprint: string;
  replyMessageId?: string;
  safeNoticeMessageId?: string;
  attemptCount: number;
  safeNoticeAttemptCount: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  lastSendStartedAt?: Date;
  sentAt?: Date;
  permissionBlockedAt?: Date;
  reconciliationRequiredAt?: Date;
  safeNoticeSentAt?: Date;
};

export type AnswerReplySourceTrace = AnswerReplySourceTraceInput & {
  id: string;
  deliveryId: string;
};

export type AnswerReplyDeliveryEventType =
  | "prepared"
  | "send_started"
  | "sent"
  | "permission_blocked"
  | "reconciliation_required"
  | "safe_notice_send_started"
  | "safe_notice_sent";

export type AnswerReplyDeliveryEvent = {
  id: string;
  deliveryId: string;
  sequence: number;
  eventType: AnswerReplyDeliveryEventType;
  attemptNumber?: number;
  sourceCount: number;
  documentSourceIds: string[];
  createdAt: Date;
};

export type AnswerReplyReceipt = {
  delivery: AnswerReplyDelivery;
  sources: AnswerReplySourceTrace[];
  events: AnswerReplyDeliveryEvent[];
};

export type PrepareAnswerReplyInput = {
  provider: AnswerReplyProvider;
  incomingMessageId: string;
  chatId: string;
  replyUuid: string;
  safeNoticeUuid: string;
  renderedText: string;
  sourceTraces: readonly AnswerReplySourceTraceInput[];
  at: Date;
};

export type VersionedTransitionInput = {
  deliveryId: string;
  expectedVersion: number;
  at: Date;
};

export type AnswerReplyRepositoryStatus = {
  unresolvedCount: number;
  pendingSafeNoticeCount: number;
  reconciliationRequiredCount: number;
};

export interface AnswerReplyRepository {
  findByIncomingMessage(input: {
    provider: AnswerReplyProvider;
    incomingMessageId: string;
  }): Promise<AnswerReplyReceipt | undefined>;
  prepare(input: PrepareAnswerReplyInput): Promise<{
    outcome: "applied" | "already_applied";
    receipt: AnswerReplyReceipt;
  }>;
  beginAnswerSend(input: VersionedTransitionInput): Promise<AnswerReplyReceipt>;
  completeAnswerSend(input: VersionedTransitionInput & {
    replyMessageId?: string;
  }): Promise<AnswerReplyReceipt>;
  blockForPermission(input: VersionedTransitionInput & {
    documentSourceIds: string[];
  }): Promise<AnswerReplyReceipt>;
  beginSafeNoticeSend(input: VersionedTransitionInput): Promise<AnswerReplyReceipt>;
  completeSafeNoticeSend(input: VersionedTransitionInput & {
    safeNoticeMessageId?: string;
  }): Promise<AnswerReplyReceipt>;
  getStatus(): Promise<AnswerReplyRepositoryStatus>;
}

export class AnswerReplyPreparationConflictError extends Error {
  constructor() {
    super("answer reply preparation conflict");
    this.name = "AnswerReplyPreparationConflictError";
  }
}

export class AnswerReplyVersionConflictError extends Error {
  constructor() {
    super("answer reply version conflict");
    this.name = "AnswerReplyVersionConflictError";
  }
}

export function createAnswerReplyDeliveryId(
  provider: AnswerReplyProvider,
  incomingMessageId: string,
): string {
  return `answer-reply-${sha256(JSON.stringify([provider, incomingMessageId]))}`;
}

export function createAnswerReplyUuid(incomingMessageId: string): string {
  return `iris-${sha256(incomingMessageId).slice(0, 45)}`;
}

export function createAnswerReplySafeNoticeUuid(incomingMessageId: string): string {
  return `iris-safe-${sha256(incomingMessageId).slice(0, 40)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
