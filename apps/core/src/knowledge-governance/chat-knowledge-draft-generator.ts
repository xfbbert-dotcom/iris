import type { ModelProvider } from "../agent/answer-draft-orchestrator.js";
import type {
  ConversationMessage,
  ConversationMessageRepository,
} from "../conversation/conversation-message-repository.js";
import { assemblePromptContext } from "../memory/context-assembly.js";
import {
  KNOWLEDGE_DRAFT_CONTENT_MAX_CHARS,
  KNOWLEDGE_DRAFT_TITLE_MAX_CHARS,
  type KnowledgeDraftEvidenceReference,
} from "./knowledge-draft.js";

const MESSAGE_SCAN_LIMIT = 60;
const MESSAGE_CONTEXT_LIMIT = 20;
const MAX_REQUEST_TEXT_CHARS = 2_000;

export type ChatKnowledgeDraftGeneratorResult =
  | {
      status: "generated";
      title: string;
      content: string;
      evidence: KnowledgeDraftEvidenceReference[];
    }
  | { status: "no_context" };

export type ChatKnowledgeDraftGenerator = {
  generate(input: {
    chatId: string;
    requesterOpenId: string;
    requestText: string;
    observedAt: Date;
  }): Promise<ChatKnowledgeDraftGeneratorResult>;
};

export class ChatKnowledgeDraftModelUnavailableError extends Error {
  readonly providerCause: unknown;

  constructor(providerCause: unknown) {
    super("knowledge draft model is unavailable");
    this.name = "ChatKnowledgeDraftModelUnavailableError";
    this.providerCause = providerCause;
  }
}

export function createChatKnowledgeDraftGenerator({
  repository,
  model,
  canReadGroupContext,
}: {
  repository: Pick<ConversationMessageRepository, "listRecentByChat">;
  model: Pick<ModelProvider, "generateAnswerDraft">;
  canReadGroupContext(groupId: string): boolean;
}): ChatKnowledgeDraftGenerator {
  return {
    async generate(input) {
      const chatId = requireNonBlank(input.chatId, "chatId");
      const requesterOpenId = requireNonBlank(input.requesterOpenId, "requesterOpenId");
      const requestText = requireNonBlank(input.requestText, "requestText");
      const observedAt = requireDate(input.observedAt);
      if (!readContextGate(canReadGroupContext, chatId)) return { status: "no_context" };
      const messages = selectContextMessages(
        await repository.listRecentByChat({ chatId, limit: MESSAGE_SCAN_LIMIT }),
        chatId,
        observedAt,
      );
      if (messages.length === 0) return { status: "no_context" };

      const promptContext = assemblePromptContext({
        backgroundDocuments: [],
        groupMemories: [],
        discussionThreads: [],
        actionItems: [],
        liveChatMessages: messages.map((message) => ({
          speaker: message.senderId ?? message.senderOpenId ?? "unknown",
          text: message.text!,
        })),
        liveChatLimit: MESSAGE_CONTEXT_LIMIT,
      });
      if (!readContextGate(canReadGroupContext, chatId)) return { status: "no_context" };
      let response: Awaited<ReturnType<ModelProvider["generateAnswerDraft"]>>;
      try {
        response = await model.generateAnswerDraft({
          question: buildGenerationQuestion({ requestText, requesterOpenId }),
          promptContext,
        });
      } catch (error) {
        throw new ChatKnowledgeDraftModelUnavailableError(error);
      }
      const parsed = parseModelResponse(response.answerText);
      return {
        status: "generated",
        ...parsed,
        evidence: messages.map((message) => ({
          type: "conversation_message" as const,
          id: message.id,
          groupId: chatId,
        })),
      };
    },
  };
}

function readContextGate(
  canReadGroupContext: (groupId: string) => boolean,
  chatId: string,
): boolean {
  try {
    return canReadGroupContext(chatId);
  } catch {
    return false;
  }
}

function selectContextMessages(
  messages: ConversationMessage[],
  chatId: string,
  observedAt: Date,
): ConversationMessage[] {
  return messages
    .filter((message) => (
      message.chatId === chatId &&
      message.sentAt.getTime() <= observedAt.getTime() &&
      typeof message.text === "string" &&
      message.text.trim().length > 0
    ))
    .slice(0, MESSAGE_CONTEXT_LIMIT)
    .reverse();
}

function buildGenerationQuestion(input: { requestText: string; requesterOpenId: string }): string {
  const boundedRequest = input.requestText.length <= MAX_REQUEST_TEXT_CHARS
    ? input.requestText
    : input.requestText.slice(0, MAX_REQUEST_TEXT_CHARS);
  return [
    "Create one reviewable company knowledge draft using only facts in live_chat_context.",
    "Do not use background knowledge, do not invent facts, and preserve explicit uncertainty.",
    "Do not claim that anything has been approved or published.",
    "Return exactly this plain-text envelope with no Markdown fence and no text before TITLE:",
    "TITLE: <one concise title, at most 256 characters>",
    "CONTENT:",
    "<the complete draft body>",
    `Requester: ${input.requesterOpenId}`,
    `Request: ${boundedRequest}`,
  ].join("\n");
}

function parseModelResponse(value: string): { title: string; content: string } {
  const match = /^TITLE:[ \t]+([^\r\n]+)\r?\nCONTENT:\r?\n([\s\S]+)$/u.exec(value);
  if (match === null) throw invalidModelResponse();
  const title = match[1]?.trim() ?? "";
  const content = match[2]?.trim() ?? "";
  if (
    title.length < 1 ||
    title.length > KNOWLEDGE_DRAFT_TITLE_MAX_CHARS ||
    content.length < 1 ||
    content.length > KNOWLEDGE_DRAFT_CONTENT_MAX_CHARS
  ) throw invalidModelResponse();
  return { title, content };
}

function requireNonBlank(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${name} must not be blank`);
  return normalized;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("observedAt must be a valid date");
  }
  return new Date(value);
}

function invalidModelResponse(): Error {
  return new Error("knowledge draft model response is invalid");
}
