import type {
  ConversationMessage,
  ConversationMessageRepository,
} from "./conversation-message-repository.js";

export type Queryable = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

type ConversationMessageRow = {
  id: string;
  provider: "feishu";
  provider_message_id: string;
  chat_id: string;
  sender_id: string | null;
  message_type: string;
  text: string | null;
  sent_at: Date;
  raw_event_idempotency_key: string;
  created_at: Date;
};

export const MAX_CONVERSATION_MESSAGE_ID_CHARS = 512;
const MAX_CONVERSATION_MESSAGE_LIST_LIMIT = 100;
const MAX_CONVERSATION_MESSAGE_TEXT_CHARS = 8000;
const TRUNCATION_MARKER = " ... [truncated]";

export function createPostgresConversationMessageRepository({
  queryable,
}: {
  queryable: Queryable;
}): ConversationMessageRepository {
  return {
    async upsertMessage(input) {
      const providerMessageId = requireBoundedIdentifier(
        "providerMessageId",
        input.providerMessageId,
      );
      const chatId = requireBoundedIdentifier("chatId", input.chatId);
      const senderId =
        input.senderId === undefined
          ? null
          : requireBoundedIdentifier("senderId", input.senderId);
      const messageType = requireBoundedIdentifier("messageType", input.messageType);
      const rawEventIdempotencyKey = requireBoundedIdentifier(
        "rawEventIdempotencyKey",
        input.rawEventIdempotencyKey,
      );
      const sentAt = normalizeConversationDate("sentAt", input.sentAt);
      const id = `${input.provider}:${providerMessageId}`;
      const result = await queryable.query<ConversationMessageRow>(
        `
        INSERT INTO conversation_messages (
          id,
          provider,
          provider_message_id,
          chat_id,
          sender_id,
          message_type,
          text,
          sent_at,
          raw_event_idempotency_key
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (provider, provider_message_id)
        DO UPDATE SET
          chat_id = EXCLUDED.chat_id,
          sender_id = EXCLUDED.sender_id,
          message_type = EXCLUDED.message_type,
          text = EXCLUDED.text,
          sent_at = EXCLUDED.sent_at,
          raw_event_idempotency_key = EXCLUDED.raw_event_idempotency_key
        RETURNING *
        `,
        [
          id,
          input.provider,
          providerMessageId,
          chatId,
          senderId,
          messageType,
          normalizeMessageText(input.text),
          sentAt,
          rawEventIdempotencyKey,
        ],
      );

      return mapRow(readOne(result.rows, "conversation message upsert returned no rows"));
    },

    async listRecentByChat(input) {
      const chatId = requireBoundedIdentifier("chatId", input.chatId);
      const limit = sanitizeLimit(input.limit);
      const result = await queryable.query<ConversationMessageRow>(
        `
        SELECT *
        FROM conversation_messages
        WHERE chat_id = $1
        ORDER BY sent_at DESC, created_at DESC
        LIMIT $2
        `,
        [chatId, limit],
      );

      return result.rows.map(mapRow);
    },
  };
}

function requireBoundedIdentifier(fieldName: string, value: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must not be blank`);
  }

  if (value.length > MAX_CONVERSATION_MESSAGE_ID_CHARS) {
    throw new Error(
      `${fieldName} must be at most ${MAX_CONVERSATION_MESSAGE_ID_CHARS} characters`,
    );
  }

  return value;
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error("conversation message limit must be a finite safe-magnitude number");
  }

  return Math.min(MAX_CONVERSATION_MESSAGE_LIST_LIMIT, Math.max(0, Math.floor(value)));
}

function normalizeConversationDate(fieldName: string, value: Date): Date {
  const normalized = new Date(value);
  if (Number.isNaN(normalized.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }

  return normalized;
}

function mapRow(row: ConversationMessageRow): ConversationMessage {
  return {
    id: row.id,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    chatId: row.chat_id,
    senderId: row.sender_id ?? undefined,
    messageType: row.message_type,
    text: normalizeMessageText(row.text ?? undefined) ?? undefined,
    sentAt: row.sent_at,
    rawEventIdempotencyKey: row.raw_event_idempotency_key,
    createdAt: row.created_at,
  };
}

function normalizeMessageText(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  if (value.length <= MAX_CONVERSATION_MESSAGE_TEXT_CHARS) {
    return value;
  }

  const prefixChars = MAX_CONVERSATION_MESSAGE_TEXT_CHARS - TRUNCATION_MARKER.length;
  return `${value.slice(0, prefixChars).trimEnd()}${TRUNCATION_MARKER}`;
}

function readOne<T>(rows: T[], errorMessage: string): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error(errorMessage);
  }

  return row;
}
