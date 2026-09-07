import type { ConversationMessageRepository } from "../conversation/conversation-message-repository.js";
import type { Queryable } from "../documents/document-fragment-repository.js";
import type { FeishuChatHistoryReader } from "../feishu/feishu-chat-history-reader.js";
import type { LiveChatMessage } from "./context-assembly.js";
import { selectTopicAwareChatWindow } from "./topic-aware-chat-window.js";

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
}: {
  reader: FeishuChatHistoryReader;
  queryable: Queryable;
}): LiveChatContextProvider {
  return {
    async loadRecentMessages(input) {
      const outputLimit = sanitizeLimit(input.limit);
      if (outputLimit <= 0) {
        return [];
      }

      const messages = (await reader.listRecentMessages({
        chatId: input.chatId,
        limit: MAX_LIVE_CHAT_SCAN_LIMIT,
      }))
        .filter((message) => message.chatId === input.chatId)
        .slice(0, MAX_LIVE_CHAT_SCAN_LIMIT);
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
          text: message.text,
          messageId: message.messageId,
          ...(message.parentMessageId === undefined ? {} : { parentMessageId: message.parentMessageId }),
          ...(message.rootMessageId === undefined ? {} : { rootMessageId: message.rootMessageId }),
        }));
      return selectTopicAwareChatWindow(readableMessages, input.question, outputLimit);
    },
  };
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
