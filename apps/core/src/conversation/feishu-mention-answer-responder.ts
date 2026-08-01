import { createHash } from "node:crypto";

import type { AnswerDraftOrchestrator } from "../agent/answer-draft-orchestrator.js";
import type { RegisterUserSubmittedDocumentInput } from "../documents/document-source-registry.js";
import type { FeishuDocumentLinkExtractor } from "../documents/feishu-document-link-extractor.js";
import type { FeishuMessageReplier } from "../feishu/feishu-message-replier.js";
import type { ChatKnowledgeDraftCommand } from "../knowledge-governance/chat-knowledge-draft-command.js";
import { ChatKnowledgeDraftModelUnavailableError } from "../knowledge-governance/chat-knowledge-draft-generator.js";
import {
  ModelProviderHttpError,
  isModelProviderCapacityError,
} from "../model/model-provider-error.js";

export type FeishuMessageMention = {
  key: string;
  openId?: string;
  name?: string;
};

export type FeishuMentionAnswerInput = {
  messageId: string;
  chatId: string;
  senderId?: string;
  senderOpenId?: string;
  text?: string;
  mentions: FeishuMessageMention[];
  observedAt?: Date;
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
  canRegisterUserSubmittedDocuments?: (chatId: string) => boolean;
  knowledgeDraftCommand?: Pick<ChatKnowledgeDraftCommand, "execute">;
  documentLinkExtractor?: Pick<FeishuDocumentLinkExtractor, "extractLinks">;
  userSubmittedDocumentRegistrar?: Pick<
    UserSubmittedDocumentRegistrar,
    "registerUserSubmittedDocument"
  >;
};

type UserSubmittedDocumentRegistrar = {
  registerUserSubmittedDocument(input: RegisterUserSubmittedDocumentInput): Promise<unknown>;
};

const BLANK_MENTION_CLARIFICATION = "我在，直接告诉我你想让我处理什么。";
const UNREADABLE_MENTION_CLARIFICATION =
  "我看到了你的 @Iris，但没读到可处理的文字内容。请用文字重新发给我一次。";
const BLANK_MODEL_ANSWER_FALLBACK = "我没拿到可用答案，你可以换个说法再问我一次。";
const MODEL_CAPACITY_FALLBACK =
  "模型服务暂时达到使用上限，我现在无法可靠回答。恢复后，请再 @我一次。";
const BLANK_MODEL_ANSWER_ERROR_MESSAGE = "model answer draft must not be blank";
const MAX_MENTION_QUESTION_CHARS = 4000;
const MAX_RECENT_REPLY_MESSAGE_IDS = 1000;
const TRUNCATION_MARKER = " ... [truncated]";
const USER_SUBMITTED_DOCUMENT_CONFIRMATION =
  "\u5df2\u6536\u5230\u8fd9\u4e2a\u6587\u6863\uff0c\u6211\u4f1a\u540c\u6b65\u5b83\u7684\u5185\u5bb9\u3002\u540c\u6b65\u5b8c\u6210\u540e\uff0c\u4f60\u53ef\u4ee5\u76f4\u63a5 @\u6211\u63d0\u95ee\u3002";
const USER_SUBMITTED_DOCUMENT_LINK_REQUIRED =
  "\u8bf7\u53d1\u9001\u4e00\u4e2a\u6211\u53ef\u4ee5\u8bfb\u53d6\u7684\u98de\u4e66\u6587\u6863\u94fe\u63a5\uff0c\u7136\u540e\u518d\u8ba9\u6211\u6536\u5f55\u3002";
const USER_SUBMITTED_DOCUMENT_DISABLED =
  "\u5f53\u524d\u6587\u6863\u8bfb\u53d6\u80fd\u529b\u5df2\u5173\u95ed\uff0c\u6211\u4e0d\u4f1a\u6536\u5f55\u8fd9\u4e2a\u6587\u6863\u3002";
const USER_SUBMITTED_DOCUMENT_SENDER_REQUIRED =
  "\u6211\u6682\u65f6\u65e0\u6cd5\u786e\u8ba4\u63d0\u4ea4\u4eba\uff0c\u4e0d\u80fd\u6536\u5f55\u8fd9\u4e2a\u6587\u6863\u3002";
const KNOWLEDGE_DRAFT_CREATED =
  "\u77e5\u8bc6\u8349\u7a3f\u5df2\u751f\u6210\uff0c\u7fa4\u786e\u8ba4\u5361\u7247\u6b63\u5728\u53d1\u9001\u3002\u5f53\u524d\u5c1a\u672a\u5199\u5165\u77e5\u8bc6\u5e93\u3002";
const KNOWLEDGE_DRAFT_RUNTIME_DISABLED =
  "\u5f53\u524d\u77e5\u8bc6\u8349\u7a3f\u529f\u80fd\u672a\u5f00\u653e\uff0c\u672a\u521b\u5efa\u8349\u7a3f\uff0c\u4e5f\u672a\u5199\u5165\u77e5\u8bc6\u5e93\u3002";
const KNOWLEDGE_DRAFT_NO_CONTEXT =
  "\u6700\u8fd1\u6ca1\u6709\u53ef\u6574\u7406\u7684\u7fa4\u804a\u5185\u5bb9\uff0c\u672a\u521b\u5efa\u77e5\u8bc6\u8349\u7a3f\u3002";
const KNOWLEDGE_DRAFT_TARGET_UNAVAILABLE =
  "\u5f53\u524d\u7fa4\u5c1a\u672a\u914d\u7f6e\u552f\u4e00\u7684\u77e5\u8bc6\u5e93\u53d1\u5e03\u4f4d\u7f6e\uff0c\u672a\u521b\u5efa\u77e5\u8bc6\u8349\u7a3f\u3002";
const KNOWLEDGE_DRAFT_SENDER_REQUIRED =
  "\u6682\u65f6\u65e0\u6cd5\u786e\u8ba4\u8bf7\u6c42\u4eba\uff0c\u672a\u521b\u5efa\u77e5\u8bc6\u8349\u7a3f\u3002";
const KNOWLEDGE_DRAFT_MODEL_CAPACITY =
  "\u6a21\u578b\u670d\u52a1\u6682\u65f6\u8fbe\u5230\u4f7f\u7528\u4e0a\u9650\uff0c\u672a\u521b\u5efa\u77e5\u8bc6\u8349\u7a3f\u3002\u6062\u590d\u540e\u8bf7\u518d @\u6211\u4e00\u6b21\u3002";
const KNOWLEDGE_DRAFT_MODEL_INVALID =
  "\u672a\u751f\u6210\u53ef\u9760\u7684\u77e5\u8bc6\u8349\u7a3f\uff0c\u6ca1\u6709\u521b\u5efa\u6216\u53d1\u5e03\u4efb\u4f55\u5185\u5bb9\u3002";
const KNOWLEDGE_DRAFT_MODEL_UNAVAILABLE =
  "\u6a21\u578b\u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u672a\u521b\u5efa\u77e5\u8bc6\u8349\u7a3f\u3002\u8bf7\u7a0d\u540e\u518d @\u6211\u4e00\u6b21\u3002";
const KNOWLEDGE_DRAFT_MODEL_INVALID_ERROR_MESSAGE =
  "knowledge draft model response is invalid";
const knowledgeDraftIntentPatterns = [
  /(?:\u521b\u5efa|\u751f\u6210|\u4ea7\u51fa|\u5236\u4f5c|\u51c6\u5907|\u6574\u7406|\u603b\u7ed3).{0,16}(?:\u4e00\u4efd|\u4e00\u4e2a)?(?:\u53ef\u5ba1\u9605\u7684)?\u77e5\u8bc6\u8349\u7a3f/u,
  /(?:\u628a|\u5c06).{0,48}(?:\u6574\u7406|\u603b\u7ed3|\u6c89\u6dc0)(?:\u6210|\u4e3a).{0,4}\u77e5\u8bc6\u8349\u7a3f/u,
  /(?:\u5f52\u6863|\u6c89\u6dc0|\u6574\u7406|\u603b\u7ed3).{0,12}(?:\u5230|\u8fdb|\u4e3a)(?:\u98de\u4e66)?\u77e5\u8bc6\u5e93/u,
  /\b(?:create|make|prepare|generate)\s+(?:a\s+)?knowledge\s+draft\b/iu,
  /\b(?:archive|capture|save)\b.{0,64}\bknowledge\s*base\b/iu,
] as const;
const negatedKnowledgeDraftIntentPatterns = [
  /(?:\u4e0d\u8981|\u522b|\u65e0\u9700|\u4e0d\u7528|\u7981\u6b62|\u53d6\u6d88).{0,20}(?:\u521b\u5efa|\u751f\u6210|\u4ea7\u51fa|\u5236\u4f5c|\u51c6\u5907|\u6574\u7406|\u603b\u7ed3|\u5f52\u6863|\u6c89\u6dc0)/u,
  /\b(?:do\s+not|don't|dont|never)\b.{0,32}\b(?:create|make|prepare|generate|archive|capture|save)\b/iu,
] as const;
const knowledgeDraftQuestionPatterns = [
  /^(?:\u5982\u4f55|\u600e\u4e48|\u600e\u6837|\u4e3a\u4ec0\u4e48|\u4f55\u65f6|\u54ea\u91cc|\u5728\u54ea).{0,64}(?:\u77e5\u8bc6\u8349\u7a3f|\u77e5\u8bc6\u5e93)/u,
  /(?:\u521b\u5efa|\u751f\u6210|\u4ea7\u51fa|\u5236\u4f5c|\u51c6\u5907|\u6574\u7406|\u603b\u7ed3).{0,16}\u77e5\u8bc6\u8349\u7a3f.{0,20}(?:\u9700\u8981\u4ec0\u4e48|\u600e\u4e48|\u5982\u4f55|\u4ec0\u4e48\u6d41\u7a0b|\u54ea\u4e9b\u6b65\u9aa4|\u6709\u4ec0\u4e48\u8981\u6c42)[\uff1f?]?$/u,
  /^(?:how|what|why|when|where)\b.{0,80}\bknowledge\s+draft\b/iu,
  /^(?:can|could|should|would)\s+i\b.{0,80}\bknowledge\s+draft\b/iu,
] as const;
const userSubmittedDocumentIntentPatterns = [
  /\b(?:add|submit|register|index)\s+(?:this\s+)?(?:feishu\s+)?doc(?:ument)?\b/iu,
  /\bread\s+(?:this\s+)?(?:feishu\s+)?doc(?:ument)?\b/iu,
  /(?:\u8bf7(?:\u4f60)?|\u5e2e\u6211|\u5e2e\u5fd9|\u9ebb\u70e6(?:\u4f60)?)\s*(?:\u63d0\u4ea4|\u6536\u5f55|\u8bfb\u53d6|\u540c\u6b65|\u5b66\u4e60|\u8bb0\u4f4f)(?:\u8fd9\u4e2a|\u8fd9\u4efd)?\u6587\u6863/u,
  /(?:^|\s)(?:\u63d0\u4ea4|\u6536\u5f55|\u8bfb\u53d6|\u540c\u6b65|\u5b66\u4e60|\u8bb0\u4f4f)(?:\u8fd9\u4e2a|\u8fd9\u4efd)\u6587\u6863(?:\s|$|[\uff0c\u3002\uff01\uff1f,.!?])/u,
] as const;

export function createFeishuMentionAnswerResponder({
  botOpenId,
  answerDraftOrchestrator,
  replier,
  canReplyWhenMentioned = () => true,
  canRegisterUserSubmittedDocuments = () => true,
  knowledgeDraftCommand,
  documentLinkExtractor,
  userSubmittedDocumentRegistrar,
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
      if (!replyDeduper.tryClaim(input.messageId)) {
        return { status: "skipped", reason: "duplicate_message" };
      }

      try {
        if (!canReplyWhenMentioned(input.chatId)) {
          replyDeduper.markHandled(input.messageId);
          return { status: "skipped", reason: "runtime_disabled" };
        }

        const replyUuid = createReplyUuid(input.messageId);
        if (input.text === undefined) {
          const result = toRepliedResult(
            await replier.replyText({
              messageId: input.messageId,
              text: UNREADABLE_MENTION_CLARIFICATION,
              replyInThread: true,
              uuid: replyUuid,
            }),
          );
          replyDeduper.markHandled(input.messageId);
          return result;
        }

        const fullQuestion = stripMentionKeys(input.text, botMentionKeys);
        const normalizedSenderId = normalizeOptionalText(input.senderId);
        const normalizedSenderOpenId = normalizeOptionalText(input.senderOpenId);
        if (detectKnowledgeDraftCommand(fullQuestion)) {
          let replyText: string;
          if (knowledgeDraftCommand === undefined) {
            replyText = KNOWLEDGE_DRAFT_RUNTIME_DISABLED;
          } else if (normalizedSenderOpenId === undefined) {
            replyText = KNOWLEDGE_DRAFT_SENDER_REQUIRED;
          } else {
            try {
              const commandResult = await knowledgeDraftCommand.execute({
                messageId: input.messageId,
                chatId: input.chatId,
                requesterOpenId: normalizedSenderOpenId,
                requestText: fullQuestion,
                observedAt: input.observedAt ?? new Date(),
              });
              replyText = knowledgeDraftReplyText(commandResult.status);
            } catch (error) {
              if (isKnowledgeDraftModelCapacityError(error)) {
                replyText = KNOWLEDGE_DRAFT_MODEL_CAPACITY;
              } else if (isInvalidKnowledgeDraftModelResponse(error)) {
                replyText = KNOWLEDGE_DRAFT_MODEL_INVALID;
              } else if (isKnowledgeDraftModelUnavailableError(error)) {
                replyText = KNOWLEDGE_DRAFT_MODEL_UNAVAILABLE;
              } else {
                throw error;
              }
            }
          }
          const result = toRepliedResult(
            await replier.replyText({
              messageId: input.messageId,
              text: replyText,
              replyInThread: true,
              uuid: replyUuid,
            }),
          );
          replyDeduper.markHandled(input.messageId);
          return result;
        }

        const userSubmittedDocumentCommand = detectUserSubmittedDocumentCommand({
          text: fullQuestion,
          documentLinkExtractor,
        });
        if (userSubmittedDocumentCommand.intent) {
          if (documentLinkExtractor === undefined || userSubmittedDocumentRegistrar === undefined) {
            const result = toRepliedResult(
              await replier.replyText({
                messageId: input.messageId,
                text: USER_SUBMITTED_DOCUMENT_DISABLED,
                replyInThread: true,
                uuid: replyUuid,
              }),
            );
            replyDeduper.markHandled(input.messageId);
            return result;
          }
          if (!canRegisterUserSubmittedDocuments(input.chatId)) {
            const result = toRepliedResult(
              await replier.replyText({
                messageId: input.messageId,
                text: USER_SUBMITTED_DOCUMENT_DISABLED,
                replyInThread: true,
                uuid: replyUuid,
              }),
            );
            replyDeduper.markHandled(input.messageId);
            return result;
          }
          if (userSubmittedDocumentCommand.sourceUri === undefined) {
            const result = toRepliedResult(
              await replier.replyText({
                messageId: input.messageId,
                text: USER_SUBMITTED_DOCUMENT_LINK_REQUIRED,
                replyInThread: true,
                uuid: replyUuid,
              }),
            );
            replyDeduper.markHandled(input.messageId);
            return result;
          }
          if (normalizedSenderId === undefined) {
            const result = toRepliedResult(
              await replier.replyText({
                messageId: input.messageId,
                text: USER_SUBMITTED_DOCUMENT_SENDER_REQUIRED,
                replyInThread: true,
                uuid: replyUuid,
              }),
            );
            replyDeduper.markHandled(input.messageId);
            return result;
          }

          await userSubmittedDocumentRegistrar.registerUserSubmittedDocument({
            sourceUri: userSubmittedDocumentCommand.sourceUri,
            submittedByUserId: normalizedSenderId,
            submissionGroupId: input.chatId,
            submissionMessageId: input.messageId,
            observedAt: input.observedAt ?? new Date(),
          });
          const result = toRepliedResult(
            await replier.replyText({
              messageId: input.messageId,
              text: USER_SUBMITTED_DOCUMENT_CONFIRMATION,
              replyInThread: true,
              uuid: replyUuid,
            }),
          );
          replyDeduper.markHandled(input.messageId);
          return result;
        }

        const question = truncateQuestion(fullQuestion);
        if (question.length === 0) {
          const result = toRepliedResult(
            await replier.replyText({
              messageId: input.messageId,
              text: BLANK_MENTION_CLARIFICATION,
              replyInThread: true,
              uuid: replyUuid,
            }),
          );
          replyDeduper.markHandled(input.messageId);
          return result;
        }

        let answerText: string;
        try {
          const answer = await answerDraftOrchestrator.generateDraft({
            executionId: input.messageId,
            question,
            chatId: input.chatId,
            ...(normalizedSenderId === undefined ? {} : { askerId: normalizedSenderId }),
            liveChatMessages: [
              {
                speaker: normalizeOptionalText(input.senderId) ?? "unknown",
                text: question,
              },
            ],
          });
          answerText = answer.answerText;
        } catch (error) {
          const fallbackText = isBlankModelAnswerError(error)
            ? BLANK_MODEL_ANSWER_FALLBACK
            : isModelProviderCapacityError(error)
              ? MODEL_CAPACITY_FALLBACK
              : undefined;
          if (fallbackText === undefined) {
            throw error;
          }

          const result = toRepliedResult(
            await replier.replyText({
              messageId: input.messageId,
              text: fallbackText,
              replyInThread: true,
              uuid: replyUuid,
            }),
          );
          replyDeduper.markHandled(input.messageId);
          return result;
        }

        const result = toRepliedResult(
          await replier.replyText({
            messageId: input.messageId,
            text: answerText,
            replyInThread: true,
            uuid: replyUuid,
          }),
        );
        replyDeduper.markHandled(input.messageId);
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

  markHandled(messageId: string): void {
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

function detectUserSubmittedDocumentCommand({
  text,
  documentLinkExtractor,
}: {
  text: string;
  documentLinkExtractor: Pick<FeishuDocumentLinkExtractor, "extractLinks"> | undefined;
}): { intent: true; sourceUri?: string } | { intent: false } {
  if (!userSubmittedDocumentIntentPatterns.some((pattern) => pattern.test(text))) {
    return { intent: false };
  }
  if (documentLinkExtractor === undefined) {
    return { intent: true };
  }

  return { intent: true, sourceUri: documentLinkExtractor.extractLinks(text)[0]?.sourceUri };
}

function detectKnowledgeDraftCommand(text: string): boolean {
  if (
    negatedKnowledgeDraftIntentPatterns.some((pattern) => pattern.test(text)) ||
    knowledgeDraftQuestionPatterns.some((pattern) => pattern.test(text))
  ) {
    return false;
  }
  return knowledgeDraftIntentPatterns.some((pattern) => pattern.test(text));
}

function knowledgeDraftReplyText(
  status: "created" | "already_created" | "runtime_disabled" | "no_context" | "target_unavailable",
): string {
  switch (status) {
    case "created":
    case "already_created":
      return KNOWLEDGE_DRAFT_CREATED;
    case "runtime_disabled":
      return KNOWLEDGE_DRAFT_RUNTIME_DISABLED;
    case "no_context":
      return KNOWLEDGE_DRAFT_NO_CONTEXT;
    case "target_unavailable":
      return KNOWLEDGE_DRAFT_TARGET_UNAVAILABLE;
  }
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

function isBlankModelAnswerError(error: unknown): boolean {
  return error instanceof Error && error.message === BLANK_MODEL_ANSWER_ERROR_MESSAGE;
}

function isInvalidKnowledgeDraftModelResponse(error: unknown): boolean {
  return error instanceof Error && error.message === KNOWLEDGE_DRAFT_MODEL_INVALID_ERROR_MESSAGE;
}

function isKnowledgeDraftModelCapacityError(error: unknown): boolean {
  return isModelProviderCapacityError(error) || (
    error instanceof ChatKnowledgeDraftModelUnavailableError &&
    isModelProviderCapacityError(error.providerCause)
  );
}

function isKnowledgeDraftModelUnavailableError(error: unknown): boolean {
  if (error instanceof ChatKnowledgeDraftModelUnavailableError) return true;
  if (error instanceof ModelProviderHttpError) return true;
  return error instanceof Error && error.message.startsWith("model provider ");
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
