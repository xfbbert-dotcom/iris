import { describe, expect, it } from "vitest";

import {
  createAnswerReplyEventId,
  createAnswerReplyRenderedFingerprint,
  createAnswerReplySemanticFingerprint,
  createAnswerReplySourceTraceId,
  requireValidAnswerReplyReceipt,
} from "../src/answer-replies/answer-reply-receipt-validator.js";
import {
  createAnswerReplyDeliveryId,
  createAnswerReplySafeNoticeUuid,
  createAnswerReplyUuid,
  type AnswerReplyDeliveryEvent,
  type AnswerReplyReceipt,
} from "../src/answer-replies/answer-reply-repository.js";
import type { AnswerReplySourceTraceInput } from "../src/answer-replies/answer-source-citation-renderer.js";

const incomingMessageId = "om_validator";
const chatId = "oc_validator";
const renderedText = "SENSITIVE validator answer";
const preparedAt = new Date("2026-08-02T02:00:00.000Z");
const firstSendAt = new Date("2026-08-02T02:01:00.000Z");
const transitionAt = new Date("2026-08-02T02:02:00.000Z");

describe("AnswerReplyReceiptValidator", () => {
  it("accepts complete legal answer and safe-notice ledgers", () => {
    const prepared = preparedReceipt();
    const sending = appendTransition(prepared, "send_started", firstSendAt, 1);
    const sent = appendTransition(sending, "sent", transitionAt);
    const permissionBlocked = appendTransition(
      prepared,
      "permission_blocked",
      firstSendAt,
      undefined,
      ["source-a"],
    );
    const permissionNoticeStarted = appendTransition(
      permissionBlocked,
      "safe_notice_send_started",
      transitionAt,
      1,
    );
    const reconciliationRequired = appendTransition(
      sending,
      "reconciliation_required",
      transitionAt,
      undefined,
      ["source-a"],
    );

    for (const receipt of [
      prepared,
      sending,
      sent,
      permissionBlocked,
      permissionNoticeStarted,
      appendTransition(permissionNoticeStarted, "safe_notice_sent", transitionAt),
      reconciliationRequired,
    ]) {
      expect(requireValidAnswerReplyReceipt(receipt)).toBe(receipt);
    }
  });

  it.each([
    ["delivery ID", (value: AnswerReplyReceipt) => {
      value.delivery.id = "foreign-delivery";
    }],
    ["reply UUID", (value: AnswerReplyReceipt) => {
      value.delivery.replyUuid = "foreign-reply-uuid";
    }],
    ["source child ID", (value: AnswerReplyReceipt) => {
      value.sources[0]!.id = "foreign-source-id";
    }],
    ["event child ID", (value: AnswerReplyReceipt) => {
      value.events[0]!.id = "foreign-event-id";
    }],
    ["rendered fingerprint", (value: AnswerReplyReceipt) => {
      value.delivery.renderedReplyFingerprint = "d".repeat(64);
    }],
    ["semantic fingerprint", (value: AnswerReplyReceipt) => {
      value.delivery.semanticFingerprint = "d".repeat(64);
    }],
    ["version/event count", (value: AnswerReplyReceipt) => {
      value.delivery.version = 2;
    }],
    ["event sequence", (value: AnswerReplyReceipt) => {
      value.events[0]!.sequence = 2;
    }],
    ["event type", (value: AnswerReplyReceipt) => {
      value.events[0]!.eventType = "sent";
    }],
    ["event attempt number", (value: AnswerReplyReceipt) => {
      value.events[0]!.attemptNumber = 1;
    }],
    ["event source count", (value: AnswerReplyReceipt) => {
      value.events[0]!.sourceCount = 2;
    }],
    ["event source IDs", (value: AnswerReplyReceipt) => {
      value.events[0]!.documentSourceIds = ["source-foreign"];
    }],
    ["event timestamp", (value: AnswerReplyReceipt) => {
      value.events[0]!.createdAt = transitionAt;
    }],
    ["ledger state", (value: AnswerReplyReceipt) => {
      value.delivery.state = "sending";
      value.delivery.attemptCount = 1;
      value.delivery.lastSendStartedAt = preparedAt;
    }],
  ] satisfies Array<[string, (value: AnswerReplyReceipt) => void]>)(
    "rejects %s corruption with a content-free error",
    (_label, corrupt) => {
      const malformed = structuredClone(preparedReceipt());
      corrupt(malformed);

      const error = captureError(() => requireValidAnswerReplyReceipt(malformed));

      expect(error.message).toBe("answer reply receipt invalid");
      expect(error.message).not.toContain(renderedText);
      expect(error.message).not.toContain("source-a");
    },
  );

  it("rejects malformed values with the same stable error", () => {
    for (const value of [undefined, null, {}, { delivery: {} }]) {
      expect(() => requireValidAnswerReplyReceipt(value)).toThrow(
        "answer reply receipt invalid",
      );
    }
  });
});

function preparedReceipt(): AnswerReplyReceipt {
  const deliveryId = createAnswerReplyDeliveryId("feishu", incomingMessageId);
  const trace = sourceTrace();
  const renderedReplyFingerprint = createAnswerReplyRenderedFingerprint(renderedText);
  return {
    delivery: {
      id: deliveryId,
      provider: "feishu",
      incomingMessageId,
      chatId,
      replyUuid: createAnswerReplyUuid(incomingMessageId),
      safeNoticeUuid: createAnswerReplySafeNoticeUuid(incomingMessageId),
      state: "prepared",
      preparedReplyText: renderedText,
      renderedReplyFingerprint,
      semanticFingerprint: createAnswerReplySemanticFingerprint({
        provider: "feishu",
        incomingMessageId,
        chatId,
        renderedReplyFingerprint,
        sourceTraces: [trace],
      }),
      attemptCount: 0,
      safeNoticeAttemptCount: 0,
      version: 1,
      createdAt: preparedAt,
      updatedAt: preparedAt,
    },
    sources: [{
      ...trace,
      id: createAnswerReplySourceTraceId(deliveryId, 1),
      deliveryId,
    }],
    events: [event(deliveryId, 1, "prepared", preparedAt)],
  };
}

function appendTransition(
  prior: AnswerReplyReceipt,
  eventType: AnswerReplyDeliveryEvent["eventType"],
  at: Date,
  attemptNumber?: number,
  documentSourceIds = ["source-a"],
): AnswerReplyReceipt {
  const sequence = prior.delivery.version + 1;
  const delivery = { ...prior.delivery, version: sequence, updatedAt: at };
  switch (eventType) {
    case "send_started":
      Object.assign(delivery, {
        state: "sending",
        attemptCount: prior.delivery.attemptCount + 1,
        lastSendStartedAt: at,
      });
      break;
    case "sent":
      Object.assign(delivery, {
        state: "sent",
        preparedReplyText: undefined,
        sentAt: at,
      });
      break;
    case "permission_blocked":
      Object.assign(delivery, {
        state: "permission_blocked",
        preparedReplyText: undefined,
        permissionBlockedAt: at,
      });
      break;
    case "reconciliation_required":
      Object.assign(delivery, {
        state: "reconciliation_required",
        preparedReplyText: undefined,
        reconciliationRequiredAt: at,
      });
      break;
    case "safe_notice_send_started":
      delivery.safeNoticeAttemptCount = prior.delivery.safeNoticeAttemptCount + 1;
      break;
    case "safe_notice_sent":
      delivery.safeNoticeSentAt = at;
      break;
    case "prepared":
      throw new Error("test transition invalid");
  }
  return {
    delivery,
    sources: prior.sources,
    events: [
      ...prior.events,
      event(prior.delivery.id, sequence, eventType, at, attemptNumber, documentSourceIds),
    ],
  };
}

function event(
  deliveryId: string,
  sequence: number,
  eventType: AnswerReplyDeliveryEvent["eventType"],
  createdAt: Date,
  attemptNumber?: number,
  documentSourceIds = ["source-a"],
): AnswerReplyDeliveryEvent {
  return {
    id: createAnswerReplyEventId(deliveryId, sequence),
    deliveryId,
    sequence,
    eventType,
    ...(attemptNumber === undefined ? {} : { attemptNumber }),
    sourceCount: 1,
    documentSourceIds,
    createdAt,
  };
}

function sourceTrace(): AnswerReplySourceTraceInput {
  return {
    promptRank: 1,
    citationRank: 1,
    documentSourceId: "source-a",
    documentSnapshotId: "snapshot-a",
    fragmentId: "fragment-a",
    chunkIndex: 0,
    sourceType: "feishu_wiki",
    sourceUri: "https://example.feishu.cn/wiki/source-a",
    sourceTitle: "SENSITIVE source A",
    contentHash: "a".repeat(64),
    embeddingProfileId: "embedding-profile-a",
    initialPermissionCheckedAt: new Date("2026-08-02T01:59:00.000Z"),
  };
}

function captureError(callback: () => unknown): Error {
  try {
    callback();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
  }
  throw new Error("expected callback to throw");
}
