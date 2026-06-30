import { describe, expect, it } from "vitest";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import { RuntimeController } from "../src/admin/runtime-controller.js";

describe("RuntimeController", () => {
  it("disables all processing when Iris is globally disabled", () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    controller.disableGlobal();

    expect(controller.canProcessGroupMessage("chat-a")).toBe(false);
    expect(controller.canReadDocuments()).toBe(false);
    expect(controller.canWriteKnowledgeBase()).toBe(false);
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
});
