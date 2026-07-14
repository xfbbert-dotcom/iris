import type { ConversationMessage } from "../conversation/conversation-message-repository.js";
import {
  createMemoryExtractionJob,
  type MemoryExtractionQueue,
} from "./memory-extraction-queue.js";
import type { MemoryExtractionRepository } from "./memory-extraction-repository.js";

export interface MemoryExtractionPlanner {
  registerMessage(message: ConversationMessage): Promise<void>;
}

type MemoryExtractionRuntimeGate = {
  canProcessIncomingEvent(input: { groupId?: string }): boolean;
  canReadGroupContext(groupId: string): boolean;
};

export function createMemoryExtractionPlanner(input: {
  repository: Pick<MemoryExtractionRepository, "registerRequest">;
  queue: Pick<MemoryExtractionQueue, "enqueue">;
  runtimeController: MemoryExtractionRuntimeGate;
  irisBotOpenId?: string;
  now?: () => Date;
}): MemoryExtractionPlanner {
  return {
    async registerMessage(message) {
      if (message.text === undefined || message.text.trim().length === 0) {
        return;
      }
      if (shouldExcludeForBotIdentity(message.senderId, input.irisBotOpenId)) {
        return;
      }
      if (!input.runtimeController.canProcessIncomingEvent({ groupId: message.chatId })) {
        return;
      }
      if (!input.runtimeController.canReadGroupContext(message.chatId)) {
        return;
      }

      const result = await input.repository.registerRequest({
        groupId: message.chatId,
        conversationMessageId: message.id,
        providerMessageId: message.providerMessageId,
      });
      await input.queue.enqueue(
        createMemoryExtractionJob({
          requestId: result.request.id,
          groupId: message.chatId,
          now: (input.now ?? (() => new Date()))(),
        }),
      );
    },
  };
}

function shouldExcludeForBotIdentity(
  senderId: string | undefined,
  irisBotOpenId: string | undefined,
): boolean {
  if (irisBotOpenId === undefined) {
    return false;
  }

  const normalizedBotOpenId = irisBotOpenId.trim();
  const normalizedSenderId = senderId?.trim();
  return (
    normalizedBotOpenId.length === 0 ||
    normalizedSenderId === undefined ||
    normalizedSenderId.length === 0 ||
    normalizedSenderId === normalizedBotOpenId
  );
}
