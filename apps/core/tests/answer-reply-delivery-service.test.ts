import { describe, expect, it, vi } from "vitest";

import {
  ANSWER_PERMISSION_CHANGED_NOTICE,
  createAnswerReplyDeliveryService,
  type AnswerReplyDeliveryRequest,
} from "../src/answer-replies/answer-reply-delivery-service.js";
import {
  createAnswerReplyEventId,
  createAnswerReplyRenderedFingerprint,
  createAnswerReplySemanticFingerprint,
  createAnswerReplySourceTraceId,
} from "../src/answer-replies/answer-reply-receipt-validator.js";
import type {
  AnswerReplyDeliveryEvent,
  AnswerReplyReceipt,
  AnswerReplyRepository,
  PrepareAnswerReplyInput,
  VersionedTransitionInput,
} from "../src/answer-replies/answer-reply-repository.js";
import {
  createAnswerReplyDeliveryId,
  createAnswerReplySafeNoticeUuid,
  createAnswerReplyUuid,
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
const incomingMessageId = "om_1";
const preparedDeliveryId = createAnswerReplyDeliveryId("feishu", incomingMessageId);
const preparedReplyUuid = createAnswerReplyUuid(incomingMessageId);
const safeNoticeUuid = createAnswerReplySafeNoticeUuid(incomingMessageId);

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
      deliveryId: preparedDeliveryId,
      expectedVersion: 3,
      replyMessageId: "reply-1",
      at: transitionAt,
    });
    expect(harness.repository.receipt?.delivery).toMatchObject({
      state: "sent",
      replyMessageId: "reply-1",
    });
  });

  it("serializes concurrent first preparation and makes the loser reload the receipt", async () => {
    const harness = createHarness();
    const firstPrepareStarted = createGate();
    const releaseFirstPrepare = createGate();
    const firstPrepare = vi.fn(async () => {
      firstPrepareStarted.open();
      await releaseFirstPrepare.promise;
      return preparedAnswer();
    });
    const losingPrepare = vi.fn(async () => preparedAnswer({
      renderedText: "CONCURRENT replacement answer",
    }));

    const firstResponse = harness.service.respond(request(firstPrepare));
    await firstPrepareStarted.promise;
    const losingResponse = harness.service.respond(request(losingPrepare));
    await nextTask();

    expect(losingPrepare).not.toHaveBeenCalled();
    expect(harness.repository.findByIncomingMessage).toHaveBeenCalledTimes(1);

    releaseFirstPrepare.open();
    await expect(Promise.all([firstResponse, losingResponse])).resolves.toEqual([
      { replyMessageId: "reply-default" },
      { replyMessageId: "reply-default" },
    ]);

    expect(firstPrepare).toHaveBeenCalledTimes(1);
    expect(losingPrepare).not.toHaveBeenCalled();
    expect(harness.repository.findByIncomingMessage).toHaveBeenCalledTimes(2);
    expect(harness.repository.prepare).toHaveBeenCalledTimes(1);
    expect(harness.replier.replyText).toHaveBeenCalledTimes(1);
  });

  it("releases a failed preparation key so a waiting caller can retry", async () => {
    const harness = createHarness();
    const firstPrepareStarted = createGate();
    const releaseFirstPrepare = createGate();
    const firstPrepare = vi.fn(async () => {
      firstPrepareStarted.open();
      await releaseFirstPrepare.promise;
      throw new Error("first preparation failed");
    });
    const retryPrepare = vi.fn(async () => preparedAnswer());

    const firstResponse = harness.service.respond(request(firstPrepare));
    const firstFailure = firstResponse.catch((error: unknown) => error);
    await firstPrepareStarted.promise;
    const retryResponse = harness.service.respond(request(retryPrepare));
    await nextTask();

    expect(retryPrepare).not.toHaveBeenCalled();
    releaseFirstPrepare.open();

    await expect(firstFailure).resolves.toMatchObject({
      message: "first preparation failed",
    });
    await expect(retryResponse).resolves.toEqual({ replyMessageId: "reply-default" });
    expect(firstPrepare).toHaveBeenCalledTimes(1);
    expect(retryPrepare).toHaveBeenCalledTimes(1);
    expect(harness.repository.findByIncomingMessage).toHaveBeenCalledTimes(2);
    expect(harness.repository.prepare).toHaveBeenCalledTimes(1);
  });

  it("rejects recursive same-key entry quickly and releases the key", async () => {
    const harness = createHarness();
    const nestedPrepare = vi.fn(async () => preparedAnswer());
    const recursivePrepare = vi.fn(async () => {
      await harness.service.respond(request(nestedPrepare));
      return preparedAnswer();
    });

    await expect(withTimeout(harness.service.respond(request(recursivePrepare))))
      .rejects.toThrow("answer reply delivery contract invalid");

    expect(nestedPrepare).not.toHaveBeenCalled();
    await expect(harness.service.respond(request(vi.fn(async () => preparedAnswer()))))
      .resolves.toEqual({ replyMessageId: "reply-default" });
  });

  it("allows inherited same-key work after its ancestor response is complete", async () => {
    const harness = createHarness();
    const releaseDelayedCall = createGate();
    const delayedPrepare = vi.fn(async () => preparedAnswer({
      renderedText: "delayed replacement must not run",
    }));
    let resolveDelayed!: (value: { replyMessageId?: string }) => void;
    let rejectDelayed!: (error: unknown) => void;
    const delayedResult = new Promise<{ replyMessageId?: string }>((resolve, reject) => {
      resolveDelayed = resolve;
      rejectDelayed = reject;
    });
    const firstPrepare = vi.fn(async () => {
      setTimeout(async () => {
        await releaseDelayedCall.promise;
        try {
          resolveDelayed(await harness.service.respond(request(delayedPrepare)));
        } catch (error) {
          rejectDelayed(error);
        }
      }, 0);
      return preparedAnswer();
    });

    await expect(harness.service.respond(request(firstPrepare))).resolves.toEqual({
      replyMessageId: "reply-default",
    });
    releaseDelayedCall.open();

    await expect(withTimeout(delayedResult)).resolves.toEqual({
      replyMessageId: "reply-default",
    });
    expect(delayedPrepare).not.toHaveBeenCalled();
    expect(harness.repository.findByIncomingMessage).toHaveBeenCalledTimes(2);
    expect(harness.replier.replyText).toHaveBeenCalledTimes(1);
  });

  it("allows different delivery keys to progress concurrently", async () => {
    const harness = createHarness();
    const firstPrepareStarted = createGate();
    const releaseFirstPrepare = createGate();
    const firstPrepare = vi.fn(async () => {
      firstPrepareStarted.open();
      await releaseFirstPrepare.promise;
      return preparedAnswer();
    });
    const secondPrepare = vi.fn(async () => preparedAnswer());

    const firstResponse = harness.service.respond(request(firstPrepare));
    await firstPrepareStarted.promise;
    const secondResponse = harness.service.respond(request(secondPrepare, {
      incomingMessageId: "om_2",
      chatId: "oc_2",
      replyUuid: createAnswerReplyUuid("om_2"),
      safeNoticeUuid: createAnswerReplySafeNoticeUuid("om_2"),
    }));

    await expect(withTimeout(secondResponse)).resolves.toEqual({
      replyMessageId: "reply-default",
    });
    expect(secondPrepare).toHaveBeenCalledTimes(1);

    releaseFirstPrepare.open();
    await expect(firstResponse).resolves.toEqual({ replyMessageId: "reply-default" });
  });

  it.each([
    ["incoming message", () => receipt({ incomingMessageId: "om_foreign" })],
    ["chat", () => receipt({ chatId: "oc_foreign" })],
    ["delivery ID", () => receipt({ id: "foreign-delivery" })],
    ["reply UUID", () => receipt({ replyUuid: "foreign-reply-uuid" })],
    ["safe-notice UUID", () => receipt({ safeNoticeUuid: "foreign-safe-uuid" })],
  ] satisfies Array<[string, () => AnswerReplyReceipt]>)(
    "rejects a lookup receipt with foreign %s before dispatch",
    async (_label, malformedReceipt) => {
      const harness = createHarness();
      harness.repository.receipt = malformedReceipt();
      const prepareAnswer = vi.fn(async () => preparedAnswer());

      const error = await harness.service.respond(request(prepareAnswer))
        .catch((caught) => caught);

      expectStableContractError(error);
      expect(prepareAnswer).not.toHaveBeenCalled();
      expectNoDispatchCalls(harness);
    },
  );

  it.each([
    ["version without events", (value: AnswerReplyReceipt) => withDelivery(value, {
      version: 99,
    })],
    ["dropped event ledger", (value: AnswerReplyReceipt) => ({ ...value, events: [] })],
    ["event sequence", (value: AnswerReplyReceipt) => changeEvent(value, 0, {
      sequence: 2,
    })],
    ["event type", (value: AnswerReplyReceipt) => changeEvent(value, 0, {
      eventType: "sent",
    })],
    ["event attempt", (value: AnswerReplyReceipt) => changeEvent(value, 0, {
      attemptNumber: 1,
    })],
    ["event source facts", (value: AnswerReplyReceipt) => changeEvent(value, 0, {
      documentSourceIds: ["source-foreign"],
    })],
    ["event timestamp", (value: AnswerReplyReceipt) => changeEvent(value, 0, {
      createdAt: transitionAt,
    })],
  ] satisfies Array<[string, (value: AnswerReplyReceipt) => AnswerReplyReceipt]>)(
    "rejects loaded receipt corruption with %s before dispatch",
    async (_label, mutate) => {
      const harness = createHarness();
      harness.repository.receipt = mutate(receipt());

      const error = await harness.service.respond(request(vi.fn())).catch((caught) => caught);

      expectStableContractError(error);
      expectNoDispatchCalls(harness);
    },
  );

  it.each([
    ["reply UUID", { replyUuid: "foreign-request-reply-uuid" }],
    ["safe-notice UUID", { safeNoticeUuid: "foreign-request-safe-uuid" }],
  ] satisfies Array<[
    string,
    Partial<Omit<AnswerReplyDeliveryRequest, "prepareAnswer">>,
  ]>)("rejects a nondeterministic request %s before dispatch", async (_label, overrides) => {
    const harness = createHarness();
    harness.repository.receipt = receipt();

    const error = await harness.service.respond(request(vi.fn(), overrides))
      .catch((caught) => caught);

    expectStableContractError(error);
    expectNoDispatchCalls(harness);
  });

  it.each([
    ["missing envelope", undefined],
    ["null envelope", null],
    ["missing outcome", { receipt: receipt() }],
    ["unknown outcome", { outcome: "foreign", receipt: receipt() }],
    ["missing receipt", { outcome: "applied" }],
  ])("rejects a prepare result with %s before dispatch", async (_label, result) => {
    const harness = createHarness();
    harness.repository.prepare.mockResolvedValueOnce(result as never);

    const error = await harness.service.respond(request(vi.fn(async () => preparedAnswer())))
      .catch((caught) => caught);

    expectStableContractError(error);
    expectNoDispatchCalls(harness);
  });

  it.each([
    ["provider", (value: AnswerReplyReceipt) => withDelivery(value, {
      provider: "foreign" as never,
    })],
    ["incoming message", (value: AnswerReplyReceipt) => withDelivery(value, {
      incomingMessageId: "om_foreign",
    })],
    ["chat", (value: AnswerReplyReceipt) => withDelivery(value, { chatId: "oc_foreign" })],
    ["reply UUID", (value: AnswerReplyReceipt) => withDelivery(value, {
      replyUuid: "foreign-reply-uuid",
    })],
    ["safe-notice UUID", (value: AnswerReplyReceipt) => withDelivery(value, {
      safeNoticeUuid: "foreign-safe-uuid",
    })],
    ["rendered fingerprint", (value: AnswerReplyReceipt) => withDelivery(value, {
      renderedReplyFingerprint: createAnswerReplyRenderedFingerprint("foreign answer"),
    })],
    ["prepared text", (value: AnswerReplyReceipt) => withDelivery(value, {
      preparedReplyText: "foreign answer",
    })],
    ["source facts", changeFirstSource],
  ] satisfies Array<[string, (value: AnswerReplyReceipt) => AnswerReplyReceipt]>)(
    "rejects a prepare receipt with mutated %s before dispatch",
    async (_label, mutate) => {
      const harness = createHarness();
      const malformed = mutate(receipt());
      harness.repository.prepare.mockResolvedValueOnce({
        outcome: "applied",
        receipt: malformed,
      });

      const error = await harness.service.respond(request(vi.fn(async () => preparedAnswer())))
        .catch((caught) => caught);

      expectStableContractError(error);
      expectNoDispatchCalls(harness);
    },
  );

  it("rejects an applied prepare receipt with a foreign preparation timestamp", async () => {
    const harness = createHarness();
    const malformed = receipt();
    malformed.delivery.createdAt = transitionAt;
    malformed.delivery.updatedAt = transitionAt;
    malformed.events[0]!.createdAt = transitionAt;
    harness.repository.prepare.mockResolvedValueOnce({
      outcome: "applied",
      receipt: malformed,
    });

    const error = await harness.service.respond(request(vi.fn(async () => preparedAnswer())))
      .catch((caught) => caught);

    expectStableContractError(error);
    expectNoDispatchCalls(harness);
  });

  it("rejects an applied prepare receipt that has already progressed", async () => {
    const harness = createHarness();
    harness.repository.prepare.mockResolvedValueOnce({
      outcome: "applied",
      receipt: beginAnswerReceipt(receipt()),
    });

    const error = await harness.service.respond(request(vi.fn(async () => preparedAnswer())))
      .catch((caught) => caught);

    expectStableContractError(error);
    expectNoDispatchCalls(harness);
  });

  it("accepts an exact already-applied prepare receipt that has progressed", async () => {
    const harness = createHarness();
    const progressed = beginAnswerReceipt(receipt());
    harness.repository.receipt = progressed;
    harness.repository.findByIncomingMessage.mockResolvedValueOnce(undefined);
    const prepareResult: Awaited<ReturnType<AnswerReplyRepository["prepare"]>> = {
      outcome: "already_applied",
      receipt: progressed,
    };
    harness.repository.prepare.mockResolvedValueOnce(prepareResult);

    await expect(harness.service.respond(request(vi.fn(async () => preparedAnswer()))))
      .resolves.toEqual({ replyMessageId: "reply-default" });

    expect(harness.verifier.verify).toHaveBeenCalledTimes(1);
    expect(harness.replier.replyText).toHaveBeenCalledTimes(1);
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
        deliveryId: preparedDeliveryId,
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
      deliveryId: preparedDeliveryId,
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
      deliveryId: preparedDeliveryId,
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
      deliveryId: preparedDeliveryId,
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
    harness.repository.receipt = completedAnswerReceipt(
      beginAnswerReceipt(receipt(), preparedAt),
      "stored-reply-id",
    );
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
      const blocked = state === "permission_blocked"
        ? blockedReceipt(receipt(), ["source-a"], preparedAt)
        : blockedReceipt(beginAnswerReceipt(receipt(), preparedAt));
      harness.repository.receipt = completedSafeNoticeReceipt(
        beginSafeNoticeReceipt(blocked),
        "stored-safe-id",
      );
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

  it.each([
    ["prepared answer attempts", () => receipt({ attemptCount: 1 })],
    ["prepared safe-notice attempts", () => receipt({ safeNoticeAttemptCount: 1 })],
    ["prepared lifecycle timestamp", () => receipt({ sentAt: transitionAt })],
    ["sending without attempts", () => receipt({
      state: "sending",
      attemptCount: 0,
      lastSendStartedAt: transitionAt,
      updatedAt: transitionAt,
    })],
    ["sending without a start timestamp", () => receipt({
      state: "sending",
      attemptCount: 1,
      version: 2,
      updatedAt: transitionAt,
    })],
    ["sent without attempts", () => receipt({
      state: "sent",
      preparedReplyText: undefined,
      sentAt: transitionAt,
      updatedAt: transitionAt,
    })],
    ["permission-blocked answer attempts", () => receipt({
      state: "permission_blocked",
      preparedReplyText: undefined,
      attemptCount: 1,
      permissionBlockedAt: transitionAt,
      updatedAt: transitionAt,
    })],
    ["reconciliation without attempts", () => receipt({
      state: "reconciliation_required",
      preparedReplyText: undefined,
      reconciliationRequiredAt: transitionAt,
      updatedAt: transitionAt,
    })],
    ["notice timestamp without notice attempt", () => receipt({
      state: "permission_blocked",
      preparedReplyText: undefined,
      permissionBlockedAt: transitionAt,
      safeNoticeSentAt: transitionAt,
      updatedAt: transitionAt,
    })],
    ["notice ID without notice timestamp", () => receipt({
      state: "permission_blocked",
      preparedReplyText: undefined,
      permissionBlockedAt: transitionAt,
      safeNoticeAttemptCount: 1,
      safeNoticeMessageId: "orphan-notice-id",
      updatedAt: transitionAt,
    })],
    ["completed notice with stale sent timestamp", () => receipt({
      state: "permission_blocked",
      preparedReplyText: undefined,
      permissionBlockedAt: preparedAt,
      safeNoticeAttemptCount: 1,
      safeNoticeSentAt: preparedAt,
      updatedAt: transitionAt,
    })],
  ] satisfies Array<[string, () => AnswerReplyReceipt]>)(
    "rejects a loaded receipt with impossible %s before dispatch",
    async (_label, malformedReceipt) => {
      const harness = createHarness();
      harness.repository.receipt = malformedReceipt();

      const error = await harness.service.respond(request(vi.fn())).catch((caught) => caught);

      expectStableContractError(error);
      expectNoDispatchCalls(harness);
    },
  );

  it.each([
    ["stale version", (value: AnswerReplyReceipt) => withDelivery(value, { version: 2 })],
    ["unchanged attempt count", (value: AnswerReplyReceipt) => withDelivery(value, {
      attemptCount: 1,
    })],
    ["changed safe-notice count", (value: AnswerReplyReceipt) => withDelivery(value, {
      safeNoticeAttemptCount: 1,
    })],
    ["changed prepared text", (value: AnswerReplyReceipt) => withDelivery(value, {
      preparedReplyText: "MUTATED prepared answer",
    })],
    ["changed fingerprint", (value: AnswerReplyReceipt) => withDelivery(value, {
      renderedReplyFingerprint: "d".repeat(64),
    })],
    ["changed source facts", changeFirstSource],
    ["malformed source timestamp", changeFirstSourceTimestamp],
    ["foreign event identity", changeFirstEventDelivery],
    ["changed immutable UUID", (value: AnswerReplyReceipt) => withDelivery(value, {
      replyUuid: "mutated-reply-uuid",
    })],
    ["stale updated timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      updatedAt: preparedAt,
    })],
    ["missing send-start timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      lastSendStartedAt: undefined,
    })],
    ["stale send-start timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      lastSendStartedAt: preparedAt,
    })],
    ["introduced sent timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      sentAt: transitionAt,
    })],
    ["dropped new event", dropLastEvent],
    ["mutated prior event prefix", changePriorSendEventTimestamp],
  ] satisfies Array<[string, (value: AnswerReplyReceipt) => AnswerReplyReceipt]>)(
    "rejects beginAnswerSend with %s before calling Feishu",
    async (_label, mutate) => {
      const harness = createHarness();
      const prior = beginAnswerReceipt(receipt(), preparedAt);
      harness.repository.receipt = prior;
      const valid = beginAnswerReceipt(prior);
      harness.repository.beginAnswerSend.mockResolvedValueOnce(mutate(valid));

      await expect(harness.service.respond(request(vi.fn())))
        .rejects.toThrow("answer reply delivery contract invalid");

      expect(harness.replier.replyText).not.toHaveBeenCalled();
      expect(harness.repository.completeAnswerSend).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["wrong blocked state", (value: AnswerReplyReceipt) => withDelivery(value, {
      state: "reconciliation_required",
      permissionBlockedAt: undefined,
      reconciliationRequiredAt: transitionAt,
    })],
    ["stale version", (value: AnswerReplyReceipt) => withDelivery(value, { version: 1 })],
    ["changed answer attempt count", (value: AnswerReplyReceipt) => withDelivery(value, {
      attemptCount: 1,
    })],
    ["changed safe-notice count", (value: AnswerReplyReceipt) => withDelivery(value, {
      safeNoticeAttemptCount: 1,
    })],
    ["retained prepared text", (value: AnswerReplyReceipt) => withDelivery(value, {
      preparedReplyText: preparedText,
    })],
    ["missing blocked timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      permissionBlockedAt: undefined,
    })],
    ["changed source facts", changeFirstSource],
    ["stale updated timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      updatedAt: preparedAt,
    })],
    ["stale blocked timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      permissionBlockedAt: preparedAt,
    })],
    ["introduced unrelated timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      reconciliationRequiredAt: transitionAt,
    })],
    ["dropped new event", dropLastEvent],
  ] satisfies Array<[string, (value: AnswerReplyReceipt) => AnswerReplyReceipt]>)(
    "rejects blockForPermission with %s before sending a notice",
    async (_label, mutate) => {
      const harness = createHarness({
        verifierResults: [[{ documentSourceId: "source-a", outcome: "denied" }]],
      });
      const prior = receipt();
      const malformed = mutate(blockedReceipt(prior));
      harness.repository.receipt = prior;
      harness.repository.blockForPermission.mockImplementationOnce(async () => {
        harness.repository.receipt = malformed;
        return malformed;
      });

      await expect(harness.service.respond(request(vi.fn())))
        .rejects.toThrow("answer reply delivery contract invalid");

      expect(harness.repository.beginSafeNoticeSend).not.toHaveBeenCalled();
      expect(harness.replier.replyText).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["stale version", (value: AnswerReplyReceipt) => withDelivery(value, { version: 2 })],
    ["unchanged safe-notice count", (value: AnswerReplyReceipt) => withDelivery(value, {
      safeNoticeAttemptCount: 0,
    })],
    ["changed answer attempt count", (value: AnswerReplyReceipt) => withDelivery(value, {
      attemptCount: 1,
    })],
    ["changed blocked state", (value: AnswerReplyReceipt) => withDelivery(value, {
      state: "reconciliation_required",
      permissionBlockedAt: undefined,
      reconciliationRequiredAt: transitionAt,
    })],
    ["restored prepared text", (value: AnswerReplyReceipt) => withDelivery(value, {
      preparedReplyText: preparedText,
    })],
    ["changed fingerprint", (value: AnswerReplyReceipt) => withDelivery(value, {
      renderedReplyFingerprint: "d".repeat(64),
    })],
    ["changed source facts", changeFirstSource],
    ["stale updated timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      updatedAt: preparedAt,
    })],
    ["changed blocked timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      permissionBlockedAt: preparedAt,
    })],
    ["introduced answer timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      sentAt: transitionAt,
    })],
    ["dropped new event", dropLastEvent],
  ] satisfies Array<[string, (value: AnswerReplyReceipt) => AnswerReplyReceipt]>)(
    "rejects beginSafeNoticeSend with %s before calling Feishu",
    async (_label, mutate) => {
      const harness = createHarness();
      const prior = blockedReceipt(receipt());
      harness.repository.receipt = prior;
      harness.repository.beginSafeNoticeSend.mockResolvedValueOnce(
        mutate(beginSafeNoticeReceipt(prior)),
      );

      await expect(harness.service.respond(request(vi.fn())))
        .rejects.toThrow("answer reply delivery contract invalid");

      expect(harness.replier.replyText).not.toHaveBeenCalled();
      expect(harness.repository.completeSafeNoticeSend).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["stale version", (value: AnswerReplyReceipt) => withDelivery(value, { version: 2 })],
    ["changed answer attempt count", (value: AnswerReplyReceipt) => withDelivery(value, {
      attemptCount: 2,
    })],
    ["changed safe-notice count", (value: AnswerReplyReceipt) => withDelivery(value, {
      safeNoticeAttemptCount: 1,
    })],
    ["retained prepared text", (value: AnswerReplyReceipt) => withDelivery(value, {
      preparedReplyText: preparedText,
    })],
    ["missing sent timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      sentAt: undefined,
    })],
    ["changed source facts", changeFirstSource],
    ["stale updated timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      updatedAt: preparedAt,
    })],
    ["stale sent timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      sentAt: preparedAt,
    })],
    ["changed send-start timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      lastSendStartedAt: preparedAt,
    })],
    ["introduced unrelated timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      permissionBlockedAt: transitionAt,
    })],
    ["dropped new event", dropLastEvent],
  ] satisfies Array<[string, (value: AnswerReplyReceipt) => AnswerReplyReceipt]>)(
    "rejects completeAnswerSend with %s after the single Feishu call",
    async (_label, mutate) => {
      const harness = createHarness();
      const prior = receipt();
      harness.repository.receipt = prior;
      const sending = beginAnswerReceipt(prior);
      harness.repository.beginAnswerSend.mockImplementationOnce(async () => {
        harness.repository.receipt = sending;
        return sending;
      });
      harness.repository.completeAnswerSend.mockResolvedValueOnce(
        mutate(completedAnswerReceipt(sending, "reply-default")),
      );

      await expect(harness.service.respond(request(vi.fn())))
        .rejects.toThrow("answer reply delivery contract invalid");

      expect(harness.replier.replyText).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["stale version", (value: AnswerReplyReceipt) => withDelivery(value, { version: 3 })],
    ["changed answer attempt count", (value: AnswerReplyReceipt) => withDelivery(value, {
      attemptCount: 1,
    })],
    ["changed safe-notice count", (value: AnswerReplyReceipt) => withDelivery(value, {
      safeNoticeAttemptCount: 2,
    })],
    ["changed blocked state", (value: AnswerReplyReceipt) => withDelivery(value, {
      state: "reconciliation_required",
      permissionBlockedAt: undefined,
      reconciliationRequiredAt: transitionAt,
    })],
    ["restored prepared text", (value: AnswerReplyReceipt) => withDelivery(value, {
      preparedReplyText: preparedText,
    })],
    ["missing notice timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      safeNoticeSentAt: undefined,
    })],
    ["changed source facts", changeFirstSource],
    ["stale updated timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      updatedAt: preparedAt,
    })],
    ["stale notice timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      safeNoticeSentAt: preparedAt,
    })],
    ["changed blocked timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      permissionBlockedAt: preparedAt,
    })],
    ["introduced answer timestamp", (value: AnswerReplyReceipt) => withDelivery(value, {
      sentAt: transitionAt,
    })],
    ["dropped new event", dropLastEvent],
  ] satisfies Array<[string, (value: AnswerReplyReceipt) => AnswerReplyReceipt]>)(
    "rejects completeSafeNoticeSend with %s after the single Feishu call",
    async (_label, mutate) => {
      const harness = createHarness({
        replyResults: [{ replyMessageId: "safe-message-id" }],
      });
      const prior = blockedReceipt(receipt());
      harness.repository.receipt = prior;
      const sending = beginSafeNoticeReceipt(prior);
      harness.repository.beginSafeNoticeSend.mockImplementationOnce(async () => {
        harness.repository.receipt = sending;
        return sending;
      });
      harness.repository.completeSafeNoticeSend.mockResolvedValueOnce(
        mutate(completedSafeNoticeReceipt(sending, "safe-message-id")),
      );

      await expect(harness.service.respond(request(vi.fn())))
        .rejects.toThrow("answer reply delivery contract invalid");

      expect(harness.replier.replyText).toHaveBeenCalledTimes(1);
      expect(harness.replier.replyText).toHaveBeenCalledWith({
        messageId: "om_1",
        text: ANSWER_PERMISSION_CHANGED_NOTICE,
        replyInThread: true,
        uuid: safeNoticeUuid,
      });
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
  overrides: Partial<Omit<AnswerReplyDeliveryRequest, "prepareAnswer">> = {},
): AnswerReplyDeliveryRequest {
  return {
    provider: "feishu",
    incomingMessageId: "om_1",
    chatId: "oc_1",
    replyUuid: preparedReplyUuid,
    safeNoticeUuid,
    ...overrides,
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
  const provider = deliveryOverrides.provider ?? "feishu";
  const receiptIncomingMessageId = deliveryOverrides.incomingMessageId ?? incomingMessageId;
  const receiptChatId = deliveryOverrides.chatId ?? "oc_1";
  const deliveryId = deliveryOverrides.id
    ?? createAnswerReplyDeliveryId("feishu", receiptIncomingMessageId);
  const renderedReplyFingerprint = deliveryOverrides.renderedReplyFingerprint
    ?? createAnswerReplyRenderedFingerprint(preparedText);
  const semanticFingerprint = deliveryOverrides.semanticFingerprint
    ?? createAnswerReplySemanticFingerprint({
      provider: "feishu",
      incomingMessageId: receiptIncomingMessageId,
      chatId: receiptChatId,
      renderedReplyFingerprint,
      sourceTraces,
    });
  return {
    delivery: {
      id: deliveryId,
      provider,
      incomingMessageId: receiptIncomingMessageId,
      chatId: receiptChatId,
      replyUuid: deliveryOverrides.replyUuid
        ?? createAnswerReplyUuid(receiptIncomingMessageId),
      safeNoticeUuid: deliveryOverrides.safeNoticeUuid
        ?? createAnswerReplySafeNoticeUuid(receiptIncomingMessageId),
      state: "prepared",
      preparedReplyText: preparedText,
      renderedReplyFingerprint,
      semanticFingerprint,
      attemptCount: 0,
      safeNoticeAttemptCount: 0,
      version: 1,
      createdAt: preparedAt,
      updatedAt: preparedAt,
      ...deliveryOverrides,
    },
    sources: sourceTraces.map((trace, index) => ({
      ...trace,
      id: createAnswerReplySourceTraceId(deliveryId, index + 1),
      deliveryId,
    })),
    events: [{
      id: createAnswerReplyEventId(deliveryId, 1),
      deliveryId,
      sequence: 1,
      eventType: "prepared",
      sourceCount: sourceTraces.length,
      documentSourceIds: [...new Set(sourceTraces.map(({ documentSourceId }) => documentSourceId))],
      createdAt: preparedAt,
    }],
  };
}

function withDelivery(
  value: AnswerReplyReceipt,
  overrides: Partial<AnswerReplyReceipt["delivery"]>,
): AnswerReplyReceipt {
  return {
    ...value,
    delivery: { ...value.delivery, ...overrides },
  };
}

function beginAnswerReceipt(
  prior: AnswerReplyReceipt,
  at = transitionAt,
): AnswerReplyReceipt {
  const updated = withDelivery(prior, {
    state: "sending",
    attemptCount: prior.delivery.attemptCount + 1,
    version: prior.delivery.version + 1,
    lastSendStartedAt: at,
    updatedAt: at,
  });
  return appendEvent(updated, prior, "send_started", at, {
    attemptNumber: updated.delivery.attemptCount,
  });
}

function completedAnswerReceipt(
  prior: AnswerReplyReceipt,
  replyMessageId: string | undefined,
  at = transitionAt,
): AnswerReplyReceipt {
  const updated = withDelivery(prior, {
    state: "sent",
    preparedReplyText: undefined,
    replyMessageId,
    version: prior.delivery.version + 1,
    sentAt: at,
    updatedAt: at,
  });
  return appendEvent(updated, prior, "sent", at);
}

function blockedReceipt(
  prior: AnswerReplyReceipt,
  documentSourceIds = uniqueSourceIds(prior),
  at = transitionAt,
): AnswerReplyReceipt {
  const state = prior.delivery.attemptCount === 0
    ? "permission_blocked" as const
    : "reconciliation_required" as const;
  const updated = withDelivery(prior, {
    state,
    preparedReplyText: undefined,
    version: prior.delivery.version + 1,
    updatedAt: at,
    ...(state === "permission_blocked"
      ? { permissionBlockedAt: at }
      : { reconciliationRequiredAt: at }),
  });
  return appendEvent(updated, prior, state, at, { documentSourceIds });
}

function beginSafeNoticeReceipt(
  prior: AnswerReplyReceipt,
  at = transitionAt,
): AnswerReplyReceipt {
  const updated = withDelivery(prior, {
    safeNoticeAttemptCount: prior.delivery.safeNoticeAttemptCount + 1,
    version: prior.delivery.version + 1,
    updatedAt: at,
  });
  return appendEvent(updated, prior, "safe_notice_send_started", at, {
    attemptNumber: updated.delivery.safeNoticeAttemptCount,
  });
}

function completedSafeNoticeReceipt(
  prior: AnswerReplyReceipt,
  safeNoticeMessageId: string | undefined,
  at = transitionAt,
): AnswerReplyReceipt {
  const updated = withDelivery(prior, {
    safeNoticeMessageId,
    safeNoticeSentAt: at,
    version: prior.delivery.version + 1,
    updatedAt: at,
  });
  return appendEvent(updated, prior, "safe_notice_sent", at);
}

function appendEvent(
  updated: AnswerReplyReceipt,
  prior: AnswerReplyReceipt,
  eventType: AnswerReplyDeliveryEvent["eventType"],
  at: Date,
  {
    attemptNumber,
    documentSourceIds = uniqueSourceIds(prior),
  }: {
    attemptNumber?: number;
    documentSourceIds?: string[];
  } = {},
): AnswerReplyReceipt {
  const sequence = prior.delivery.version + 1;
  return {
    ...updated,
    events: [
      ...prior.events,
      {
        id: createAnswerReplyEventId(prior.delivery.id, sequence),
        deliveryId: prior.delivery.id,
        sequence,
        eventType,
        ...(attemptNumber === undefined ? {} : { attemptNumber }),
        sourceCount: prior.sources.length,
        documentSourceIds,
        createdAt: at,
      },
    ],
  };
}

function uniqueSourceIds(receiptValue: AnswerReplyReceipt): string[] {
  return [...new Set(receiptValue.sources.map(({ documentSourceId }) => documentSourceId))];
}

function changeFirstSource(value: AnswerReplyReceipt): AnswerReplyReceipt {
  return {
    ...value,
    sources: value.sources.map((source, index) => index === 0
      ? { ...source, documentSnapshotId: "mutated-snapshot" }
      : source),
  };
}

function changeFirstSourceTimestamp(value: AnswerReplyReceipt): AnswerReplyReceipt {
  return {
    ...value,
    sources: value.sources.map((source, index) => index === 0
      ? { ...source, initialPermissionCheckedAt: "invalid-date" as never }
      : source),
  };
}

function changeFirstEventDelivery(value: AnswerReplyReceipt): AnswerReplyReceipt {
  return {
    ...value,
    events: value.events.map((event, index) => index === 0
      ? { ...event, deliveryId: "foreign-delivery" }
      : event),
  };
}

function changeEvent(
  value: AnswerReplyReceipt,
  index: number,
  overrides: Partial<AnswerReplyDeliveryEvent>,
): AnswerReplyReceipt {
  return {
    ...value,
    events: value.events.map((event, eventIndex) => eventIndex === index
      ? { ...event, ...overrides }
      : event),
  };
}

function dropLastEvent(value: AnswerReplyReceipt): AnswerReplyReceipt {
  return { ...value, events: value.events.slice(0, -1) };
}

function changePriorSendEventTimestamp(value: AnswerReplyReceipt): AnswerReplyReceipt {
  return changeEvent(value, 1, { createdAt: transitionAt });
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

function expectStableContractError(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("answer reply delivery contract invalid");
  expect((error as Error).message).not.toContain(preparedText);
  expect((error as Error).message).not.toContain("source-a");
}

function expectNoDispatchCalls(harness: Harness): void {
  expect(harness.verifier.verify).not.toHaveBeenCalled();
  expect(harness.repository.beginAnswerSend).not.toHaveBeenCalled();
  expect(harness.repository.completeAnswerSend).not.toHaveBeenCalled();
  expect(harness.repository.blockForPermission).not.toHaveBeenCalled();
  expect(harness.repository.beginSafeNoticeSend).not.toHaveBeenCalled();
  expect(harness.repository.completeSafeNoticeSend).not.toHaveBeenCalled();
  expect(harness.replier.replyText).not.toHaveBeenCalled();
}

function createGate(): { promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function nextTask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("test timed out")), 100);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timeout);
  }
}

class RecordingAnswerReplyRepository implements AnswerReplyRepository {
  private readonly receipts = new Map<string, AnswerReplyReceipt>();

  get receipt(): AnswerReplyReceipt | undefined {
    return this.receipts.get(receiptKey("feishu", "om_1"));
  }

  set receipt(value: AnswerReplyReceipt | undefined) {
    const key = receiptKey("feishu", "om_1");
    if (value === undefined) {
      this.receipts.delete(key);
    } else {
      this.receipts.set(key, value);
    }
  }

  findByIncomingMessage = vi.fn(async (input: {
    provider: "feishu";
    incomingMessageId: string;
  }) => this.receipts.get(receiptKey(input.provider, input.incomingMessageId)));

  prepare = vi.fn(async (
    input: PrepareAnswerReplyInput,
  ): ReturnType<AnswerReplyRepository["prepare"]> => {
    const key = receiptKey(input.provider, input.incomingMessageId);
    let current = this.receipts.get(key);
    if (current === undefined) {
      current = receipt({
        id: createAnswerReplyDeliveryId(input.provider, input.incomingMessageId),
        provider: input.provider,
        incomingMessageId: input.incomingMessageId,
        chatId: input.chatId,
        replyUuid: input.replyUuid,
        safeNoticeUuid: input.safeNoticeUuid,
        preparedReplyText: input.renderedText,
        renderedReplyFingerprint: createAnswerReplyRenderedFingerprint(input.renderedText),
        createdAt: input.at,
        updatedAt: input.at,
      }, [...input.sourceTraces]);
      this.receipts.set(key, current);
    }
    return { outcome: "applied", receipt: current };
  });

  beginAnswerSend = vi.fn(async (
    input: VersionedTransitionInput,
  ): Promise<AnswerReplyReceipt> => {
    const current = this.requireReceipt(input.deliveryId);
    const updated = beginAnswerReceipt(current, input.at);
    this.storeReceipt(updated);
    return updated;
  });

  completeAnswerSend = vi.fn(async (
    input: VersionedTransitionInput & { replyMessageId?: string },
  ): Promise<AnswerReplyReceipt> => {
    const current = this.requireReceipt(input.deliveryId);
    const updated = completedAnswerReceipt(current, input.replyMessageId, input.at);
    this.storeReceipt(updated);
    return updated;
  });

  blockForPermission = vi.fn(async (
    input: VersionedTransitionInput & { documentSourceIds: string[] },
  ): Promise<AnswerReplyReceipt> => {
    const current = this.requireReceipt(input.deliveryId);
    const updated = blockedReceipt(current, input.documentSourceIds, input.at);
    this.storeReceipt(updated);
    return updated;
  });

  beginSafeNoticeSend = vi.fn(async (
    input: VersionedTransitionInput,
  ): Promise<AnswerReplyReceipt> => {
    const current = this.requireReceipt(input.deliveryId);
    const updated = beginSafeNoticeReceipt(current, input.at);
    this.storeReceipt(updated);
    return updated;
  });

  completeSafeNoticeSend = vi.fn(async (
    input: VersionedTransitionInput & { safeNoticeMessageId?: string },
  ): Promise<AnswerReplyReceipt> => {
    const current = this.requireReceipt(input.deliveryId);
    const updated = completedSafeNoticeReceipt(
      current,
      input.safeNoticeMessageId,
      input.at,
    );
    this.storeReceipt(updated);
    return updated;
  });

  getStatus = vi.fn(async () => ({
    unresolvedCount: 0,
    pendingSafeNoticeCount: 0,
    reconciliationRequiredCount: 0,
  }));

  private requireReceipt(deliveryId: string): AnswerReplyReceipt {
    const current = [...this.receipts.values()].find(
      ({ delivery }) => delivery.id === deliveryId,
    );
    if (current === undefined) {
      throw new Error("test receipt missing");
    }
    return current;
  }

  private storeReceipt(value: AnswerReplyReceipt): void {
    this.receipts.set(
      receiptKey(value.delivery.provider, value.delivery.incomingMessageId),
      value,
    );
  }
}

function receiptKey(provider: string, incomingMessageId: string): string {
  return JSON.stringify([provider, incomingMessageId]);
}
