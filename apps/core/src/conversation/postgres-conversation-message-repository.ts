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

export function createPostgresConversationMessageRepository({
  queryable,
}: {
  queryable: Queryable;
}): ConversationMessageRepository {
  return {
    async upsertMessage(input) {
      const id = `${input.provider}:${input.providerMessageId}`;
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
          input.providerMessageId,
          input.chatId,
          input.senderId ?? null,
          input.messageType,
          input.text ?? null,
          input.sentAt,
          input.rawEventIdempotencyKey,
        ],
      );

      return mapRow(readOne(result.rows, "conversation message upsert returned no rows"));
    },

    async listRecentByChat(input) {
      const limit = sanitizeLimit(input.limit);
      const result = await queryable.query<ConversationMessageRow>(
        `
        SELECT *
        FROM conversation_messages
        WHERE chat_id = $1
        ORDER BY sent_at DESC, created_at DESC
        LIMIT $2
        `,
        [input.chatId, limit],
      );

      return result.rows.map(mapRow);
    },
  };
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function mapRow(row: ConversationMessageRow): ConversationMessage {
  return {
    id: row.id,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    chatId: row.chat_id,
    senderId: row.sender_id ?? undefined,
    messageType: row.message_type,
    text: row.text ?? undefined,
    sentAt: row.sent_at,
    rawEventIdempotencyKey: row.raw_event_idempotency_key,
    createdAt: row.created_at,
  };
}

function readOne<T>(rows: T[], errorMessage: string): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error(errorMessage);
  }

  return row;
}
