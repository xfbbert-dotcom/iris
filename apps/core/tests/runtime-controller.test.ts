import { describe, expect, it } from "vitest";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import {
  RuntimeController,
  type RuntimeControlStore,
} from "../src/admin/runtime-controller.js";

describe("RuntimeController", () => {
  it("disables all processing when Iris is globally disabled", async () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    await controller.disableGlobal();

    expect(controller.canProcessGroupMessage("chat-a")).toBe(false);
    expect(controller.canReadGroupContext("chat-a")).toBe(false);
    expect(controller.canReadDocuments()).toBe(false);
    expect(controller.canRetrieveKnowledgeBase()).toBe(false);
    expect(controller.canGenerateKnowledgeDrafts()).toBe(false);
    expect(controller.canWriteKnowledgeBase()).toBe(false);
    expect(controller.canCallExternalTools()).toBe(false);
  });

  it("supports per-group enablement", async () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    await controller.disableGroup("chat-a");

    expect(controller.canProcessGroupMessage("chat-a")).toBe(false);
    expect(controller.canProcessGroupMessage("chat-b")).toBe(true);
  });

  it("normalizes group ids when toggling and checking group access", async () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    await controller.disableGroup(" chat-a ");

    expect(controller.canProcessGroupMessage("chat-a")).toBe(false);
    expect(controller.canProcessGroupMessage(" chat-a ")).toBe(false);

    await controller.enableGroup(" chat-a ");

    expect(controller.canProcessGroupMessage("chat-a")).toBe(true);
  });

  it("rejects blank group ids", async () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    await controller.disableGroup("   ");

    expect(controller.canProcessGroupMessage("   ")).toBe(false);
    expect(controller.canReplyWhenMentioned("")).toBe(false);
  });

  it("emergency pause disables proactive behavior but keeps mention replies enabled", async () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    await controller.pauseProactiveBehavior();

    expect(controller.canProactivelySpeak("chat-a")).toBe(false);
    expect(controller.canReplyWhenMentioned("chat-a")).toBe(true);
  });

  it("pauseDocumentReading disables document reads", async () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    await controller.pauseDocumentReading();

    expect(controller.canReadDocuments()).toBe(false);
  });

  it("pauseKnowledgeBaseWriting disables knowledge base writes", async () => {
    const config = createDefaultRuntimeConfig();
    config.capabilities.writeKnowledgeBase = true;
    const controller = new RuntimeController(config);

    await controller.pauseKnowledgeBaseWriting();

    expect(controller.canWriteKnowledgeBase()).toBe(false);
  });

  it("pauseExternalToolCalls disables external tool calls", async () => {
    const config = createDefaultRuntimeConfig();
    config.capabilities.callExternalTools = true;
    const controller = new RuntimeController(config);

    await controller.pauseExternalToolCalls();

    expect(controller.canCallExternalTools()).toBe(false);
  });

  it("per-group disable gates group context reads for that group", async () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    await controller.disableGroup("chat-a");

    expect(controller.canReadGroupContext("chat-a")).toBe(false);
    expect(controller.canReadGroupContext("chat-b")).toBe(true);
  });

  it("returns cloned runtime control snapshots", async () => {
    const config = createDefaultRuntimeConfig();
    const controller = new RuntimeController(config);
    await controller.disableGroup("chat-b");
    await controller.disableGroup("chat-a");

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

  it("gates incoming events by global and per-group runtime state", async () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    expect(controller.canProcessIncomingEvent({ groupId: "chat-a" })).toBe(true);
    expect(controller.canProcessIncomingEvent({})).toBe(true);
    expect(controller.canProcessIncomingEvent({ groupId: "   " })).toBe(false);

    await controller.disableGroup(" chat-a ");

    expect(controller.canProcessIncomingEvent({ groupId: "chat-a" })).toBe(false);
    expect(controller.canProcessIncomingEvent({ groupId: "chat-b" })).toBe(true);
    expect(controller.canProcessIncomingEvent({})).toBe(true);

    await controller.disableGlobal();

    expect(controller.canProcessIncomingEvent({ groupId: "chat-b" })).toBe(false);
    expect(controller.canProcessIncomingEvent({})).toBe(false);
  });

  it("updates individual runtime capabilities", async () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    await controller.setCapability("proactiveSpeech", false);

    expect(controller.canProactivelySpeak("chat-a")).toBe(false);
    expect(controller.getSnapshot().capabilities.proactiveSpeech).toBe(false);

    await controller.setCapability("proactiveSpeech", true);

    expect(controller.canProactivelySpeak("chat-a")).toBe(true);
    expect(controller.getSnapshot().capabilities.proactiveSpeech).toBe(true);
  });

  it("gates answer draft generation by reply capability", async () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig());

    expect(controller.canGenerateAnswerDraft({ groupId: "chat-a" })).toBe(true);

    await controller.setCapability("replyWhenMentioned", false);

    expect(controller.canGenerateAnswerDraft({ groupId: "chat-a" })).toBe(false);
    expect(controller.canGenerateAnswerDraft({})).toBe(false);

    await controller.setCapability("replyWhenMentioned", true);
    await controller.disableGroup("chat-a");

    expect(controller.canGenerateAnswerDraft({ groupId: "chat-a" })).toBe(false);
    expect(controller.canGenerateAnswerDraft({ groupId: "chat-b" })).toBe(true);
  });

  it("hydrates persisted controls before serving synchronous gate checks", async () => {
    const store = fakeRuntimeControlStore({
      load: async (defaults) => ({
        ...defaults,
        globalEnabled: false,
        disabledGroupIds: ["chat-b", "chat-a"],
        capabilities: {
          ...defaults.capabilities,
          callExternalTools: true,
        },
      }),
    });
    const controller = new RuntimeController(createDefaultRuntimeConfig(), store);

    await controller.hydrate();

    expect(controller.getSnapshot()).toMatchObject({
      globalEnabled: false,
      disabledGroupIds: ["chat-a", "chat-b"],
      capabilities: {
        callExternalTools: true,
      },
    });
    expect(controller.canProcessIncomingEvent({ groupId: "chat-c" })).toBe(false);
  });

  it("serializes persisted mutations in invocation order", async () => {
    const persisted: boolean[] = [];
    let releaseFirst: () => void = () => undefined;
    let markFirstStarted: () => void = () => undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const store = fakeRuntimeControlStore({
      setGlobalEnabled: async (enabled) => {
        persisted.push(enabled);
        if (!enabled) {
          markFirstStarted();
          await firstWrite;
        }
      },
    });
    const controller = new RuntimeController(createDefaultRuntimeConfig(), store);

    const disable = controller.disableGlobal();
    const enable = controller.enableGlobal();
    await firstStarted;

    expect(persisted).toEqual([false]);
    releaseFirst();
    await Promise.all([disable, enable]);

    expect(persisted).toEqual([false, true]);
    expect(controller.getSnapshot().globalEnabled).toBe(true);
  });

  it("keeps the last durable state when persistence fails and accepts later retries", async () => {
    let shouldFail = true;
    const store = fakeRuntimeControlStore({
      setGlobalEnabled: async () => {
        if (shouldFail) {
          throw new Error("database unavailable");
        }
      },
    });
    const controller = new RuntimeController(createDefaultRuntimeConfig(), store);

    await expect(controller.disableGlobal()).rejects.toThrow("database unavailable");
    expect(controller.getSnapshot().globalEnabled).toBe(true);

    shouldFail = false;
    await controller.disableGlobal();
    expect(controller.getSnapshot().globalEnabled).toBe(false);
  });
});

function fakeRuntimeControlStore(
  overrides: Partial<RuntimeControlStore> = {},
): RuntimeControlStore {
  return {
    load: async (defaults) => defaults,
    setGlobalEnabled: async () => undefined,
    setGroupEnabled: async () => undefined,
    setCapabilities: async () => undefined,
    ...overrides,
  };
}
