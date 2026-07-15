import type {
  ConversationMessage,
  ConversationMessageMention,
  ConversationMessageRepository,
} from "./conversation-message-repository.js";
import { MAX_RAW_EVENT_IDEMPOTENCY_KEY_LENGTH } from "../events/raw-event-queue.js";

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
  mentions?: unknown;
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
      const rawEventIdempotencyKey = requireBoundedRawEventIdempotencyKey(
        "rawEventIdempotencyKey",
        input.rawEventIdempotencyKey,
      );
      const mentions = normalizeMentions(input.mentions);
      const sentAt = normalizeConversationDate("sentAt", input.sentAt);
      const id = `${input.provider}:${providerMessageId}`;
      const result = await queryable.query<ConversationMessageRow>(
        `
        WITH upserted_message AS (
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
        ),
        cleared_mentions AS (
          DELETE FROM conversation_message_mentions
          WHERE conversation_message_id = (SELECT id FROM upserted_message)
          RETURNING conversation_message_id
        ),
        inserted_mentions AS (
          INSERT INTO conversation_message_mentions (
            conversation_message_id,
            mention_key,
            mentioned_open_id
          )
          SELECT
            (SELECT id FROM upserted_message),
            mention_key,
            mentioned_open_id
          FROM unnest($10::text[], $11::text[]) AS mention(mention_key, mentioned_open_id)
          WHERE (SELECT count(*) FROM cleared_mentions) >= 0
          RETURNING mention_key, mentioned_open_id
        )
        SELECT
          upserted_message.*,
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object('key', mention_key, 'openId', mentioned_open_id)
                ORDER BY mention_key, mentioned_open_id
              )
              FROM inserted_mentions
            ),
            '[]'::jsonb
          ) AS mentions
        FROM upserted_message
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
          mentions.map((mention) => mention.key),
          mentions.map((mention) => mention.openId),
        ],
      );

      return mapRow(readOne(result.rows, "conversation message upsert returned no rows"));
    },

    async listRecentByChat(input) {
      const chatId = requireBoundedIdentifier("chatId", input.chatId);
      const limit = sanitizeLimit(input.limit);
      const result = await queryable.query<ConversationMessageRow>(
        `
        SELECT
          conversation_messages.*,
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'key',
                conversation_message_mentions.mention_key,
                'openId',
                conversation_message_mentions.mentioned_open_id
              )
              ORDER BY
                conversation_message_mentions.mention_key,
                conversation_message_mentions.mentioned_open_id
            ) FILTER (WHERE conversation_message_mentions.conversation_message_id IS NOT NULL),
            '[]'::jsonb
          ) AS mentions
        FROM conversation_messages
        LEFT JOIN conversation_message_mentions
          ON conversation_message_mentions.conversation_message_id = conversation_messages.id
        WHERE chat_id = $1
        GROUP BY conversation_messages.id
        ORDER BY conversation_messages.sent_at DESC, conversation_messages.created_at DESC
        LIMIT $2
        `,
        [chatId, limit],
      );

      return result.rows.map(mapRow);
    },
  };
}

function requireBoundedIdentifier(fieldName: string, value: string): string {
  return requireBoundedString(fieldName, value, MAX_CONVERSATION_MESSAGE_ID_CHARS);
}

function requireBoundedRawEventIdempotencyKey(fieldName: string, value: string): string {
  return requireBoundedString(fieldName, value, MAX_RAW_EVENT_IDEMPOTENCY_KEY_LENGTH);
}

function requireBoundedString(fieldName: string, value: string, maxChars: number): string {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must not be blank`);
  }

  if (value.length > maxChars) {
    throw new Error(`${fieldName} must be at most ${maxChars} characters`);
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
  const mentions = readMentions(row.mentions);
  return {
    id: row.id,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    chatId: row.chat_id,
    senderId: row.sender_id ?? undefined,
    messageType: row.message_type,
    text: normalizeMessageText(row.text ?? undefined) ?? undefined,
    ...(mentions === undefined ? {} : { mentions }),
    sentAt: row.sent_at,
    rawEventIdempotencyKey: row.raw_event_idempotency_key,
    createdAt: row.created_at,
  };
}

function normalizeMentions(
  mentions: ConversationMessageMention[] | undefined,
): ConversationMessageMention[] {
  const normalized: ConversationMessageMention[] = [];

  for (const mention of mentions ?? []) {
    const key = requireBoundedIdentifier("mention key", mention.key.trim());
    const openId = requireBoundedIdentifier("mention openId", mention.openId.trim());
    if (!normalized.some((existing) => existing.key === key && existing.openId === openId)) {
      normalized.push({ key, openId });
    }
  }

  normalized.sort((left, right) => {
    if (left.key !== right.key) {
      return left.key < right.key ? -1 : 1;
    }
    if (left.openId === right.openId) {
      return 0;
    }
    return left.openId < right.openId ? -1 : 1;
  });

  const seenOpenIds = new Set<string>();
  return normalized.filter(({ openId }) => {
    if (seenOpenIds.has(openId)) {
      return false;
    }
    seenOpenIds.add(openId);
    return true;
  });
}

function readMentions(value: unknown): ConversationMessageMention[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((mention): ConversationMessageMention[] => {
    if (
      typeof mention !== "object" ||
      mention === null ||
      typeof mention.key !== "string" ||
      typeof mention.openId !== "string"
    ) {
      return [];
    }
    return [{ key: mention.key, openId: mention.openId }];
  });
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
