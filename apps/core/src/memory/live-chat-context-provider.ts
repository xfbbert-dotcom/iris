import type { ConversationMessageRepository } from "../conversation/conversation-message-repository.js";
import type { Queryable } from "../documents/document-fragment-repository.js";
import type { FeishuChatHistoryMessage, FeishuChatHistoryReader } from "../feishu/feishu-chat-history-reader.js";
import type { LiveChatMessage } from "./context-assembly.js";
import { selectTopicAwareChatWindow } from "./topic-aware-chat-window.js";
import { resolveHistoricalChatQuery } from "./historical-chat-query.js";

export type LiveChatContextProvider = {
  loadRecentMessages(input: { chatId: string; limit?: number; question?: string }): Promise<LiveChatMessage[]>;
};

export function createLiveChatContextProvider({
  repository,
}: {
  repository: Pick<ConversationMessageRepository, "listRecentByChat">;
}): LiveChatContextProvider {
  return {
    async loadRecentMessages(input) {
      const outputLimit = sanitizeLimit(input.limit);
      if (outputLimit <= 0) {
        return [];
      }

      const messages = await repository.listRecentByChat({
        chatId: input.chatId,
        limit: scanLimitForOutput(outputLimit),
      });

      return messages
        .slice()
        .reverse()
        .filter((message) => typeof message.text === "string" && message.text.trim().length > 0)
        .map((message) => ({
          speaker: message.senderId ?? "unknown",
          text: message.text!.trim(),
        }))
        .slice(-outputLimit);
    },
  };
}

export function createFeishuLiveChatContextProvider({
  reader,
  queryable,
  now = () => new Date(),
}: {
  reader: FeishuChatHistoryReader;
  queryable: Queryable;
  now?: () => Date;
}): LiveChatContextProvider {
  return {
    async loadRecentMessages(input) {
      const outputLimit = sanitizeLimit(input.limit);
      if (outputLimit <= 0) {
        return [];
      }

      const historicalQuery = resolveHistoricalChatQuery(input.question, now());
      const messages = historicalQuery === undefined
        ? (await reader.listRecentMessages({ chatId: input.chatId, limit: MAX_LIVE_CHAT_SCAN_LIMIT }))
          .filter((message) => message.chatId === input.chatId).slice(0, MAX_LIVE_CHAT_SCAN_LIMIT)
        : await loadHistoricalMessages({ reader, queryable, chatId: input.chatId, question: input.question!, query: historicalQuery });
      if (messages.length === 0) {
        return [];
      }

      // Tombstones outlive local rows, including messages whose receive callback was missed.
      const result = await queryable.query<{ provider_message_id: string }>(
        `SELECT provider_message_id
         FROM conversation_message_deletion_tombstones
         WHERE provider = 'feishu' AND provider_message_id = ANY($1::text[])`,
        [messages.map((message) => message.messageId)],
      );
      const deletedIds = new Set(result.rows.map((row) => row.provider_message_id));
      const readableMessages = messages
        .filter((message) => !deletedIds.has(message.messageId))
        .reverse()
        .map((message) => ({
          speaker: message.senderId,
          text: historicalQuery === undefined ? message.text : `[${formatHistoricalTime(message.sentAt)} 北京时间] ${message.text}`,
          messageId: message.messageId,
          ...(message.parentMessageId === undefined ? {} : { parentMessageId: message.parentMessageId }),
          ...(message.rootMessageId === undefined ? {} : { rootMessageId: message.rootMessageId }),
        }));
      return selectTopicAwareChatWindow(readableMessages, input.question, outputLimit);
    },
  };
}

// Stored rows discover candidate identities only. Every body used below comes from a fresh
// same-chat Feishu read; neither a cache hit nor an old reply link grants access to content.
async function loadHistoricalMessages({ reader, queryable, chatId, question, query }: {
  reader: FeishuChatHistoryReader;
  queryable: Queryable;
  chatId: string;
  question: string;
  query: NonNullable<ReturnType<typeof resolveHistoricalChatQuery>>;
}): Promise<FeishuChatHistoryMessage[]> {
  const candidateIds = query.terms.length === 0 || reader.readMessagesByIds === undefined ? [] :
    (await queryable.query<{ provider_message_id: string }>(
      `SELECT m.provider_message_id
       FROM conversation_messages m
       WHERE m.provider = 'feishu' AND m.chat_id = $1
         AND m.sent_at >= $2 AND m.sent_at < $3
         AND m.message_type IN ('text', 'post') AND m.text IS NOT NULL
         AND RIGHT(LOWER(TRIM(m.text)), LENGTH($5::text)) <> $5
         AND NOT EXISTS (
           SELECT 1 FROM conversation_message_deletion_tombstones t
           WHERE t.provider = 'feishu' AND t.provider_message_id = m.provider_message_id
         )
         AND EXISTS (SELECT 1 FROM UNNEST($4::text[]) term WHERE STRPOS(LOWER(m.text), term) > 0)
       ORDER BY (SELECT COUNT(*) FROM UNNEST($4::text[]) term WHERE STRPOS(LOWER(m.text), term) > 0) DESC,
                m.sent_at DESC, m.provider_message_id ASC
       LIMIT 8`,
      [chatId, query.start, query.end, query.terms, question.trim().toLowerCase()],
    )).rows.map(row => row.provider_message_id).filter(id => typeof id === "string" && id.length > 0).slice(0, 8);
  const [dayMessages, candidates] = await Promise.all([
    reader.listRecentMessages({ chatId, limit: MAX_LIVE_CHAT_SCAN_LIMIT, timeRange: { start: query.start, end: query.end } }),
    candidateIds.length === 0 ? [] : reader.readMessagesByIds!({ chatId, messageIds: candidateIds }),
  ]);
  const isInScope = (message: FeishuChatHistoryMessage) => message.chatId === chatId
    && message.sentAt >= query.start && message.sentAt < query.end;
  const byId = new Map<string, FeishuChatHistoryMessage>();
  // A by-ID denial/deletion (omitted result) supersedes any earlier list body for that ID.
  for (const message of [
    ...dayMessages.slice(0, MAX_LIVE_CHAT_SCAN_LIMIT).filter(message => !candidateIds.includes(message.messageId)),
    ...candidates.slice(0, 8),
  ]) {
    if (isInScope(message)) byId.set(message.messageId, message);
  }
  const ordered = [...byId.values()].sort((left, right) => left.sentAt.getTime() - right.sentAt.getTime());
  // A matching label can be older than many questions repeating the same topic. Resolve its
  // declared parent before selection: without the parent it cannot yet win reply-linked ranking.
  const selected = query.terms.length === 0 ? ordered.slice(-8).reverse()
    : ordered.slice().reverse().filter(message => query.terms.some(term => message.text.toLowerCase().includes(term)));
  const parentIds = [...new Set(selected.flatMap(message => [message.parentMessageId, message.rootMessageId]))]
    .filter((id): id is string => id !== undefined && !byId.has(id) && !candidateIds.includes(id)).slice(0, 8);
  if (parentIds.length > 0 && reader.readMessagesByIds !== undefined) {
    const parents = await reader.readMessagesByIds({ chatId, messageIds: parentIds });
    for (const message of parents.slice(0, 8)) {
      if (parentIds.includes(message.messageId) && isInScope(message)) byId.set(message.messageId, message);
    }
  }
  return [...byId.values()].sort((left, right) => right.sentAt.getTime() - left.sentAt.getTime());
}

function formatHistoricalTime(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

const DEFAULT_LIVE_CHAT_LIMIT = 20;
const MAX_LIVE_CHAT_LIMIT = 20;
const LIVE_CHAT_SCAN_MULTIPLIER = 3;
const MAX_LIVE_CHAT_SCAN_LIMIT = 100;

function sanitizeLimit(value: number | undefined): number {
  if (
    value !== undefined &&
    (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("live chat limit must be a finite safe-magnitude number");
  }
  if (value === undefined) {
    return DEFAULT_LIVE_CHAT_LIMIT;
  }

  return Math.min(MAX_LIVE_CHAT_LIMIT, Math.max(0, Math.floor(value)));
}

function scanLimitForOutput(outputLimit: number): number {
  return Math.min(MAX_LIVE_CHAT_SCAN_LIMIT, outputLimit * LIVE_CHAT_SCAN_MULTIPLIER);
}
