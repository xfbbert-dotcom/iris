import type { ConversationMessageRepository } from "../conversation/conversation-message-repository.js";
import type { LiveChatMessage } from "./context-assembly.js";

export type LiveChatContextProvider = {
  loadRecentMessages(input: { chatId: string; limit?: number }): Promise<LiveChatMessage[]>;
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
