import type { RuntimeController } from "../admin/runtime-controller.js";
import type { FeishuBotChatAccessChecker } from "../feishu/feishu-bot-chat-access-checker.js";
import type { FeishuChatHistoryReader } from "../feishu/feishu-chat-history-reader.js";
import { hashSharedChatText, MAX_SHARED_CHAT_SOURCE_BINDINGS, normalizeSharedChatSourceBinding,
  type SharedChatSourceBinding, type SharedChatSourceVerifier, type WorkingChatScopeRepository } from "./working-chat-scope.js";

export function createSharedChatSourceVerifier({ scopes, reader, botAccessChecker, runtimeController }: {
  scopes: Pick<WorkingChatScopeRepository, "validateExact">;
  reader: FeishuChatHistoryReader;
  botAccessChecker: Pick<FeishuBotChatAccessChecker, "canAccessChat">;
  runtimeController: Pick<RuntimeController, "canReadGroupContext" | "canReplyWhenMentioned">;
}): SharedChatSourceVerifier {
  return { async verify({ chatId, sources }) {
    try {
      if (!Array.isArray(sources) || sources.length > MAX_SHARED_CHAT_SOURCE_BINDINGS) return false;
      if (sources.length === 0) return true;
      if (reader.readMessagesByIds === undefined) return false;
      const normalized: SharedChatSourceBinding[] = [];
      const identities = new Map<string, string>();
      for (const value of sources) {
        const source = normalizeSharedChatSourceBinding(value);
        if (source.destinationChatId !== chatId) return false;
        const identity = JSON.stringify(source);
        const prior = identities.get(source.messageId);
        if (prior !== undefined && prior !== identity) return false;
        if (prior === undefined) normalized.push(source);
        identities.set(source.messageId, identity);
      }
      const groupIds = [...new Set([chatId, ...normalized.map(source => source.sourceChatId)])];
      const localAllowed = () => runtimeController.canReplyWhenMentioned(chatId)
        && groupIds.every(groupId => runtimeController.canReadGroupContext(groupId));
      if (!localAllowed()) return false;
      for (const source of normalized) if (!await scopes.validateExact(source)) return false;
      for (const groupId of groupIds) if (!await botAccessChecker.canAccessChat({ chatId: groupId })) return false;
      for (const groupId of groupIds.filter(groupId => groupId !== chatId)) {
        const groupSources = normalized.filter(source => source.sourceChatId === groupId);
        for (let offset = 0; offset < groupSources.length; offset += 8) {
          const batch = groupSources.slice(offset, offset + 8);
          const messages = await reader.readMessagesByIds({ chatId: groupId, messageIds: batch.map(source => source.messageId) });
          if (messages.length !== batch.length || new Set(messages.map(message => message.messageId)).size !== batch.length) return false;
          for (const source of batch) {
            const message = messages.find(message => message.messageId === source.messageId);
            if (message === undefined || message.chatId !== groupId || message.role === "assistant"
              || hashSharedChatText(message.text) !== source.contentHash) return false;
          }
        }
      }
      // Catch local revocations/deletions that arrived during Feishu I/O.
      for (const source of normalized) if (!await scopes.validateExact(source)) return false;
      return localAllowed();
    } catch { return false; }
  } };
}
