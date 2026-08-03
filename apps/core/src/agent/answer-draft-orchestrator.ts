import { createHash, randomUUID } from "node:crypto";

import type { AgentExecutionObserver } from "../agent-runtime/agent-execution-observer.js";
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
  executionId?: string;
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

export type AnswerDraftPermissionInspectionResult = {
  blockedDocumentSourceIds: string[];
};

export interface AnswerDraftOrchestrator {
  generateDraft(input: AnswerDraftInput): Promise<AnswerDraftResult>;
  inspectPromptPermissions(
    input: AnswerDraftInput,
  ): Promise<AnswerDraftPermissionInspectionResult>;
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
const MAX_EXECUTION_ID_CHARS = 512;
const MAX_EXECUTION_OPERATION_KEY_CHARS = 512;
const TRUNCATION_MARKER = " ... [truncated]";
const PERMISSION_BLOCKED_ANSWER_DRAFT = "Answer withheld by the live permission guard.";

export function createAnswerDraftOrchestrator({
  contextBuilder,
  model,
  liveChatContextProvider,
  agentExecutionObserver,
  provider,
  modelId,
  createExecutionId = randomUUID,
}: {
  contextBuilder: Pick<DocumentRetrievalContextBuilder, "buildContext">;
  model: ModelProvider;
  liveChatContextProvider?: LiveChatContextProvider;
  agentExecutionObserver?: AgentExecutionObserver;
  provider?: string;
  modelId?: string;
  createExecutionId?: () => string;
}): AnswerDraftOrchestrator {
  function normalizeInput(input: AnswerDraftInput): {
    question: string;
    liveChatLimit: number | undefined;
  } {
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
    return {
      question,
      liveChatLimit: sanitizeLiveChatLimit(input.liveChatLimit),
    };
  }

  async function buildContext(
    input: AnswerDraftInput,
    normalized: ReturnType<typeof normalizeInput>,
  ): Promise<DocumentRetrievalContextResult> {
    const storedLiveChatMessages = input.chatId === undefined
      ? []
      : await liveChatContextProvider?.loadRecentMessages({
          chatId: input.chatId,
          limit: normalized.liveChatLimit,
        }) ?? [];
    const liveChatMessages = selectLiveChatWindow(
      dedupeLiveChatMessages([...storedLiveChatMessages, ...input.liveChatMessages]),
      normalized.liveChatLimit,
    );

    return contextBuilder.buildContext({
      queryText: buildRetrievalQueryText(normalized.question, liveChatMessages),
      liveChatMessages,
      fragmentLimit: input.fragmentLimit,
      liveChatLimit: normalized.liveChatLimit,
      ...(input.askerId === undefined ? {} : { askerId: input.askerId }),
    });
  }

  return {
    async inspectPromptPermissions(input) {
      const normalized = normalizeInput(input);
      const context = await buildContext(input, normalized);
      return { blockedDocumentSourceIds: [...context.deniedDocumentIds] };
    },

    async generateDraft(input) {
      const normalized = normalizeInput(input);
      const { question } = normalized;
      const executionId = resolveAnswerDraftExecutionId(input.executionId, createExecutionId);
      const commonObservation = {
        ...toOptionalObservationReference("groupId", input.chatId),
        ...toOptionalObservationReference("actorOpenId", input.askerId),
        subjectId: executionId,
      };
      await safelyObserve(agentExecutionObserver, {
        ...commonObservation,
        subjectType: "turn",
        eventType: "turn_started",
        phase: "context_assembly",
        operationKey: createTurnOperationKey(executionId, "started"),
        metadata: {},
      });

      try {
        const context = await buildContext(input, normalized);

        let answerText: string;
        if (context.deniedDocumentIds.length > 0) {
          answerText = PERMISSION_BLOCKED_ANSWER_DRAFT;
        } else {
          const providerObservation = {
            ...commonObservation,
            subjectType: "provider_request" as const,
            ...(provider === undefined ? {} : { provider }),
            ...(modelId === undefined ? {} : { modelId }),
          };
          await safelyObserve(agentExecutionObserver, {
            ...providerObservation,
            eventType: "provider_request_started",
            phase: "sampling",
            operationKey: createTurnOperationKey(executionId, "provider:started"),
            metadata: {},
          });
          try {
            const modelResult = await model.generateAnswerDraft({
              question,
              promptContext: context.promptContext,
            });
            answerText = truncateAnswerDraftText(modelResult.answerText.trim());
            if (answerText.length === 0) {
              throw new Error("model answer draft must not be blank");
            }
            await safelyObserve(agentExecutionObserver, {
              ...providerObservation,
              eventType: "provider_request_completed",
              phase: "sampling",
              outcome: "success",
              operationKey: createTurnOperationKey(executionId, "provider:completed"),
              metadata: {},
            });
          } catch (error) {
            await safelyObserve(agentExecutionObserver, {
              ...providerObservation,
              eventType: "provider_request_failed",
              phase: "sampling",
              outcome: "error",
              decisionReason: "model_provider_failed",
              operationKey: createTurnOperationKey(executionId, "provider:failed"),
              metadata: {},
            });
            throw error;
          }
        }

        const result = toAnswerDraftResult(answerText, context);
        await safelyObserve(agentExecutionObserver, {
          ...commonObservation,
          subjectType: "turn",
          eventType: "turn_completed",
          phase: "completed",
          outcome: "success",
          operationKey: createTurnOperationKey(executionId, "completed"),
          metadata: {
            retrievedFragmentCount: result.retrievedFragmentCount,
            allowedFragmentCount: result.allowedFragments.length,
            deniedDocumentCount: result.deniedDocumentIds.length,
            groupMemoryCount: result.usedGroupMemories.length,
            discussionThreadCount: result.usedDiscussionThreads?.length ?? 0,
            actionItemCount: result.usedActionItems?.length ?? 0,
          },
        });
        return result;
      } catch (error) {
        await safelyObserve(agentExecutionObserver, {
          ...commonObservation,
          subjectType: "turn",
          eventType: "turn_failed",
          phase: "completed",
          outcome: "error",
          decisionReason: "answer_draft_failed",
          operationKey: createTurnOperationKey(executionId, "failed"),
          metadata: {},
        });
        throw error;
      }
    },
  };
}

async function safelyObserve(
  observer: AgentExecutionObserver | undefined,
  input: Parameters<AgentExecutionObserver["observe"]>[0],
): Promise<void> {
  try {
    await observer?.observe(input);
  } catch {
    // Execution observability is best-effort and must not replace the answer result.
  }
}

export function resolveAnswerDraftExecutionId(
  value: string | undefined,
  createExecutionId: () => string = randomUUID,
): string {
  const candidate = value ?? createExecutionId();
  const normalized = candidate.trim();
  if (normalized.length === 0 || [...normalized].length > MAX_EXECUTION_ID_CHARS) {
    throw new Error(`executionId must include at most ${MAX_EXECUTION_ID_CHARS} characters`);
  }
  return normalized;
}

function toOptionalObservationReference<
  TName extends "groupId" | "actorOpenId",
>(
  name: TName,
  value: string | undefined,
): Partial<Record<TName, string>> {
  const normalized = value?.trim();
  if (
    normalized === undefined ||
    normalized.length === 0 ||
    [...normalized].length > MAX_EXECUTION_ID_CHARS
  ) {
    return {};
  }
  return { [name]: normalized } as Partial<Record<TName, string>>;
}

function createTurnOperationKey(executionId: string, suffix: string): string {
  const readable = `turn:${executionId}:${suffix}`;
  if ([...readable].length <= MAX_EXECUTION_OPERATION_KEY_CHARS) {
    return readable;
  }
  const executionHash = createHash("sha256").update(executionId).digest("hex");
  return `turn:${executionHash}:${suffix}`;
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
