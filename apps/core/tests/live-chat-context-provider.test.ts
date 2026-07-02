import { describe, expect, it, vi } from "vitest";

import { createLiveChatContextProvider } from "../src/memory/live-chat-context-provider.js";

describe("LiveChatContextProvider", () => {
  it("loads recent text messages in chronological order", async () => {
    const repository = {
      listRecentByChat: vi.fn(async () => [
        {
          id: "msg-3",
          provider: "feishu",
          providerMessageId: "om_3",
          chatId: "oc_1",
          senderId: "ou_b",
          messageType: "text",
          text: "Latest",
          sentAt: new Date("2026-07-02T10:02:00.000Z"),
          rawEventIdempotencyKey: "event-3",
          createdAt: new Date("2026-07-02T10:02:01.000Z"),
        },
        {
          id: "msg-2",
          provider: "feishu",
          providerMessageId: "om_2",
          chatId: "oc_1",
          senderId: null,
          messageType: "image",
          sentAt: new Date("2026-07-02T10:01:00.000Z"),
          rawEventIdempotencyKey: "event-2",
          createdAt: new Date("2026-07-02T10:01:01.000Z"),
        },
        {
          id: "msg-1",
          provider: "feishu",
          providerMessageId: "om_1",
          chatId: "oc_1",
          senderId: "ou_a",
          messageType: "text",
          text: "Earlier",
          sentAt: new Date("2026-07-02T10:00:00.000Z"),
          rawEventIdempotencyKey: "event-1",
          createdAt: new Date("2026-07-02T10:00:01.000Z"),
        },
      ]),
    };
    const provider = createLiveChatContextProvider({ repository });

    const messages = await provider.loadRecentMessages({ chatId: "oc_1" });

    expect(repository.listRecentByChat).toHaveBeenCalledWith({ chatId: "oc_1", limit: 20 });
    expect(messages).toEqual([
      { speaker: "ou_a", text: "Earlier" },
      { speaker: "ou_b", text: "Latest" },
    ]);
  });

  it("uses custom limits and fallback speaker labels", async () => {
    const repository = {
      listRecentByChat: vi.fn(async () => [
        {
          id: "msg-1",
          provider: "feishu",
          providerMessageId: "om_1",
          chatId: "oc_1",
          senderId: null,
          messageType: "text",
          text: "No sender",
          sentAt: new Date("2026-07-02T10:00:00.000Z"),
          rawEventIdempotencyKey: "event-1",
          createdAt: new Date("2026-07-02T10:00:01.000Z"),
        },
      ]),
    };
    const provider = createLiveChatContextProvider({ repository });

    const messages = await provider.loadRecentMessages({ chatId: "oc_1", limit: 5 });

    expect(repository.listRecentByChat).toHaveBeenCalledWith({ chatId: "oc_1", limit: 5 });
    expect(messages).toEqual([{ speaker: "unknown", text: "No sender" }]);
  });
});
