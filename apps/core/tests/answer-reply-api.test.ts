import { describe, expect, it, vi } from "vitest";

import type { AnswerReplyReceipt } from "../src/answer-replies/answer-reply-repository.js";
import { buildApp, type BuildAppDependencies } from "../src/app.js";
import type { EventWorkerRuntime } from "../src/runtime/event-worker-runtime.js";

const authorization = { authorization: "Bearer operator-secret" };
type AnswerReplyInspectionRepository = NonNullable<EventWorkerRuntime["answerReplies"]>;

describe("answer reply inspection API", () => {
  it("requires the existing internal bearer token before inspecting a receipt", async () => {
    const repository = {
      findByIncomingMessage: vi.fn(async () => receipt()),
    };
    const app = await createApp(repository);

    const response = await app.inject({
      method: "GET",
      url: "/internal/answer-replies/feishu/om_1",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ ok: false, error: "internal_api_unauthorized" });
    expect(repository.findByIncomingMessage).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns an explicit content-free receipt mapping for an authorized operator", async () => {
    const repository = {
      findByIncomingMessage: vi.fn(async () => receipt()),
    };
    const app = await createApp(repository);

    const response = await app.inject({
      method: "GET",
      url: "/internal/answer-replies/feishu/om_1",
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(repository.findByIncomingMessage).toHaveBeenCalledWith({
      provider: "feishu",
      incomingMessageId: "om_1",
    });
    expect(response.json()).toEqual({
      ok: true,
      delivery: {
        id: "answer-reply-1",
        provider: "feishu",
        incomingMessageId: "om_1",
        chatId: "oc_1",
        state: "sent",
        renderedReplyFingerprint: "rendered-fingerprint",
        semanticFingerprint: "semantic-fingerprint",
        replyMessageId: "om_reply",
        safeNoticeMessageId: "om_notice",
        attemptCount: 2,
        safeNoticeAttemptCount: 1,
        version: 7,
        createdAt: "2026-08-02T01:02:03.000Z",
        updatedAt: "2026-08-02T01:03:04.000Z",
        sentAt: "2026-08-02T01:03:04.000Z",
        permissionBlockedAt: undefined,
        reconciliationRequiredAt: undefined,
        safeNoticeSentAt: "2026-08-02T01:03:05.000Z",
      },
      sources: [{
        id: "source-trace-1",
        deliveryId: "answer-reply-1",
        promptRank: 1,
        citationRank: 1,
        documentSourceId: "source-1",
        documentSnapshotId: "snapshot-1",
        fragmentId: "fragment-1",
        chunkIndex: 0,
        sourceType: "feishu_wiki",
        sourceUri: "https://example.feishu.cn/wiki/source-1",
        sourceTitle: "Release notes",
        contentHash: "content-hash",
        embeddingProfileId: "embedding-profile-1",
        initialPermissionCheckedAt: "2026-08-02T01:02:02.000Z",
      }],
      events: [{
        id: "event-1",
        deliveryId: "answer-reply-1",
        sequence: 1,
        eventType: "prepared",
        attemptNumber: undefined,
        sourceCount: 1,
        documentSourceIds: ["source-1"],
        createdAt: "2026-08-02T01:02:03.000Z",
      }],
    });
    expect(response.body).not.toContain("SENSITIVE_PREPARED_ANSWER");
    expect(response.body).not.toContain("SENSITIVE_FRAGMENT_TEXT");
    expect(response.body).not.toContain("SENSITIVE_PROMPT");
    expect(response.body).not.toContain("SENSITIVE_TOKEN");
    expect(response.body).not.toContain("SENSITIVE_PROVIDER_BODY");
    expect(response.body).not.toContain("arbitraryDeliveryProperty");
    expect(response.body).not.toContain("arbitrarySourceProperty");
    expect(response.body).not.toContain("arbitraryEventProperty");
    await app.close();
  });

  it("rejects invalid route parameters with a bounded 400 response", async () => {
    const repository = {
      findByIncomingMessage: vi.fn(async () => receipt()),
    };
    const app = await createApp(repository);

    for (const url of [
      "/internal/answer-replies/slack/om_1",
      "/internal/answer-replies/feishu/%20",
      `/internal/answer-replies/feishu/${"a".repeat(513)}`,
    ]) {
      const response = await app.inject({ method: "GET", url, headers: authorization });
      expect(response.statusCode, url).toBe(400);
      expect(response.json(), url).toEqual({ ok: false, error: "invalid_request" });
    }

    expect(repository.findByIncomingMessage).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects whitespace-padded incoming message IDs without querying the repository", async () => {
    const repository = {
      findByIncomingMessage: vi.fn(async () => receipt()),
    };
    const app = await createApp(repository);

    const response = await app.inject({
      method: "GET",
      url: "/internal/answer-replies/feishu/om_1%20",
      headers: authorization,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(repository.findByIncomingMessage).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns a bounded 404 when the receipt is absent", async () => {
    const repository = {
      findByIncomingMessage: vi.fn(async () => undefined),
    };
    const app = await createApp(repository);

    const missing = await app.inject({
      method: "GET",
      url: "/internal/answer-replies/feishu/om_missing",
      headers: authorization,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ ok: false, error: "answer_reply_not_found" });
    await app.close();
  });

  it("keeps the inspection route absent when the event worker has no answer-reply repository", async () => {
    const unavailable = await createApp(undefined);
    const unavailableResponse = await unavailable.inject({
      method: "GET",
      url: "/internal/answer-replies/feishu/om_missing",
      headers: authorization,
    });
    expect(unavailableResponse.statusCode).toBe(404);
    expect(unavailableResponse.json()).toMatchObject({ statusCode: 404, error: "Not Found" });
    await unavailable.close();
  });

  it("uses the internal error boundary without echoing repository exceptions", async () => {
    const repository = {
      findByIncomingMessage: vi.fn(async () => {
        throw new Error("SENSITIVE_REPOSITORY_EXCEPTION");
      }),
    };
    const app = await createApp(repository);

    const response = await app.inject({
      method: "GET",
      url: "/internal/answer-replies/feishu/om_1",
      headers: authorization,
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("SENSITIVE_REPOSITORY_EXCEPTION");
    await app.close();
  });
});

async function createApp(
  repository: AnswerReplyInspectionRepository | undefined,
) {
  return await buildApp({
    ...disabledRuntimeFactories(),
    internalApiToken: "operator-secret",
    createEventWorkerRuntime: () => fakeEventWorkerRuntime(repository),
  });
}

function disabledRuntimeFactories(): Pick<
  BuildAppDependencies,
  | "createAgentExecutionLedgerRuntime"
  | "createAnswerDraftRuntime"
  | "createMemoryExtractionRuntime"
  | "createReindexWorkerRuntime"
  | "createDocumentSyncRuntime"
  | "createConversationStateInspectionRuntime"
  | "createProactiveSignalRuntime"
  | "createKnowledgeDraftRuntime"
  | "createKnowledgeCardRuntime"
  | "createActionApprovalRuntime"
  | "createActionReviewRuntime"
  | "createProactiveSignalPlannerRuntime"
  | "createProactiveSignalDeliveryRuntime"
> {
  return {
    createAgentExecutionLedgerRuntime: () => undefined,
    createAnswerDraftRuntime: () => undefined,
    createMemoryExtractionRuntime: () => undefined,
    createReindexWorkerRuntime: () => undefined,
    createDocumentSyncRuntime: () => undefined,
    createConversationStateInspectionRuntime: () => undefined,
    createProactiveSignalRuntime: () => undefined,
    createKnowledgeDraftRuntime: () => undefined,
    createKnowledgeCardRuntime: () => undefined,
    createActionApprovalRuntime: () => undefined,
    createActionReviewRuntime: () => undefined,
    createProactiveSignalPlannerRuntime: () => undefined,
    createProactiveSignalDeliveryRuntime: () => undefined,
  };
}

function fakeEventWorkerRuntime(
  answerReplies: AnswerReplyInspectionRepository | undefined,
): EventWorkerRuntime {
  return {
    answerReplies,
    deadLetters: {
      list: vi.fn(async () => []),
      replay: vi.fn(async () => "not_found" as const),
      delete: vi.fn(async () => "not_found" as const),
      replayBatch: vi.fn(async () => ({
        replayedCount: 0,
        notFoundIds: [],
        unsupportedLegacyIds: [],
      })),
    },
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      running: false,
      intervalMs: 1_000,
      batchLimit: 1,
      mentionRepliesEnabled: false,
      pendingEventCount: 0,
      deadLetterEventCount: 0,
      answerReplyUnresolvedCount: 0,
      answerReplyPendingSafeNoticeCount: 0,
      answerReplyReconciliationRequiredCount: 0,
    })),
    start: vi.fn(),
    close: vi.fn(async () => undefined),
  };
}

function receipt(): AnswerReplyReceipt {
  const createdAt = new Date("2026-08-02T01:02:03.000Z");
  const updatedAt = new Date("2026-08-02T01:03:04.000Z");
  const value = {
    delivery: {
      id: "answer-reply-1",
      provider: "feishu" as const,
      incomingMessageId: "om_1",
      chatId: "oc_1",
      replyUuid: "reply-uuid",
      safeNoticeUuid: "safe-notice-uuid",
      state: "sent" as const,
      preparedReplyText: "SENSITIVE_PREPARED_ANSWER",
      renderedReplyFingerprint: "rendered-fingerprint",
      semanticFingerprint: "semantic-fingerprint",
      replyMessageId: "om_reply",
      safeNoticeMessageId: "om_notice",
      attemptCount: 2,
      safeNoticeAttemptCount: 1,
      version: 7,
      createdAt,
      updatedAt,
      sentAt: updatedAt,
      safeNoticeSentAt: new Date("2026-08-02T01:03:05.000Z"),
      arbitraryDeliveryProperty: "SENSITIVE_TOKEN",
    },
    sources: [{
      id: "source-trace-1",
      deliveryId: "answer-reply-1",
      promptRank: 1,
      citationRank: 1,
      documentSourceId: "source-1",
      documentSnapshotId: "snapshot-1",
      fragmentId: "fragment-1",
      chunkIndex: 0,
      sourceType: "feishu_wiki" as const,
      sourceUri: "https://example.feishu.cn/wiki/source-1",
      sourceTitle: "Release notes",
      contentHash: "content-hash",
      embeddingProfileId: "embedding-profile-1",
      initialPermissionCheckedAt: new Date("2026-08-02T01:02:02.000Z"),
      fragmentText: "SENSITIVE_FRAGMENT_TEXT",
      promptContext: "SENSITIVE_PROMPT",
      arbitrarySourceProperty: "SENSITIVE_PROVIDER_BODY",
    }],
    events: [{
      id: "event-1",
      deliveryId: "answer-reply-1",
      sequence: 1,
      eventType: "prepared" as const,
      sourceCount: 1,
      documentSourceIds: ["source-1"],
      createdAt,
      exceptionMessage: "SENSITIVE_REPOSITORY_EXCEPTION",
      arbitraryEventProperty: "SENSITIVE_PROVIDER_BODY",
    }],
  };
  return value as AnswerReplyReceipt;
}
