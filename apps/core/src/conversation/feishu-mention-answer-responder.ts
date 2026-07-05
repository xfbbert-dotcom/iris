import { createHash } from "node:crypto";

import type { AnswerDraftOrchestrator } from "../agent/answer-draft-orchestrator.js";
import type { FeishuMessageReplier } from "../feishu/feishu-message-replier.js";

export type FeishuMessageMention = {
  key: string;
  openId?: string;
  name?: string;
};

export type FeishuMentionAnswerInput = {
  messageId: string;
  chatId: string;
  senderId?: string;
  text?: string;
  mentions: FeishuMessageMention[];
};

export type FeishuMentionAnswerResult =
  | { status: "replied"; replyMessageId?: string }
  | {
      status: "skipped";
      reason: "not_mentioned" | "runtime_disabled" | "self_message" | "duplicate_message";
    };

export type FeishuMentionAnswerResponder = {
  maybeRespond(input: FeishuMentionAnswerInput): Promise<FeishuMentionAnswerResult>;
};

export type FeishuMentionAnswerResponderDependencies = {
  botOpenId: string;
  answerDraftOrchestrator: Pick<AnswerDraftOrchestrator, "generateDraft">;
  replier: Pick<FeishuMessageReplier, "replyText">;
  canReplyWhenMentioned?: (chatId: string) => boolean;
};

const BLANK_MENTION_CLARIFICATION = "我在，直接告诉我你想让我处理什么。";
const MAX_MENTION_QUESTION_CHARS = 4000;
const MAX_RECENT_REPLY_MESSAGE_IDS = 1000;
const TRUNCATION_MARKER = " ... [truncated]";

export function createFeishuMentionAnswerResponder({
  botOpenId,
  answerDraftOrchestrator,
  replier,
  canReplyWhenMentioned = () => true,
}: FeishuMentionAnswerResponderDependencies): FeishuMentionAnswerResponder {
  const normalizedBotOpenId = normalizeRequiredOpenId(botOpenId);
  const replyDeduper = new RecentReplyDeduper(MAX_RECENT_REPLY_MESSAGE_IDS);

  return {
    async maybeRespond(input) {
      const botMentionKeys = collectBotMentionKeys(input.mentions, normalizedBotOpenId);
      if (botMentionKeys.length === 0) {
        return { status: "skipped", reason: "not_mentioned" };
      }
      if (normalizeOptionalText(input.senderId) === normalizedBotOpenId) {
        return { status: "skipped", reason: "self_message" };
      }
      if (!canReplyWhenMentioned(input.chatId)) {
        return { status: "skipped", reason: "runtime_disabled" };
      }

      if (!replyDeduper.tryClaim(input.messageId)) {
        return { status: "skipped", reason: "duplicate_message" };
      }

      try {
        const question = truncateQuestion(stripMentionKeys(input.text ?? "", botMentionKeys));
        const replyUuid = createReplyUuid(input.messageId);
        if (question.length === 0) {
          const result = toRepliedResult(
            await replier.replyText({
              messageId: input.messageId,
              text: BLANK_MENTION_CLARIFICATION,
              replyInThread: true,
              uuid: replyUuid,
            }),
          );
          replyDeduper.markReplied(input.messageId);
          return result;
        }

        const answer = await answerDraftOrchestrator.generateDraft({
          question,
          chatId: input.chatId,
          liveChatMessages: [
            {
              speaker: normalizeOptionalText(input.senderId) ?? "unknown",
              text: question,
            },
          ],
        });

        const result = toRepliedResult(
          await replier.replyText({
            messageId: input.messageId,
            text: answer.answerText,
            replyInThread: true,
            uuid: replyUuid,
          }),
        );
        replyDeduper.markReplied(input.messageId);
        return result;
      } catch (error) {
        replyDeduper.release(input.messageId);
        throw error;
      }
    },
  };
}

class RecentReplyDeduper {
  private readonly inFlightMessageIds = new Set<string>();
  private readonly repliedMessageIds = new Set<string>();
  private readonly repliedMessageIdOrder: string[] = [];

  constructor(private readonly maxRepliedMessageIds: number) {}

  tryClaim(messageId: string): boolean {
    if (this.inFlightMessageIds.has(messageId) || this.repliedMessageIds.has(messageId)) {
      return false;
    }

    this.inFlightMessageIds.add(messageId);
    return true;
  }

  markReplied(messageId: string): void {
    this.inFlightMessageIds.delete(messageId);
    if (this.repliedMessageIds.has(messageId)) {
      return;
    }

    this.repliedMessageIds.add(messageId);
    this.repliedMessageIdOrder.push(messageId);
    while (this.repliedMessageIdOrder.length > this.maxRepliedMessageIds) {
      const expiredMessageId = this.repliedMessageIdOrder.shift();
      if (expiredMessageId !== undefined) {
        this.repliedMessageIds.delete(expiredMessageId);
      }
    }
  }

  release(messageId: string): void {
    this.inFlightMessageIds.delete(messageId);
  }
}

function collectBotMentionKeys(
  mentions: FeishuMessageMention[],
  botOpenId: string,
): string[] {
  const keys = new Set<string>();
  for (const mention of mentions) {
    const openId = normalizeOptionalText(mention.openId);
    const key = normalizeOptionalText(mention.key);
    if (openId === botOpenId && key !== undefined) {
      keys.add(key);
    }
  }

  return [...keys].sort((left, right) => right.length - left.length);
}

function stripMentionKeys(text: string, mentionKeys: string[]): string {
  let question = text;
  for (const key of mentionKeys) {
    question = question.replaceAll(key, " ");
  }

  return question.replace(/\s+/gu, " ").trim();
}

function truncateQuestion(value: string): string {
  if (value.length <= MAX_MENTION_QUESTION_CHARS) {
    return value;
  }

  const prefixChars = MAX_MENTION_QUESTION_CHARS - TRUNCATION_MARKER.length;
  return `${value.slice(0, prefixChars).trimEnd()}${TRUNCATION_MARKER}`;
}

function createReplyUuid(messageId: string): string {
  const digest = createHash("sha256").update(messageId).digest("hex");
  return `iris-${digest.slice(0, 45)}`;
}

function toRepliedResult(result: { replyMessageId?: string }): FeishuMentionAnswerResult {
  return {
    status: "replied",
    ...(result.replyMessageId === undefined ? {} : { replyMessageId: result.replyMessageId }),
  };
}

function normalizeRequiredOpenId(value: string): string {
  const normalized = normalizeOptionalText(value);
  if (normalized === undefined) {
    throw new Error("botOpenId must not be blank");
  }

  return normalized;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
