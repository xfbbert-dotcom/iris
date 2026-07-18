import { describe, expect, it, vi } from "vitest";

import { createFeishuCardActionGateway } from "../src/feishu/feishu-card-action-gateway.js";

describe("FeishuCardActionGateway", () => {
  it("verifies before parsing and returns 401 without enqueueing", async () => {
    const queue = { enqueue: vi.fn(async () => "enqueued" as const) };
    const gateway = createFeishuCardActionGateway({
      queue,
      verifyRequest: () => false,
    });

    await expect(gateway.handleCallback({ headers: {}, body: { invalid: true } })).resolves.toEqual({
      statusCode: 401,
      body: { ok: false },
    });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("returns 400 without enqueueing when a verified callback is not an exact card action", async () => {
    const queue = { enqueue: vi.fn(async () => "enqueued" as const) };
    const gateway = createFeishuCardActionGateway({ queue, verifyRequest: () => true });

    await expect(gateway.handleCallback({ headers: {}, body: { schema: "1.0" } })).resolves.toEqual({
      statusCode: 400,
      body: { ok: false },
    });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("enqueues the normalized job once and acknowledges a fast enqueue", async () => {
    const now = new Date("2026-07-19T00:00:00.000Z");
    const queue = { enqueue: vi.fn(async () => "enqueued" as const) };
    const gateway = createFeishuCardActionGateway({
      queue,
      verifyRequest: () => true,
      now: () => now,
    });

    await expect(gateway.handleCallback({ headers: {}, body: cardAction() })).resolves.toEqual({
      statusCode: 200,
      body: { toast: { type: "info", content: "\u5df2\u6536\u5230\uff0c\u6b63\u5728\u6838\u9a8c" } },
    });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith({
      idempotencyKey: "feishu-card:cli_approval:event-1",
      eventId: "event-1",
      appId: "cli_approval",
      actorOpenId: "ou_reviewer",
      chatId: "oc_approval",
      messageId: "om_approval",
      presentationId: "presentation-1",
      draftId: "draft-1",
      revisionNumber: 7,
      draftVersion: 11,
      action: "confirm",
      receivedAt: now,
      attempts: 0,
    });
  });

  it("returns an error toast after one second when enqueue does not settle", async () => {
    vi.useFakeTimers();
    try {
      const queue = { enqueue: vi.fn(() => new Promise<"enqueued" | "duplicate">(() => undefined)) };
      const gateway = createFeishuCardActionGateway({ queue, verifyRequest: () => true });
      const response = gateway.handleCallback({ headers: {}, body: cardAction() });

      await vi.advanceTimersByTimeAsync(999);
      expect(queue.enqueue).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);

      await expect(response).resolves.toEqual({
        statusCode: 200,
        body: { toast: { type: "error", content: "\u64cd\u4f5c\u672a\u63d0\u4ea4\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5" } },
      });
      expect(queue.enqueue).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains a late enqueue rejection after the one-second timeout", async () => {
    vi.useFakeTimers();
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);
    try {
      const deferred = createDeferred<"enqueued" | "duplicate">();
      const queue = { enqueue: vi.fn(() => deferred.promise) };
      const gateway = createFeishuCardActionGateway({ queue, verifyRequest: () => true });
      const response = gateway.handleCallback({ headers: {}, body: cardAction() });

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(response).resolves.toEqual({
        statusCode: 200,
        body: { toast: { type: "error", content: "\u64cd\u4f5c\u672a\u63d0\u4ea4\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5" } },
      });
      expect(vi.getTimerCount()).toBe(0);

      deferred.reject(new Error("late queue rejection"));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(queue.enqueue).toHaveBeenCalledTimes(1);
      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.off("unhandledRejection", unhandledRejection);
      vi.useRealTimers();
    }
  });

  it("returns an error toast when its one enqueue attempt rejects", async () => {
    const queue = { enqueue: vi.fn(async () => { throw new Error("queue unavailable"); }) };
    const gateway = createFeishuCardActionGateway({ queue, verifyRequest: () => true });

    await expect(gateway.handleCallback({ headers: {}, body: cardAction() })).resolves.toEqual({
      statusCode: 200,
      body: { toast: { type: "error", content: "\u64cd\u4f5c\u672a\u63d0\u4ea4\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5" } },
    });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });
});

function cardAction(): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      event_id: "event-1",
      token: "verification-token",
      create_time: "1784419200000000",
      event_type: "card.action.trigger",
      tenant_key: "tenant-1",
      app_id: "cli_approval",
    },
    event: {
      operator: { tenant_key: "tenant-1", open_id: "ou_reviewer" },
      token: "card-token",
      action: {
        value: {
          action: "confirm",
          presentationId: "presentation-1",
          draftId: "draft-1",
          revisionNumber: 7,
          draftVersion: 11,
        },
        tag: "button",
        name: "confirm",
        form_value: { reason: "", rejectionConfirmed: [] },
      },
      host: "im_message",
      context: { open_message_id: "om_approval", open_chat_id: "oc_approval" },
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
