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

export function createAnswerDraftOrchestrator({
  contextBuilder,
  model,
}: {
  contextBuilder: Pick<DocumentRetrievalContextBuilder, "buildContext">;
  model: ModelProvider;
}): AnswerDraftOrchestrator {
  return {
    async generateDraft(input) {
      const question = input.question.trim();
      if (question.length === 0) {
        throw new Error("question must not be blank");
      }

      const context = await contextBuilder.buildContext({
        queryText: question,
        liveChatMessages: input.liveChatMessages,
        fragmentLimit: input.fragmentLimit,
        liveChatLimit: input.liveChatLimit,
      });

      const modelResult = await model.generateAnswerDraft({
        question,
        promptContext: context.promptContext,
      });
      const answerText = modelResult.answerText.trim();
      if (answerText.length === 0) {
        throw new Error("model answer draft must not be blank");
      }

      return toAnswerDraftResult(answerText, context);
    },
  };
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
