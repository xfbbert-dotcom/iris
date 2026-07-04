import type { RetrievedDocumentFragment } from "../documents/document-fragment-repository.js";
import type {
  DocumentRetrievalContextBuilder,
  DocumentRetrievalContextResult,
} from "../memory/document-retrieval-context.js";
import type { LiveChatMessage } from "../memory/context-assembly.js";

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
};

export interface AnswerDraftOrchestrator {
  generateDraft(input: AnswerDraftInput): Promise<AnswerDraftResult>;
}

type LiveChatContextProvider = {
  loadRecentMessages(input: { chatId: string; limit?: number }): Promise<LiveChatMessage[]>;
};

const MAX_ANSWER_DRAFT_TEXT_CHARS = 8000;
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

      assertSafeMagnitudeLimit(input.fragmentLimit, "fragmentLimit");
      const liveChatLimit = sanitizeLiveChatLimit(input.liveChatLimit);
      const storedLiveChatMessages =
        input.chatId === undefined
          ? []
          : await liveChatContextProvider?.loadRecentMessages({
              chatId: input.chatId,
              limit: liveChatLimit,
            }) ?? [];
      const liveChatMessages = dedupeLiveChatMessages([
        ...storedLiveChatMessages,
        ...input.liveChatMessages,
      ]);

      const context = await contextBuilder.buildContext({
        queryText: question,
        liveChatMessages,
        fragmentLimit: input.fragmentLimit,
        liveChatLimit,
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
  if (value !== undefined && Number.isFinite(value) && Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${fieldName} must be a finite safe-magnitude number`);
  }
}

function truncateAnswerDraftText(value: string): string {
  if (value.length <= MAX_ANSWER_DRAFT_TEXT_CHARS) {
    return value;
  }

  const prefixChars = MAX_ANSWER_DRAFT_TEXT_CHARS - TRUNCATION_MARKER.length;
  return `${value.slice(0, prefixChars).trimEnd()}${TRUNCATION_MARKER}`;
}

function dedupeLiveChatMessages(messages: LiveChatMessage[]): LiveChatMessage[] {
  const seen = new Set<string>();
  const normalizedMessages = messages
    .map((message) => ({
      speaker: message.speaker.trim(),
      text: message.text.trim(),
    }))
    .filter((message) => message.speaker.length > 0 && message.text.length > 0);

  return normalizedMessages.filter((message) => {
    const key = `${message.speaker}\u0000${message.text}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
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
  };
}
