import { describe, expect, it, vi } from "vitest";

import {
  ANSWER_PERMISSION_CHANGED_NOTICE,
  createAnswerReplyDeliveryService,
  type AnswerReplyDeliveryRequest,
} from "../src/answer-replies/answer-reply-delivery-service.js";
import type {
  AnswerReplyReceipt,
  AnswerReplyRepository,
  PrepareAnswerReplyInput,
  VersionedTransitionInput,
} from "../src/answer-replies/answer-reply-repository.js";
import type { AnswerReplySourceTraceInput } from "../src/answer-replies/answer-source-citation-renderer.js";
import type {
  AnswerSourcePermissionDecision,
  AnswerSourcePermissionVerifier,
} from "../src/answer-replies/answer-source-permission-verifier.js";
import type { FeishuMessageReplier } from "../src/feishu/feishu-message-replier.js";

const preparedAt = new Date("2026-08-02T01:00:00.000Z");
const transitionAt = new Date("2026-08-02T01:01:00.000Z");
const preparedText = "SENSITIVE prepared answer";
const preparedReplyUuid = "iris-normal-reply-uuid";
const safeNoticeUuid = "iris-safe-notice-uuid";

describe("AnswerReplyDeliveryService", () => {
  it("persists the prepared payload exactly and retries the stored answer and UUID", async () => {
    const harness = createHarness({
      replyResults: [new Error("Feishu unavailable"), { replyMessageId: "reply-1" }],
    });
    const firstPrepare = vi.fn(async () => preparedAnswer());
    const replacementPrepare = vi.fn(async () => preparedAnswer({
      renderedText: "REPLACEMENT answer must not be used",
    }));

    await expect(harness.service.respond(request(firstPrepare))).rejects.toThrow(
      "Feishu unavailable",
    );
    await expect(harness.service.respond(request(replacementPrepare))).resolves.toEqual({
      replyMessageId: "reply-1",
    });

    expect(firstPrepare).toHaveBeenCalledTimes(1);
    expect(replacementPrepare).not.toHaveBeenCalled();
    expect(harness.repository.prepare).toHaveBeenCalledTimes(1);
    expect(harness.repository.prepare).toHaveBeenCalledWith({
      provider: "feishu",
      incomingMessageId: "om_1",
      chatId: "oc_1",
      replyUuid: preparedReplyUuid,
      safeNoticeUuid,
      renderedText: preparedText,
      sourceTraces: [sourceTrace()],
      at: preparedAt,
    });
    expect(harness.replier.replyText).toHaveBeenNthCalledWith(1, {
      messageId: "om_1",
      text: preparedText,
      replyInThread: true,
      uuid: preparedReplyUuid,
    });
    expect(harness.replier.replyText).toHaveBeenNthCalledWith(2, {
      messageId: "om_1",
      text: preparedText,
      replyInThread: true,
      uuid: preparedReplyUuid,
    });
    expect(harness.repository.completeAnswerSend).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      expectedVersion: 3,
      replyMessageId: "reply-1",
      at: transitionAt,
    });
    expect(harness.repository.receipt?.delivery).toMatchObject({
      state: "sent",
      replyMessageId: "reply-1",
    });
  });

  it("checks each unique source in first-seen order before every answer attempt", async () => {
    const harness = createHarness({
      replyResults: [new Error("uncertain send"), { replyMessageId: "reply-2" }],
    });
    const prepareAnswer = vi.fn(async () => preparedAnswer({
      sourceTraces: [
        sourceTrace(),
        sourceTrace({ promptRank: 2, fragmentId: "fragment-a-2" }),
        sourceTrace({
          promptRank: 3,
          citationRank: 2,
          documentSourceId: "source-b",
          documentSnapshotId: "snapshot-b",
          fragmentId: "fragment-b",
          sourceTitle: "SENSITIVE source B",
          sourceUri: "https://example.feishu.cn/wiki/source-b",
        }),
      ],
    }));

    await expect(harness.service.respond(request(prepareAnswer))).rejects.toThrow(
      "uncertain send",
    );
    await harness.service.respond(request(vi.fn()));

    expect(harness.verifier.verify).toHaveBeenCalledTimes(2);
    expect(harness.verifier.verify).toHaveBeenNthCalledWith(1, {
      chatId: "oc_1",
      documentSourceIds: ["source-a", "source-b"],
    });
    expect(harness.verifier.verify).toHaveBeenNthCalledWith(2, {
      chatId: "oc_1",
      documentSourceIds: ["source-a", "source-b"],
    });
  });

  it("retries the exact stored answer when sent-state persistence fails", async () => {
    const harness = createHarness({
      replyResults: [
        { replyMessageId: "reply-persisted" },
        { replyMessageId: "reply-persisted" },
      ],
    });
    harness.repository.completeAnswerSend.mockRejectedValueOnce(
      new Error("receipt persistence unavailable"),
    );
    const prepareAnswer = vi.fn(async () => preparedAnswer());

    await expect(harness.service.respond(request(prepareAnswer))).rejects.toThrow(
      "receipt persistence unavailable",
    );
    await harness.service.respond(request(vi.fn()));

    expect(prepareAnswer).toHaveBeenCalledTimes(1);
    expect(harness.replier.replyText).toHaveBeenCalledTimes(2);
    expect(harness.replier.replyText.mock.calls[0]).toEqual(
      harness.replier.replyText.mock.calls[1],
    );
    expect(harness.repository.receipt?.delivery).toMatchObject({
      state: "sent",
      replyMessageId: "reply-persisted",
    });
  });

  it("sends a source-free prepared answer without calling the verifier", async () => {
    const harness = createHarness();

    await expect(harness.service.respond(request(vi.fn(async () => preparedAnswer({
      sourceTraces: [],
    }))))).resolves.toEqual({ replyMessageId: "reply-default" });

    expect(harness.verifier.verify).not.toHaveBeenCalled();
    expect(harness.repository.beginAnswerSend.mock.invocationCallOrder[0]).toBeLessThan(
      harness.replier.replyText.mock.invocationCallOrder[0]!,
    );
    expect(harness.replier.replyText).toHaveBeenCalledWith({
      messageId: "om_1",
      text: preparedText,
      replyInThread: true,
      uuid: preparedReplyUuid,
    });
  });

  it.each([
    ["denied", [{ documentSourceId: "source-a", outcome: "denied" }]],
    ["error", [{ documentSourceId: "source-a", outcome: "error" }]],
  ] satisfies Array<[string, AnswerSourcePermissionDecision[]]>) (
    "blocks before the first send when a source check is %s",
    async (_label, decisions) => {
      const harness = createHarness({ verifierResults: [decisions] });

      await expect(harness.service.respond(request(vi.fn(async () => preparedAnswer()))))
        .resolves.toEqual({ replyMessageId: "reply-default" });

      expect(harness.repository.blockForPermission).toHaveBeenCalledWith({
        deliveryId: "delivery-1",
        expectedVersion: 1,
        documentSourceIds: ["source-a"],
        at: transitionAt,
      });
      expect(harness.repository.beginAnswerSend).not.toHaveBeenCalled();
      expect(harness.repository.blockForPermission.mock.invocationCallOrder[0]).toBeLessThan(
        harness.repository.beginSafeNoticeSend.mock.invocationCallOrder[0]!,
      );
      expectOnlySafeNoticeWasSent(harness);
      expect(harness.repository.receipt?.delivery.state).toBe("permission_blocked");
    },
  );

  it.each([
    ["missing", [{ documentSourceId: "source-a", outcome: "allowed" }]],
    ["duplicated", [
      { documentSourceId: "source-a", outcome: "allowed" },
      { documentSourceId: "source-a", outcome: "allowed" },
    ]],
    ["reordered", [
      { documentSourceId: "source-b", outcome: "allowed" },
      { documentSourceId: "source-a", outcome: "allowed" },
    ]],
    ["unexpected", [
      { documentSourceId: "source-a", outcome: "allowed" },
      { documentSourceId: "source-unexpected", outcome: "allowed" },
    ]],
    ["invalid outcome", [
      { documentSourceId: "source-a", outcome: "allowed" },
      { documentSourceId: "source-b", outcome: "unknown" },
    ]],
  ])("blocks when verifier decisions are %s", async (_label, malformedDecisions) => {
    const harness = createHarness({
      verifierResults: [malformedDecisions as AnswerSourcePermissionDecision[]],
    });

    await harness.service.respond(request(vi.fn(async () => preparedAnswer({
      sourceTraces: twoSourceTraces(),
    }))));

    expect(harness.repository.blockForPermission).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      expectedVersion: 1,
      documentSourceIds: ["source-a", "source-b"],
      at: transitionAt,
    });
    expect(harness.repository.beginAnswerSend).not.toHaveBeenCalled();
    expectOnlySafeNoticeWasSent(harness);
  });

  it("blocks when the verifier unexpectedly throws", async () => {
    const harness = createHarness({
      verifierResults: [new Error("SENSITIVE verifier provider response")],
    });

    await expect(harness.service.respond(request(vi.fn(async () => preparedAnswer()))))
      .resolves.toEqual({ replyMessageId: "reply-default" });

    expect(harness.repository.blockForPermission).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      expectedVersion: 1,
      documentSourceIds: ["source-a"],
      at: transitionAt,
    });
    expect(harness.repository.beginAnswerSend).not.toHaveBeenCalled();
    expectOnlySafeNoticeWasSent(harness);
    expect(JSON.stringify(harness.replier.replyText.mock.calls)).not.toContain(
      "verifier provider response",
    );
  });

  it("records reconciliation_required when a prior answer send had started", async () => {
    const harness = createHarness({
      verifierResults: [
        [{ documentSourceId: "source-a", outcome: "allowed" }],
        [{ documentSourceId: "source-a", outcome: "denied" }],
      ],
      replyResults: [new Error("uncertain answer send"), { replyMessageId: "safe-reply" }],
    });
    const prepareAnswer = vi.fn(async () => preparedAnswer());

    await expect(harness.service.respond(request(prepareAnswer))).rejects.toThrow(
      "uncertain answer send",
    );
    await expect(harness.service.respond(request(vi.fn()))).resolves.toEqual({
      replyMessageId: "safe-reply",
    });

    expect(harness.repository.receipt?.delivery.state).toBe("reconciliation_required");
    expect(harness.repository.beginAnswerSend).toHaveBeenCalledTimes(1);
    expect(harness.replier.replyText).toHaveBeenNthCalledWith(2, {
      messageId: "om_1",
      text: ANSWER_PERMISSION_CHANGED_NOTICE,
      replyInThread: true,
      uuid: safeNoticeUuid,
    });
    expect(harness.repository.blockForPermission.mock.invocationCallOrder[0]).toBeLessThan(
      harness.repository.beginSafeNoticeSend.mock.invocationCallOrder[0]!,
    );
  });

  it("sends only the content-free notice with the separate safe UUID", async () => {
    const harness = createHarness({
      verifierResults: [[{ documentSourceId: "source-a", outcome: "denied" }]],
      replyResults: [{ replyMessageId: "safe-message-id" }],
    });

    await harness.service.respond(request(vi.fn(async () => preparedAnswer())));

    expect(harness.replier.replyText).toHaveBeenCalledOnce();
    expect(harness.replier.replyText).toHaveBeenCalledWith({
      messageId: "om_1",
      text: "资料权限已变化，我没有发送原答案。请重新提问。",
      replyInThread: true,
      uuid: safeNoticeUuid,
    });
    expect(harness.repository.completeSafeNoticeSend).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      expectedVersion: 3,
      safeNoticeMessageId: "safe-message-id",
      at: transitionAt,
    });
    expectOnlySafeNoticeWasSent(harness);
  });

  it("retries only the stored safe notice after notice delivery fails", async () => {
    const harness = createHarness({
      verifierResults: [[{ documentSourceId: "source-a", outcome: "denied" }]],
      replyResults: [new Error("notice delivery failed"), { replyMessageId: "safe-retry" }],
    });
    const firstPrepare = vi.fn(async () => preparedAnswer());
    const retryPrepare = vi.fn(async () => preparedAnswer({
      renderedText: "RECONSTRUCTED blocked answer",
    }));

    await expect(harness.service.respond(request(firstPrepare))).rejects.toThrow(
      "notice delivery failed",
    );
    await expect(harness.service.respond(request(retryPrepare))).resolves.toEqual({
      replyMessageId: "safe-retry",
    });

    expect(firstPrepare).toHaveBeenCalledTimes(1);
    expect(retryPrepare).not.toHaveBeenCalled();
    expect(harness.verifier.verify).toHaveBeenCalledTimes(1);
    expect(harness.repository.blockForPermission).toHaveBeenCalledTimes(1);
    expect(harness.repository.beginAnswerSend).not.toHaveBeenCalled();
    expect(harness.replier.replyText).toHaveBeenCalledTimes(2);
    expect(harness.replier.replyText.mock.calls[0]).toEqual(
      harness.replier.replyText.mock.calls[1],
    );
    expectOnlySafeNoticeWasSent(harness);
  });

  it("returns a sent receipt without preparing, verifying, or calling Feishu", async () => {
    const harness = createHarness();
    harness.repository.receipt = receipt({
      state: "sent",
      preparedReplyText: undefined,
      replyMessageId: "stored-reply-id",
      sentAt: transitionAt,
    });
    const prepareAnswer = vi.fn();

    await expect(harness.service.respond(request(prepareAnswer))).resolves.toEqual({
      replyMessageId: "stored-reply-id",
    });

    expect(prepareAnswer).not.toHaveBeenCalled();
    expect(harness.verifier.verify).not.toHaveBeenCalled();
    expect(harness.repository.prepare).not.toHaveBeenCalled();
    expect(harness.repository.beginAnswerSend).not.toHaveBeenCalled();
    expect(harness.replier.replyText).not.toHaveBeenCalled();
  });

  it.each(["permission_blocked", "reconciliation_required"] as const)(
    "returns a terminal %s safe notice without another external call",
    async (state) => {
      const harness = createHarness();
      harness.repository.receipt = receipt({
        state,
        preparedReplyText: undefined,
        safeNoticeMessageId: "stored-safe-id",
        safeNoticeSentAt: transitionAt,
        ...(state === "permission_blocked"
          ? { permissionBlockedAt: transitionAt }
          : { reconciliationRequiredAt: transitionAt, attemptCount: 1 }),
      });
      const prepareAnswer = vi.fn();

      await expect(harness.service.respond(request(prepareAnswer))).resolves.toEqual({
        replyMessageId: "stored-safe-id",
      });

      expect(prepareAnswer).not.toHaveBeenCalled();
      expect(harness.verifier.verify).not.toHaveBeenCalled();
      expect(harness.repository.beginSafeNoticeSend).not.toHaveBeenCalled();
      expect(harness.replier.replyText).not.toHaveBeenCalled();
    },
  );

  it("fails closed on a malformed prepared receipt without exposing stored content", async () => {
    const harness = createHarness();
    harness.repository.receipt = {
      ...receipt(),
      sources: undefined as never,
    };

    const error = await harness.service.respond(request(vi.fn())).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("answer reply delivery contract invalid");
    expect((error as Error).message).not.toContain(preparedText);
    expect((error as Error).message).not.toContain("source-a");
    expect(harness.verifier.verify).not.toHaveBeenCalled();
    expect(harness.replier.replyText).not.toHaveBeenCalled();
  });
});

type Harness = ReturnType<typeof createHarness>;

function createHarness({
  verifierResults = [],
  replyResults = [{ replyMessageId: "reply-default" }],
}: {
  verifierResults?: Array<AnswerSourcePermissionDecision[] | Error>;
  replyResults?: Array<{ replyMessageId?: string } | Error>;
} = {}) {
  const repository = new RecordingAnswerReplyRepository();
  const queuedVerifierResults = [...verifierResults];
  const verify = vi.fn<AnswerSourcePermissionVerifier["verify"]>(
    async ({ documentSourceIds }) => {
      const result = queuedVerifierResults.shift();
      if (result instanceof Error) {
        throw result;
      }
      return result ?? documentSourceIds.map((documentSourceId) => ({
        documentSourceId,
        outcome: "allowed" as const,
      }));
    },
  );
  const verifier = { verify };
  const queuedReplyResults = [...replyResults];
  const replyText = vi.fn<FeishuMessageReplier["replyText"]>(
    async () => {
      const result = queuedReplyResults.shift() ?? { replyMessageId: "reply-default" };
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  );
  const replier = { replyText };
  const service = createAnswerReplyDeliveryService({
    repository,
    verifier,
    replier,
    now: () => new Date(transitionAt.getTime()),
  });

  return { repository, verifier, replier, service };
}

function request(
  prepareAnswer: AnswerReplyDeliveryRequest["prepareAnswer"],
): AnswerReplyDeliveryRequest {
  return {
    provider: "feishu",
    incomingMessageId: "om_1",
    chatId: "oc_1",
    replyUuid: preparedReplyUuid,
    safeNoticeUuid,
    prepareAnswer,
  };
}

function preparedAnswer(overrides: Partial<Awaited<
  ReturnType<AnswerReplyDeliveryRequest["prepareAnswer"]>
>> = {}) {
  return {
    renderedText: preparedText,
    sourceTraces: [sourceTrace()],
    preparedAt,
    ...overrides,
  };
}

function twoSourceTraces(): AnswerReplySourceTraceInput[] {
  return [
    sourceTrace(),
    sourceTrace({
      promptRank: 2,
      citationRank: 2,
      documentSourceId: "source-b",
      documentSnapshotId: "snapshot-b",
      fragmentId: "fragment-b",
      sourceTitle: "SENSITIVE source B",
      sourceUri: "https://example.feishu.cn/wiki/source-b",
    }),
  ];
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
    sourceUri: "https://example.feishu.cn/wiki/SENSITIVE-source-a",
    sourceTitle: "SENSITIVE source A",
    contentHash: "a".repeat(64),
    embeddingProfileId: "embedding-profile-a",
    initialPermissionCheckedAt: new Date("2026-08-02T00:59:00.000Z"),
    ...overrides,
  };
}

function receipt(
  deliveryOverrides: Partial<AnswerReplyReceipt["delivery"]> = {},
  sourceTraces: AnswerReplySourceTraceInput[] = [sourceTrace()],
): AnswerReplyReceipt {
  return {
    delivery: {
      id: "delivery-1",
      provider: "feishu",
      incomingMessageId: "om_1",
      chatId: "oc_1",
      replyUuid: preparedReplyUuid,
      safeNoticeUuid,
      state: "prepared",
      preparedReplyText: preparedText,
      renderedReplyFingerprint: "b".repeat(64),
      semanticFingerprint: "c".repeat(64),
      attemptCount: 0,
      safeNoticeAttemptCount: 0,
      version: 1,
      createdAt: preparedAt,
      updatedAt: preparedAt,
      ...deliveryOverrides,
    },
    sources: sourceTraces.map((trace, index) => ({
      ...trace,
      id: `trace-${index + 1}`,
      deliveryId: "delivery-1",
    })),
    events: [{
      id: "event-1",
      deliveryId: "delivery-1",
      sequence: 1,
      eventType: "prepared",
      sourceCount: sourceTraces.length,
      documentSourceIds: [...new Set(sourceTraces.map(({ documentSourceId }) => documentSourceId))],
      createdAt: preparedAt,
    }],
  };
}

function expectOnlySafeNoticeWasSent(harness: Harness): void {
  const serializedCalls = JSON.stringify(harness.replier.replyText.mock.calls);
  expect(serializedCalls).not.toContain(preparedText);
  expect(serializedCalls).not.toContain("SENSITIVE source A");
  expect(serializedCalls).not.toContain("SENSITIVE-source-a");
  for (const [input] of harness.replier.replyText.mock.calls) {
    expect(input).toEqual({
      messageId: "om_1",
      text: ANSWER_PERMISSION_CHANGED_NOTICE,
      replyInThread: true,
      uuid: safeNoticeUuid,
    });
  }
}

class RecordingAnswerReplyRepository implements AnswerReplyRepository {
  receipt: AnswerReplyReceipt | undefined;

  findByIncomingMessage = vi.fn(async () => this.receipt);

  prepare = vi.fn(async (input: PrepareAnswerReplyInput) => {
    if (this.receipt === undefined) {
      this.receipt = receipt({}, [...input.sourceTraces]);
      this.receipt.delivery = {
        ...this.receipt.delivery,
        provider: input.provider,
        incomingMessageId: input.incomingMessageId,
        chatId: input.chatId,
        replyUuid: input.replyUuid,
        safeNoticeUuid: input.safeNoticeUuid,
        preparedReplyText: input.renderedText,
        createdAt: input.at,
        updatedAt: input.at,
      };
    }
    return { outcome: "applied" as const, receipt: this.receipt };
  });

  beginAnswerSend = vi.fn(async (input: VersionedTransitionInput) => {
    const current = this.requireReceipt();
    this.receipt = {
      ...current,
      delivery: {
        ...current.delivery,
        state: "sending",
        attemptCount: current.delivery.attemptCount + 1,
        version: current.delivery.version + 1,
        updatedAt: input.at,
        lastSendStartedAt: input.at,
      },
    };
    return this.receipt;
  });

  completeAnswerSend = vi.fn(async (input: VersionedTransitionInput & {
    replyMessageId?: string;
  }) => {
    const current = this.requireReceipt();
    this.receipt = {
      ...current,
      delivery: {
        ...current.delivery,
        state: "sent",
        preparedReplyText: undefined,
        ...(input.replyMessageId === undefined ? {} : { replyMessageId: input.replyMessageId }),
        version: current.delivery.version + 1,
        updatedAt: input.at,
        sentAt: input.at,
      },
    };
    return this.receipt;
  });

  blockForPermission = vi.fn(async (input: VersionedTransitionInput & {
    documentSourceIds: string[];
  }) => {
    const current = this.requireReceipt();
    const state = current.delivery.attemptCount === 0
      ? "permission_blocked" as const
      : "reconciliation_required" as const;
    this.receipt = {
      ...current,
      delivery: {
        ...current.delivery,
        state,
        preparedReplyText: undefined,
        version: current.delivery.version + 1,
        updatedAt: input.at,
        ...(state === "permission_blocked"
          ? { permissionBlockedAt: input.at }
          : { reconciliationRequiredAt: input.at }),
      },
    };
    return this.receipt;
  });

  beginSafeNoticeSend = vi.fn(async (input: VersionedTransitionInput) => {
    const current = this.requireReceipt();
    this.receipt = {
      ...current,
      delivery: {
        ...current.delivery,
        safeNoticeAttemptCount: current.delivery.safeNoticeAttemptCount + 1,
        version: current.delivery.version + 1,
        updatedAt: input.at,
      },
    };
    return this.receipt;
  });

  completeSafeNoticeSend = vi.fn(async (input: VersionedTransitionInput & {
    safeNoticeMessageId?: string;
  }) => {
    const current = this.requireReceipt();
    this.receipt = {
      ...current,
      delivery: {
        ...current.delivery,
        ...(input.safeNoticeMessageId === undefined
          ? {}
          : { safeNoticeMessageId: input.safeNoticeMessageId }),
        version: current.delivery.version + 1,
        updatedAt: input.at,
        safeNoticeSentAt: input.at,
      },
    };
    return this.receipt;
  });

  getStatus = vi.fn(async () => ({
    unresolvedCount: 0,
    pendingSafeNoticeCount: 0,
    reconciliationRequiredCount: 0,
  }));

  private requireReceipt(): AnswerReplyReceipt {
    if (this.receipt === undefined) {
      throw new Error("test receipt missing");
    }
    return this.receipt;
  }
}
