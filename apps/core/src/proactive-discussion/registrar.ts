import type { ConversationMessage } from "../conversation/conversation-message-repository.js";
import { hashLocalMessageText } from "../memory/local-message-source.js";
import { PD_PILOT_CHAT } from "./contracts.js";
import { parsePdFeedback, removePdFeedbackMention } from "./feedback.js";
import type { PdRepository } from "./repository.js";

export type PdRegistrar = {
  registerMessage(input: {
    conversationMessage: ConversationMessage;
    senderType: "user" | "app" | "unknown";
    parentMessageId?: string;
    rootMessageId?: string;
    mentionedIris: boolean;
  }): Promise<void>;
};

export function createPdRegistrar({ repository, botOpenId, now }: {
  repository: Pick<PdRepository, "register" | "readState">;
  botOpenId: string;
  now: () => Date;
}): PdRegistrar {
  return {
    async registerMessage(input) {
      const { conversationMessage: message } = input;
      if (
        input.senderType !== "user"
        || message.chatId !== PD_PILOT_CHAT
        || message.senderOpenId === botOpenId
        || typeof message.text !== "string"
        || message.text.trim().length === 0
      ) return;

      const irisMentionKey = findIrisMentionPrefix({
        text: message.text,
        mentions: message.mentions ?? [],
        botOpenId,
        mentionedIris: input.mentionedIris,
      });
      const feedbackAction = parsePdFeedback(removePdFeedbackMention(message.text, irisMentionKey));
      const replyMessageId = input.parentMessageId ?? input.rootMessageId;
      let feedback: {
        action: "pause" | "resume";
        replyMessageId: string;
        actorOpenId: string;
        irisMentionKey?: string;
      } | undefined;
      if (
        feedbackAction !== null
        && replyMessageId !== undefined
        && message.senderOpenId !== undefined
      ) {
        feedback = { action: feedbackAction, replyMessageId, actorOpenId: message.senderOpenId,
          ...(irisMentionKey === undefined ? {} : { irisMentionKey }) };
      }
      if (feedbackAction !== null && feedback === undefined) return;
      if (input.mentionedIris && feedback === undefined) return;

      const state = await repository.readState(message.chatId);
      if (
        state.policy === null
        || !state.policy.enabled
        || state.policy.chatId !== message.chatId
      ) return;

      await repository.register({
        chatId: message.chatId,
        messageId: message.providerMessageId,
        contentHash: hashLocalMessageText(message.text),
        policyVersion: state.policy.version,
        purpose: feedback === undefined ? "assessment" : "feedback",
        ...(feedback === undefined ? {} : { feedback }),
        at: now(),
      });
    },
  };
}

function findIrisMentionPrefix(input: {
  text: string;
  mentions: readonly { key: string; openId: string }[];
  botOpenId: string;
  mentionedIris: boolean;
}): string | undefined {
  if (!input.mentionedIris) return undefined;
  const keys = input.mentions
    .filter((mention) => mention.openId === input.botOpenId)
    .map((mention) => mention.key)
    .sort((left, right) => right.length - left.length);
  for (const key of keys) {
    if (removePdFeedbackMention(input.text, key) !== input.text) return key;
  }
  return undefined;
}
