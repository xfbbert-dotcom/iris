import type { ModelProvider } from "../agent/answer-draft-orchestrator.js";
import type {
  ConversationMessage,
  ConversationMessageRepository,
} from "../conversation/conversation-message-repository.js";
import { assemblePromptContext } from "../memory/context-assembly.js";

import type {
  FormalTaskEvidenceReference,
} from "./formal-task-repository.js";
import type { FormalTaskReminderMinutes } from "./formal-task-draft.js";

const MESSAGE_SCAN_LIMIT = 60;
const MESSAGE_CONTEXT_LIMIT = 20;
const MAX_REQUEST_TEXT_CHARS = 2_000;
const MAX_TITLE_CHARS = 256;
const MAX_DESCRIPTION_CHARS = 3_000;

export type ChatFormalTaskDraftGeneratorResult =
  | {
      status: "generated";
      title: string;
      description: string;
      dueAt?: Date;
      reminderMinutes?: FormalTaskReminderMinutes;
      evidence: FormalTaskEvidenceReference[];
    }
  | { status: "no_context" };

export type ChatFormalTaskDraftGenerator = {
  generate(input: {
    messageId: string;
    chatId: string;
    requesterOpenId: string;
    requestText: string;
    observedAt: Date;
  }): Promise<ChatFormalTaskDraftGeneratorResult>;
};

export class ChatFormalTaskDraftModelUnavailableError extends Error {
  constructor(readonly providerCause: unknown) {
    super("formal task draft model is unavailable");
    this.name = "ChatFormalTaskDraftModelUnavailableError";
  }
}

export function createChatFormalTaskDraftGenerator({
  repository,
  model,
  canReadGroupContext,
}: {
  repository: Pick<ConversationMessageRepository, "listRecentByChat">;
  model: Pick<ModelProvider, "generateAnswerDraft">;
  canReadGroupContext(groupId: string): boolean;
}): ChatFormalTaskDraftGenerator {
  return {
    async generate(input) {
      const messageId = requireNonBlank(input.messageId, "messageId");
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
      if (!messages.some((message) => messageMatchesTrigger(message, messageId))) {
        return { status: "no_context" };
      }
      if (!readContextGate(canReadGroupContext, chatId)) return { status: "no_context" };

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
      let response: Awaited<ReturnType<ModelProvider["generateAnswerDraft"]>>;
      try {
        response = await model.generateAnswerDraft({
          question: buildGenerationQuestion({ requesterOpenId, requestText }),
          promptContext,
        });
      } catch (error) {
        throw new ChatFormalTaskDraftModelUnavailableError(error);
      }
      const parsed = parseModelResponse(response.answerText);
      return {
        status: "generated",
        ...parsed,
        evidence: messages.map((message) => ({
          type: "conversation_message" as const,
          id: message.id,
        })),
      };
    },
  };
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

function messageMatchesTrigger(message: ConversationMessage, messageId: string): boolean {
  return message.id === messageId || message.providerMessageId === messageId;
}

function buildGenerationQuestion(input: {
  requesterOpenId: string;
  requestText: string;
}): string {
  const boundedRequest = input.requestText.length <= MAX_REQUEST_TEXT_CHARS
    ? input.requestText
    : input.requestText.slice(0, MAX_REQUEST_TEXT_CHARS);
  return [
    "Create exactly one reviewable Feishu task draft using only facts in live_chat_context.",
    "Do not invent an assignee, approval, completion, publication, or external task creation.",
    "Use an exact UTC millisecond timestamp or NONE, and only one supported reminder.",
    "Return exactly this plain-text envelope with no Markdown fence or extra text:",
    "TITLE: <one concise title, at most 256 characters>",
    "DESCRIPTION:",
    "<complete task description, at most 3000 characters>",
    "DUE_AT_UTC: <YYYY-MM-DDTHH:mm:ss.sssZ or NONE>",
    "REMINDER_MINUTES: <NONE, 0, 30, 60, or 1440>",
    `Requester: ${input.requesterOpenId}`,
    `Request: ${boundedRequest}`,
  ].join("\n");
}

function parseModelResponse(value: string): {
  title: string;
  description: string;
  dueAt?: Date;
  reminderMinutes?: FormalTaskReminderMinutes;
} {
  const match = /^TITLE:[ \t]+([^\r\n]+)\r?\nDESCRIPTION:\r?\n([\s\S]+?)\r?\nDUE_AT_UTC:[ \t]+([^\r\n]+)\r?\nREMINDER_MINUTES:[ \t]+([^\r\n]+)$/u.exec(value);
  if (match === null) throw invalidModelResponse();
  const title = match[1]?.trim() ?? "";
  const description = match[2]?.trim() ?? "";
  if (
    [...title].length < 1 ||
    [...title].length > MAX_TITLE_CHARS ||
    [...description].length < 1 ||
    [...description].length > MAX_DESCRIPTION_CHARS
  ) throw invalidModelResponse();

  const dueValue = match[3]?.trim() ?? "";
  const reminderValue = match[4]?.trim() ?? "";
  if (dueValue === "NONE" || reminderValue === "NONE") {
    if (dueValue !== "NONE" || reminderValue !== "NONE") throw invalidModelResponse();
    return { title, description };
  }
  const dueAt = new Date(dueValue);
  if (!Number.isFinite(dueAt.getTime()) || dueAt.toISOString() !== dueValue) {
    throw invalidModelResponse();
  }
  if (!/^(0|30|60|1440)$/u.test(reminderValue)) throw invalidModelResponse();
  return {
    title,
    description,
    dueAt,
    reminderMinutes: Number(reminderValue) as FormalTaskReminderMinutes,
  };
}

function readContextGate(
  canReadGroupContext: (groupId: string) => boolean,
  groupId: string,
): boolean {
  try {
    return canReadGroupContext(groupId);
  } catch {
    return false;
  }
}

function requireNonBlank(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must not be blank`);
  }
  return value.trim();
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("observedAt must be a valid date");
  }
  return new Date(value);
}

function invalidModelResponse(): Error {
  return new Error("formal task draft model response is invalid");
}
