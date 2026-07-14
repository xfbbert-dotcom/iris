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
    const documentLinkExtractor = {
      extractLinks: vi.fn(() => [{ sourceUri: "https://docs.feishu.cn/docx/a" }]),
    };
    const groupVisibleDocumentRegistrar = {
      registerDiscoveredLinks: vi.fn(async () => undefined),
    };
    const processor = createFeishuMessageEventProcessor({
      messages,
      documentLinkExtractor,
      groupVisibleDocumentRegistrar,
    });

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
    expect(documentLinkExtractor.extractLinks).toHaveBeenCalledWith("Hello");
    expect(groupVisibleDocumentRegistrar.registerDiscoveredLinks).toHaveBeenCalledWith({
      chatId: "chat-1",
      messageId: "message-1",
      senderId: "open-1",
      observedAt: new Date("2026-07-01T17:00:00.000Z"),
      links: [{ sourceUri: "https://docs.feishu.cn/docx/a" }],
    });
  });

  it("attempts replies first and passes the persisted message to extraction planning", async () => {
    const calls: string[] = [];
    const persistedMessage = {
      id: "feishu:message-1",
      provider: "feishu" as const,
      providerMessageId: "message-1",
      chatId: "chat-1",
      senderId: "open-1",
      messageType: "text",
      text: "Hello",
      sentAt: new Date("2026-07-01T17:00:00.000Z"),
      rawEventIdempotencyKey: "raw-event:feishu:event-1",
      createdAt: new Date("2026-07-02T01:00:01.000Z"),
    };
    const mentionAnswerResponder = {
      maybeRespond: vi.fn(async () => {
        calls.push("reply");
        return { status: "skipped" as const, reason: "not_mentioned" as const };
      }),
    };
    const messages = {
      upsertMessage: vi.fn(async () => {
        calls.push("persist");
        return persistedMessage;
      }),
    };
    const memoryExtractionPlanner = {
      registerMessage: vi.fn(async () => {
        calls.push("plan");
      }),
    };
    const documentLinkExtractor = {
      extractLinks: vi.fn(() => {
        calls.push("documents");
        return [];
      }),
    };
    const processor = createFeishuMessageEventProcessor({
      messages,
      mentionAnswerResponder,
      memoryExtractionPlanner,
      documentLinkExtractor,
    });

    await processor.process(rawEventFixture());

    expect(calls).toEqual(["reply", "persist", "plan", "documents"]);
    expect(memoryExtractionPlanner.registerMessage).toHaveBeenCalledWith(persistedMessage);
  });

  it("attempts document discovery before surfacing an extraction planner failure", async () => {
    const plannerError = new Error("extraction scheduling failed");
    const messages = {
      upsertMessage: vi.fn(async (input) => ({
        id: "feishu:message-1",
        createdAt: new Date(),
        ...input,
      })),
    };
    const memoryExtractionPlanner = {
      registerMessage: vi.fn(async () => {
        throw plannerError;
      }),
    };
    const documentLinkExtractor = {
      extractLinks: vi.fn(() => [{ sourceUri: "https://docs.feishu.cn/docx/a" }]),
    };
    const groupVisibleDocumentRegistrar = {
      registerDiscoveredLinks: vi.fn(async () => undefined),
    };
    const processor = createFeishuMessageEventProcessor({
      messages,
      memoryExtractionPlanner,
      documentLinkExtractor,
      groupVisibleDocumentRegistrar,
    });

    await expect(processor.process(rawEventFixture())).rejects.toBe(plannerError);

    expect(memoryExtractionPlanner.registerMessage).toHaveBeenCalledOnce();
    expect(groupVisibleDocumentRegistrar.registerDiscoveredLinks).toHaveBeenCalledOnce();
  });

  it("surfaces reply, planner, and document failures in deterministic priority", async () => {
    const replyError = new Error("reply failed");
    const plannerError = new Error("planner failed");
    const documentError = new Error("document discovery failed");
    const attempts: string[] = [];
    const messages = {
      upsertMessage: vi.fn(async (input) => ({
        id: "feishu:message-1",
        createdAt: new Date(),
        ...input,
      })),
    };
    const mentionAnswerResponder = {
      maybeRespond: vi.fn(async (): Promise<{
        status: "skipped";
        reason: "not_mentioned";
      }> => {
        attempts.push("reply");
        throw replyError;
      }),
    };
    const memoryExtractionPlanner = {
      registerMessage: vi.fn(async () => {
        attempts.push("planner");
        throw plannerError;
      }),
    };
    const documentLinkExtractor = {
      extractLinks: vi.fn(() => [{ sourceUri: "https://docs.feishu.cn/docx/a" }]),
    };
    const groupVisibleDocumentRegistrar = {
      registerDiscoveredLinks: vi.fn(async () => {
        attempts.push("documents");
        throw documentError;
      }),
    };
    const processor = createFeishuMessageEventProcessor({
      messages,
      mentionAnswerResponder,
      memoryExtractionPlanner,
      documentLinkExtractor,
      groupVisibleDocumentRegistrar,
    });

    await expect(processor.process(rawEventFixture())).rejects.toBe(replyError);
    expect(attempts).toEqual(["reply", "planner", "documents"]);

    mentionAnswerResponder.maybeRespond.mockResolvedValueOnce({
      status: "skipped" as const,
      reason: "not_mentioned" as const,
    });
    await expect(processor.process(rawEventFixture())).rejects.toBe(plannerError);
  });

  it("passes parsed Feishu mentions to the mention answer responder", async () => {
    const messages = {
      upsertMessage: vi.fn(async (input) => ({
        id: "feishu:message-1",
        createdAt: new Date(),
        ...input,
      })),
    };
    const mentionAnswerResponder = {
      maybeRespond: vi.fn(async () => ({ status: "skipped" as const, reason: "not_mentioned" as const })),
    };
    const processor = createFeishuMessageEventProcessor({
      messages,
      mentionAnswerResponder,
    });

    await processor.process(
      rawEventFixture({
        rawBody: {
          header: { event_id: "event-1", event_type: "im.message.receive_v1" },
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
              content: "{\"text\":\"@_user_1 帮我总结\"}",
              mentions: [
                {
                  key: "@_user_1",
                  id: { open_id: "ou_iris" },
                  name: "Iris",
                },
              ],
              create_time: "1782925200000",
            },
          },
        },
      }),
    );

    expect(mentionAnswerResponder.maybeRespond).toHaveBeenCalledWith({
      messageId: "message-1",
      chatId: "chat-1",
      senderId: "open-1",
      text: "@_user_1 帮我总结",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    });
  });

  it("truncates oversized message text before downstream processing", async () => {
    const oversizedText = `${"T".repeat(9000)} trailing message detail`;
    const messages = {
      upsertMessage: vi.fn(async (input) => ({
        id: "feishu:message-1",
        createdAt: new Date(),
        ...input,
      })),
    };
    const documentLinkExtractor = {
      extractLinks: vi.fn((_text: string) => []),
    };
    const mentionAnswerResponder = {
      maybeRespond: vi.fn(
        async (_input: {
          messageId: string;
          chatId: string;
          senderId?: string;
          text?: string;
          mentions: unknown[];
        }) => ({ status: "skipped" as const, reason: "not_mentioned" as const }),
      ),
    };
    const processor = createFeishuMessageEventProcessor({
      messages,
      documentLinkExtractor,
      mentionAnswerResponder,
    });

    await processor.process(
      rawEventFixture({
        rawBody: {
          header: { event_id: "event-1", event_type: "im.message.receive_v1" },
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
              content: JSON.stringify({ text: oversizedText }),
              create_time: "1782925200000",
            },
          },
        },
      }),
    );

    const writtenText = messages.upsertMessage.mock.calls[0]?.[0].text;
    const extractedText = documentLinkExtractor.extractLinks.mock.calls[0]?.[0];
    const responderText = mentionAnswerResponder.maybeRespond.mock.calls[0]?.[0].text;

    expect(writtenText?.length).toBeLessThanOrEqual(8000);
    expect(writtenText).toContain("[truncated]");
    expect(writtenText).not.toContain("trailing message detail");
    expect(extractedText).toBe(writtenText);
    expect(responderText).toBe(writtenText);
  });

  it("treats oversized message content payloads as unreadable before downstream processing", async () => {
    const messages = {
      upsertMessage: vi.fn(async (input) => ({
        id: "feishu:message-1",
        createdAt: new Date(),
        ...input,
      })),
    };
    const documentLinkExtractor = {
      extractLinks: vi.fn((_text: string) => []),
    };
    const mentionAnswerResponder = {
      maybeRespond: vi.fn(
        async (_input: {
          messageId: string;
          chatId: string;
          senderId?: string;
          text?: string;
          mentions: unknown[];
        }) => ({ status: "skipped" as const, reason: "not_mentioned" as const }),
      ),
    };
    const processor = createFeishuMessageEventProcessor({
      messages,
      documentLinkExtractor,
      mentionAnswerResponder,
    });

    await processor.process(
      rawEventFixture({
        rawBody: {
          header: { event_id: "event-1", event_type: "im.message.receive_v1" },
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
              content: JSON.stringify({
                text: `${"T".repeat(70_000)} https://docs.feishu.cn/docx/oversized`,
              }),
              create_time: "1782925200000",
            },
          },
        },
      }),
    );

    expect(messages.upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: "message-1",
        text: undefined,
      }),
    );
    expect(documentLinkExtractor.extractLinks).not.toHaveBeenCalled();
    expect(mentionAnswerResponder.maybeRespond).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "message-1",
        text: undefined,
      }),
    );
  });

  it("skips disabled group messages without writing facts or discovering documents", async () => {
    const messages = {
      upsertMessage: vi.fn(),
    };
    const documentLinkExtractor = {
      extractLinks: vi.fn(() => [{ sourceUri: "https://docs.feishu.cn/docx/a" }]),
    };
    const groupVisibleDocumentRegistrar = {
      registerDiscoveredLinks: vi.fn(async () => undefined),
    };
    const runtimeController = {
      canProcessIncomingEvent: vi.fn(() => false),
      canReadGroupContext: vi.fn(() => true),
      canReadDocuments: vi.fn(() => true),
    };
    const processor = createFeishuMessageEventProcessor({
      messages,
      documentLinkExtractor,
      groupVisibleDocumentRegistrar,
      runtimeController,
    });

    await processor.process(rawEventFixture());

    expect(runtimeController.canProcessIncomingEvent).toHaveBeenCalledWith({
      groupId: "chat-1",
    });
    expect(messages.upsertMessage).not.toHaveBeenCalled();
    expect(documentLinkExtractor.extractLinks).not.toHaveBeenCalled();
    expect(groupVisibleDocumentRegistrar.registerDiscoveredLinks).not.toHaveBeenCalled();
  });

  it("skips message facts and document discovery when group context reading is disabled", async () => {
    const messages = {
      upsertMessage: vi.fn(),
    };
    const documentLinkExtractor = {
      extractLinks: vi.fn(() => [{ sourceUri: "https://docs.feishu.cn/docx/a" }]),
    };
    const groupVisibleDocumentRegistrar = {
      registerDiscoveredLinks: vi.fn(async () => undefined),
    };
    const mentionAnswerResponder = {
      maybeRespond: vi.fn(async () => ({ status: "skipped" as const, reason: "not_mentioned" as const })),
    };
    const memoryExtractionPlanner = {
      registerMessage: vi.fn(async () => undefined),
    };
    const runtimeController = {
      canProcessIncomingEvent: vi.fn(() => true),
      canReadGroupContext: vi.fn(() => false),
      canReadDocuments: vi.fn(() => true),
    };
    const processor = createFeishuMessageEventProcessor({
      messages,
      documentLinkExtractor,
      groupVisibleDocumentRegistrar,
      mentionAnswerResponder,
      memoryExtractionPlanner,
      runtimeController,
    });

    await processor.process(rawEventFixture());

    expect(runtimeController.canReadGroupContext).toHaveBeenCalledWith("chat-1");
    expect(messages.upsertMessage).not.toHaveBeenCalled();
    expect(documentLinkExtractor.extractLinks).not.toHaveBeenCalled();
    expect(groupVisibleDocumentRegistrar.registerDiscoveredLinks).not.toHaveBeenCalled();
    expect(memoryExtractionPlanner.registerMessage).not.toHaveBeenCalled();
    expect(mentionAnswerResponder.maybeRespond).toHaveBeenCalledWith({
      messageId: "message-1",
      chatId: "chat-1",
      senderId: "open-1",
      text: "Hello",
      mentions: [],
    });
  });

  it("persists messages but skips document discovery when document reading is disabled", async () => {
    const messages = {
      upsertMessage: vi.fn(async (input) => ({
        id: "feishu:message-1",
        createdAt: new Date(),
        ...input,
      })),
    };
    const documentLinkExtractor = {
      extractLinks: vi.fn(() => [{ sourceUri: "https://docs.feishu.cn/docx/a" }]),
    };
    const groupVisibleDocumentRegistrar = {
      registerDiscoveredLinks: vi.fn(async () => undefined),
    };
    const mentionAnswerResponder = {
      maybeRespond: vi.fn(async () => ({ status: "skipped" as const, reason: "not_mentioned" as const })),
    };
    const runtimeController = {
      canProcessIncomingEvent: vi.fn(() => true),
      canReadGroupContext: vi.fn(() => true),
      canReadDocuments: vi.fn(() => false),
    };
    const processor = createFeishuMessageEventProcessor({
      messages,
      documentLinkExtractor,
      groupVisibleDocumentRegistrar,
      mentionAnswerResponder,
      runtimeController,
    });

    await processor.process(rawEventFixture());

    expect(messages.upsertMessage).toHaveBeenCalledOnce();
    expect(runtimeController.canReadDocuments).toHaveBeenCalledOnce();
    expect(documentLinkExtractor.extractLinks).not.toHaveBeenCalled();
    expect(groupVisibleDocumentRegistrar.registerDiscoveredLinks).not.toHaveBeenCalled();
    expect(mentionAnswerResponder.maybeRespond).toHaveBeenCalledWith({
      messageId: "message-1",
      chatId: "chat-1",
      senderId: "open-1",
      text: "Hello",
      mentions: [],
    });
  });

  it("still responds to explicit mentions when document discovery fails", async () => {
    const messages = {
      upsertMessage: vi.fn(async (input) => ({
        id: "feishu:message-1",
        createdAt: new Date(),
        ...input,
      })),
    };
    const documentLinkExtractor = {
      extractLinks: vi.fn(() => [{ sourceUri: "https://docs.feishu.cn/docx/a" }]),
    };
    const groupVisibleDocumentRegistrar = {
      registerDiscoveredLinks: vi.fn(async () => {
        throw new Error("sync queue unavailable");
      }),
    };
    const mentionAnswerResponder = {
      maybeRespond: vi.fn(async () => ({ status: "replied" as const })),
    };
    const processor = createFeishuMessageEventProcessor({
      messages,
      documentLinkExtractor,
      groupVisibleDocumentRegistrar,
      mentionAnswerResponder,
    });

    await expect(
      processor.process(
        rawEventFixture({
          rawBody: {
            header: { event_id: "event-1", event_type: "im.message.receive_v1" },
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
                content: JSON.stringify({
                  text: "@_user_1 please read https://docs.feishu.cn/docx/a",
                }),
                mentions: [
                  {
                    key: "@_user_1",
                    id: { open_id: "ou_iris" },
                    name: "Iris",
                  },
                ],
                create_time: "1782925200000",
              },
            },
          },
        }),
      ),
    ).rejects.toThrow("sync queue unavailable");

    expect(mentionAnswerResponder.maybeRespond).toHaveBeenCalledWith({
      messageId: "message-1",
      chatId: "chat-1",
      senderId: "open-1",
      text: "@_user_1 please read https://docs.feishu.cn/docx/a",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    });
    expect(groupVisibleDocumentRegistrar.registerDiscoveredLinks).toHaveBeenCalledOnce();
  });

  it("still attempts explicit mention replies when message fact persistence fails", async () => {
    const messages = {
      upsertMessage: vi.fn(async () => {
        throw new Error("conversation store unavailable");
      }),
    };
    const mentionAnswerResponder = {
      maybeRespond: vi.fn(async () => ({ status: "replied" as const })),
    };
    const documentLinkExtractor = {
      extractLinks: vi.fn(() => [{ sourceUri: "https://docs.feishu.cn/docx/a" }]),
    };
    const processor = createFeishuMessageEventProcessor({
      messages,
      mentionAnswerResponder,
      documentLinkExtractor,
    });

    await expect(
      processor.process(
        rawEventFixture({
          rawBody: {
            header: { event_id: "event-1", event_type: "im.message.receive_v1" },
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
                content: JSON.stringify({
                  text: "@_user_1 please help",
                }),
                mentions: [
                  {
                    key: "@_user_1",
                    id: { open_id: "ou_iris" },
                    name: "Iris",
                  },
                ],
                create_time: "1782925200000",
              },
            },
          },
        }),
      ),
    ).rejects.toThrow("conversation store unavailable");

    expect(mentionAnswerResponder.maybeRespond).toHaveBeenCalledWith({
      messageId: "message-1",
      chatId: "chat-1",
      senderId: "open-1",
      text: "@_user_1 please help",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    });
    expect(documentLinkExtractor.extractLinks).not.toHaveBeenCalled();
  });

  it("does not call the mention answer responder for disabled incoming events", async () => {
    const messages = {
      upsertMessage: vi.fn(),
    };
    const mentionAnswerResponder = {
      maybeRespond: vi.fn(),
    };
    const runtimeController = {
      canProcessIncomingEvent: vi.fn(() => false),
      canReadGroupContext: vi.fn(() => true),
      canReadDocuments: vi.fn(() => true),
    };
    const processor = createFeishuMessageEventProcessor({
      messages,
      mentionAnswerResponder,
      runtimeController,
    });

    await processor.process(rawEventFixture());

    expect(mentionAnswerResponder.maybeRespond).not.toHaveBeenCalled();
  });

  it("falls back to normalized event type when the Feishu header omits event_type", async () => {
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
        eventType: "im.message.receive_v1",
        rawBody: {
          header: { event_id: "event-1" },
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
              content: "{\"text\":\"Hello from fallback\"}",
              create_time: "1782925200000",
            },
          },
        },
      }),
    );

    expect(messages.upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: "message-1",
        chatId: "chat-1",
        text: "Hello from fallback",
      }),
    );
  });

  it("persists non-text messages without text", async () => {
    const messages = {
      upsertMessage: vi.fn(async (input) => ({
        id: "feishu:message-1",
        createdAt: new Date(),
        ...input,
      })),
    };
    const groupVisibleDocumentRegistrar = {
      registerDiscoveredLinks: vi.fn(async () => undefined),
    };
    const processor = createFeishuMessageEventProcessor({
      messages,
      groupVisibleDocumentRegistrar,
    });

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
    expect(groupVisibleDocumentRegistrar.registerDiscoveredLinks).not.toHaveBeenCalled();
  });

  it.each([
    ["message_id", "message_id"],
    ["chat_id", "chat_id"],
    ["message_type", "message_type"],
  ] as const)("ignores events with oversized required %s", async (_label, field) => {
    const messages = {
      upsertMessage: vi.fn(),
    };
    const mentionAnswerResponder = {
      maybeRespond: vi.fn(),
    };
    const processor = createFeishuMessageEventProcessor({
      messages,
      mentionAnswerResponder,
    });

    await processor.process(
      rawEventFixture({
        rawBody: {
          header: { event_id: "event-1", event_type: "im.message.receive_v1" },
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
              [field]: "I".repeat(513),
              content: "{\"text\":\"Hello\"}",
              create_time: "1782925200000",
            },
          },
        },
      }),
    );

    expect(messages.upsertMessage).not.toHaveBeenCalled();
    expect(mentionAnswerResponder.maybeRespond).not.toHaveBeenCalled();
  });

  it("omits oversized optional sender ids before writing message facts", async () => {
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
            sender: {
              sender_id: {
                open_id: "O".repeat(513),
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
      }),
    );

    expect(messages.upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: "message-1",
        senderId: undefined,
      }),
    );
  });

  it("extracts document links from Feishu post message content", async () => {
    const messages = {
      upsertMessage: vi.fn(async (input) => ({
        id: "feishu:message-1",
        createdAt: new Date(),
        ...input,
      })),
    };
    const documentLinkExtractor = {
      extractLinks: vi.fn(() => [{ sourceUri: "https://docs.feishu.cn/docx/post-doc" }]),
    };
    const groupVisibleDocumentRegistrar = {
      registerDiscoveredLinks: vi.fn(async () => undefined),
    };
    const processor = createFeishuMessageEventProcessor({
      messages,
      documentLinkExtractor,
      groupVisibleDocumentRegistrar,
    });

    await processor.process(
      rawEventFixture({
        rawBody: {
          header: { event_id: "event-1", event_type: "im.message.receive_v1" },
          event: {
            sender: {
              sender_id: {
                open_id: "open-1",
              },
            },
            message: {
              message_id: "message-1",
              chat_id: "chat-1",
              message_type: "post",
              content: JSON.stringify({
                title: "Spec",
                content: [
                  [
                    { tag: "text", text: "Please review " },
                    {
                      tag: "a",
                      text: "product spec",
                      href: "https://docs.feishu.cn/docx/post-doc?from=chat",
                    },
                  ],
                ],
              }),
              create_time: "1782925200000",
            },
          },
        },
      }),
    );

    expect(messages.upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: "post",
        text: "Spec Please review product spec https://docs.feishu.cn/docx/post-doc?from=chat",
      }),
    );
    expect(documentLinkExtractor.extractLinks).toHaveBeenCalledWith(
      "Spec Please review product spec https://docs.feishu.cn/docx/post-doc?from=chat",
    );
    expect(groupVisibleDocumentRegistrar.registerDiscoveredLinks).toHaveBeenCalledWith({
      chatId: "chat-1",
      messageId: "message-1",
      senderId: "open-1",
      observedAt: new Date("2026-07-01T17:00:00.000Z"),
      links: [{ sourceUri: "https://docs.feishu.cn/docx/post-doc" }],
    });
  });

  it("ignores deeply nested Feishu post text beyond the traversal budget", async () => {
    const messages = {
      upsertMessage: vi.fn(async (input) => ({
        id: "feishu:message-1",
        createdAt: new Date(),
        ...input,
      })),
    };
    const processor = createFeishuMessageEventProcessor({ messages });

    let content: unknown = { tag: "text", text: "too deep" };
    for (let index = 0; index < 40; index += 1) {
      content = [content];
    }

    await processor.process(
      rawEventFixture({
        rawBody: {
          header: { event_id: "event-1", event_type: "im.message.receive_v1" },
          event: {
            message: {
              message_id: "message-1",
              chat_id: "chat-1",
              message_type: "post",
              content: JSON.stringify({ content }),
              create_time: "1782925200000",
            },
          },
        },
      }),
    );

    expect(messages.upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: "post",
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

  it("falls back to the Feishu header timestamp before receivedAt", async () => {
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
          header: {
            event_id: "event-1",
            event_type: "im.message.receive_v1",
            create_time: "1782925260000",
          },
          event: {
            message: {
              message_id: "message-1",
              chat_id: "chat-1",
              message_type: "text",
              content: "{\"text\":\"Header time\"}",
              create_time: "bad",
            },
          },
        },
      }),
    );

    expect(messages.upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Header time",
        sentAt: new Date("2026-07-01T17:01:00.000Z"),
      }),
    );
  });

  it("falls back to the Feishu header timestamp for non-decimal message timestamps", async () => {
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
          header: {
            event_id: "event-1",
            event_type: "im.message.receive_v1",
            create_time: "1782925260000",
          },
          event: {
            message: {
              message_id: "message-1",
              chat_id: "chat-1",
              message_type: "text",
              content: "{\"text\":\"Scientific time\"}",
              create_time: "1e3",
            },
          },
        },
      }),
    );

    expect(messages.upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Scientific time",
        sentAt: new Date("2026-07-01T17:01:00.000Z"),
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
