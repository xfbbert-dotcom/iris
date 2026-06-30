import { describe, expect, it } from "vitest";
import { assemblePromptContext } from "../src/memory/context-assembly.js";

describe("assemblePromptContext", () => {
  it("places background documents before live chat context", () => {
    const context = assemblePromptContext({
      backgroundDocuments: [
        { source: "doc-a", text: "Document evidence" }
      ],
      liveChatMessages: [
        { speaker: "Alice", text: "What changed today?" },
        { speaker: "Iris", text: "I will check the latest context." }
      ]
    });

    expect(context).toContain("<background_documents>");
    expect(context).toContain("<live_chat_context>");
    expect(context.indexOf("<background_documents>")).toBeLessThan(context.indexOf("<live_chat_context>"));
    expect(context.trim().endsWith("</live_chat_context>")).toBe(true);
  });

  it("limits live chat to the latest 20 messages", () => {
    const liveChatMessages = Array.from({ length: 25 }, (_, index) => ({
      speaker: "User",
      text: `message-${index + 1}`
    }));

    const context = assemblePromptContext({
      backgroundDocuments: [],
      liveChatMessages
    });

    expect(context).not.toContain('<message speaker="User">message-1</message>');
    expect(context).toContain("message-6");
    expect(context).toContain("message-25");
  });
});
