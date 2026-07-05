import { describe, expect, it, vi } from "vitest";

import type { UpsertConversationMessageInput } from "../src/conversation/conversation-message-repository.js";
import {
  createPostgresConversationMessageRepository,
  type Queryable,
} from "../src/conversation/postgres-conversation-message-repository.js";

describe("PostgresConversationMessageRepository", () => {
  it("upserts conversation messages", async () => {
    const queryable = fakeQueryable([
      {
        id: "feishu:message-1",
        provider: "feishu",
        provider_message_id: "message-1",
        chat_id: "chat-1",
        sender_id: "user-1",
        message_type: "text",
        text: "Hello",
        sent_at: new Date("2026-07-02T01:00:00.000Z"),
        raw_event_idempotency_key: "raw-event:feishu:event-1",
        created_at: new Date("2026-07-02T01:00:01.000Z"),
      },
    ]);
    const repository = createPostgresConversationMessageRepository({ queryable });

    await expect(
      repository.upsertMessage({
        provider: "feishu",
        providerMessageId: "message-1",
        chatId: "chat-1",
        senderId: "user-1",
        messageType: "text",
        text: "Hello",
        sentAt: new Date("2026-07-02T01:00:00.000Z"),
        rawEventIdempotencyKey: "raw-event:feishu:event-1",
      }),
    ).resolves.toMatchObject({
      id: "feishu:message-1",
      providerMessageId: "message-1",
      chatId: "chat-1",
      text: "Hello",
    });
    expect(queryable.query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT"),
      expect.any(Array),
    );
  });

  it("bounds oversized message text before upsert", async () => {
    const queryable = fakeQueryable([
      {
        id: "feishu:message-1",
        provider: "feishu",
        provider_message_id: "message-1",
        chat_id: "chat-1",
        sender_id: null,
        message_type: "text",
        text: "stored",
        sent_at: new Date("2026-07-02T01:00:00.000Z"),
        raw_event_idempotency_key: "raw-event:feishu:event-1",
        created_at: new Date("2026-07-02T01:00:01.000Z"),
      },
    ]);
    const repository = createPostgresConversationMessageRepository({ queryable });

    await repository.upsertMessage({
      provider: "feishu",
      providerMessageId: "message-1",
      chatId: "chat-1",
      messageType: "text",
      text: `${"M".repeat(9000)} trailing message detail`,
      sentAt: new Date("2026-07-02T01:00:00.000Z"),
      rawEventIdempotencyKey: "raw-event:feishu:event-1",
    });
    const params = firstQueryParams(queryable);
    const storedText = params[6];

    expect(typeof storedText).toBe("string");
    expect((storedText as string).length).toBeLessThanOrEqual(8000);
    expect(storedText).toContain("[truncated]");
    expect(storedText).not.toContain("trailing message detail");
  });

  it.each([
    {
      field: "providerMessageId",
      message: "providerMessageId must be at most 512 characters",
    },
    {
      field: "chatId",
      message: "chatId must be at most 512 characters",
    },
    {
      field: "senderId",
      message: "senderId must be at most 512 characters",
    },
    {
      field: "messageType",
      message: "messageType must be at most 512 characters",
    },
    {
      field: "rawEventIdempotencyKey",
      message: "rawEventIdempotencyKey must be at most 512 characters",
    },
  ] as const)("rejects oversized $field before upsert", async ({ field, message }) => {
    const queryable = fakeQueryable([]);
    const repository = createPostgresConversationMessageRepository({ queryable });
    const input: UpsertConversationMessageInput = {
      ...baseUpsertInput(),
      [field]: "I".repeat(513),
    };

    await expect(repository.upsertMessage(input)).rejects.toThrow(message);
    expect(queryable.query).not.toHaveBeenCalled();
  });

  it.each([
    {
      field: "providerMessageId",
      message: "providerMessageId must not be blank",
    },
    {
      field: "chatId",
      message: "chatId must not be blank",
    },
    {
      field: "senderId",
      message: "senderId must not be blank",
    },
    {
      field: "messageType",
      message: "messageType must not be blank",
    },
    {
      field: "rawEventIdempotencyKey",
      message: "rawEventIdempotencyKey must not be blank",
    },
  ] as const)("rejects blank $field before upsert", async ({ field, message }) => {
    const queryable = fakeQueryable([]);
    const repository = createPostgresConversationMessageRepository({ queryable });
    const input: UpsertConversationMessageInput = {
      ...baseUpsertInput(),
      [field]: "   ",
    };

    await expect(repository.upsertMessage(input)).rejects.toThrow(message);
    expect(queryable.query).not.toHaveBeenCalled();
  });

  it("lists recent messages by chat", async () => {
    const queryable = fakeQueryable([
      {
        id: "feishu:message-2",
        provider: "feishu",
        provider_message_id: "message-2",
        chat_id: "chat-1",
        sender_id: null,
        message_type: "text",
        text: "Second",
        sent_at: new Date("2026-07-02T01:01:00.000Z"),
        raw_event_idempotency_key: "raw-event:feishu:event-2",
        created_at: new Date("2026-07-02T01:01:01.000Z"),
      },
    ]);
    const repository = createPostgresConversationMessageRepository({ queryable });

    await expect(repository.listRecentByChat({ chatId: "chat-1", limit: 20 })).resolves.toEqual([
      {
        id: "feishu:message-2",
        provider: "feishu",
        providerMessageId: "message-2",
        chatId: "chat-1",
        senderId: undefined,
        messageType: "text",
        text: "Second",
        sentAt: new Date("2026-07-02T01:01:00.000Z"),
        rawEventIdempotencyKey: "raw-event:feishu:event-2",
        createdAt: new Date("2026-07-02T01:01:01.000Z"),
      },
    ]);
    expect(queryable.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE chat_id = $1"),
      ["chat-1", 20],
    );
  });

  it("rejects oversized recent chat ids before querying Postgres", async () => {
    const queryable = fakeQueryable([]);
    const repository = createPostgresConversationMessageRepository({ queryable });

    await expect(
      repository.listRecentByChat({ chatId: "C".repeat(513), limit: 20 }),
    ).rejects.toThrow("chatId must be at most 512 characters");
    expect(queryable.query).not.toHaveBeenCalled();
  });

  it("rejects blank recent chat ids before querying Postgres", async () => {
    const queryable = fakeQueryable([]);
    const repository = createPostgresConversationMessageRepository({ queryable });

    await expect(repository.listRecentByChat({ chatId: "   ", limit: 20 })).rejects.toThrow(
      "chatId must not be blank",
    );
    expect(queryable.query).not.toHaveBeenCalled();
  });

  it("bounds oversized legacy message text when reading rows", async () => {
    const queryable = fakeQueryable([
      {
        id: "feishu:message-legacy",
        provider: "feishu",
        provider_message_id: "message-legacy",
        chat_id: "chat-1",
        sender_id: null,
        message_type: "text",
        text: `${"L".repeat(9000)} trailing legacy detail`,
        sent_at: new Date("2026-07-02T01:01:00.000Z"),
        raw_event_idempotency_key: "raw-event:feishu:event-legacy",
        created_at: new Date("2026-07-02T01:01:01.000Z"),
      },
    ]);
    const repository = createPostgresConversationMessageRepository({ queryable });

    const [message] = await repository.listRecentByChat({ chatId: "chat-1", limit: 20 });

    expect(message?.text).toBeDefined();
    expect(message!.text!.length).toBeLessThanOrEqual(8000);
    expect(message!.text).toContain("[truncated]");
    expect(message!.text).not.toContain("trailing legacy detail");
  });

  it("rejects non-finite recent message limits before querying Postgres", async () => {
    const queryable = fakeQueryable([]);
    const repository = createPostgresConversationMessageRepository({ queryable });

    await expect(
      repository.listRecentByChat({ chatId: "chat-1", limit: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow("conversation message limit must be a finite safe-magnitude number");
    await expect(
      repository.listRecentByChat({ chatId: "chat-1", limit: Number.NaN }),
    ).rejects.toThrow("conversation message limit must be a finite safe-magnitude number");

    expect(queryable.query).not.toHaveBeenCalled();
  });

  it("caps oversized recent message limits before querying Postgres", async () => {
    const queryable = fakeQueryable([]);
    const repository = createPostgresConversationMessageRepository({ queryable });

    await expect(
      repository.listRecentByChat({
        chatId: "chat-1",
        limit: 101,
      }),
    ).resolves.toEqual([]);

    expect(queryable.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE chat_id = $1"),
      ["chat-1", 100],
    );
  });

  it("rejects unsafe recent message limits before querying Postgres", async () => {
    const queryable = fakeQueryable([]);
    const repository = createPostgresConversationMessageRepository({ queryable });

    await expect(
      repository.listRecentByChat({
        chatId: "chat-1",
        limit: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow("conversation message limit must be a finite safe-magnitude number");
    expect(queryable.query).not.toHaveBeenCalled();
  });
});

function baseUpsertInput(): UpsertConversationMessageInput {
  return {
    provider: "feishu",
    providerMessageId: "message-1",
    chatId: "chat-1",
    senderId: "user-1",
    messageType: "text",
    text: "Hello",
    sentAt: new Date("2026-07-02T01:00:00.000Z"),
    rawEventIdempotencyKey: "raw-event:feishu:event-1",
  };
}

function fakeQueryable(rows: unknown[]): Queryable {
  const query = vi.fn(async () => ({ rows }));
  return {
    query: query as unknown as Queryable["query"],
  };
}

function firstQueryParams(queryable: Queryable): unknown[] {
  const calls = (queryable.query as unknown as { mock: { calls: Array<[string, unknown[]]> } }).mock
    .calls;
  const params = calls[0]?.[1];
  if (params === undefined) {
    throw new Error("expected query to be called");
  }

  return params;
}
