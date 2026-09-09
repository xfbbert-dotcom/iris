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
  it("distinguishes verified-empty new provenance from legacy absence and binds every source field", () => {
    const receipt = preparedReceipt();
    const base = { provider: receipt.delivery.provider, incomingMessageId, chatId,
      renderedReplyFingerprint: receipt.delivery.renderedReplyFingerprint, sourceTraces: receipt.sources };
    const legacy = createAnswerReplySemanticFingerprint(base);
    const empty = createAnswerReplySemanticFingerprint({ ...base, sharedChatSources: [] });
    const source = { scopeId: "pilot-working-chat", scopeVersion: 1, sourceChatId: "external", destinationChatId: chatId,
      messageId: "original", contentHash: "a".repeat(64) };
    const traced = createAnswerReplySemanticFingerprint({ ...base, sharedChatSources: [source] });
    expect(new Set([legacy, empty, traced]).size).toBe(3);
    for (const changed of [{ scopeVersion: 2 }, { sourceChatId: "different" }, { messageId: "other" }, { contentHash: "b".repeat(64) }]) {
      expect(createAnswerReplySemanticFingerprint({ ...base, sharedChatSources: [{ ...source, ...changed }] })).not.toBe(traced);
    }
    receipt.delivery.chatProvenanceVersion = 1;
    receipt.chatSources = [source];
    receipt.delivery.semanticFingerprint = traced;
    expect(requireValidAnswerReplyReceipt(receipt)).toBe(receipt);
  });

  it.each(["missing marker", "missing array", "duplicate", "wrong destination", "changed version"])("rejects %s in persisted shared provenance", kind => {
    const receipt = preparedReceipt();
    receipt.delivery.chatProvenanceVersion = 1;
    receipt.chatSources = [{ scopeId: "pilot-working-chat", scopeVersion: 1, sourceChatId: "external", destinationChatId: chatId,
      messageId: "original", contentHash: "a".repeat(64) }];
    receipt.delivery.semanticFingerprint = createAnswerReplySemanticFingerprint({ provider: "feishu", incomingMessageId, chatId,
      renderedReplyFingerprint: receipt.delivery.renderedReplyFingerprint, sourceTraces: receipt.sources, sharedChatSources: receipt.chatSources });
    if (kind === "missing marker") delete receipt.delivery.chatProvenanceVersion;
    if (kind === "missing array") delete receipt.chatSources;
    if (kind === "duplicate") receipt.chatSources!.push({ ...receipt.chatSources![0]! });
    if (kind === "wrong destination") receipt.chatSources![0]!.destinationChatId = "other";
    if (kind === "changed version") receipt.chatSources![0]!.scopeVersion = 2;
    expect(() => requireValidAnswerReplyReceipt(receipt)).toThrow("answer reply receipt invalid");
  });

  it("binds the exact cross-group grant facts into semantic identity", () => {
    const renderedReplyFingerprint = createAnswerReplyRenderedFingerprint(renderedText);
    const base = {
      provider: "feishu" as const,
      incomingMessageId,
      chatId,
      renderedReplyFingerprint,
    };
    const unbound = createAnswerReplySemanticFingerprint({
      ...base,
      sourceTraces: [sourceTrace()],
    });
    const bound = createAnswerReplySemanticFingerprint({
      ...base,
      sourceTraces: [sourceTrace({
        sourceType: "feishu_group_document",
        crossGroupGrantId: "grant-a",
        crossGroupGrantVersion: 5,
        crossGroupGrantorGroupId: "group-owner",
        crossGroupGranteeGroupId: "group-reader",
      })],
    });

    expect(bound).not.toBe(unbound);
  });

  it("rejects partial cross-group grant facts in a persisted receipt", () => {
    const malformed = preparedReceipt();
    malformed.sources[0]!.crossGroupGrantId = "grant-a";
    expect(() => requireValidAnswerReplyReceipt(malformed)).toThrow(
      "answer reply receipt invalid",
    );
  });

  it("includes the knowledge-conflict candidate in semantic preparation identity", () => {
    const trace = sourceTrace();
    const renderedReplyFingerprint = createAnswerReplyRenderedFingerprint(renderedText);
    const base = {
      provider: "feishu" as const,
      incomingMessageId,
      chatId,
      renderedReplyFingerprint,
      sourceTraces: [trace],
    };

    expect(createAnswerReplySemanticFingerprint({
      ...base,
      knowledgeConflictCandidateId: "candidate-a",
    })).not.toBe(createAnswerReplySemanticFingerprint({
      ...base,
      knowledgeConflictCandidateId: "candidate-b",
    }));
    expect(createAnswerReplySemanticFingerprint({
      ...base,
      knowledgeConflictCandidateId: "candidate-a",
    })).not.toBe(createAnswerReplySemanticFingerprint(base));
  });

  it("validates the persisted candidate ID against the semantic fingerprint", () => {
    const linked = preparedReceipt();
    linked.delivery.knowledgeConflictCandidateId = "candidate-a";
    linked.delivery.semanticFingerprint = createAnswerReplySemanticFingerprint({
      provider: linked.delivery.provider,
      incomingMessageId: linked.delivery.incomingMessageId,
      chatId: linked.delivery.chatId,
      renderedReplyFingerprint: linked.delivery.renderedReplyFingerprint,
      knowledgeConflictCandidateId: linked.delivery.knowledgeConflictCandidateId,
      sourceTraces: linked.sources,
    });
    expect(requireValidAnswerReplyReceipt(linked)).toBe(linked);

    linked.delivery.knowledgeConflictCandidateId = "candidate-b";
    expect(() => requireValidAnswerReplyReceipt(linked)).toThrow(
      "answer reply receipt invalid",
    );
  });

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
    const notSentReconciled = appendTransition(
      sending,
      "not_sent_reconciled",
      transitionAt,
    );

    for (const receipt of [
      prepared,
      sending,
      sent,
      permissionBlocked,
      permissionNoticeStarted,
      appendTransition(permissionNoticeStarted, "safe_notice_sent", transitionAt),
      reconciliationRequired,
      notSentReconciled,
      appendTransition(
        notSentReconciled,
        "safe_notice_send_started",
        new Date("2026-08-02T02:03:00.000Z"),
        1,
      ),
    ]) {
      expect(requireValidAnswerReplyReceipt(receipt)).toBe(receipt);
    }
  });

  it("accepts a preflight permission block for a denied source that was never prompted", () => {
    const blocked = appendTransition(
      preparedReceipt(),
      "permission_blocked",
      firstSendAt,
      undefined,
      ["source-revoked"],
    );
    blocked.events.at(-1)!.sourceCount = 2;

    expect(requireValidAnswerReplyReceipt(blocked)).toBe(blocked);
  });

  it("rejects a permission block that mixes prompted and preflight-denied source IDs", () => {
    const malformed = appendTransition(
      preparedReceipt(),
      "permission_blocked",
      firstSendAt,
      undefined,
      ["source-a", "source-revoked"],
    );
    malformed.events.at(-1)!.sourceCount = 2;

    expect(() => requireValidAnswerReplyReceipt(malformed)).toThrow(
      "answer reply receipt invalid",
    );
  });

  it("still rejects a reconciliation event for a source outside the prompt trace", () => {
    const sending = appendTransition(preparedReceipt(), "send_started", firstSendAt, 1);
    const malformed = appendTransition(
      sending,
      "reconciliation_required",
      transitionAt,
      undefined,
      ["source-revoked"],
    );
    malformed.events.at(-1)!.sourceCount = 2;

    expect(() => requireValidAnswerReplyReceipt(malformed)).toThrow(
      "answer reply receipt invalid",
    );
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
    case "not_sent_reconciled":
      Object.assign(delivery, {
        state: "not_sent_reconciled",
        preparedReplyText: undefined,
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

function sourceTrace(
  overrides: Partial<AnswerReplySourceTraceInput> = {},
): AnswerReplySourceTraceInput {
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
    ...overrides,
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
