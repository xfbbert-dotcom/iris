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
      const messages = await repository.listRecentByChat({
        chatId: input.chatId,
        limit: sanitizeLimit(input.limit),
      });

      return messages
        .slice()
        .reverse()
        .filter((message) => typeof message.text === "string" && message.text.trim().length > 0)
        .map((message) => ({
          speaker: message.senderId ?? "unknown",
          text: message.text!.trim(),
        }));
    },
  };
}

function sanitizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 20;
  }

  return Math.max(0, Math.floor(value));
}
