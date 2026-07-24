import { describe, expect, it, vi } from "vitest";

import type { AnswerDraftInput } from "../src/agent/answer-draft-orchestrator.js";
import { createFeishuMentionAnswerResponder } from "../src/conversation/feishu-mention-answer-responder.js";
import { createFeishuDocumentLinkExtractor } from "../src/documents/feishu-document-link-extractor.js";
import type { FeishuMessageReplier } from "../src/feishu/feishu-message-replier.js";
import { ModelProviderHttpError } from "../src/model/model-provider-error.js";

type ReplyTextInput = Parameters<FeishuMessageReplier["replyText"]>[0];

describe("FeishuMentionAnswerResponder", () => {
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
      question: "帮我总结一下",
      chatId: "oc_group_1",
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
      question: "summarize this",
      chatId: "oc_group_1",
      liveChatMessages: [{ speaker: "ou_alice", text: "summarize this" }],
    });
  });

  it("registers a user-submitted Feishu document from an explicit mention command without drafting an answer", async () => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const registerUserSubmittedDocument = vi.fn(async () => ({
      source: { id: "doc-source-1" },
      enqueue: { status: "enqueued" as const, jobId: "sync-job-1" },
    }));
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-doc" })) };
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
      observedAt: new Date("2026-07-24T02:30:00.000Z"),
    });
    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
    expect(replier.replyText).toHaveBeenCalledWith({
      messageId: "om_user_doc_submission",
      text: "\u5df2\u6536\u5230\u8fd9\u4e2a\u6587\u6863\uff0c\u6211\u4f1a\u540c\u6b65\u5b83\u7684\u5185\u5bb9\u3002\u540c\u6b65\u5b8c\u6210\u540e\uff0c\u4f60\u53ef\u4ee5\u76f4\u63a5 @\u6211\u63d0\u95ee\u3002",
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
      question: "what does this document say? https://docs.feishu.cn/docx/user_doc_token_1",
      chatId: "oc_group_1",
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
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-blank" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
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
    expect(replier.replyText).toHaveBeenCalledWith({
      messageId: "om_blank_model_answer",
      text: "我没拿到可用答案，你可以换个说法再问我一次。",
      replyInThread: true,
      uuid: expect.stringMatching(/^iris-[a-f0-9]{45}$/u),
    });
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
    const replier = { replyText: vi.fn(async () => ({ replyMessageId: "reply-capacity" })) };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
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
    expect(replier.replyText).toHaveBeenCalledWith({
      messageId: "om_model_capacity",
      text: "模型服务暂时达到使用上限，我现在无法可靠回答。恢复后，请再 @我一次。",
      replyInThread: true,
      uuid: expect.stringMatching(/^iris-[a-f0-9]{45}$/u),
    });
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
