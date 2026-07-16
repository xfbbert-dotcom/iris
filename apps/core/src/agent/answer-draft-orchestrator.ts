import type { RetrievedDocumentFragment } from "../documents/document-fragment-repository.js";
import type {
  DocumentRetrievalContextBuilder,
  DocumentRetrievalContextResult,
} from "../memory/document-retrieval-context.js";
import type {
  LiveChatMessage,
  PromptActionItem,
  PromptDiscussionThread,
  PromptGroupMemory,
} from "../memory/context-assembly.js";

export type GenerateAnswerDraftInput = {
  question: string;
  promptContext: string;
};

export type GenerateAnswerDraftResult = {
  answerText: string;
};

export interface ModelProvider {
  generateAnswerDraft(input: GenerateAnswerDraftInput): Promise<GenerateAnswerDraftResult>;
}

export type AnswerDraftInput = {
  question: string;
  chatId?: string;
  askerId?: string;
  liveChatMessages: LiveChatMessage[];
  fragmentLimit?: number;
  liveChatLimit?: number;
};

export type AnswerDraftResult = {
  answerText: string;
  promptContext: string;
  allowedFragments: RetrievedDocumentFragment[];
  deniedDocumentIds: string[];
  retrievedFragmentCount: number;
  usedGroupMemories: PromptGroupMemory[];
  usedDiscussionThreads?: PromptDiscussionThread[];
  usedActionItems?: PromptActionItem[];
};

export interface AnswerDraftOrchestrator {
  generateDraft(input: AnswerDraftInput): Promise<AnswerDraftResult>;
}

type LiveChatContextProvider = {
  loadRecentMessages(input: { chatId: string; limit?: number }): Promise<LiveChatMessage[]>;
};

const MAX_ANSWER_DRAFT_TEXT_CHARS = 8000;
const MAX_ANSWER_DRAFT_QUESTION_CHARS = 4000;
const MAX_REQUEST_LIVE_CHAT_MESSAGES = 50;
const MAX_LIVE_CHAT_SPEAKER_CHARS = 256;
const MAX_LIVE_CHAT_TEXT_CHARS = 2000;
const MAX_LIVE_CHAT_LIMIT = 20;
const TRUNCATION_MARKER = " ... [truncated]";

export function createAnswerDraftOrchestrator({
  contextBuilder,
  model,
  liveChatContextProvider,
}: {
  contextBuilder: Pick<DocumentRetrievalContextBuilder, "buildContext">;
  model: ModelProvider;
  liveChatContextProvider?: LiveChatContextProvider;
}): AnswerDraftOrchestrator {
  return {
    async generateDraft(input) {
      const question = input.question.trim();
      if (question.length === 0) {
        throw new Error("question must not be blank");
      }
      if (question.length > MAX_ANSWER_DRAFT_QUESTION_CHARS) {
        throw new Error(`question must be at most ${MAX_ANSWER_DRAFT_QUESTION_CHARS} characters`);
      }
      if (input.liveChatMessages.length > MAX_REQUEST_LIVE_CHAT_MESSAGES) {
        throw new Error(
          `liveChatMessages must include at most ${MAX_REQUEST_LIVE_CHAT_MESSAGES} messages`,
        );
      }

      assertSafeMagnitudeLimit(input.fragmentLimit, "fragmentLimit");
      const liveChatLimit = sanitizeLiveChatLimit(input.liveChatLimit);
      const storedLiveChatMessages =
        input.chatId === undefined
          ? []
          : await liveChatContextProvider?.loadRecentMessages({
              chatId: input.chatId,
              limit: liveChatLimit,
            }) ?? [];
      const liveChatMessages = selectLiveChatWindow(
        dedupeLiveChatMessages([...storedLiveChatMessages, ...input.liveChatMessages]),
        liveChatLimit,
      );

      const context = await contextBuilder.buildContext({
        queryText: buildRetrievalQueryText(question, liveChatMessages),
        liveChatMessages,
        fragmentLimit: input.fragmentLimit,
        liveChatLimit,
        ...(input.askerId === undefined ? {} : { askerId: input.askerId }),
      });

      const modelResult = await model.generateAnswerDraft({
        question,
        promptContext: context.promptContext,
      });
      const answerText = truncateAnswerDraftText(modelResult.answerText.trim());
      if (answerText.length === 0) {
        throw new Error("model answer draft must not be blank");
      }

      return toAnswerDraftResult(answerText, context);
    },
  };
}

function sanitizeLiveChatLimit(value: number | undefined): number | undefined {
  assertSafeMagnitudeLimit(value, "liveChatLimit");
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.min(MAX_LIVE_CHAT_LIMIT, Math.max(0, Math.floor(value)));
}

function assertSafeMagnitudeLimit(value: number | undefined, fieldName: string): void {
  if (
    value !== undefined &&
    (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(`${fieldName} must be a finite safe-magnitude number`);
  }
}

function truncateAnswerDraftText(value: string): string {
  return truncateWithMarker(value, MAX_ANSWER_DRAFT_TEXT_CHARS);
}

function truncateWithMarker(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const prefixChars = maxChars - TRUNCATION_MARKER.length;
  return `${value.slice(0, prefixChars).trimEnd()}${TRUNCATION_MARKER}`;
}

function dedupeLiveChatMessages(messages: LiveChatMessage[]): LiveChatMessage[] {
  const seen = new Set<string>();
  const normalizedMessages = messages
    .map((message) => ({
      speaker: truncateWithMarker(message.speaker.trim(), MAX_LIVE_CHAT_SPEAKER_CHARS),
      text: truncateWithMarker(message.text.trim(), MAX_LIVE_CHAT_TEXT_CHARS),
    }))
    .filter((message) => message.speaker.length > 0 && message.text.length > 0);

  return normalizedMessages.reduceRight<LiveChatMessage[]>((deduplicated, message) => {
    const key = `${message.speaker}\u0000${message.text}`;
    if (seen.has(key)) {
      return deduplicated;
    }
    seen.add(key);
    deduplicated.unshift(message);
    return deduplicated;
  }, []);
}

function selectLiveChatWindow(
  messages: LiveChatMessage[],
  liveChatLimit: number | undefined,
): LiveChatMessage[] {
  const limit = liveChatLimit ?? MAX_LIVE_CHAT_LIMIT;
  if (limit <= 0) {
    return [];
  }

  return messages.slice(-limit);
}

function buildRetrievalQueryText(question: string, liveChatMessages: LiveChatMessage[]): string {
  const separator = "\n\nRecent live chat:\n";
  if (
    liveChatMessages.length === 0 ||
    question.length + separator.length >= MAX_ANSWER_DRAFT_QUESTION_CHARS
  ) {
    return question;
  }

  const liveChatBudget = MAX_ANSWER_DRAFT_QUESTION_CHARS - question.length - separator.length;
  const liveChatQueryText = buildLiveChatRetrievalText(liveChatMessages, liveChatBudget);
  if (liveChatQueryText.length === 0) {
    return question;
  }

  return `${question}${separator}${liveChatQueryText}`;
}

function buildLiveChatRetrievalText(
  liveChatMessages: LiveChatMessage[],
  maxChars: number,
): string {
  const selectedLines: string[] = [];
  for (let index = liveChatMessages.length - 1; index >= 0; index -= 1) {
    const message = liveChatMessages[index];
    if (message === undefined) {
      continue;
    }

    const line = `${message.speaker}: ${message.text}`;
    const candidateLines = [line, ...selectedLines];
    const candidate = candidateLines.join("\n");
    if (candidate.length <= maxChars) {
      selectedLines.unshift(line);
      continue;
    }

    if (selectedLines.length === 0 && maxChars > TRUNCATION_MARKER.length) {
      selectedLines.unshift(truncateWithMarker(line, maxChars));
    }
    break;
  }

  return selectedLines.join("\n");
}

function toAnswerDraftResult(
  answerText: string,
  context: DocumentRetrievalContextResult,
): AnswerDraftResult {
  return {
    answerText,
    promptContext: context.promptContext,
    allowedFragments: context.allowedFragments,
    deniedDocumentIds: context.deniedDocumentIds,
    retrievedFragmentCount: context.retrievedFragmentCount,
    usedGroupMemories: context.usedGroupMemories.map((memory) => ({
      ...memory,
      evidenceMessageIds: [...memory.evidenceMessageIds],
    })),
    usedDiscussionThreads: (context.usedDiscussionThreads ?? []).map((thread) => ({
      ...thread,
      evidenceMessageIds: [...thread.evidenceMessageIds],
    })),
    usedActionItems: (context.usedActionItems ?? []).map((action) => ({
      ...action,
      ...(action.dueAt === undefined ? {} : { dueAt: new Date(action.dueAt) }),
      evidenceMessageIds: [...action.evidenceMessageIds],
    })),
  };
}
