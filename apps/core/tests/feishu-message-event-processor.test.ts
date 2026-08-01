import { describe, expect, it, vi } from "vitest";

import { createFeishuMessageEventProcessor as createFeishuMessageEventProcessorWithReplayGuard } from "../src/conversation/feishu-message-event-processor.js";
import { createFeishuMentionAnswerResponder } from "../src/conversation/feishu-mention-answer-responder.js";
import type { ConversationMessageReplayGuard } from "../src/conversation/conversation-message-replay-guard.js";
import { createDocumentSourceRegistry } from "../src/documents/document-source-registry.js";
import { createFeishuDocumentLinkExtractor } from "../src/documents/feishu-document-link-extractor.js";
import { createGroupVisibleDocumentRegistrar } from "../src/documents/group-visible-document-registrar.js";
import type { RawEvent } from "../src/events/raw-event-queue.js";
import { createMemoryExtractionPlanner } from "../src/memory-extraction/memory-extraction-planner.js";

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
      senderOpenId: "open-1",
      messageType: "text",
      text: "Hello",
      mentions: [],
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
    const messageReplayGuard: ConversationMessageReplayGuard = {
      async runUnlessDeleted<T>({ effect }: { effect: () => Promise<T> }) {
        calls.push("guard");
        return { status: "active", value: await effect() };
      },
    };
    const persistedMessage = {
      id: "feishu:message-1",
      provider: "feishu" as const,
      providerMessageId: "message-1",
      chatId: "chat-1",
      senderId: "open-1",
      senderOpenId: "open-1",
      messageType: "text",
      text: "Hello",
      mentions: [],
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
      messageReplayGuard,
      mentionAnswerResponder,
      memoryExtractionPlanner,
      documentLinkExtractor,
    });

    await processor.process(rawEventFixture());

    expect(calls).toEqual([
      "guard", "reply",
      "guard", "persist",
      "guard", "plan",
      "guard", "documents",
    ]);
    expect(memoryExtractionPlanner.registerMessage).toHaveBeenCalledWith(persistedMessage, {
      senderOpenId: "open-1",
    });
  });

  it("keeps an explicit submission canonical after the full event runs generic discovery", async () => {
    const registry = createDocumentSourceRegistry({
      createId: () => "doc-source-1",
      now: () => new Date("2026-07-28T11:30:00.000Z"),
    });
    const asyncRegistry = {
      registerGroupVisibleDocument: async (
        input: Parameters<typeof registry.registerGroupVisibleDocument>[0],
      ) => registry.registerGroupVisibleDocument(input),
      registerUserSubmittedDocument: async (
        input: Parameters<typeof registry.registerUserSubmittedDocument>[0],
      ) => registry.registerUserSubmittedDocument(input),
    };
    const documentLinkExtractor = createFeishuDocumentLinkExtractor();
    const mentionAnswerResponder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator: { generateDraft: vi.fn() },
      replier: { replyText: vi.fn(async () => ({ replyMessageId: "reply-1" })) },
      documentLinkExtractor,
      userSubmittedDocumentRegistrar: asyncRegistry,
    });
    const processor = createFeishuMessageEventProcessor({
      messages: {
        upsertMessage: vi.fn(async (input) => ({
          id: `feishu:${input.providerMessageId}`,
          createdAt: new Date("2026-07-28T11:30:01.000Z"),
          ...input,
        })),
      },
      documentLinkExtractor,
      groupVisibleDocumentRegistrar: createGroupVisibleDocumentRegistrar({
        registry: asyncRegistry,
      }),
      mentionAnswerResponder,
    });
    const sourceUri = "https://docs.feishu.cn/docx/user_doc_token_1";

    const event = rawEventFixture({
      rawBody: {
        header: {
          event_id: "event-user-submission",
          event_type: "im.message.receive_v1",
        },
        event: {
          sender: { sender_id: { open_id: "ou_alice" } },
          message: {
            message_id: "message-user-submission",
            chat_id: "chat-user-submission",
            message_type: "text",
            content: JSON.stringify({
              text: `@_user_1 请收录这个文档 ${sourceUri}?from=chat`,
            }),
            mentions: [
              { key: "@_user_1", id: { open_id: "ou_iris" }, name: "Iris" },
            ],
            create_time: "1785238140000",
          },
        },
      },
    });

    await processor.process(event);
    await processor.process(event);

    const source = registry.findSourceByUri(sourceUri);
    expect(source?.sourceType).toBe("user_submitted_document");
    expect(source?.canUseForKnowledgeDrafts).toBe(false);
    expect(source?.evidence.map((evidence) => evidence.kind)).toEqual([
      "user_submission",
      "group_message",
    ]);
  });

  it("rechecks deletion before each effect and stops after persistence when the tombstone appears", async () => {
    let guardCalls = 0;
    const messageReplayGuard: ConversationMessageReplayGuard = {
      async runUnlessDeleted<T>({ effect }: { effect: () => Promise<T> }) {
        guardCalls += 1;
        if (guardCalls === 3) return { status: "deleted" };
        return { status: "active", value: await effect() };
      },
    };
    const mentionAnswerResponder = {
      maybeRespond: vi.fn(async () => ({ status: "skipped" as const, reason: "not_mentioned" as const })),
    };
    const messages = {
      upsertMessage: vi.fn(async (input) => ({
        id: "feishu:message-1",
        createdAt: new Date("2026-07-02T01:00:01.000Z"),
        ...input,
      })),
    };
    const memoryExtractionPlanner = { registerMessage: vi.fn(async () => undefined) };
    const documentLinkExtractor = { extractLinks: vi.fn(() => []) };
    const processor = createFeishuMessageEventProcessor({
      messages,
      messageReplayGuard,
      mentionAnswerResponder,
      memoryExtractionPlanner,
      documentLinkExtractor,
    });

    await processor.process(rawEventFixture());

    expect(guardCalls).toBe(3);
    expect(mentionAnswerResponder.maybeRespond).toHaveBeenCalledOnce();
    expect(messages.upsertMessage).toHaveBeenCalledOnce();
    expect(memoryExtractionPlanner.registerMessage).not.toHaveBeenCalled();
    expect(documentLinkExtractor.extractLinks).not.toHaveBeenCalled();
  });

  it("plans only messages with a confirmed non-Iris sender Open ID", async () => {
    const messages = {
      upsertMessage: vi.fn(async (input) => ({
        id: `feishu:${input.providerMessageId}`,
        createdAt: new Date("2026-07-02T01:00:01.000Z"),
        ...input,
      })),
    };
    const repository = {
      registerRequest: vi.fn(async (input) => ({
        request: {
          id: `request:${input.providerMessageId}`,
          groupId: input.groupId,
          conversationMessageId: input.conversationMessageId,
          providerMessageId: input.providerMessageId,
          status: "pending" as const,
          createdAt: new Date("2026-07-02T01:00:02.000Z"),
          updatedAt: new Date("2026-07-02T01:00:02.000Z"),
        },
        created: true,
      })),
    };
    const queue = { enqueue: vi.fn(async (_job: unknown) => undefined) };
    const memoryExtractionPlanner = createMemoryExtractionPlanner({
      repository,
      queue,
      runtimeController: {
        canProcessIncomingEvent: vi.fn(() => true),
        canReadGroupContext: vi.fn(() => true),
      },
      irisBotOpenId: "iris-bot-open-id",
      now: () => new Date("2026-07-02T01:00:03.000Z"),
    });
    const processor = createFeishuMessageEventProcessor({
      messages,
      memoryExtractionPlanner,
    });
    const senderCases = [
      {
        messageId: "union-message",
        senderIds: { union_id: "union-iris-fallback" },
        persistedSenderId: "union-iris-fallback",
        persistedTypedIds: { senderUnionId: "union-iris-fallback" },
      },
      {
        messageId: "user-message",
        senderIds: { user_id: "user-iris-fallback" },
        persistedSenderId: "user-iris-fallback",
        persistedTypedIds: { senderUserId: "user-iris-fallback" },
      },
      {
        messageId: "iris-message",
        senderIds: { open_id: "iris-bot-open-id", union_id: "union-iris" },
        persistedSenderId: "iris-bot-open-id",
        persistedTypedIds: {
          senderOpenId: "iris-bot-open-id",
          senderUnionId: "union-iris",
        },
      },
      {
        messageId: "human-message",
        senderIds: { open_id: "human-open-id", union_id: "union-human" },
        persistedSenderId: "human-open-id",
        persistedTypedIds: {
          senderOpenId: "human-open-id",
          senderUnionId: "union-human",
        },
      },
    ];

    for (const senderCase of senderCases) {
      await processor.process(
        rawEventFixture({
          idempotencyKey: `raw-event:feishu:${senderCase.messageId}`,
          rawBody: {
            header: {
              event_id: `event-${senderCase.messageId}`,
              event_type: "im.message.receive_v1",
            },
            event: {
              sender: { sender_id: senderCase.senderIds },
              message: {
                message_id: senderCase.messageId,
                chat_id: "chat-1",
                message_type: "text",
                content: JSON.stringify({ text: "Eligible conversation text" }),
                create_time: "1782925200000",
              },
            },
          },
        }),
      );
    }

    expect(messages.upsertMessage.mock.calls.map(([input]) => input.senderId)).toEqual(
      senderCases.map((senderCase) => senderCase.persistedSenderId),
    );
    expect(messages.upsertMessage.mock.calls.map(([input]) => ({
      ...(input.senderOpenId === undefined ? {} : { senderOpenId: input.senderOpenId }),
      ...(input.senderUnionId === undefined ? {} : { senderUnionId: input.senderUnionId }),
      ...(input.senderUserId === undefined ? {} : { senderUserId: input.senderUserId }),
    }))).toEqual(senderCases.map((senderCase) => senderCase.persistedTypedIds));
    expect(repository.registerRequest).toHaveBeenCalledOnce();
    expect(repository.registerRequest).toHaveBeenCalledWith({
      groupId: "chat-1",
      conversationMessageId: "feishu:human-message",
      providerMessageId: "human-message",
    });
    expect(queue.enqueue).toHaveBeenCalledOnce();
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.not.objectContaining({ text: expect.anything(), senderId: expect.anything() }),
    );
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
      senderOpenId: "open-1",
      text: "@_user_1 帮我总结",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
      observedAt: new Date("2026-07-01T17:00:00.000Z"),
    });
  });

  it("does not present a union ID fallback as a Feishu open ID", async () => {
    const messages = {
      upsertMessage: vi.fn(async (input) => ({
        id: "feishu:message-union-only",
        createdAt: new Date(),
        ...input,
      })),
    };
    const mentionAnswerResponder = {
      maybeRespond: vi.fn(async () => ({ status: "skipped" as const, reason: "not_mentioned" as const })),
    };
    const processor = createFeishuMessageEventProcessor({ messages, mentionAnswerResponder });

    await processor.process(rawEventFixture({
      rawBody: {
        header: { event_id: "event-union-only", event_type: "im.message.receive_v1" },
        event: {
          sender: { sender_id: { union_id: "on_union_only" } },
          message: {
            message_id: "message-union-only",
            chat_id: "chat-1",
            message_type: "text",
            content: "{\"text\":\"@_user_1 create a knowledge draft\"}",
            mentions: [{ key: "@_user_1", id: { open_id: "ou_iris" }, name: "Iris" }],
            create_time: "1782925200000",
          },
        },
      },
    }));

    expect(mentionAnswerResponder.maybeRespond).toHaveBeenCalledWith(expect.objectContaining({
      senderId: "on_union_only",
    }));
    expect(mentionAnswerResponder.maybeRespond).not.toHaveBeenCalledWith(expect.objectContaining({
      senderOpenId: expect.any(String),
    }));
  });

  it("persists only structured Feishu mention open IDs", async () => {
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
              content: "{\"text\":\"@_user_1 @Alice\"}",
              mentions: [
                { key: "@_user_1", id: { open_id: "ou_owner" }, name: "Owner" },
                { key: "@Alice", name: "Alice" },
              ],
              create_time: "1782925200000",
            },
          },
        },
      }),
    );

    expect(messages.upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        mentions: [{ key: "@_user_1", openId: "ou_owner" }],
      }),
    );
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
      }),
    );
    expect(messages.upsertMessage.mock.calls[0]?.[0]).not.toHaveProperty("text");
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
      senderOpenId: "open-1",
      text: "Hello",
      mentions: [],
      observedAt: new Date("2026-07-01T17:00:00.000Z"),
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
      senderOpenId: "open-1",
      text: "Hello",
      mentions: [],
      observedAt: new Date("2026-07-01T17:00:00.000Z"),
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
      senderOpenId: "open-1",
      text: "@_user_1 please read https://docs.feishu.cn/docx/a",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
      observedAt: new Date("2026-07-01T17:00:00.000Z"),
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
      senderOpenId: "open-1",
      text: "@_user_1 please help",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
      observedAt: new Date("2026-07-01T17:00:00.000Z"),
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
      }),
    );
    expect(messages.upsertMessage.mock.calls[0]?.[0]).not.toHaveProperty("text");
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
      }),
    );
    expect(messages.upsertMessage.mock.calls[0]?.[0]).not.toHaveProperty("senderId");
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
      }),
    );
    expect(messages.upsertMessage.mock.calls[0]?.[0]).not.toHaveProperty("text");
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
        sentAt: new Date("2026-07-02T01:00:00.000Z"),
      }),
    );
    expect(messages.upsertMessage.mock.calls[0]?.[0]).not.toHaveProperty("text");
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

const allowActiveMessages: ConversationMessageReplayGuard = {
  async runUnlessDeleted<T>({ effect }: { effect: () => Promise<T> }) {
    return { status: "active", value: await effect() };
  },
};

function createFeishuMessageEventProcessor(
  input: Omit<Parameters<typeof createFeishuMessageEventProcessorWithReplayGuard>[0], "messageReplayGuard"> & {
    messageReplayGuard?: ConversationMessageReplayGuard;
  },
) {
  const { messageReplayGuard = allowActiveMessages, ...dependencies } = input;
  return createFeishuMessageEventProcessorWithReplayGuard({
    ...dependencies,
    messageReplayGuard,
  });
}

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
