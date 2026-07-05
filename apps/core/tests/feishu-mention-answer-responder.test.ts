import { describe, expect, it, vi } from "vitest";

import type { AnswerDraftInput } from "../src/agent/answer-draft-orchestrator.js";
import { createFeishuMentionAnswerResponder } from "../src/conversation/feishu-mention-answer-responder.js";
import type { FeishuMessageReplier } from "../src/feishu/feishu-message-replier.js";

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
});
