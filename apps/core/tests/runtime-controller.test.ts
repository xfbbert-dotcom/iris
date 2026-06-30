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
});
