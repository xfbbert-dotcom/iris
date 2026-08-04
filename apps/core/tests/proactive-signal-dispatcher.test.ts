import { describe, expect, it, vi } from "vitest";

import type { AgentExecutionObserver } from "../src/agent-runtime/agent-execution-observer.js";
import { FeishuInteractiveCardClientError } from "../src/feishu/feishu-interactive-card-client.js";
import { createProactiveSignalDispatcher } from "../src/proactive-signals/proactive-signal-dispatcher.js";
import type {
  ProactiveSignalDeliveryClaim,
  ProactiveSignalDeliveryContext,
} from "../src/proactive-signals/proactive-signal-repository.js";

const now = new Date("2026-07-23T10:00:00.000Z");

describe("ProactiveSignalDispatcher", () => {
  it("sends one approved candidate to the exact group only after the runtime gate passes twice", async () => {
    const order: string[] = [];
    const canDeliver = vi.fn(() => {
      order.push("gate");
      return true;
    });
    const harness = createHarness({
      canDeliver,
      getContext: async () => {
        order.push("context");
        return deliveryContext();
      },
      begin: async () => {
        order.push("begin");
        return { status: "authorized" };
      },
      send: async (input) => {
        order.push("send");
        expect(input.chatId).toBe("group-a");
        expect(input.cardJson).toContain("Iris 主动提醒");
        expect(input.cardJson).toContain("Iris PR\\\\#22 acceptance discussion");
        expect(input.cardJson).not.toContain("message-a");
        expect(input.uuid).toHaveLength(50);
        return { messageId: "om_proactive" };
      },
      complete: async () => {
        order.push("complete");
      },
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "sent",
      deliveryId: "delivery-a",
      code: "send_succeeded",
    }]);
    expect(order).toEqual(["context", "gate", "begin", "context", "gate", "send", "complete"]);
    expect(canDeliver).toHaveBeenNthCalledWith(1, "group-a");
    expect(canDeliver).toHaveBeenNthCalledWith(2, "group-a");
    expect(harness.repository.completeProactiveSignalDelivery).toHaveBeenCalledWith({
      deliveryId: "delivery-a",
      workerId: "proactive-dispatcher-1",
      messageId: "om_proactive",
      at: now,
    });
    expect(harness.observe.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        groupId: "group-a",
        subjectType: "tool_call",
        subjectId: "delivery-a",
        eventType: "tool_call_started",
        phase: "external_call",
        toolCallId: "delivery-a",
        toolName: "iris.feishu.deliverProactiveSignal",
        metadata: {
          signalType: "quiet_open_thread",
          attemptNumber: 1,
        },
      }),
      expect.objectContaining({
        subjectId: "delivery-a",
        eventType: "tool_call_completed",
        outcome: "success",
        decisionReason: "send_succeeded",
      }),
    ]);
    expect(JSON.stringify(harness.observe.mock.calls)).not.toMatch(
      /Iris follow-up|message-a|om_proactive/iu,
    );
  });

  it("fails preparation without sending when context is stale or runtime is disabled", async () => {
    const harness = createHarness({
      canDeliver: () => false,
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      deliveryId: "delivery-a",
      code: "runtime_disabled",
    }]);
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
    expect(harness.repository.failProactiveSignalDeliveryPreparation).toHaveBeenCalledWith({
      deliveryId: "delivery-a",
      workerId: "proactive-dispatcher-1",
      errorCode: "runtime_disabled",
      at: now,
    });
    expect(harness.observe).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "tool_call_cancelled",
      outcome: "skipped",
      decisionReason: "runtime_disabled",
    }));
  });

  it("fails closed if the runtime gate changes after final database authorization", async () => {
    let reads = 0;
    const harness = createHarness({
      canDeliver: () => ++reads === 1,
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      deliveryId: "delivery-a",
      code: "runtime_disabled",
    }]);
    expect(harness.repository.beginProactiveSignalDeliveryAttempt).toHaveBeenCalledOnce();
    expect(harness.repository.failProactiveSignalDeliveryPreparation).not.toHaveBeenCalled();
    expect(harness.repository.failProactiveSignalDelivery).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: "delivery-a",
      classification: "permanent",
      errorCode: "runtime_disabled",
    }));
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
  });

  it("rechecks the exact subject after final authorization and cancels stale content", async () => {
    let contextReadCount = 0;
    const harness = createHarness({
      getContext: async () => {
        contextReadCount += 1;
        if (contextReadCount === 1) return deliveryContext();
        const staleContext = deliveryContext();
        delete staleContext.subjectLabel;
        return staleContext;
      },
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      deliveryId: "delivery-a",
      code: "stale_delivery",
    }]);
    expect(harness.repository.getProactiveSignalDeliveryContext).toHaveBeenCalledTimes(2);
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
    expect(harness.repository.failProactiveSignalDeliveryPreparation).toHaveBeenCalledWith({
      deliveryId: "delivery-a",
      workerId: "proactive-dispatcher-1",
      errorCode: "stale_delivery",
      at: now,
    });
  });

  it("cancels a claimed delivery when feedback suppression wins before external send", async () => {
    const harness = createHarness({
      begin: async () => ({ status: "suppressed" as const }),
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      deliveryId: "delivery-a",
      code: "feedback_suppressed",
    }]);
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
    expect(harness.repository.failProactiveSignalDeliveryPreparation).not.toHaveBeenCalled();
    expect(harness.observe).toHaveBeenLastCalledWith(expect.objectContaining({
      eventType: "tool_call_cancelled",
      outcome: "skipped",
      decisionReason: "feedback_suppressed",
    }));
  });

  it.each([
    ["request_not_sent", "retrying", "request_not_sent"],
    ["retryable_remote_failure", "retrying", "retryable_remote_failure"],
    ["remote_rejected", "permanent_failure", "remote_rejected"],
    ["outcome_unknown", "outcome_unknown", "outcome_unknown"],
  ] as const)("classifies %s without leaking remote details", async (classification, status, code) => {
    const harness = createHarness({
      send: async () => {
        throw new FeishuInteractiveCardClientError(classification, "private_feishu_code");
      },
    });

    const result = await harness.dispatcher.processBatch({ limit: 1 });

    expect(result).toEqual([{ status, deliveryId: "delivery-a", code }]);
    expect(JSON.stringify(result)).not.toContain("private_feishu_code");
    expect(harness.repository.failProactiveSignalDelivery).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: "delivery-a",
      classification: status === "retrying"
        ? "retryable"
        : status === "permanent_failure" ? "permanent" : "outcome_unknown",
      errorCode: code,
    }));
    expect(harness.observe).toHaveBeenLastCalledWith(expect.objectContaining({
      eventType: "tool_call_failed",
      outcome: status === "outcome_unknown" ? "unknown" : "error",
      decisionReason: code,
    }));
  });

  it("keeps delivery successful when execution observation fails", async () => {
    const harness = createHarness({
      observe: async () => {
        throw new Error("ledger unavailable");
      },
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "sent",
      deliveryId: "delivery-a",
      code: "send_succeeded",
    }]);
  });

  it("stops when no delivery is ready and bounds the batch limit", async () => {
    const harness = createHarness({ claim: undefined });

    await expect(harness.dispatcher.processBatch({ limit: 1000 })).resolves.toEqual([]);
    expect(harness.repository.claimProactiveSignalDelivery).toHaveBeenCalledWith({
      workerId: "proactive-dispatcher-1",
      at: now,
      leaseUntil: new Date(now.getTime() + 30_000),
    });
    await expect(harness.dispatcher.processBatch({ limit: Number.POSITIVE_INFINITY }))
      .rejects.toThrow("batch limit");
  });
});

type HarnessOverrides = {
  claim?: ProactiveSignalDeliveryClaim;
  getContext?: () => Promise<ProactiveSignalDeliveryContext | undefined>;
  canDeliver?: (groupId: string) => boolean;
  begin?: () => Promise<
    { status: "authorized" } | { status: "suppressed" } | { status: "stale" }
  >;
  send?: (input: { chatId: string; cardJson: string; uuid: string }) => Promise<{ messageId: string }>;
  complete?: () => Promise<void>;
  observe?: AgentExecutionObserver["observe"];
};

function createHarness(overrides: HarnessOverrides = {}) {
  const repository = {
    claimProactiveSignalDelivery: vi.fn(async () =>
      Object.hasOwn(overrides, "claim") ? overrides.claim : deliveryClaim()),
    getProactiveSignalDeliveryContext: vi.fn(overrides.getContext ?? (async () => deliveryContext())),
    beginProactiveSignalDeliveryAttempt: vi.fn(
      overrides.begin ?? (async () => ({ status: "authorized" as const })),
    ),
    failProactiveSignalDeliveryPreparation: vi.fn(async () => undefined),
    completeProactiveSignalDelivery: vi.fn(overrides.complete ?? (async () => undefined)),
    failProactiveSignalDelivery: vi.fn(async () => undefined),
  };
  const cardClient = {
    sendCard: vi.fn(overrides.send ?? (async () => ({ messageId: "om_proactive" }))),
  };
  const observe = vi.fn<AgentExecutionObserver["observe"]>(
    overrides.observe ?? (async () => undefined),
  );
  return {
    repository,
    cardClient,
    observe,
    dispatcher: createProactiveSignalDispatcher({
      repository,
      cardClient,
      canDeliverProactiveSignals: overrides.canDeliver ?? (() => true),
      workerId: "proactive-dispatcher-1",
      leaseMs: 30_000,
      retryDelayMs: 60_000,
      now: () => new Date(now),
      agentExecutionObserver: { observe },
    }),
  };
}

function deliveryClaim(): ProactiveSignalDeliveryClaim {
  return {
    delivery: deliveryContext().delivery,
    workerId: "proactive-dispatcher-1",
    leaseUntil: new Date(now.getTime() + 30_000),
    attempts: 1,
  };
}

function deliveryContext(): ProactiveSignalDeliveryContext {
  const createdAt = new Date("2026-07-23T09:00:00.000Z");
  return {
    delivery: {
      id: "delivery-a",
      candidateIdempotencyKey: "quiet_open_thread:thread-a:1",
      groupId: "group-a",
      status: "processing",
      attemptCount: 1,
    },
    candidate: {
      idempotencyKey: "quiet_open_thread:thread-a:1",
      groupId: "group-a",
      kind: "quiet_open_thread",
      priority: "medium",
      entityType: "thread",
      entityId: "thread-a",
      entityVersion: 1,
      reasonCode: "thread_quiet_threshold_elapsed",
      suggestedMode: "ask_for_thread_update",
      status: "pending",
      lastRelevantAt: new Date("2026-07-23T08:00:00.000Z"),
      createdAt,
      updatedAt: createdAt,
      evidenceMessageIds: ["message-a"],
    },
    subjectLabel: "Iris PR#22 acceptance discussion",
  };
}
