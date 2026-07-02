import { describe, expect, it, vi } from "vitest";

import { createFeishuMessageEventProcessor } from "../src/conversation/feishu-message-event-processor.js";
import type { RawEvent } from "../src/events/raw-event-queue.js";

describe("FeishuMessageEventProcessor", () => {
  it("persists text Feishu message events", async () => {
    const messages = {
      upsertMessage: vi.fn(async (input) => ({
        id: "feishu:message-1",
        createdAt: new Date(),
        ...input,
      })),
    };
    const processor = createFeishuMessageEventProcessor({ messages });

    await processor.process(rawEventFixture());

    expect(messages.upsertMessage).toHaveBeenCalledWith({
      provider: "feishu",
      providerMessageId: "message-1",
      chatId: "chat-1",
      senderId: "open-1",
      messageType: "text",
      text: "Hello",
      sentAt: new Date("2026-07-01T17:00:00.000Z"),
      rawEventIdempotencyKey: "raw-event:feishu:event-1",
    });
  });

  it("persists non-text messages without text", async () => {
    const messages = {
      upsertMessage: vi.fn(async (input) => ({
        id: "feishu:message-1",
        createdAt: new Date(),
        ...input,
      })),
    };
    const processor = createFeishuMessageEventProcessor({ messages });

    await processor.process(
      rawEventFixture({
        rawBody: {
          header: { event_id: "event-1", event_type: "im.message.receive_v1" },
          event: {
            message: {
              message_id: "message-1",
              chat_id: "chat-1",
              message_type: "image",
              create_time: "1782925200000",
            },
          },
        },
      }),
    );

    expect(messages.upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: "image",
        text: undefined,
      }),
    );
  });

  it("ignores unsupported events", async () => {
    const messages = { upsertMessage: vi.fn() };
    const processor = createFeishuMessageEventProcessor({ messages });

    await processor.process(rawEventFixture({ eventType: "unsupported", rawBody: { hello: "world" } }));

    expect(messages.upsertMessage).not.toHaveBeenCalled();
  });

  it("falls back to receivedAt for invalid timestamps and ignores malformed text content", async () => {
    const messages = {
      upsertMessage: vi.fn(async (input) => ({
        id: "feishu:message-1",
        createdAt: new Date(),
        ...input,
      })),
    };
    const processor = createFeishuMessageEventProcessor({ messages });

    await processor.process(
      rawEventFixture({
        rawBody: {
          header: { event_id: "event-1", event_type: "im.message.receive_v1" },
          event: {
            message: {
              message_id: "message-1",
              chat_id: "chat-1",
              message_type: "text",
              content: "{",
              create_time: "bad",
            },
          },
        },
      }),
    );

    expect(messages.upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: undefined,
        sentAt: new Date("2026-07-02T01:00:00.000Z"),
      }),
    );
  });
});

function rawEventFixture(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    idempotencyKey: "raw-event:feishu:event-1",
    provider: "feishu",
    eventType: "im.message.receive_v1",
    rawBody: {
      header: {
        event_id: "event-1",
        event_type: "im.message.receive_v1",
      },
      event: {
        sender: {
          sender_id: {
            open_id: "open-1",
          },
        },
        message: {
          message_id: "message-1",
          chat_id: "chat-1",
          message_type: "text",
          content: "{\"text\":\"Hello\"}",
          create_time: "1782925200000",
        },
      },
    },
    receivedAt: new Date("2026-07-02T01:00:00.000Z"),
    attempts: 0,
    ...overrides,
  };
}
