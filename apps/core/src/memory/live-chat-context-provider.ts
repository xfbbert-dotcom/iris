import type { ConversationMessageRepository } from "../conversation/conversation-message-repository.js";
import type { Queryable } from "../documents/document-fragment-repository.js";
import type { FeishuChatHistoryMessage, FeishuChatHistoryReader } from "../feishu/feishu-chat-history-reader.js";
import type { LiveChatMessage } from "./context-assembly.js";
import { selectTopicAwareChatWindow } from "./topic-aware-chat-window.js";
import { resolveHistoricalChatQuery } from "./historical-chat-query.js";
import { resolveFollowupHistoricalQueries } from "./followup-historical-chat-query.js";
import type { AssistantConversationContextProvider } from "./assistant-conversation-context.js";

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
  assistantReplies,
}: {
  reader: FeishuChatHistoryReader;
  queryable: Queryable;
  now?: () => Date;
  assistantReplies?: AssistantConversationContextProvider;
}): LiveChatContextProvider {
  return {
    async loadRecentMessages(input) {
      const outputLimit = sanitizeLimit(input.limit);
      if (outputLimit <= 0) {
        return [];
      }

      const answerTime = now();
      const historicalQuery = resolveHistoricalChatQuery(input.question, answerTime);
      const recallBudget = { candidates: 8, parents: 8, attempted: new Set<string>() };
      const recent = historicalQuery === undefined
        ? (await reader.listRecentMessages({ chatId: input.chatId, limit: MAX_LIVE_CHAT_SCAN_LIMIT }))
          .filter((message) => message.chatId === input.chatId).slice(0, MAX_LIVE_CHAT_SCAN_LIMIT)
        : [];
      const historicalQueries = historicalQuery === undefined
        ? resolveFollowupHistoricalQueries(input.question, recent) : [historicalQuery];
      const selectionTopicTerms = [...new Set(historicalQueries.flatMap(query => query.terms))]
        .slice(0, MAX_SELECTION_TOPIC_TERMS);
      const byId = new Map(recent.map(message => [message.messageId, message]));
      for (const [index, query] of historicalQueries.entries()) {
        const recalled = await loadHistoricalMessages({ reader, queryable, chatId: input.chatId,
          question: input.question!, query, budget: recallBudget,
          candidateLimit: Math.ceil(recallBudget.candidates / (historicalQueries.length - index)),
        });
        // A fresh exact denial must not be undone by another (earlier) recent/day list.
        for (const id of recalled.revalidatedIds) byId.delete(id);
        for (const message of recalled.messages) byId.set(message.messageId, message);
      }
      if (historicalQuery === undefined && assistantReplies !== undefined) {
        const replies = await assistantReplies.loadRecentReplies({ chatId: input.chatId, before: answerTime });
        for (const reply of replies) {
          if (reply.chatId === input.chatId && reply.role === "assistant") byId.set(reply.messageId, reply);
        }
      }
      const messages = [...byId.values()].sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
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
          speaker: message.role === "assistant" ? "Iris" : message.senderId,
          text: historicalQueries.length === 0 ? message.text : `[${formatHistoricalTime(message.sentAt)} 北京时间] ${message.text}`,
          messageId: message.messageId,
          ...(message.role === undefined ? {} : { role: message.role }),
          ...(selectionTopicTerms.length === 0 ? {} : { selectionTopicTerms: [...selectionTopicTerms] }),
          ...(message.underlyingDocumentSources === undefined ? {} : { underlyingDocumentSources: message.underlyingDocumentSources.map(source => ({ ...source })) }),
          ...(message.parentMessageId === undefined ? {} : { parentMessageId: message.parentMessageId }),
          ...(message.rootMessageId === undefined ? {} : { rootMessageId: message.rootMessageId }),
        }));
      return selectTopicAwareChatWindow(readableMessages, input.question, outputLimit);
    },
  };
}

// Stored rows discover candidate identities only. Every body used below comes from a fresh
// same-chat Feishu read; neither a cache hit nor an old reply link grants access to content.
async function loadHistoricalMessages({ reader, queryable, chatId, question, query, budget, candidateLimit }: {
  reader: FeishuChatHistoryReader;
  queryable: Queryable;
  chatId: string;
  question: string;
  query: NonNullable<ReturnType<typeof resolveHistoricalChatQuery>>;
  budget: { candidates: number; parents: number; attempted: Set<string> };
  candidateLimit: number;
}): Promise<{ messages: FeishuChatHistoryMessage[]; revalidatedIds: string[] }> {
  const candidateIds = query.terms.length === 0 || candidateLimit === 0 || reader.readMessagesByIds === undefined ? [] :
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
         AND NOT (m.provider_message_id = ANY($7::text[]))
       ORDER BY CASE WHEN LENGTH(m.text) > 500 THEN 0 WHEN m.text ~ '@_user_|[?？]' THEN 2 ELSE 1 END,
                (SELECT COUNT(*) FROM UNNEST($4::text[]) term WHERE STRPOS(LOWER(m.text), term) > 0) DESC,
                m.sent_at DESC, m.provider_message_id ASC
       LIMIT $6`,
      [chatId, query.start, query.end, query.terms, question.trim().toLowerCase(), candidateLimit, [...budget.attempted]],
    )).rows.map(row => row.provider_message_id).filter(id => typeof id === "string" && id.length > 0 && !budget.attempted.has(id)).slice(0, candidateLimit);
  budget.candidates -= candidateIds.length;
  const previouslyAttempted = new Set(budget.attempted);
  candidateIds.forEach(id => budget.attempted.add(id));
  const [dayMessages, candidates] = await Promise.all([
    reader.listRecentMessages({ chatId, limit: MAX_LIVE_CHAT_SCAN_LIMIT, timeRange: { start: query.start, end: query.end } }),
    candidateIds.length === 0 ? [] : reader.readMessagesByIds!({ chatId, messageIds: candidateIds }),
  ]);
  const isInScope = (message: FeishuChatHistoryMessage) => message.chatId === chatId
    && message.sentAt >= query.start && message.sentAt < query.end;
  const byId = new Map<string, FeishuChatHistoryMessage>();
  // A by-ID denial/deletion (omitted result) supersedes any earlier list body for that ID.
  for (const message of [
    ...dayMessages.slice(0, MAX_LIVE_CHAT_SCAN_LIMIT).filter(message => !budget.attempted.has(message.messageId)),
    ...candidates.slice(0, candidateLimit).filter(message => candidateIds.includes(message.messageId)),
  ]) {
    if (isInScope(message)) byId.set(message.messageId, message);
  }
  const ordered = [...byId.values()].sort((left, right) => left.sentAt.getTime() - right.sentAt.getTime());
  // A matching label can be older than many questions repeating the same topic. Resolve its
  // declared parent before selection: without the parent it cannot yet win reply-linked ranking.
  const selected = query.terms.length === 0 ? ordered.slice(-8).reverse()
    : ordered.slice().reverse().filter(message => query.terms.some(term => message.text.toLowerCase().includes(term)));
  const parentIds = [...new Set(selected.flatMap(message => [message.parentMessageId, message.rootMessageId]))]
    .filter((id): id is string => id !== undefined && !byId.has(id) && !budget.attempted.has(id)).slice(0, budget.parents);
  if (parentIds.length > 0 && reader.readMessagesByIds !== undefined) {
    budget.parents -= parentIds.length;
    parentIds.forEach(id => budget.attempted.add(id));
    const parents = await reader.readMessagesByIds({ chatId, messageIds: parentIds });
    for (const message of parents.slice(0, 8)) {
      if (parentIds.includes(message.messageId) && isInScope(message)) byId.set(message.messageId, message);
    }
  }
  return { messages: [...byId.values()].sort((left, right) => right.sentAt.getTime() - left.sentAt.getTime()),
    revalidatedIds: [...budget.attempted].filter(id => !previouslyAttempted.has(id)),
  };
}

function formatHistoricalTime(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

const DEFAULT_LIVE_CHAT_LIMIT = 20;
const MAX_LIVE_CHAT_LIMIT = 20;
const LIVE_CHAT_SCAN_MULTIPLIER = 3;
const MAX_LIVE_CHAT_SCAN_LIMIT = 100;
const MAX_SELECTION_TOPIC_TERMS = 24;

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
