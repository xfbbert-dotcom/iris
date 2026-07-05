import { describe, expect, it, vi } from "vitest";

import type { ConversationMessage } from "../src/conversation/conversation-message-repository.js";
import { createLiveChatContextProvider } from "../src/memory/live-chat-context-provider.js";

describe("LiveChatContextProvider", () => {
  it("loads recent text messages in chronological order", async () => {
    const repository = {
      listRecentByChat: vi.fn(async () => [
        message({
          id: "msg-3",
          providerMessageId: "om_3",
          senderId: "ou_b",
          text: "Latest",
          sentAt: new Date("2026-07-02T10:02:00.000Z"),
          rawEventIdempotencyKey: "event-3",
          createdAt: new Date("2026-07-02T10:02:01.000Z"),
        }),
        message({
          id: "msg-2",
          providerMessageId: "om_2",
          messageType: "image",
          sentAt: new Date("2026-07-02T10:01:00.000Z"),
          rawEventIdempotencyKey: "event-2",
          createdAt: new Date("2026-07-02T10:01:01.000Z"),
        }),
        message({
          id: "msg-1",
          providerMessageId: "om_1",
          senderId: "ou_a",
          text: "Earlier",
          sentAt: new Date("2026-07-02T10:00:00.000Z"),
          rawEventIdempotencyKey: "event-1",
          createdAt: new Date("2026-07-02T10:00:01.000Z"),
        }),
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
        message({
          id: "msg-1",
          providerMessageId: "om_1",
          text: "No sender",
          sentAt: new Date("2026-07-02T10:00:00.000Z"),
          rawEventIdempotencyKey: "event-1",
          createdAt: new Date("2026-07-02T10:00:01.000Z"),
        }),
      ]),
    };
    const provider = createLiveChatContextProvider({ repository });

    const messages = await provider.loadRecentMessages({ chatId: "oc_1", limit: 5 });

    expect(repository.listRecentByChat).toHaveBeenCalledWith({ chatId: "oc_1", limit: 5 });
    expect(messages).toEqual([{ speaker: "unknown", text: "No sender" }]);
  });

  it("caps oversized custom limits before querying the repository", async () => {
    const repository = {
      listRecentByChat: vi.fn(async () => []),
    };
    const provider = createLiveChatContextProvider({ repository });

    await provider.loadRecentMessages({ chatId: "oc_1", limit: 999 });

    expect(repository.listRecentByChat).toHaveBeenCalledWith({ chatId: "oc_1", limit: 20 });
  });

  it("rejects unsafe custom limits before querying the repository", async () => {
    const repository = {
      listRecentByChat: vi.fn(async () => []),
    };
    const provider = createLiveChatContextProvider({ repository });

    await expect(
      provider.loadRecentMessages({
        chatId: "oc_1",
        limit: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow("live chat limit must be a finite safe-magnitude number");
    expect(repository.listRecentByChat).not.toHaveBeenCalled();
  });

  it("rejects non-finite custom limits before querying the repository", async () => {
    const repository = {
      listRecentByChat: vi.fn(async () => []),
    };
    const provider = createLiveChatContextProvider({ repository });

    await expect(
      provider.loadRecentMessages({
        chatId: "oc_1",
        limit: Number.NaN,
      }),
    ).rejects.toThrow("live chat limit must be a finite safe-magnitude number");
    expect(repository.listRecentByChat).not.toHaveBeenCalled();
  });
});

function message(overrides: Partial<ConversationMessage>): ConversationMessage {
  return {
    id: "msg",
    provider: "feishu",
    providerMessageId: "om",
    chatId: "oc_1",
    messageType: "text",
    sentAt: new Date("2026-07-02T10:00:00.000Z"),
    rawEventIdempotencyKey: "event",
    createdAt: new Date("2026-07-02T10:00:01.000Z"),
    ...overrides,
  };
}
