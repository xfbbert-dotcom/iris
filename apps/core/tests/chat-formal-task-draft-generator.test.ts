import { describe, expect, it, vi } from "vitest";

import type { ModelProvider } from "../src/agent/answer-draft-orchestrator.js";
import type { ConversationMessage } from
  "../src/conversation/conversation-message-repository.js";
import {
  ChatFormalTaskDraftModelUnavailableError,
  createChatFormalTaskDraftGenerator,
} from "../src/formal-tasks/chat-formal-task-draft-generator.js";

const observedAt = new Date("2026-08-22T06:00:00.000Z");

describe("ChatFormalTaskDraftGenerator", () => {
  it("generates one bounded task from chronological same-group context including the trigger", async () => {
    const repository = {
      listRecentByChat: vi.fn(async () => [
        message("feishu:om_trigger", "om_trigger", "请给 @同事 建任务", "2026-08-22T05:59:00.000Z"),
        message("feishu:om_context", "om_context", "交付验收报告", "2026-08-22T05:58:00.000Z"),
      ]),
    };
    const model = {
      generateAnswerDraft: vi.fn<ModelProvider["generateAnswerDraft"]>(async () => ({
        answerText: [
          "TITLE: 提交验收报告",
          "DESCRIPTION:",
          "汇总试点证据并提交验收报告。",
          "DUE_AT_UTC: 2026-08-24T09:30:00.000Z",
          "REMINDER_MINUTES: 30",
        ].join("\n"),
      })),
    };
    const generator = createChatFormalTaskDraftGenerator({
      repository,
      model,
      canReadGroupContext: () => true,
    });

    await expect(generator.generate({
      messageId: "om_trigger",
      chatId: "oc_pilot",
      requesterOpenId: "ou_requester",
      requestText: "请给 @同事 创建一个飞书任务草稿",
      observedAt,
    })).resolves.toEqual({
      status: "generated",
      title: "提交验收报告",
      description: "汇总试点证据并提交验收报告。",
      dueAt: new Date("2026-08-24T09:30:00.000Z"),
      reminderMinutes: 30,
      evidence: [
        { type: "conversation_message", id: "feishu:om_context" },
        { type: "conversation_message", id: "feishu:om_trigger" },
      ],
    });
    expect(repository.listRecentByChat).toHaveBeenCalledWith({ chatId: "oc_pilot", limit: 60 });
    expect(model.generateAnswerDraft).toHaveBeenCalledWith({
      question: expect.stringContaining("Create exactly one reviewable Feishu task draft"),
      promptContext: expect.stringMatching(
        /<live_chat_context>[\s\S]*交付验收报告[\s\S]*请给 @同事 建任务[\s\S]*<\/live_chat_context>/u,
      ),
    });
  });

  it("requires the triggering message to be present in current same-group context", async () => {
    const model = { generateAnswerDraft: vi.fn() };
    const generator = createChatFormalTaskDraftGenerator({
      repository: {
        listRecentByChat: vi.fn(async () => [
          message("feishu:om_other", "om_other", "other context", "2026-08-22T05:59:00.000Z"),
        ]),
      },
      model,
      canReadGroupContext: () => true,
    });

    await expect(generator.generate({
      messageId: "om_missing",
      chatId: "oc_pilot",
      requesterOpenId: "ou_requester",
      requestText: "create a task draft",
      observedAt,
    })).resolves.toEqual({ status: "no_context" });
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("excludes cross-group rows and limits live context and evidence to the newest 20 messages", async () => {
    const sameGroupContext = Array.from({ length: 25 }, (_, index) => message(
      `feishu:om_context_${index}`,
      `om_context_${index}`,
      `context-${index}`,
      new Date(observedAt.getTime() - (index + 2) * 1_000).toISOString(),
    ));
    const crossGroupMessage = {
      ...message(
        "feishu:om_private",
        "om_private",
        "CROSS_GROUP_PRIVATE_MARKER",
        new Date(observedAt.getTime() - 500).toISOString(),
      ),
      chatId: "oc_control",
    };
    const model = {
      generateAnswerDraft: vi.fn<ModelProvider["generateAnswerDraft"]>(async () => ({
        answerText: [
          "TITLE: Review evidence",
          "DESCRIPTION:",
          "Review the pilot evidence.",
          "DUE_AT_UTC: NONE",
          "REMINDER_MINUTES: NONE",
        ].join("\n"),
      })),
    };
    const generator = createChatFormalTaskDraftGenerator({
      repository: {
        listRecentByChat: vi.fn(async () => [
          crossGroupMessage,
          triggerMessage(),
          ...sameGroupContext,
        ]),
      },
      model,
      canReadGroupContext: () => true,
    });

    const result = await generator.generate(generatorInput());

    expect(result).toMatchObject({ status: "generated" });
    if (result.status !== "generated") throw new Error("expected generated result");
    expect(result.evidence).toHaveLength(20);
    expect(result.evidence).toContainEqual({
      type: "conversation_message",
      id: "feishu:om_trigger",
    });
    expect(result.evidence).not.toContainEqual({
      type: "conversation_message",
      id: "feishu:om_private",
    });
    const request = model.generateAnswerDraft.mock.calls[0]?.[0];
    expect(request?.promptContext).not.toContain("CROSS_GROUP_PRIVATE_MARKER");
    expect(request?.promptContext).toContain("context-18");
    expect(request?.promptContext).not.toContain("context-19");
  });

  it("bounds the explicit request text sent to the model at 2000 characters", async () => {
    const model = {
      generateAnswerDraft: vi.fn<ModelProvider["generateAnswerDraft"]>(async () => ({
        answerText: [
          "TITLE: Review evidence",
          "DESCRIPTION:",
          "Review the pilot evidence.",
          "DUE_AT_UTC: NONE",
          "REMINDER_MINUTES: NONE",
        ].join("\n"),
      })),
    };
    const generator = createChatFormalTaskDraftGenerator({
      repository: { listRecentByChat: vi.fn(async () => [triggerMessage()]) },
      model,
      canReadGroupContext: () => true,
    });

    await generator.generate({
      ...generatorInput(),
      requestText: `${"R".repeat(2_000)}PRIVATE_SUFFIX`,
    });

    const question = model.generateAnswerDraft.mock.calls[0]?.[0]?.question;
    expect(question).toMatch(new RegExp(`Request: R{${2_000}}$`, "u"));
    expect(question).not.toContain("PRIVATE_SUFFIX");
  });

  it("omits due and reminder only when the model returns the exact NONE pair", async () => {
    const generator = generatorForResponse([
      "TITLE: Review evidence",
      "DESCRIPTION:",
      "Review the pilot evidence.",
      "DUE_AT_UTC: NONE",
      "REMINDER_MINUTES: NONE",
    ].join("\n"));

    const result = await generator.generate(generatorInput());

    expect(result).toMatchObject({ status: "generated", title: "Review evidence" });
    expect(result).not.toHaveProperty("dueAt");
    expect(result).not.toHaveProperty("reminderMinutes");
  });

  it.each([
    "",
    "TITLE: Missing fields",
    ["TITLE: X", "DESCRIPTION:", "Y", "DUE_AT_UTC: invalid", "REMINDER_MINUTES: NONE"].join("\n"),
    ["TITLE: X", "DESCRIPTION:", "Y", "DUE_AT_UTC: NONE", "REMINDER_MINUTES: 30"].join("\n"),
    ["TITLE: X", "DESCRIPTION:", "Y", "DUE_AT_UTC: 2026-08-24T09:30:00.000Z", "REMINDER_MINUTES: 15"].join("\n"),
  ])("fails closed for malformed model output %#", async (answerText) => {
    await expect(generatorForResponse(answerText).generate(generatorInput()))
      .rejects.toThrow("formal task draft model response is invalid");
  });

  it("wraps model transport failures without exposing private details", async () => {
    const providerCause = new Error("private model transport");
    const generator = createChatFormalTaskDraftGenerator({
      repository: { listRecentByChat: vi.fn(async () => [triggerMessage()]) },
      model: { generateAnswerDraft: vi.fn(async () => { throw providerCause; }) },
      canReadGroupContext: () => true,
    });

    const error = await generator.generate(generatorInput()).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(ChatFormalTaskDraftModelUnavailableError);
    expect((error as ChatFormalTaskDraftModelUnavailableError).providerCause).toBe(providerCause);
    expect((error as Error).message).not.toContain("private model transport");
  });
});

function generatorForResponse(answerText: string) {
  return createChatFormalTaskDraftGenerator({
    repository: { listRecentByChat: vi.fn(async () => [triggerMessage()]) },
    model: { generateAnswerDraft: vi.fn(async () => ({ answerText })) },
    canReadGroupContext: () => true,
  });
}

function generatorInput() {
  return {
    messageId: "om_trigger",
    chatId: "oc_pilot",
    requesterOpenId: "ou_requester",
    requestText: "create a task draft",
    observedAt,
  };
}

function triggerMessage(): ConversationMessage {
  return message(
    "feishu:om_trigger",
    "om_trigger",
    "create a task draft",
    "2026-08-22T05:59:00.000Z",
  );
}

function message(
  id: string,
  providerMessageId: string,
  text: string,
  sentAt: string,
): ConversationMessage {
  return {
    id,
    provider: "feishu",
    providerMessageId,
    chatId: "oc_pilot",
    senderId: "ou_member",
    senderOpenId: "ou_member",
    messageType: "text",
    text,
    sentAt: new Date(sentAt),
    rawEventIdempotencyKey: `event:${providerMessageId}`,
    createdAt: new Date(sentAt),
  };
}
