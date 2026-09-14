import { describe, expect, it, vi } from "vitest";

import type { ConversationMessage } from "../src/conversation/conversation-message-repository.js";
import { parsePdFeedback } from "../src/proactive-discussion/feedback.js";
import { createPdRegistrar } from "../src/proactive-discussion/registrar.js";
import { PD_PILOT_CHAT } from "../src/proactive-discussion/contracts.js";
import { hashLocalMessageText } from "../src/memory/local-message-source.js";

describe("proactive discussion ingress", () => {
  it("only binds exact self-authored stop and resume bodies", () => {
    expect(parsePdFeedback("不再跟进这件事")).toBe("pause");
    expect(parsePdFeedback("恢复跟进这件事")).toBe("resume");
    expect(parsePdFeedback("不再跟进这件事。！！")).toBe("pause");
    expect(parsePdFeedback("他说：不再跟进这件事")).toBeNull();
    expect(parsePdFeedback("你先别说了吧，也许呢")).toBeNull();
  });

  it("registers an exact human non-mention against the current enabled policy", async () => {
    const register = vi.fn(async () => "registered" as const);
    const registrar = createPdRegistrar({
      repository: { register, readState: async () => state() },
      botOpenId: "ou_iris",
      now: () => new Date("2026-09-14T12:00:00.000Z"),
    });
    const conversationMessage = message({ text: "预算似乎对不上" });

    await registrar.registerMessage({
      conversationMessage,
      senderType: "user",
      mentionedIris: false,
    });

    expect(register).toHaveBeenCalledWith({
      chatId: PD_PILOT_CHAT,
      messageId: "om-trigger",
      contentHash: hashLocalMessageText("预算似乎对不上"),
      policyVersion: 3,
      purpose: "assessment",
      at: new Date("2026-09-14T12:00:00.000Z"),
    });
  });

  it("uses the parent only for exact feedback and removes only the platform Iris mention prefix", async () => {
    const register = vi.fn(async () => "registered" as const);
    const registrar = createPdRegistrar({
      repository: { register, readState: async () => state() },
      botOpenId: "ou_iris",
      now: () => new Date("2026-09-14T12:00:00.000Z"),
    });
    const conversationMessage = message({
      senderOpenId: "ou_member",
      text: "@_user_1 恢复跟进这件事！",
      mentions: [
        { key: "@_user_1", openId: "ou_iris" },
        { key: "@someone", openId: "ou_someone" },
      ],
    });

    await registrar.registerMessage({
      conversationMessage,
      senderType: "user",
      parentMessageId: "om-parent-not-root",
      rootMessageId: "om-root",
      mentionedIris: true,
    });

    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "feedback",
      feedback: {
        action: "resume",
        replyMessageId: "om-parent-not-root",
        actorOpenId: "ou_member",
        irisMentionKey: "@_user_1",
      },
    }));
  });

  it("falls back to the root only when parent is absent", async () => {
    const register = vi.fn(async () => "registered" as const);
    const registrar = createPdRegistrar({
      repository: { register, readState: async () => state() },
      botOpenId: "ou_iris",
      now: () => new Date("2026-09-14T12:00:00.000Z"),
    });

    await registrar.registerMessage({
      conversationMessage: message({ text: "不再跟进这件事", senderOpenId: "ou_member" }),
      senderType: "user",
      rootMessageId: "om-root",
      mentionedIris: false,
    });

    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "feedback",
      feedback: expect.objectContaining({ replyMessageId: "om-root" }),
    }));
  });

  it("does not turn an unbound feedback phrase into a new assessment", async () => {
    const register = vi.fn(async () => "registered" as const);
    const registrar = createPdRegistrar({
      repository: { register, readState: async () => state() },
      botOpenId: "ou_iris",
      now: () => new Date("2026-09-14T12:00:00.000Z"),
    });

    await registrar.registerMessage({
      conversationMessage: message({ text: "不再跟进这件事" }),
      senderType: "user",
      mentionedIris: false,
    });

    expect(register).not.toHaveBeenCalled();
  });

  it.each([
    ["app sender", { senderType: "app" as const, conversationMessage: undefined, mentionedIris: undefined }],
    ["unknown sender", { senderType: "unknown" as const, conversationMessage: undefined, mentionedIris: undefined }],
    ["Iris identity", { senderType: "user" as const, conversationMessage: message({ senderOpenId: "ou_iris" }), mentionedIris: undefined }],
    ["blank body", { senderType: "user" as const, conversationMessage: message({ text: "  " }), mentionedIris: undefined }],
    ["ordinary Iris mention", { senderType: "user" as const, conversationMessage: undefined, mentionedIris: true }],
  ])("does not create assessment work for %s", async (_label, overrides) => {
    const register = vi.fn(async () => "registered" as const);
    const registrar = createPdRegistrar({
      repository: { register, readState: async () => state() },
      botOpenId: "ou_iris",
      now: () => new Date("2026-09-14T12:00:00.000Z"),
    });

    await registrar.registerMessage({
      conversationMessage: overrides.conversationMessage ?? message(),
      mentionedIris: overrides.mentionedIris ?? false,
      senderType: overrides.senderType ?? "user",
    });

    expect(register).not.toHaveBeenCalled();
  });

  it("does not register against a missing, disabled, stale, or foreign policy", async () => {
    const register = vi.fn(async () => "registered" as const);
    const states = [
      { ...state(), policy: null },
      { ...state(), policy: { ...state().policy!, enabled: false } },
      { ...state(), policy: { ...state().policy!, chatId: "oc_other" } },
    ];
    for (const repositoryState of states) {
      const registrar = createPdRegistrar({
        repository: { register, readState: async () => repositoryState },
        botOpenId: "ou_iris",
        now: () => new Date("2026-09-14T12:00:00.000Z"),
      });
      await registrar.registerMessage({ conversationMessage: message(), senderType: "user", mentionedIris: false });
    }
    expect(register).not.toHaveBeenCalled();
  });
});

function state() {
  return {
    policy: { chatId: PD_PILOT_CHAT, version: 3, enabled: true, operatorId: "operator" },
    contextVersion: 1,
    catalogVersion: 1,
    issues: [],
  };
}

function message(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: "feishu:om-trigger",
    provider: "feishu",
    providerMessageId: "om-trigger",
    chatId: PD_PILOT_CHAT,
    senderId: "ou_member",
    senderOpenId: "ou_member",
    messageType: "text",
    text: "预算似乎对不上",
    mentions: [],
    sentAt: new Date("2026-09-14T11:59:00.000Z"),
    rawEventIdempotencyKey: "raw-event:trigger",
    createdAt: new Date("2026-09-14T11:59:01.000Z"),
    ...overrides,
  };
}
