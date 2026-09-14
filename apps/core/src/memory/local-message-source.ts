import { createHash } from "node:crypto";
import type { FeishuChatHistoryReader } from "../feishu/feishu-chat-history-reader.js";

export type LocalMessageSourceBinding = { chatId: string; messageId: string; contentHash: string };

export interface LocalMessageSourceVerifier {
  verify(input: {
    chatId: string;
    sources: readonly LocalMessageSourceBinding[];
  }): Promise<boolean>;
}

// Live bindings hash the entire readable body. A stored/truncated event body hash is
// only suitable for registration and must not be presented as the live body identity.
export function hashLocalMessageText(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/gu, "\n"), "utf8").digest("hex");
}

const MAX_MESSAGE_IDS_PER_READ = 8;

export function createLocalMessageSourceVerifier({ reader, canReadGroup }: {
  reader: FeishuChatHistoryReader;
  canReadGroup: (chatId: string) => boolean;
}): LocalMessageSourceVerifier {
  return {
    async verify({ chatId, sources }) {
      if (!canReadGroup(chatId)) return false;
      if (sources.some((source) => (
        source.chatId !== chatId
        || typeof source.messageId !== "string"
        || source.messageId.length === 0
        || !/^[a-f0-9]{64}$/u.test(source.contentHash)
      ))) return false;
      if (sources.length > 0 && reader.readMessagesByIds === undefined) return false;

      try {
        const expectedById = new Map<string, string>();
        for (const source of sources) {
          const previousHash = expectedById.get(source.messageId);
          if (previousHash !== undefined && previousHash !== source.contentHash) return false;
          expectedById.set(source.messageId, source.contentHash);
        }

        const verifiedIds = new Set<string>();
        const messageIds = [...expectedById.keys()];
        for (let offset = 0; offset < messageIds.length; offset += MAX_MESSAGE_IDS_PER_READ) {
          const requestedIds = messageIds.slice(offset, offset + MAX_MESSAGE_IDS_PER_READ);
          const requested = new Set(requestedIds);
          const messages = await reader.readMessagesByIds!({ chatId, messageIds: requestedIds, sender: "user" });
          for (const message of messages) {
            if (
              !requested.has(message.messageId)
              || verifiedIds.has(message.messageId)
              || message.chatId !== chatId
              || message.role === "assistant"
              || hashLocalMessageText(message.text) !== expectedById.get(message.messageId)
            ) return false;
            verifiedIds.add(message.messageId);
          }
        }
        return verifiedIds.size === expectedById.size && canReadGroup(chatId);
      } catch {
        return false;
      }
    },
  };
}
