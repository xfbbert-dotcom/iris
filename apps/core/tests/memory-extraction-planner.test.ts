import { describe, expect, it, vi } from "vitest";

import type { ConversationMessage } from "../src/conversation/conversation-message-repository.js";
import { createMemoryExtractionPlanner } from "../src/memory-extraction/memory-extraction-planner.js";

describe("MemoryExtractionPlanner", () => {
  it("registers persisted message identifiers and enqueues an identifier-only job", async () => {
    const now = new Date("2026-07-15T01:02:03.000Z");
    const repository = {
      registerRequest: vi.fn(async () => ({
        request: extractionRequest(),
        created: true,
      })),
    };
    const queue = { enqueue: vi.fn(async (_job: unknown) => undefined) };
    const planner = createMemoryExtractionPlanner({
      repository,
      queue,
      runtimeController: enabledRuntimeController(),
      irisBotOpenId: "iris-bot-open-id",
      now: () => now,
    });

    await planner.registerMessage(message());

    expect(repository.registerRequest).toHaveBeenCalledWith({
      groupId: "chat-a",
      conversationMessageId: "feishu:message-1",
      providerMessageId: "message-1",
    });
    expect(queue.enqueue).toHaveBeenCalledWith({
      schemaVersion: 1,
      idempotencyKey: "memory-extraction:request-1",
      requestId: "request-1",
      groupId: "chat-a",
      enqueuedAt: now,
      notBefore: now,
      attempts: 0,
    });
    expect(queue.enqueue.mock.calls[0]?.[0]).not.toHaveProperty("text");
    expect(queue.enqueue.mock.calls[0]?.[0]).not.toHaveProperty("senderId");
  });

  it.each([undefined, "", "   ", "\t\n"])(
    "ignores undefined or blank message text %#",
    async (text) => {
      const repository = {
        registerRequest: vi.fn(async () => ({ request: extractionRequest(), created: true })),
      };
      const queue = { enqueue: vi.fn(async () => undefined) };
      const runtimeController = enabledRuntimeController();
      const planner = createMemoryExtractionPlanner({ repository, queue, runtimeController });

      await planner.registerMessage(message({ text }));

      expect(repository.registerRequest).not.toHaveBeenCalled();
      expect(queue.enqueue).not.toHaveBeenCalled();
      expect(runtimeController.canProcessIncomingEvent).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["the Iris bot", "iris-bot-open-id"],
    ["an unattributed sender", undefined],
  ])("fails closed for %s when bot identity is configured", async (_label, senderId) => {
    const repository = {
      registerRequest: vi.fn(async () => ({ request: extractionRequest(), created: true })),
    };
    const queue = { enqueue: vi.fn(async () => undefined) };
    const runtimeController = enabledRuntimeController();
    const planner = createMemoryExtractionPlanner({
      repository,
      queue,
      runtimeController,
      irisBotOpenId: "iris-bot-open-id",
    });

    await planner.registerMessage(message({ senderId }));

    expect(repository.registerRequest).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(runtimeController.canProcessIncomingEvent).not.toHaveBeenCalled();
  });

  it("rechecks both runtime gates immediately before durable registration", async () => {
    const calls: string[] = [];
    const repository = {
      registerRequest: vi.fn(async () => {
        calls.push("register");
        return { request: extractionRequest(), created: true };
      }),
    };
    const queue = { enqueue: vi.fn(async () => undefined) };
    const runtimeController = {
      canProcessIncomingEvent: vi.fn(() => {
        calls.push("incoming");
        return true;
      }),
      canReadGroupContext: vi.fn(() => {
        calls.push("context");
        return true;
      }),
    };
    const planner = createMemoryExtractionPlanner({ repository, queue, runtimeController });

    await planner.registerMessage(message());

    expect(calls).toEqual(["incoming", "context", "register"]);
    expect(runtimeController.canProcessIncomingEvent).toHaveBeenCalledWith({
      groupId: "chat-a",
    });
    expect(runtimeController.canReadGroupContext).toHaveBeenCalledWith("chat-a");
  });

  it.each([
    ["incoming events are disabled", false, true],
    ["group context reading is disabled", true, false],
  ])("does not register when %s", async (_label, canProcess, canReadContext) => {
    const repository = {
      registerRequest: vi.fn(async () => ({ request: extractionRequest(), created: true })),
    };
    const queue = { enqueue: vi.fn(async () => undefined) };
    const runtimeController = {
      canProcessIncomingEvent: vi.fn(() => canProcess),
      canReadGroupContext: vi.fn(() => canReadContext),
    };
    const planner = createMemoryExtractionPlanner({ repository, queue, runtimeController });

    await planner.registerMessage(message());

    expect(repository.registerRequest).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(runtimeController.canReadGroupContext).toHaveBeenCalledTimes(canProcess ? 1 : 0);
  });

  it("enqueues an idempotent replay to repair a prior enqueue failure", async () => {
    const repository = {
      registerRequest: vi
        .fn()
        .mockResolvedValueOnce({ request: extractionRequest(), created: true })
        .mockResolvedValueOnce({ request: extractionRequest(), created: false }),
    };
    const queue = {
      enqueue: vi
        .fn()
        .mockRejectedValueOnce(new Error("queue unavailable"))
        .mockResolvedValueOnce(undefined),
    };
    const planner = createMemoryExtractionPlanner({
      repository,
      queue,
      runtimeController: enabledRuntimeController(),
      now: () => new Date("2026-07-15T01:02:03.000Z"),
    });
    const persistedMessage = message();

    await expect(planner.registerMessage(persistedMessage)).rejects.toThrow("queue unavailable");
    await expect(planner.registerMessage(persistedMessage)).resolves.toBeUndefined();

    expect(repository.registerRequest).toHaveBeenCalledTimes(2);
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
    expect(queue.enqueue.mock.calls[1]?.[0]).toMatchObject({
      requestId: "request-1",
      groupId: "chat-a",
    });
  });
});

function message(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: "feishu:message-1",
    provider: "feishu",
    providerMessageId: "message-1",
    chatId: "chat-a",
    senderId: "user-open-id",
    messageType: "text",
    text: "We decided to ship Friday.",
    sentAt: new Date("2026-07-15T01:00:00.000Z"),
    rawEventIdempotencyKey: "raw-event:feishu:event-1",
    createdAt: new Date("2026-07-15T01:00:01.000Z"),
    ...overrides,
  };
}

function extractionRequest() {
  return {
    id: "request-1",
    groupId: "chat-a",
    conversationMessageId: "feishu:message-1",
    providerMessageId: "message-1",
    status: "pending" as const,
    createdAt: new Date("2026-07-15T01:00:02.000Z"),
    updatedAt: new Date("2026-07-15T01:00:02.000Z"),
  };
}

function enabledRuntimeController() {
  return {
    canProcessIncomingEvent: vi.fn(() => true),
    canReadGroupContext: vi.fn(() => true),
  };
}
