import { describe, expect, it } from "vitest";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import { RuntimeController } from "../src/admin/runtime-controller.js";

describe("RuntimeController", () => {
  it("disables all processing when Iris is globally disabled", () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    controller.disableGlobal();

    expect(controller.canProcessGroupMessage("chat-a")).toBe(false);
    expect(controller.canReadGroupContext("chat-a")).toBe(false);
    expect(controller.canReadDocuments()).toBe(false);
    expect(controller.canRetrieveKnowledgeBase()).toBe(false);
    expect(controller.canGenerateKnowledgeDrafts()).toBe(false);
    expect(controller.canWriteKnowledgeBase()).toBe(false);
    expect(controller.canCallExternalTools()).toBe(false);
  });

  it("supports per-group enablement", () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    controller.disableGroup("chat-a");

    expect(controller.canProcessGroupMessage("chat-a")).toBe(false);
    expect(controller.canProcessGroupMessage("chat-b")).toBe(true);
  });

  it("normalizes group ids when toggling and checking group access", () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    controller.disableGroup(" chat-a ");

    expect(controller.canProcessGroupMessage("chat-a")).toBe(false);
    expect(controller.canProcessGroupMessage(" chat-a ")).toBe(false);

    controller.enableGroup(" chat-a ");

    expect(controller.canProcessGroupMessage("chat-a")).toBe(true);
  });

  it("rejects blank group ids", () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    controller.disableGroup("   ");

    expect(controller.canProcessGroupMessage("   ")).toBe(false);
    expect(controller.canReplyWhenMentioned("")).toBe(false);
  });

  it("emergency pause disables proactive behavior but keeps mention replies enabled", () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    controller.pauseProactiveBehavior();

    expect(controller.canProactivelySpeak("chat-a")).toBe(false);
    expect(controller.canReplyWhenMentioned("chat-a")).toBe(true);
  });

  it("pauseDocumentReading disables document reads", () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    controller.pauseDocumentReading();

    expect(controller.canReadDocuments()).toBe(false);
  });

  it("pauseKnowledgeBaseWriting disables knowledge base writes", () => {
    const config = createDefaultRuntimeConfig();
    config.capabilities.writeKnowledgeBase = true;
    const controller = new RuntimeController(config);

    controller.pauseKnowledgeBaseWriting();

    expect(controller.canWriteKnowledgeBase()).toBe(false);
  });

  it("pauseExternalToolCalls disables external tool calls", () => {
    const config = createDefaultRuntimeConfig();
    config.capabilities.callExternalTools = true;
    const controller = new RuntimeController(config);

    controller.pauseExternalToolCalls();

    expect(controller.canCallExternalTools()).toBe(false);
  });

  it("per-group disable gates group context reads for that group", () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    controller.disableGroup("chat-a");

    expect(controller.canReadGroupContext("chat-a")).toBe(false);
    expect(controller.canReadGroupContext("chat-b")).toBe(true);
  });

  it("returns cloned runtime control snapshots", () => {
    const config = createDefaultRuntimeConfig();
    const controller = new RuntimeController(config);
    controller.disableGroup("chat-b");
    controller.disableGroup("chat-a");

    const snapshot = controller.getSnapshot();
    expect(snapshot).toMatchObject({
      globalEnabled: true,
      disabledGroupIds: ["chat-a", "chat-b"],
    });

    snapshot.disabledGroupIds.push("chat-mutated");
    snapshot.capabilities.readGroupContext = false;

    expect(controller.getSnapshot()).toMatchObject({
      globalEnabled: true,
      disabledGroupIds: ["chat-a", "chat-b"],
      capabilities: {
        readGroupContext: true,
      },
    });
  });

  it("gates incoming events by global and per-group runtime state", () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    expect(controller.canProcessIncomingEvent({ groupId: "chat-a" })).toBe(true);
    expect(controller.canProcessIncomingEvent({})).toBe(true);

    controller.disableGroup(" chat-a ");

    expect(controller.canProcessIncomingEvent({ groupId: "chat-a" })).toBe(false);
    expect(controller.canProcessIncomingEvent({ groupId: "chat-b" })).toBe(true);
    expect(controller.canProcessIncomingEvent({})).toBe(true);

    controller.disableGlobal();

    expect(controller.canProcessIncomingEvent({ groupId: "chat-b" })).toBe(false);
    expect(controller.canProcessIncomingEvent({})).toBe(false);
  });

  it("updates individual runtime capabilities", () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    controller.setCapability("proactiveSpeech", false);

    expect(controller.canProactivelySpeak("chat-a")).toBe(false);
    expect(controller.getSnapshot().capabilities.proactiveSpeech).toBe(false);

    controller.setCapability("proactiveSpeech", true);

    expect(controller.canProactivelySpeak("chat-a")).toBe(true);
    expect(controller.getSnapshot().capabilities.proactiveSpeech).toBe(true);
  });

  it("gates answer draft generation by reply capability", () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    expect(controller.canGenerateAnswerDraft({ groupId: "chat-a" })).toBe(true);

    controller.setCapability("replyWhenMentioned", false);

    expect(controller.canGenerateAnswerDraft({ groupId: "chat-a" })).toBe(false);
    expect(controller.canGenerateAnswerDraft({})).toBe(false);

    controller.setCapability("replyWhenMentioned", true);
    controller.disableGroup("chat-a");

    expect(controller.canGenerateAnswerDraft({ groupId: "chat-a" })).toBe(false);
    expect(controller.canGenerateAnswerDraft({ groupId: "chat-b" })).toBe(true);
  });
});
