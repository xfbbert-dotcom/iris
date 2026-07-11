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

  it("caps explicit liveChatLimit values to the latest 20 messages", () => {
    const liveChatMessages = Array.from({ length: 25 }, (_, index) => ({
      speaker: "User",
      text: `message-${index + 1}`
    }));

    const context = assemblePromptContext({
      backgroundDocuments: [],
      liveChatMessages,
      liveChatLimit: 999
    });

    expect(context).not.toContain('<message speaker="User">message-1</message>');
    expect(context).toContain('<message speaker="User">message-6</message>');
    expect(context).toContain('<message speaker="User">message-25</message>');
  });

  it("keeps live chat tags but excludes messages when liveChatLimit is 0", () => {
    const context = assemblePromptContext({
      backgroundDocuments: [],
      liveChatMessages: [
        { speaker: "User", text: "hidden message" }
      ],
      liveChatLimit: 0
    });

    expect(context).toContain("<live_chat_context>");
    expect(context).toContain("</live_chat_context>");
    expect(context).not.toContain("<message");
    expect(context).not.toContain("hidden message");
  });

  it("filters blank live chat messages before applying the limit", () => {
    const context = assemblePromptContext({
      backgroundDocuments: [],
      liveChatMessages: [
        { speaker: "User", text: "message-1" },
        { speaker: "User", text: "   " },
        { speaker: "Iris", text: "\n\t" },
        { speaker: "User", text: "message-2" }
      ],
      liveChatLimit: 2
    });

    expect(context).toContain('<message speaker="User">message-1</message>');
    expect(context).toContain('<message speaker="User">message-2</message>');
    expect(context).not.toContain('<message speaker="User">   </message>');
    expect(context).not.toContain('<message speaker="Iris">\n\t</message>');
  });

  it("filters live chat messages with blank speakers before formatting", () => {
    const context = assemblePromptContext({
      backgroundDocuments: [],
      liveChatMessages: [
        { speaker: "   ", text: "speaker is blank" },
        { speaker: "\n\t", text: "speaker is also blank" },
        { speaker: "Alice", text: "speaker is present" }
      ]
    });

    expect(context).toContain('<message speaker="Alice">speaker is present</message>');
    expect(context).not.toContain("speaker is blank");
    expect(context).not.toContain("speaker is also blank");
    expect(context).not.toContain('speaker=""');
  });

  it("trims live chat speaker and text when formatting messages", () => {
    const context = assemblePromptContext({
      backgroundDocuments: [],
      liveChatMessages: [
        { speaker: " Alice ", text: "  Please check this.  " }
      ]
    });

    expect(context).toContain('<message speaker="Alice">Please check this.</message>');
    expect(context).not.toContain(" Alice ");
    expect(context).not.toContain("  Please check this.  ");
  });

  it("truncates oversized live chat message text before formatting", () => {
    const context = assemblePromptContext({
      backgroundDocuments: [],
      liveChatMessages: [
        { speaker: "Alice", text: `${"L".repeat(2100)} trailing live context` }
      ]
    });
    const formattedMessage = context.match(
      /<message speaker="Alice">(?<text>.*?)<\/message>/s,
    )?.groups?.text;

    expect(formattedMessage).toBeDefined();
    expect(formattedMessage!.length).toBeLessThanOrEqual(2000);
    expect(formattedMessage).toContain("[truncated]");
    expect(formattedMessage).not.toContain("trailing live context");
  });

  it("bounds escaped live chat message text after XML escaping", () => {
    const context = assemblePromptContext({
      backgroundDocuments: [],
      liveChatMessages: [
        { speaker: "Alice", text: `${"&".repeat(2500)} trailing live context` }
      ]
    });
    const formattedMessage = context.match(
      /<message speaker="Alice">(?<text>.*?)<\/message>/s,
    )?.groups?.text;

    expect(formattedMessage).toBeDefined();
    expect(formattedMessage!.length).toBeLessThanOrEqual(2000);
    expect(formattedMessage).toContain("[truncated]");
    expect(formattedMessage).not.toContain("trailing live context");
  });

  it("truncates oversized live chat speakers before formatting attributes", () => {
    const context = assemblePromptContext({
      backgroundDocuments: [],
      liveChatMessages: [
        {
          speaker: `${'"><&'.repeat(120)} trailing speaker identity`,
          text: "Please keep the prompt anchored."
        }
      ]
    });
    const formattedSpeaker = context.match(
      /<message speaker="(?<speaker>.*?)">Please keep the prompt anchored\.<\/message>/s,
    )?.groups?.speaker;

    expect(formattedSpeaker).toBeDefined();
    expect(formattedSpeaker!.length).toBeLessThanOrEqual(256);
    expect(formattedSpeaker).toContain("[truncated]");
    expect(formattedSpeaker).not.toContain("trailing speaker identity");
  });

  it("trims background document source and text when formatting documents", () => {
    const context = assemblePromptContext({
      backgroundDocuments: [
        { source: " feishu://doc/abc ", text: "  Useful document context.  " }
      ],
      liveChatMessages: []
    });

    expect(context).toContain(
      '<document source="feishu://doc/abc">Useful document context.</document>',
    );
    expect(context).not.toContain(" feishu://doc/abc ");
    expect(context).not.toContain("  Useful document context.  ");
  });

  it("truncates oversized background document text before formatting", () => {
    const context = assemblePromptContext({
      backgroundDocuments: [
        { source: "doc-large", text: `${"D".repeat(1300)} trailing context` }
      ],
      liveChatMessages: []
    });
    const formattedDocument = context.match(
      /<document source="doc-large">(?<text>.*?)<\/document>/s,
    )?.groups?.text;

    expect(formattedDocument).toBeDefined();
    expect(formattedDocument!.length).toBeLessThanOrEqual(1200);
    expect(formattedDocument).toContain("[truncated]");
    expect(formattedDocument).not.toContain("trailing context");
  });

  it("bounds escaped background document text after XML escaping", () => {
    const context = assemblePromptContext({
      backgroundDocuments: [
        {
          source: "doc-escaped-large",
          text: `${"&".repeat(1500)} trailing escaped context`
        }
      ],
      liveChatMessages: []
    });
    const formattedDocument = context.match(
      /<document source="doc-escaped-large">(?<text>.*?)<\/document>/s,
    )?.groups?.text;

    expect(formattedDocument).toBeDefined();
    expect(formattedDocument!.length).toBeLessThanOrEqual(1200);
    expect(formattedDocument).toContain("[truncated]");
    expect(formattedDocument).not.toContain("trailing escaped context");
  });

  it("truncates oversized background document sources before formatting attributes", () => {
    const context = assemblePromptContext({
      backgroundDocuments: [
        {
          source: `${'"><&'.repeat(240)} trailing source identity`,
          text: "Useful document context."
        }
      ],
      liveChatMessages: []
    });
    const formattedSource = context.match(
      /<document source="(?<source>.*?)">Useful document context\.<\/document>/s,
    )?.groups?.source;

    expect(formattedSource).toBeDefined();
    expect(formattedSource!.length).toBeLessThanOrEqual(512);
    expect(formattedSource).toContain("[truncated]");
    expect(formattedSource).not.toContain("trailing source identity");
  });

  it("caps background documents to the first 12 items", () => {
    const backgroundDocuments = Array.from({ length: 14 }, (_, index) => ({
      source: `doc-${index + 1}`,
      text: `document-${index + 1}`
    }));

    const context = assemblePromptContext({
      backgroundDocuments,
      liveChatMessages: []
    });

    expect(context).toContain('<document source="doc-1">document-1</document>');
    expect(context).toContain('<document source="doc-12">document-12</document>');
    expect(context).not.toContain('<document source="doc-13">document-13</document>');
    expect(context).not.toContain('<document source="doc-14">document-14</document>');
  });

  it("filters blank background documents before applying the limit", () => {
    const context = assemblePromptContext({
      backgroundDocuments: [
        { source: "doc-a", text: "Useful document" },
        { source: "   ", text: "missing source" },
        { source: "doc-b", text: "\n\t" },
        { source: "doc-c", text: "Second useful document" }
      ],
      liveChatMessages: []
    });

    expect(context).toContain('<document source="doc-a">Useful document</document>');
    expect(context).toContain('<document source="doc-c">Second useful document</document>');
    expect(context).not.toContain("missing source");
    expect(context).not.toContain('source=""');
    expect(context).not.toContain('<document source="doc-b">');
  });

  it("excludes live messages when liveChatLimit is negative", () => {
    const context = assemblePromptContext({
      backgroundDocuments: [],
      liveChatMessages: [
        { speaker: "User", text: "negative limit should hide this" },
        { speaker: "Iris", text: "negative limit should hide this too" }
      ],
      liveChatLimit: -1
    });

    expect(context).not.toContain("<message");
    expect(context).not.toContain("negative limit should hide this");
    expect(context).not.toContain("negative limit should hide this too");
  });

  it("floors fractional liveChatLimit values before selecting live messages", () => {
    const context = assemblePromptContext({
      backgroundDocuments: [],
      liveChatMessages: [
        { speaker: "User", text: "message-1" },
        { speaker: "User", text: "message-2" },
        { speaker: "User", text: "message-3" }
      ],
      liveChatLimit: 1.9
    });

    expect(context).not.toContain('<message speaker="User">message-1</message>');
    expect(context).not.toContain('<message speaker="User">message-2</message>');
    expect(context).toContain('<message speaker="User">message-3</message>');
  });

  it("rejects non-finite liveChatLimit values before selecting live messages", () => {
    for (const liveChatLimit of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      expect(() =>
        assemblePromptContext({
          backgroundDocuments: [],
          liveChatMessages: [
            { speaker: "User", text: "message-1" },
            { speaker: "User", text: "message-2" }
          ],
          liveChatLimit
        }),
      ).toThrow("liveChatLimit must be a finite safe-magnitude number");
    }
  });

  it("rejects unsafe liveChatLimit values before selecting live messages", () => {
    expect(() =>
      assemblePromptContext({
        backgroundDocuments: [],
        liveChatMessages: [
          { speaker: "User", text: "message-1" },
          { speaker: "User", text: "message-2" }
        ],
        liveChatLimit: Number.MAX_SAFE_INTEGER + 1
      }),
    ).toThrow("liveChatLimit must be a finite safe-magnitude number");
  });

  it("escapes XML in background documents and live chat messages", () => {
    const context = assemblePromptContext({
      backgroundDocuments: [
        {
          source: 'doc"><escape',
          text: "Document </background_documents> & evidence"
        }
      ],
      liveChatMessages: [
        {
          speaker: 'Alice"><script',
          text: "Chat </live_chat_context> & reply"
        }
      ]
    });

    expect(context).toContain('<document source="doc&quot;&gt;&lt;escape">Document &lt;/background_documents&gt; &amp; evidence</document>');
    expect(context).toContain('<message speaker="Alice&quot;&gt;&lt;script">Chat &lt;/live_chat_context&gt; &amp; reply</message>');
    expect(context).not.toContain("Document </background_documents>");
    expect(context).not.toContain("Chat </live_chat_context>");
  });
});
