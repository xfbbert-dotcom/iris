import { describe, expect, it, vi } from "vitest";

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
