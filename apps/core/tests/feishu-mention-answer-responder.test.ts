import { describe, expect, it, vi } from "vitest";

import type { AnswerDraftInput } from "../src/agent/answer-draft-orchestrator.js";
import type {
  AnswerReplyDeliveryRequest,
  AnswerReplyDeliveryService,
} from "../src/answer-replies/answer-reply-delivery-service.js";
import {
  createFeishuMentionAnswerResponder as createProductionFeishuMentionAnswerResponder,
  type FeishuMentionAnswerResponderDependencies,
} from "../src/conversation/feishu-mention-answer-responder.js";
import type { RetrievedDocumentFragment } from "../src/documents/document-fragment-repository.js";
import { createFeishuDocumentLinkExtractor } from "../src/documents/feishu-document-link-extractor.js";
import type { FeishuMessageReplier } from "../src/feishu/feishu-message-replier.js";
import { ModelProviderHttpError } from "../src/model/model-provider-error.js";
import type { ChatKnowledgeDraftCommand } from "../src/knowledge-governance/chat-knowledge-draft-command.js";
import { ChatKnowledgeDraftModelUnavailableError } from "../src/knowledge-governance/chat-knowledge-draft-generator.js";

type ReplyTextInput = Parameters<FeishuMessageReplier["replyText"]>[0];

describe("FeishuMentionAnswerResponder", () => {
  it("handles an explicit knowledge-draft command before ordinary answer drafting", async () => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const answerReplyDeliveryService = { respond: vi.fn() };
    const knowledgeDraftCommand = {
      execute: vi.fn<ChatKnowledgeDraftCommand["execute"]>(async () => ({
        status: "created",
        draftId: "draft-1",
        presentationId: "presentation-1",
      })),
    };
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-draft" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      answerReplyDeliveryService,
      knowledgeDraftCommand,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
    });
    const input = {
      messageId: "om_create_draft",
      chatId: "oc_pilot",
      senderId: "ou_owner",
      senderOpenId: "ou_owner",
      text: "@_user_1 \u628a\u521a\u624d\u8ba8\u8bba\u6574\u7406\u6210\u77e5\u8bc6\u8349\u7a3f",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
      observedAt: new Date("2026-08-02T03:00:00.000Z"),
    };

    await expect(responder.maybeRespond(input)).resolves.toEqual({
      status: "replied",
      replyMessageId: "reply-draft",
    });
    await expect(responder.maybeRespond(input)).resolves.toEqual({
      status: "skipped",
      reason: "duplicate_message",
    });
    expect(knowledgeDraftCommand.execute).toHaveBeenCalledWith({
      messageId: "om_create_draft",
      chatId: "oc_pilot",
      requesterOpenId: "ou_owner",
      requestText: "\u628a\u521a\u624d\u8ba8\u8bba\u6574\u7406\u6210\u77e5\u8bc6\u8349\u7a3f",
      observedAt: new Date("2026-08-02T03:00:00.000Z"),
    });
    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
    expect(answerReplyDeliveryService.respond).not.toHaveBeenCalled();
    expect(replier.replyText).toHaveBeenCalledWith({
      messageId: "om_create_draft",
      text: "\u77e5\u8bc6\u8349\u7a3f\u5df2\u751f\u6210\uff0c\u7fa4\u786e\u8ba4\u5361\u7247\u6b63\u5728\u53d1\u9001\u3002\u5f53\u524d\u5c1a\u672a\u5199\u5165\u77e5\u8bc6\u5e93\u3002",
      replyInThread: true,
      uuid: expect.stringMatching(/^iris-[a-f0-9]{45}$/u),
    });
  });

  it.each([
    "@_user_1 \u80fd\u5e2e\u6211\u521b\u5efa\u4e00\u4efd\u77e5\u8bc6\u8349\u7a3f\u5417\uff1f",
    "@_user_1 Can you create a knowledge draft from this discussion?",
  ])("treats a polite knowledge-draft request as an explicit command: %s", async (text) => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const knowledgeDraftCommand = {
      execute: vi.fn<ChatKnowledgeDraftCommand["execute"]>(async () => ({
        status: "created",
        draftId: "draft-polite",
        presentationId: "presentation-polite",
      })),
    };
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-polite" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      knowledgeDraftCommand,
      replier,
    });

    await responder.maybeRespond({
      messageId: `om_polite_${text.length}`,
      chatId: "oc_pilot",
      senderId: "ou_owner",
      senderOpenId: "ou_owner",
      text,
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    });

    expect(knowledgeDraftCommand.execute).toHaveBeenCalledOnce();
    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
  });

  it("keeps an ordinary knowledge-base question on the answer path", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "A normal answer.",
        promptContext: "<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const knowledgeDraftCommand = { execute: vi.fn<ChatKnowledgeDraftCommand["execute"]>() };
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-normal" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      knowledgeDraftCommand,
      replier,
    });

    await responder.maybeRespond({
      messageId: "om_knowledge_question",
      chatId: "oc_pilot",
      senderId: "ou_owner",
      text: "@_user_1 \u77e5\u8bc6\u5e93\u662f\u4ec0\u4e48\uff1f",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    });

    expect(knowledgeDraftCommand.execute).not.toHaveBeenCalled();
    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledOnce();
  });

  it.each([
    "@_user_1 \u77e5\u8bc6\u8349\u7a3f\u662f\u4ec0\u4e48\uff1f",
    "@_user_1 \u5982\u4f55\u521b\u5efa\u77e5\u8bc6\u8349\u7a3f\uff1f",
    "@_user_1 \u521b\u5efa\u77e5\u8bc6\u8349\u7a3f\u9700\u8981\u4ec0\u4e48\u6d41\u7a0b\uff1f",
    "@_user_1 \u4e0d\u8981\u521b\u5efa\u77e5\u8bc6\u8349\u7a3f",
    "@_user_1 \u522b\u628a\u8fd9\u6bb5\u8ba8\u8bba\u6574\u7406\u5230\u77e5\u8bc6\u5e93",
  ])("does not persist a draft for a question or negated command: %s", async (text) => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "A normal answer.",
        promptContext: "<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const knowledgeDraftCommand = { execute: vi.fn<ChatKnowledgeDraftCommand["execute"]>() };
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-normal" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      knowledgeDraftCommand,
      replier,
    });

    await responder.maybeRespond({
      messageId: `om_non_command_${text.length}`,
      chatId: "oc_pilot",
      senderId: "ou_owner",
      senderOpenId: "ou_owner",
      text,
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    });

    expect(knowledgeDraftCommand.execute).not.toHaveBeenCalled();
    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledOnce();
  });

  it("fails closed when an explicit draft command has no requester identity", async () => {
    const knowledgeDraftCommand = { execute: vi.fn<ChatKnowledgeDraftCommand["execute"]>() };
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-no-sender" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator: { generateDraft: vi.fn() },
      knowledgeDraftCommand,
      replier,
    });

    await responder.maybeRespond({
      messageId: "om_draft_no_sender",
      chatId: "oc_pilot",
      senderId: "on_union_id_is_not_an_open_id",
      text: "@_user_1 create a knowledge draft",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    });

    expect(knowledgeDraftCommand.execute).not.toHaveBeenCalled();
    expect(replier.replyText).toHaveBeenCalledWith(expect.objectContaining({
      text: "\u6682\u65f6\u65e0\u6cd5\u786e\u8ba4\u8bf7\u6c42\u4eba\uff0c\u672a\u521b\u5efa\u77e5\u8bc6\u8349\u7a3f\u3002",
    }));
  });

  it("does not fall through to ordinary answering when the draft command is unavailable", async () => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-disabled" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
    });

    await responder.maybeRespond({
      messageId: "om_draft_unavailable",
      chatId: "oc_pilot",
      senderId: "ou_owner",
      senderOpenId: "ou_owner",
      text: "@_user_1 create a knowledge draft",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    });

    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
    expect(replier.replyText).toHaveBeenCalledWith(expect.objectContaining({
      text: "\u5f53\u524d\u77e5\u8bc6\u8349\u7a3f\u529f\u80fd\u672a\u5f00\u653e\uff0c\u672a\u521b\u5efa\u8349\u7a3f\uff0c\u4e5f\u672a\u5199\u5165\u77e5\u8bc6\u5e93\u3002",
    }));
  });

  it.each([
    {
      status: "runtime_disabled" as const,
      expected: "\u5f53\u524d\u77e5\u8bc6\u8349\u7a3f\u529f\u80fd\u672a\u5f00\u653e\uff0c\u672a\u521b\u5efa\u8349\u7a3f\uff0c\u4e5f\u672a\u5199\u5165\u77e5\u8bc6\u5e93\u3002",
    },
    {
      status: "no_context" as const,
      expected: "\u6700\u8fd1\u6ca1\u6709\u53ef\u6574\u7406\u7684\u7fa4\u804a\u5185\u5bb9\uff0c\u672a\u521b\u5efa\u77e5\u8bc6\u8349\u7a3f\u3002",
    },
    {
      status: "target_unavailable" as const,
      expected: "\u5f53\u524d\u7fa4\u5c1a\u672a\u914d\u7f6e\u552f\u4e00\u7684\u77e5\u8bc6\u5e93\u53d1\u5e03\u4f4d\u7f6e\uff0c\u672a\u521b\u5efa\u77e5\u8bc6\u8349\u7a3f\u3002",
    },
  ])("returns a bounded $status draft outcome", async ({ status, expected }) => {
    const knowledgeDraftCommand = {
      execute: vi.fn<ChatKnowledgeDraftCommand["execute"]>(async () => ({ status })),
    };
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-outcome" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator: { generateDraft: vi.fn() },
      knowledgeDraftCommand,
      replier,
    });

    await responder.maybeRespond({
      messageId: `om_${status}`,
      chatId: "oc_pilot",
      senderId: "ou_owner",
      senderOpenId: "ou_owner",
      text: "@_user_1 archive this discussion to the knowledge base",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    });

    expect(replier.replyText).toHaveBeenCalledWith(expect.objectContaining({ text: expected }));
  });

  it("uses the capacity fallback for draft generation without exposing provider detail", async () => {
    const knowledgeDraftCommand = {
      execute: vi.fn<ChatKnowledgeDraftCommand["execute"]>(async () => {
        throw new ChatKnowledgeDraftModelUnavailableError(
          new ModelProviderHttpError(429, "private quota detail"),
        );
      }),
    };
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-capacity" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator: { generateDraft: vi.fn() },
      knowledgeDraftCommand,
      replier,
    });

    await responder.maybeRespond({
      messageId: "om_draft_capacity",
      chatId: "oc_pilot",
      senderId: "ou_owner",
      senderOpenId: "ou_owner",
      text: "@_user_1 create a knowledge draft",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    });

    expect(replier.replyText).toHaveBeenCalledWith(expect.objectContaining({
      text: "\u6a21\u578b\u670d\u52a1\u6682\u65f6\u8fbe\u5230\u4f7f\u7528\u4e0a\u9650\uff0c\u672a\u521b\u5efa\u77e5\u8bc6\u8349\u7a3f\u3002\u6062\u590d\u540e\u8bf7\u518d @\u6211\u4e00\u6b21\u3002",
    }));
  });

  it.each([
    {
      name: "provider 503",
      error: new ModelProviderHttpError(503, "private upstream detail"),
    },
    {
      name: "provider timeout",
      error: new Error("model provider request timed out"),
    },
  ])("returns a bounded non-creation reply for $name", async ({ error }) => {
    const knowledgeDraftCommand = {
      execute: vi.fn<ChatKnowledgeDraftCommand["execute"]>(async () => {
        throw error;
      }),
    };
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-unavailable" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator: { generateDraft: vi.fn() },
      knowledgeDraftCommand,
      replier,
    });

    await expect(responder.maybeRespond({
      messageId: `om_draft_unavailable_${error.message.length}`,
      chatId: "oc_pilot",
      senderId: "ou_owner",
      senderOpenId: "ou_owner",
      text: "@_user_1 create a knowledge draft",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    })).resolves.toMatchObject({ status: "replied" });

    expect(replier.replyText).toHaveBeenCalledWith(expect.objectContaining({
      text: "\u6a21\u578b\u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u672a\u521b\u5efa\u77e5\u8bc6\u8349\u7a3f\u3002\u8bf7\u7a0d\u540e\u518d @\u6211\u4e00\u6b21\u3002",
    }));
  });

  it("reports invalid draft model output as a safe non-creation", async () => {
    const knowledgeDraftCommand = {
      execute: vi.fn<ChatKnowledgeDraftCommand["execute"]>(async () => {
        throw new Error("knowledge draft model response is invalid");
      }),
    };
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-invalid" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator: { generateDraft: vi.fn() },
      knowledgeDraftCommand,
      replier,
    });

    await responder.maybeRespond({
      messageId: "om_draft_invalid",
      chatId: "oc_pilot",
      senderId: "ou_owner",
      senderOpenId: "ou_owner",
      text: "@_user_1 create a knowledge draft",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    });

    expect(replier.replyText).toHaveBeenCalledWith(expect.objectContaining({
      text: "\u672a\u751f\u6210\u53ef\u9760\u7684\u77e5\u8bc6\u8349\u7a3f\uff0c\u6ca1\u6709\u521b\u5efa\u6216\u53d1\u5e03\u4efb\u4f55\u5185\u5bb9\u3002",
    }));
  });

  it("drafts an answer and replies when the configured Iris bot is mentioned", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "Iris answer.",
        promptContext: "<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const replyInputs: ReplyTextInput[] = [];
    const replier = {
      replyText: vi.fn(async (input: ReplyTextInput) => {
        replyInputs.push(input);
        return { replyMessageId: "reply-1" };
      }),
    };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
    });

    await expect(
      responder.maybeRespond({
        messageId: "om_message_1",
        chatId: "oc_group_1",
        senderId: "ou_alice",
        text: "@_user_1 帮我总结一下",
        mentions: [
          {
            key: "@_user_1",
            openId: "ou_iris",
            name: "Iris",
          },
        ],
      }),
    ).resolves.toEqual({ status: "replied", replyMessageId: "reply-1" });

    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledWith({
      executionId: "om_message_1",
      question: "帮我总结一下",
      chatId: "oc_group_1",
      askerId: "ou_alice",
      liveChatMessages: [{ speaker: "ou_alice", text: "帮我总结一下" }],
    });
    expect(replier.replyText).toHaveBeenCalledWith({
      messageId: "om_message_1",
      text: "Iris answer.",
      replyInThread: true,
      uuid: expect.stringMatching(/^iris-[a-f0-9]{45}$/u),
    });
    const replyInput = replyInputs[0];
    expect(replyInput).toBeDefined();
    expect(replyInput?.uuid?.length).toBe(50);
  });

  it("prepares a cited ordinary answer lazily through the durable delivery service", async () => {
    const preparedAt = new Date("2026-08-02T04:05:06.000Z");
    const allowedFragment = answerFragment();
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "Grounded answer.",
        citedSourceRefs: ["D1"],
        promptContext: "<document_context></document_context>",
        allowedFragments: [allowedFragment],
        deniedDocumentIds: ["source-revoked"],
        retrievedFragmentCount: 1,
        usedGroupMemories: [],
      })),
    };
    let deliveryRequest: AnswerReplyDeliveryRequest | undefined;
    let preparedAnswer: Awaited<ReturnType<AnswerReplyDeliveryRequest["prepareAnswer"]>> | undefined;
    const answerReplyDeliveryService = {
      respond: vi.fn<AnswerReplyDeliveryService["respond"]>(async (request) => {
        deliveryRequest = request;
        preparedAnswer = await request.prepareAnswer();
        return { replyMessageId: "reply-from-service" };
      }),
    };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      answerReplyDeliveryService,
      replier: { replyText: vi.fn() },
      now: () => preparedAt,
    });

    await expect(responder.maybeRespond({
      messageId: "om_cited_answer",
      chatId: "oc_group_1",
      senderId: "ou_alice",
      text: "@_user_1 summarize the wiki",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    })).resolves.toEqual({
      status: "replied",
      replyMessageId: "reply-from-service",
    });

    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledOnce();
    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledWith({
      executionId: "om_cited_answer",
      question: "summarize the wiki",
      chatId: "oc_group_1",
      askerId: "ou_alice",
      liveChatMessages: [{ speaker: "ou_alice", text: "summarize the wiki" }],
    });
    expect(deliveryRequest).toMatchObject({
      provider: "feishu",
      incomingMessageId: "om_cited_answer",
      chatId: "oc_group_1",
      replyUuid: "iris-1d3e446e24c6a2c7bfd8e1004e7c26b2d0d901c9d367a",
      safeNoticeUuid: "iris-safe-1d3e446e24c6a2c7bfd8e1004e7c26b2d0d901c9",
      prepareAnswer: expect.any(Function),
    });
    expect(preparedAnswer).toEqual({
      renderedText:
        "Grounded answer.\n\n" +
        "Iris \u53c2\u8003\u8d44\u6599\uff1a\n" +
        "[1] [\u77e5\u8bc6\u5e93] Quello Life Engine\n" +
        "https://tenant.feishu.cn/wiki/wikiA",
      sourceTraces: [{
        promptRank: 1,
        citationRank: 1,
        documentSourceId: "source-wiki-a",
        documentSnapshotId: "snapshot-a",
        fragmentId: "fragment-a-2",
        chunkIndex: 2,
        sourceType: "feishu_wiki",
        sourceUri: "https://tenant.feishu.cn/wiki/wikiA",
        sourceTitle: "Quello Life Engine",
        contentHash: "hash-fragment-a-2",
        embeddingProfileId: "profile-1",
        initialPermissionCheckedAt: preparedAt,
      }],
      blockedDocumentSourceIds: ["source-revoked"],
      preparedAt,
    });
  });

  it("resumes a durable ordinary answer without generating another draft", async () => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const answerReplyDeliveryService = {
      respond: vi.fn<AnswerReplyDeliveryService["respond"]>(async () => ({
        replyMessageId: "reply-resumed",
      })),
    };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      answerReplyDeliveryService,
      replier: { replyText: vi.fn() },
    });

    await expect(responder.maybeRespond({
      messageId: "om_resumed_answer",
      chatId: "oc_group_1",
      senderId: "ou_alice",
      text: "@_user_1 summarize",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    })).resolves.toEqual({ status: "replied", replyMessageId: "reply-resumed" });

    expect(answerReplyDeliveryService.respond).toHaveBeenCalledOnce();
    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
  });

  it.each([
    ["blank-shaped", () => new Error("model answer draft must not be blank")],
    ["capacity-shaped", () => new ModelProviderHttpError(429, "model capacity reached")],
  ])(
    "keeps %s delivery failures before preparation on the retry path",
    async (_label, createServiceError) => {
      const serviceError = createServiceError();
      const answerDraftOrchestrator = { generateDraft: vi.fn() };
      const answerReplyDeliveryService = {
        respond: vi.fn<AnswerReplyDeliveryService["respond"]>(async () => {
          throw serviceError;
        }),
      };
      const replier = { replyText: vi.fn() };
      const responder = createFeishuMentionAnswerResponder({
        botOpenId: "ou_iris",
        answerDraftOrchestrator,
        answerReplyDeliveryService,
        replier,
      });

      await expect(responder.maybeRespond({
        messageId: "om_delivery_failure_before_prepare",
        chatId: "oc_group_1",
        senderId: "ou_alice",
        text: "@_user_1 summarize",
        mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
      })).rejects.toBe(serviceError);

      expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
      expect(replier.replyText).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["blank-shaped", () => new Error("model answer draft must not be blank")],
    ["capacity-shaped", () => new ModelProviderHttpError(429, "model capacity reached")],
  ])(
    "keeps %s delivery failures after successful preparation on the retry path",
    async (_label, createServiceError) => {
      const serviceError = createServiceError();
      const answerDraftOrchestrator = {
        generateDraft: vi.fn(async () => ({
          answerText: "Prepared answer.",
          promptContext: "<live_chat_context></live_chat_context>",
          allowedFragments: [],
          deniedDocumentIds: [],
          retrievedFragmentCount: 0,
          usedGroupMemories: [],
        })),
      };
      const answerReplyDeliveryService = {
        respond: vi.fn<AnswerReplyDeliveryService["respond"]>(async (request) => {
          await request.prepareAnswer();
          throw serviceError;
        }),
      };
      const replier = { replyText: vi.fn() };
      const responder = createFeishuMentionAnswerResponder({
        botOpenId: "ou_iris",
        answerDraftOrchestrator,
        answerReplyDeliveryService,
        replier,
      });

      await expect(responder.maybeRespond({
        messageId: "om_delivery_failure_after_prepare",
        chatId: "oc_group_1",
        senderId: "ou_alice",
        text: "@_user_1 summarize",
        mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
      })).rejects.toBe(serviceError);

      expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledOnce();
      expect(replier.replyText).not.toHaveBeenCalled();
    },
  );

  it("prepares a source-free ordinary answer without a citation footer or trace", async () => {
    const preparedAt = new Date("2026-08-02T05:06:07.000Z");
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "Source-free answer.",
        promptContext: "<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    let preparedAnswer: Awaited<ReturnType<AnswerReplyDeliveryRequest["prepareAnswer"]>> | undefined;
    const answerReplyDeliveryService = {
      respond: vi.fn<AnswerReplyDeliveryService["respond"]>(async (request) => {
        preparedAnswer = await request.prepareAnswer();
        return { replyMessageId: "reply-source-free" };
      }),
    };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      answerReplyDeliveryService,
      replier: { replyText: vi.fn() },
      now: () => preparedAt,
    });

    await responder.maybeRespond({
      messageId: "om_source_free",
      chatId: "oc_group_1",
      senderId: "ou_alice",
      text: "@_user_1 answer from chat",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    });

    expect(preparedAnswer).toEqual({
      renderedText: "Source-free answer.",
      sourceTraces: [],
      preparedAt,
    });
    expect(preparedAnswer?.renderedText).not.toContain("Iris \u53c2\u8003\u8d44\u6599\uff1a");
  });

  it("skips messages that mention another user but not Iris", async () => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const replier = { replyText: vi.fn() };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
    });

    await expect(
      responder.maybeRespond({
        messageId: "om_message_1",
        chatId: "oc_group_1",
        senderId: "ou_alice",
        text: "@_user_1 帮我看下",
        mentions: [{ key: "@_user_1", openId: "ou_bob", name: "Bob" }],
      }),
    ).resolves.toEqual({ status: "skipped", reason: "not_mentioned" });

    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
    expect(replier.replyText).not.toHaveBeenCalled();
  });

  it("truncates oversized mentioned questions before drafting an answer", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async (_input: AnswerDraftInput) => ({
        answerText: "Iris answer.",
        promptContext: "<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-1" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
    });

    await responder.maybeRespond({
      messageId: "om_message_1",
      chatId: "oc_group_1",
      senderId: "ou_alice",
      text: `@_user_1 ${"Q".repeat(5000)} trailing detail`,
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    });

    const request = answerDraftOrchestrator.generateDraft.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    expect(request?.question.length).toBeLessThanOrEqual(4000);
    expect(request?.question).toContain("[truncated]");
    expect(request?.question).not.toContain("trailing detail");
    expect(request?.executionId).toBe("om_message_1");
    expect(request?.askerId).toBe("ou_alice");
    expect(request?.liveChatMessages).toEqual([
      { speaker: "ou_alice", text: request?.question },
    ]);
  });

  it("strips overlapping bot mention keys without leaving partial key text", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async (_input: AnswerDraftInput) => ({
        answerText: "Iris answer.",
        promptContext: "<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-1" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
    });

    await responder.maybeRespond({
      messageId: "om_message_1",
      chatId: "oc_group_1",
      senderId: "ou_alice",
      text: "@_user_10 @_user_1 summarize this",
      mentions: [
        { key: "@_user_1", openId: "ou_iris", name: "Iris" },
        { key: "@_user_10", openId: "ou_iris", name: "Iris" },
      ],
    });

    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledWith({
      executionId: "om_message_1",
      question: "summarize this",
      chatId: "oc_group_1",
      askerId: "ou_alice",
      liveChatMessages: [{ speaker: "ou_alice", text: "summarize this" }],
    });
  });

  it("registers a user-submitted Feishu document from an explicit mention command without drafting an answer", async () => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const answerReplyDeliveryService = { respond: vi.fn() };
    const registerUserSubmittedDocument = vi.fn(async () => ({
      source: { id: "doc-source-1" },
      enqueue: { status: "enqueued" as const, jobId: "sync-job-1" },
    }));
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-doc" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      answerReplyDeliveryService,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
      documentLinkExtractor: createFeishuDocumentLinkExtractor(),
      userSubmittedDocumentRegistrar: { registerUserSubmittedDocument },
    });

    await expect(
      responder.maybeRespond({
        messageId: "om_user_doc_submission",
        chatId: "oc_group_1",
        senderId: "ou_alice",
        text: "@_user_1 please register document https://docs.feishu.cn/docx/user_doc_token_1?from=chat",
        mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
        observedAt: new Date("2026-07-24T02:30:00.000Z"),
      }),
    ).resolves.toEqual({ status: "replied", replyMessageId: "reply-doc" });

    expect(registerUserSubmittedDocument).toHaveBeenCalledWith({
      sourceUri: "https://docs.feishu.cn/docx/user_doc_token_1",
      submittedByUserId: "ou_alice",
      submissionGroupId: "oc_group_1",
      submissionMessageId: "om_user_doc_submission",
      observedAt: new Date("2026-07-24T02:30:00.000Z"),
    });
    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
    expect(answerReplyDeliveryService.respond).not.toHaveBeenCalled();
    expect(replier.replyText).toHaveBeenCalledWith({
      messageId: "om_user_doc_submission",
      text: "\u5df2\u6536\u5230\u8fd9\u4e2a\u6587\u6863\uff0c\u6211\u4f1a\u540c\u6b65\u5b83\u7684\u5185\u5bb9\u3002\u540c\u6b65\u5b8c\u6210\u540e\uff0c\u4f60\u53ef\u4ee5\u76f4\u63a5 @\u6211\u63d0\u95ee\u3002",
      replyInThread: true,
      uuid: expect.stringMatching(/^iris-[a-f0-9]{45}$/u),
    });
  });

  it("registers a user-submitted Feishu document from an explicit Chinese mention command", async () => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const registerUserSubmittedDocument = vi.fn(async () => ({
      source: { id: "doc-source-cn" },
      enqueue: { status: "enqueued" as const, jobId: "sync-job-cn" },
    }));
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-doc-cn" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
      documentLinkExtractor: createFeishuDocumentLinkExtractor(),
      userSubmittedDocumentRegistrar: { registerUserSubmittedDocument },
    });

    await expect(
      responder.maybeRespond({
        messageId: "om_user_doc_submission_cn",
        chatId: "oc_group_1",
        senderId: "ou_alice",
        text: "@_user_1 \u8bf7\u6536\u5f55\u8fd9\u4e2a\u6587\u6863 https://tcnmvzw006k7.feishu.cn/wiki/N2cswiBleiiyOokzJotcnDTunxe?fromScene=spaceOverview",
        mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
        observedAt: new Date("2026-07-24T03:00:00.000Z"),
      }),
    ).resolves.toEqual({ status: "replied", replyMessageId: "reply-doc-cn" });

    expect(registerUserSubmittedDocument).toHaveBeenCalledWith({
      sourceUri: "https://tcnmvzw006k7.feishu.cn/wiki/N2cswiBleiiyOokzJotcnDTunxe",
      submittedByUserId: "ou_alice",
      submissionGroupId: "oc_group_1",
      submissionMessageId: "om_user_doc_submission_cn",
      observedAt: new Date("2026-07-24T03:00:00.000Z"),
    });
    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
  });

  it("asks for a Feishu document link when an explicit document submission command has no readable link", async () => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const registerUserSubmittedDocument = vi.fn();
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-doc-link" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
      documentLinkExtractor: createFeishuDocumentLinkExtractor(),
      userSubmittedDocumentRegistrar: { registerUserSubmittedDocument },
    });

    await expect(
      responder.maybeRespond({
        messageId: "om_user_doc_submission_without_link",
        chatId: "oc_group_1",
        senderId: "ou_alice",
        text: "@_user_1 please register document",
        mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
      }),
    ).resolves.toEqual({ status: "replied", replyMessageId: "reply-doc-link" });

    expect(registerUserSubmittedDocument).not.toHaveBeenCalled();
    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
    expect(replier.replyText).toHaveBeenCalledWith({
      messageId: "om_user_doc_submission_without_link",
      text: "\u8bf7\u53d1\u9001\u4e00\u4e2a\u6211\u53ef\u4ee5\u8bfb\u53d6\u7684\u98de\u4e66\u6587\u6863\u94fe\u63a5\uff0c\u7136\u540e\u518d\u8ba9\u6211\u6536\u5f55\u3002",
      replyInThread: true,
      uuid: expect.stringMatching(/^iris-[a-f0-9]{45}$/u),
    });
  });

  it("keeps questions about user-submitted documents on the answer path", async () => {
    const question =
      "\u521a\u624d\u6536\u5f55\u7684\u7528\u6237\u63d0\u4ea4\u6587\u6863\uff0c\u9a8c\u6536\u7f16\u53f7\u662f\u4ec0\u4e48\uff1f\u53ea\u56de\u590d\u7f16\u53f7\u3002";
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "IRIS_USER_DOC_20260728_616559",
        promptContext: "<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const registerUserSubmittedDocument = vi.fn();
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-answer" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
      documentLinkExtractor: createFeishuDocumentLinkExtractor(),
      userSubmittedDocumentRegistrar: { registerUserSubmittedDocument },
    });

    await expect(
      responder.maybeRespond({
        messageId: "om_user_doc_question",
        chatId: "oc_group_1",
        senderId: "ou_alice",
        text: `@_user_1 ${question}`,
        mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
      }),
    ).resolves.toEqual({ status: "replied", replyMessageId: "reply-answer" });

    expect(registerUserSubmittedDocument).not.toHaveBeenCalled();
    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledWith({
      executionId: "om_user_doc_question",
      question,
      chatId: "oc_group_1",
      askerId: "ou_alice",
      liveChatMessages: [{ speaker: "ou_alice", text: question }],
    });
  });

  it("does not register or answer explicit document submission commands when document reading is disabled", async () => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const registerUserSubmittedDocument = vi.fn();
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-doc-disabled" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
      canRegisterUserSubmittedDocuments: vi.fn(() => false),
      documentLinkExtractor: createFeishuDocumentLinkExtractor(),
      userSubmittedDocumentRegistrar: { registerUserSubmittedDocument },
    });

    await expect(
      responder.maybeRespond({
        messageId: "om_user_doc_submission_disabled",
        chatId: "oc_group_1",
        senderId: "ou_alice",
        text: "@_user_1 please register document https://docs.feishu.cn/docx/user_doc_token_1",
        mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
      }),
    ).resolves.toEqual({ status: "replied", replyMessageId: "reply-doc-disabled" });

    expect(registerUserSubmittedDocument).not.toHaveBeenCalled();
    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
    expect(replier.replyText).toHaveBeenCalledWith({
      messageId: "om_user_doc_submission_disabled",
      text: "\u5f53\u524d\u6587\u6863\u8bfb\u53d6\u80fd\u529b\u5df2\u5173\u95ed\uff0c\u6211\u4e0d\u4f1a\u6536\u5f55\u8fd9\u4e2a\u6587\u6863\u3002",
      replyInThread: true,
      uuid: expect.stringMatching(/^iris-[a-f0-9]{45}$/u),
    });
  });

  it("keeps ordinary mentioned questions with Feishu document links on the answer path", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "Iris answer.",
        promptContext: "<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const registerUserSubmittedDocument = vi.fn();
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-answer" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
      documentLinkExtractor: createFeishuDocumentLinkExtractor(),
      userSubmittedDocumentRegistrar: { registerUserSubmittedDocument },
    });

    await expect(
      responder.maybeRespond({
        messageId: "om_doc_question",
        chatId: "oc_group_1",
        senderId: "ou_alice",
        text: "@_user_1 what does this document say? https://docs.feishu.cn/docx/user_doc_token_1",
        mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
      }),
    ).resolves.toEqual({ status: "replied", replyMessageId: "reply-answer" });

    expect(registerUserSubmittedDocument).not.toHaveBeenCalled();
    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledWith({
      executionId: "om_doc_question",
      question: "what does this document say? https://docs.feishu.cn/docx/user_doc_token_1",
      chatId: "oc_group_1",
      askerId: "ou_alice",
      liveChatMessages: [
        {
          speaker: "ou_alice",
          text: "what does this document say? https://docs.feishu.cn/docx/user_doc_token_1",
        },
      ],
    });
  });

  it("skips mentioned messages when runtime control disables replies", async () => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const replier = { replyText: vi.fn() };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => false),
    });

    await expect(
      responder.maybeRespond({
        messageId: "om_message_1",
        chatId: "oc_group_1",
        senderId: "ou_alice",
        text: "@_user_1 帮我看下",
        mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
      }),
    ).resolves.toEqual({ status: "skipped", reason: "runtime_disabled" });

    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
    expect(replier.replyText).not.toHaveBeenCalled();
  });

  it("does not answer an old duplicate mention after replies are re-enabled", async () => {
    let repliesEnabled = false;
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "Iris answer.",
        promptContext: "<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-1" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => repliesEnabled),
    });
    const input = {
      messageId: "om_disabled_then_retried",
      chatId: "oc_group_1",
      senderId: "ou_alice",
      text: "@_user_1 summarize",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    };

    await expect(responder.maybeRespond(input)).resolves.toEqual({
      status: "skipped",
      reason: "runtime_disabled",
    });
    repliesEnabled = true;
    await expect(responder.maybeRespond(input)).resolves.toEqual({
      status: "skipped",
      reason: "duplicate_message",
    });

    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
    expect(replier.replyText).not.toHaveBeenCalled();
  });

  it("skips messages sent by the Iris bot itself", async () => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const replier = { replyText: vi.fn() };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
    });

    await expect(
      responder.maybeRespond({
        messageId: "om_message_1",
        chatId: "oc_group_1",
        senderId: "ou_iris",
        text: "@_user_1 loop",
        mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
      }),
    ).resolves.toEqual({ status: "skipped", reason: "self_message" });

    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
    expect(replier.replyText).not.toHaveBeenCalled();
  });

  it("replies with a clarification when Iris is mentioned without a question", async () => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-1" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
    });

    await expect(
      responder.maybeRespond({
        messageId: "om_message_1",
        chatId: "oc_group_1",
        senderId: "ou_alice",
        text: "@_user_1   ",
        mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
      }),
    ).resolves.toEqual({ status: "replied", replyMessageId: "reply-1" });

    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
    expect(replier.replyText).toHaveBeenCalledWith({
      messageId: "om_message_1",
      text: "我在，直接告诉我你想让我处理什么。",
      replyInThread: true,
      uuid: expect.stringMatching(/^iris-[a-f0-9]{45}$/u),
    });
  });

  it("replies with an unreadable-message clarification when Iris is mentioned without text content", async () => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-unreadable" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
    });

    await expect(
      responder.maybeRespond({
        messageId: "om_unreadable_mention",
        chatId: "oc_group_1",
        senderId: "ou_alice",
        text: undefined,
        mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
      }),
    ).resolves.toEqual({ status: "replied", replyMessageId: "reply-unreadable" });

    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
    expect(replier.replyText).toHaveBeenCalledWith({
      messageId: "om_unreadable_mention",
      text: "我看到了你的 @Iris，但没读到可处理的文字内容。请用文字重新发给我一次。",
      replyInThread: true,
      uuid: expect.stringMatching(/^iris-[a-f0-9]{45}$/u),
    });
  });

  it("replies with a fallback when the model returns a blank answer", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => {
        throw new Error("model answer draft must not be blank");
      }),
    };
    let preparedReceiptCount = 0;
    const answerReplyDeliveryService = {
      respond: vi.fn<AnswerReplyDeliveryService["respond"]>(async (request) => {
        const prepared = await request.prepareAnswer();
        preparedReceiptCount += 1;
        return { replyMessageId: prepared.renderedText };
      }),
    };
    const replier = {
      replyText: vi.fn(async (_input: ReplyTextInput) => ({ replyMessageId: "reply-blank" })),
    };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      answerReplyDeliveryService,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
    });
    const input = {
      messageId: "om_blank_model_answer",
      chatId: "oc_group_1",
      senderId: "ou_alice",
      text: "@_user_1 summarize",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    };

    await expect(responder.maybeRespond(input)).resolves.toEqual({
      status: "replied",
      replyMessageId: "reply-blank",
    });
    await expect(responder.maybeRespond(input)).resolves.toEqual({
      status: "skipped",
      reason: "duplicate_message",
    });

    expect(replier.replyText).toHaveBeenCalledOnce();
    const fallbackReply = replier.replyText.mock.calls[0]?.[0];
    expect(fallbackReply).toEqual({
      messageId: "om_blank_model_answer",
      text: "我没拿到可用答案，你可以换个说法再问我一次。",
      replyInThread: true,
      uuid: "iris-7900347c03b79015c84fd1ec6c58db825f66e3d133bdd",
    });
    expect(fallbackReply?.text.length).toBeLessThanOrEqual(8000);
    expect(answerReplyDeliveryService.respond).toHaveBeenCalledOnce();
    expect(preparedReceiptCount).toBe(0);
  });

  it("replies once with a recoverable message when the model reaches its capacity limit", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => {
        throw new ModelProviderHttpError(
          429,
          "model provider request failed with status 429: private provider quota detail",
        );
      }),
    };
    let preparedReceiptCount = 0;
    const answerReplyDeliveryService = {
      respond: vi.fn<AnswerReplyDeliveryService["respond"]>(async (request) => {
        const prepared = await request.prepareAnswer();
        preparedReceiptCount += 1;
        return { replyMessageId: prepared.renderedText };
      }),
    };
    const replier = {
      replyText: vi.fn(async (_input: ReplyTextInput) => ({ replyMessageId: "reply-capacity" })),
    };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      answerReplyDeliveryService,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
    });
    const input = {
      messageId: "om_model_capacity",
      chatId: "oc_group_1",
      senderId: "ou_alice",
      text: "@_user_1 summarize",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    };

    await expect(responder.maybeRespond(input)).resolves.toEqual({
      status: "replied",
      replyMessageId: "reply-capacity",
    });
    await expect(responder.maybeRespond(input)).resolves.toEqual({
      status: "skipped",
      reason: "duplicate_message",
    });

    expect(replier.replyText).toHaveBeenCalledOnce();
    const fallbackReply = replier.replyText.mock.calls[0]?.[0];
    expect(fallbackReply).toEqual({
      messageId: "om_model_capacity",
      text: "模型服务暂时达到使用上限，我现在无法可靠回答。恢复后，请再 @我一次。",
      replyInThread: true,
      uuid: "iris-05b16c71a9f4fa2fd04f9e214e9c7b8487352b93476c7",
    });
    expect(fallbackReply?.text.length).toBeLessThanOrEqual(8000);
    expect(answerReplyDeliveryService.respond).toHaveBeenCalledOnce();
    expect(preparedReceiptCount).toBe(0);
  });

  it("keeps non-capacity model HTTP failures on the retry path", async () => {
    const providerError = new ModelProviderHttpError(
      503,
      "model provider request failed with status 503: unavailable",
    );
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => {
        throw providerError;
      }),
    };
    const replier = { replyText: vi.fn() };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
    });

    const input = {
      messageId: "om_model_unavailable",
      chatId: "oc_group_1",
      senderId: "ou_alice",
      text: "@_user_1 summarize",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    };

    await expect(responder.maybeRespond(input)).rejects.toBe(providerError);
    await expect(responder.maybeRespond(input)).rejects.toBe(providerError);

    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledTimes(2);
    expect(replier.replyText).not.toHaveBeenCalled();
  });

  it("allows the same mention to retry after sending the capacity fallback fails", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => {
        throw new ModelProviderHttpError(429, "model capacity reached");
      }),
    };
    const replier = {
      replyText: vi
        .fn()
        .mockRejectedValueOnce(new Error("Feishu fallback reply failed"))
        .mockResolvedValueOnce({ replyMessageId: "reply-capacity-retry" }),
    };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
    });
    const input = {
      messageId: "om_model_capacity_reply_retry",
      chatId: "oc_group_1",
      senderId: "ou_alice",
      text: "@_user_1 summarize",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    };

    await expect(responder.maybeRespond(input)).rejects.toThrow(
      "Feishu fallback reply failed",
    );
    await expect(responder.maybeRespond(input)).resolves.toEqual({
      status: "replied",
      replyMessageId: "reply-capacity-retry",
    });

    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledTimes(2);
    expect(replier.replyText).toHaveBeenCalledTimes(2);
    expect(replier.replyText).toHaveBeenLastCalledWith({
      messageId: "om_model_capacity_reply_retry",
      text: "模型服务暂时达到使用上限，我现在无法可靠回答。恢复后，请再 @我一次。",
      replyInThread: true,
      uuid: expect.stringMatching(/^iris-[a-f0-9]{45}$/u),
    });
  });

  it("does not classify generic errors by matching 429 in their text", async () => {
    const genericError = new Error("model provider request failed with status 429");
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => {
        throw genericError;
      }),
    };
    const replier = { replyText: vi.fn() };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
    });

    await expect(
      responder.maybeRespond({
        messageId: "om_generic_429_text",
        chatId: "oc_group_1",
        senderId: "ou_alice",
        text: "@_user_1 summarize",
        mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
      }),
    ).rejects.toBe(genericError);

    expect(replier.replyText).not.toHaveBeenCalled();
  });

  it("skips duplicate mentioned messages after a successful reply", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "Iris answer.",
        promptContext: "<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-1" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
    });
    const input = {
      messageId: "om_duplicate_message",
      chatId: "oc_group_1",
      senderId: "ou_alice",
      text: "@_user_1 summarize",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    };

    await expect(responder.maybeRespond(input)).resolves.toEqual({
      status: "replied",
      replyMessageId: "reply-1",
    });
    await expect(responder.maybeRespond(input)).resolves.toEqual({
      status: "skipped",
      reason: "duplicate_message",
    });

    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledTimes(1);
    expect(replier.replyText).toHaveBeenCalledTimes(1);
  });

  it("skips duplicate mentioned messages while the first reply is in flight", async () => {
    let resolveFirstDraft:
      | ((value: {
          answerText: string;
          promptContext: string;
          allowedFragments: never[];
          deniedDocumentIds: never[];
          retrievedFragmentCount: number;
          usedGroupMemories: never[];
        }) => void)
      | undefined;
    let draftCallCount = 0;
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => {
        draftCallCount += 1;
        if (draftCallCount === 1) {
          return await new Promise<{
            answerText: string;
            promptContext: string;
            allowedFragments: never[];
            deniedDocumentIds: never[];
            retrievedFragmentCount: number;
            usedGroupMemories: never[];
          }>((resolve) => {
            resolveFirstDraft = resolve;
          });
        }

        return {
          answerText: "Duplicate answer.",
          promptContext: "<live_chat_context></live_chat_context>",
          allowedFragments: [],
          deniedDocumentIds: [],
          retrievedFragmentCount: 0,
          usedGroupMemories: [],
        };
      }),
    };
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-1" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
    });
    const input = {
      messageId: "om_in_flight_duplicate",
      chatId: "oc_group_1",
      senderId: "ou_alice",
      text: "@_user_1 summarize",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    };

    const firstReply = responder.maybeRespond(input);
    await expect(responder.maybeRespond(input)).resolves.toEqual({
      status: "skipped",
      reason: "duplicate_message",
    });

    resolveFirstDraft?.({
      answerText: "Iris answer.",
      promptContext: "<live_chat_context></live_chat_context>",
      allowedFragments: [],
      deniedDocumentIds: [],
      retrievedFragmentCount: 0,
      usedGroupMemories: [],
    });
    await expect(firstReply).resolves.toEqual({
      status: "replied",
      replyMessageId: "reply-1",
    });
    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledTimes(1);
    expect(replier.replyText).toHaveBeenCalledTimes(1);
  });

  it("allows a retried mentioned message after the first reply attempt fails", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "Iris answer.",
        promptContext: "<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const replier = {
      replyText: vi
        .fn()
        .mockRejectedValueOnce(new Error("Feishu reply failed"))
        .mockResolvedValueOnce({ replyMessageId: "reply-2" }),
    };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: vi.fn(() => true),
    });
    const input = {
      messageId: "om_retry_after_failure",
      chatId: "oc_group_1",
      senderId: "ou_alice",
      text: "@_user_1 summarize",
      mentions: [{ key: "@_user_1", openId: "ou_iris", name: "Iris" }],
    };

    await expect(responder.maybeRespond(input)).rejects.toThrow("Feishu reply failed");
    await expect(responder.maybeRespond(input)).resolves.toEqual({
      status: "replied",
      replyMessageId: "reply-2",
    });

    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledTimes(2);
    expect(replier.replyText).toHaveBeenCalledTimes(2);
  });
});

function createFeishuMentionAnswerResponder(
  input: Omit<FeishuMentionAnswerResponderDependencies, "answerReplyDeliveryService"> & {
    answerReplyDeliveryService?: Pick<AnswerReplyDeliveryService, "respond">;
  },
) {
  const answerReplyDeliveryService = input.answerReplyDeliveryService ?? {
    async respond(request: AnswerReplyDeliveryRequest) {
      const prepared = await request.prepareAnswer();
      return input.replier.replyText({
        messageId: request.incomingMessageId,
        text: prepared.renderedText,
        replyInThread: true,
        uuid: request.replyUuid,
      });
    },
  };
  return createProductionFeishuMentionAnswerResponder({
    ...input,
    answerReplyDeliveryService,
  });
}

function answerFragment(
  overrides: Partial<RetrievedDocumentFragment> = {},
): RetrievedDocumentFragment {
  return {
    id: "fragment-a-2",
    documentSourceId: "source-wiki-a",
    documentSnapshotId: "snapshot-a",
    sourceUri: "https://tenant.feishu.cn/wiki/wikiA?from=chat#section",
    chunkIndex: 2,
    text: "Life Engine context",
    contentHash: "hash-fragment-a-2",
    embedding: [1, 0, 0],
    embeddingProfileId: "profile-1",
    createdAt: new Date("2026-08-02T03:00:00.000Z"),
    sourceTitle: "Quello Life Engine",
    sourceType: "feishu_wiki",
    ...overrides,
  };
}
