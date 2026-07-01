import { describe, expect, it } from "vitest";
import { normalizeFeishuEvent } from "../src/feishu/feishu-event-normalizer.js";

describe("normalizeFeishuEvent", () => {
  it("normalizes group text message events", () => {
    const result = normalizeFeishuEvent({
      event_id: "event-a",
      event: {
        sender: { sender_id: { open_id: "user-a" } },
        message: {
          message_id: "msg-a",
          chat_id: "chat-a",
          create_time: "1710000000000",
          message_type: "text",
          content: "{\"text\":\"hello iris\"}"
        }
      }
    });

    expect(result).toEqual({
      kind: "group_message",
      eventId: "event-a",
      messageId: "msg-a",
      chatId: "chat-a",
      senderOpenId: "user-a",
      messageType: "text",
      text: "hello iris",
      timestamp: new Date(1710000000000),
      documentLinks: []
    });
  });

  it("extracts Feishu document links from text content", () => {
    const docxLink = "https://example.feishu.cn/docx/ABC123";
    const wikiLink = "https://example.feishu.cn/wiki/WIKI123";
    const fileLink = "https://example.feishu.cn/file/FILE123";
    const docsLink = "https://example.feishu.cn/docs/DOCS123";

    const result = normalizeFeishuEvent({
      event_id: "event-links",
      event: {
        sender: { sender_id: { open_id: "user-a" } },
        message: {
          message_id: "msg-links",
          chat_id: "chat-a",
          create_time: "1710000000000",
          message_type: "text",
          content: JSON.stringify({
            text: `Links: ${docxLink} ${wikiLink} ${fileLink} ${docsLink}`
          })
        }
      }
    });

    expect(result).toMatchObject({
      kind: "group_message",
      documentLinks: [docxLink, wikiLink, fileLink, docsLink]
    });
  });

  it("returns unsupported when the message payload is missing", () => {
    const result = normalizeFeishuEvent({
      event_id: "event-a",
      event: {}
    });

    expect(result).toEqual({
      kind: "unsupported",
      eventId: "event-a",
      reason: "missing_message"
    });
  });

  it("falls back to raw content when text content is not valid JSON", () => {
    const result = normalizeFeishuEvent({
      event_id: "event-raw-content",
      event: {
        sender: { sender_id: { open_id: "user-a" } },
        message: {
          message_id: "msg-raw",
          chat_id: "chat-a",
          create_time: "1710000000000",
          message_type: "text",
          content: "plain text"
        }
      }
    });

    expect(result).toMatchObject({
      kind: "group_message",
      text: "plain text"
    });
  });

  it("returns unsupported when required fields are missing", () => {
    const result = normalizeFeishuEvent({
      event_id: "event-missing-fields",
      event: {
        sender: { sender_id: { open_id: "user-a" } },
        message: {
          message_id: "msg-missing",
          chat_id: "chat-a",
          message_type: "text",
          content: "{\"text\":\"hello iris\"}"
        }
      }
    });

    expect(result).toEqual({
      kind: "unsupported",
      eventId: "event-missing-fields",
      reason: "missing_required_fields"
    });
  });

  it("returns unsupported when message_type is missing", () => {
    const result = normalizeFeishuEvent({
      event_id: "event-missing-message-type",
      event: {
        sender: { sender_id: { open_id: "user-a" } },
        message: {
          message_id: "msg-missing-type",
          chat_id: "chat-a",
          create_time: "1710000000000",
          content: "{\"text\":\"hello iris\"}"
        }
      }
    });

    expect(result).toEqual({
      kind: "unsupported",
      eventId: "event-missing-message-type",
      reason: "missing_required_fields"
    });
  });

  it("uses unknown when event_id is missing", () => {
    const result = normalizeFeishuEvent({
      event: {}
    });

    expect(result).toEqual({
      kind: "unsupported",
      eventId: "unknown",
      reason: "missing_message"
    });
  });
});
