import { createHash, randomUUID } from "node:crypto";

import type { AgentExecutionObserver } from "../agent-runtime/agent-execution-observer.js";
import {
  citedRefsForEvidencePlan,
  documentCitationRefsForEvidencePlan,
  type EvidencePlan,
  type EvidencePlanningDocument,
} from "./evidence-plan.js";
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
import type { EvidencePlanner } from "../model/openai-compatible-evidence-planner.js";
import type { GroundedAnswerRenderer } from "../model/openai-compatible-grounded-answer-renderer.js";

export type GenerateAnswerDraftInput = {
  question: string;
  promptContext: string;
};

export type GenerateAnswerDraftResult = {
  answerText: string;
  citedSourceRefs?: string[];
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
  citedSourceRefs?: string[];
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
const MAX_RETRIEVAL_QUERY_LIVE_CHAT_MESSAGES = 5;
const MAX_PLANNING_LIVE_CHAT_EVIDENCE_MESSAGES = 10;
const MAX_PLANNING_GROUP_MEMORY_TEXT_CHARS = 600;
const MAX_PLANNING_EVIDENCE_TEXT_CHARS = 1200;
const MAX_EXECUTION_ID_CHARS = 512;
const MAX_EXECUTION_OPERATION_KEY_CHARS = 512;
const TRUNCATION_MARKER = " ... [truncated]";
const PERMISSION_BLOCKED_ANSWER_DRAFT = "Answer withheld by the live permission guard.";
const DIRECT_TASK_PROMPT_CONTEXT =
  "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>";

export function createAnswerDraftOrchestrator({
  contextBuilder,
  model,
  planner,
  renderer,
  liveChatContextProvider,
  agentExecutionObserver,
  provider,
  modelId,
  createExecutionId = randomUUID,
}: {
  contextBuilder: Pick<DocumentRetrievalContextBuilder, "buildContext">;
  model: ModelProvider;
  planner: EvidencePlanner;
  renderer: GroundedAnswerRenderer;
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

    const supplementalQueryText = buildSupplementalRetrievalQueryText(
      normalized.question,
      liveChatMessages,
    );
    return contextBuilder.buildContext({
      queryText: normalized.question,
      ...(supplementalQueryText === undefined ? {} : { supplementalQueryText }),
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
        let citedSourceRefs: string[] = [];
        let reasoningMetadata: {
          taskMode: EvidencePlan["taskMode"];
          evidenceState?: NonNullable<EvidencePlan["evidenceState"]>;
          confidence?: NonNullable<EvidencePlan["confidence"]>;
        } | undefined;
        if (context.deniedDocumentIds.length > 0) {
          answerText = PERMISSION_BLOCKED_ANSWER_DRAFT;
        } else {
          const providerObservation = {
            ...commonObservation,
            subjectType: "provider_request" as const,
            ...(provider === undefined ? {} : { provider }),
            ...(modelId === undefined ? {} : { modelId }),
          };
          if (isExplicitDirectTaskQuestion(question)) {
            reasoningMetadata = { taskMode: "direct_task" };
            const modelResult = await runObservedProviderRequest({
              observer: agentExecutionObserver,
              providerObservation,
              executionId,
              stageKey: "renderer",
              stage: "answer_rendering",
              request: () => model.generateAnswerDraft({
                question,
                promptContext: DIRECT_TASK_PROMPT_CONTEXT,
              }),
            });
            answerText = truncateAnswerDraftText(modelResult.answerText.trim());
            citedSourceRefs = [];
          } else {
            const evidence = buildPlanningEvidence(question, context);
            const plan = await runObservedProviderRequest({
              observer: agentExecutionObserver,
              providerObservation,
              executionId,
              stageKey: "planner",
              stage: "evidence_planning",
              request: () => planner.plan({
                question,
                evidence,
                liveChatMessages: [],
              }),
            });
            if (plan.taskMode !== "company_fact") {
              throw new Error("company-fact evidence planner returned an invalid task mode");
            }
            reasoningMetadata = {
              taskMode: plan.taskMode,
              ...(plan.evidenceState === null ? {} : { evidenceState: plan.evidenceState }),
              ...(plan.confidence === null ? {} : { confidence: plan.confidence }),
            };
            const selectedEvidence = selectEvidenceForPlan(evidence, plan);
            citedSourceRefs = normalizeCitedSourceRefs(
              documentCitationRefsForEvidencePlan(plan),
              context.allowedFragments.length,
            );
            const rendered = await runObservedProviderRequest({
              observer: agentExecutionObserver,
              providerObservation,
              executionId,
              stageKey: "renderer",
              stage: "answer_rendering",
              request: () => renderer.render({
                question,
                plan,
                evidence: selectedEvidence,
                liveChatMessages: [],
              }),
            });
            answerText = truncateAnswerDraftText(rendered.answerText.trim());
          }
          if (answerText.length === 0) {
            throw new Error("model answer draft must not be blank");
          }
        }

        const result = toAnswerDraftResult(answerText, context, citedSourceRefs);
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
            ...(reasoningMetadata ?? {}),
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

const DIRECT_TASK_PAYLOAD_DELIMITER_PATTERNS = [
  /^(?:(?:请|麻烦|烦请)\s*)?(?:(?:帮我|替我)\s*)?(?:(?:把|将)\s*)?(?:翻译|改写|重写|润色|校对|总结|概括|整理|格式化|提炼|压缩|扩写|转换|生成|列出|提取)[^:：]{0,40}[:：]\s*\S/u,
  /^(?:please\s+)?(?:translate|rewrite|rephrase|paraphrase|polish|proofread|summari[sz]e|format|extract|condense|expand|convert|generate|list)[^:：]{0,40}[:：]\s*\S/iu,
];
const DIRECT_TASK_OBJECT_MARKER_PATTERN = /(?:这段(?:话|文字|文本|内容|会议纪要)?|这份(?:文档|文件|材料|报告|会议纪要|纪要|内容)|这些(?:文字|文本|内容|材料|笔记|消息)|以下|下列|上面|上述|上一条|刚才|附件|该(?:文|段|内容))|\b(?:this\s+(?:text|passage|paragraph|document|file|note|message|content|meeting notes?)|these\s+(?:texts|passages|paragraphs|documents|files|notes|messages|meeting notes)|the following|the above|previous message|attached)\b/iu;
const QUESTION_LITERAL_TRANSFORM_PATTERNS = [
  /^(?:(?:请|麻烦|烦请)\s*)?(?:(?:帮我|替我)\s*)?(?:(?:把|将)\s*)?(?:翻译|改写|重写|润色|校对|格式化|转换)[^:：]{0,40}[:：]/u,
  /^(?:please\s+)?(?:translate|rewrite|rephrase|paraphrase|polish|proofread|format|convert)[^:：]{0,40}[:：]/iu,
];
const EXACT_OUTPUT_PAYLOAD_PATTERNS = [
  /^(?:(?:请|麻烦|烦请)\s*)?(?:只|仅)\s*(?:回复|输出)[^:：]{0,40}[:：]\s*\S/u,
  /^(?:please\s+)?(?:reply|output)\s+only[^:：]{0,40}[:：]\s*\S/iu,
];

function isExplicitDirectTaskQuestion(question: string): boolean {
  const normalized = question.trim();
  if (EXACT_OUTPUT_PAYLOAD_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  if (!DIRECT_TASK_PAYLOAD_DELIMITER_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  if (QUESTION_LITERAL_TRANSFORM_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  const delimiterIndex = normalized.search(/[:：]/u);
  return delimiterIndex > 0 &&
    DIRECT_TASK_OBJECT_MARKER_PATTERN.test(normalized.slice(0, delimiterIndex));
}

function buildPlanningEvidence(
  question: string,
  context: DocumentRetrievalContextResult,
): EvidencePlanningDocument[] {
  const normalizedQuestion = question.trim();
  const liveChatEvidence = (context.liveChatMessages ?? [])
    .filter(({ text }) => {
      const normalizedText = text.trim();
      return normalizedText !== normalizedQuestion && !normalizedText.endsWith(normalizedQuestion);
    })
    .slice(-MAX_PLANNING_LIVE_CHAT_EVIDENCE_MESSAGES)
    .map((message, index) => ({
      citationRef: `C${index + 1}`,
      source: `live_chat:${index + 1}`,
      text: truncateWithMarker(
        `${message.speaker.trim()}: ${message.text.trim()}`,
        MAX_PLANNING_EVIDENCE_TEXT_CHARS,
      ),
    }));
  const groupMemoryEvidence = context.usedGroupMemories.slice(0, 8).map((memory, index) => ({
    citationRef: `M${index + 1}`,
    source: `group_memory:${memory.id}`,
    text: truncateWithMarker(memory.content, MAX_PLANNING_GROUP_MEMORY_TEXT_CHARS),
  }));
  const discussionThreadEvidence = (context.usedDiscussionThreads ?? [])
    .slice(0, 6)
    .map((thread, index) => ({
      citationRef: `T${index + 1}`,
      source: `discussion_thread:${thread.id}:${thread.status}`,
      text: truncateWithMarker(thread.summary, MAX_PLANNING_EVIDENCE_TEXT_CHARS),
    }));
  const documentEvidence = context.allowedFragments.map((fragment, index) => ({
    citationRef: `D${index + 1}`,
    source: `${fragment.sourceUri}#chunk-${fragment.chunkIndex}`,
    text: truncateWithMarker(fragment.text, MAX_PLANNING_EVIDENCE_TEXT_CHARS),
  }));
  const actionEvidence = (context.usedActionItems ?? []).slice(0, 6).map((action, index) => ({
    citationRef: `A${index + 1}`,
    source: `action_item:${action.id}:${action.status}`,
    text: truncateWithMarker(
      `${action.description.trim()} Owner: ${action.ownerRef.trim()}${
        action.dueAt === undefined ? "" : ` Due: ${action.dueAt.toISOString()}`
      }`,
      MAX_PLANNING_EVIDENCE_TEXT_CHARS,
    ),
  }));

  return [
    ...liveChatEvidence,
    ...groupMemoryEvidence,
    ...discussionThreadEvidence,
    ...documentEvidence,
    ...actionEvidence,
  ];
}

function selectEvidenceForPlan(
  evidence: EvidencePlanningDocument[],
  plan: EvidencePlan,
): EvidencePlanningDocument[] {
  const evidenceByRef = new Map(evidence.map((item) => [item.citationRef, item]));
  return citedRefsForEvidencePlan(plan).map((citationRef) => {
    const item = evidenceByRef.get(citationRef);
    if (item === undefined) {
      throw new Error(`evidence plan reference ${citationRef} is outside the allowed evidence`);
    }
    return item;
  });
}

type ProviderObservationBase = {
  groupId?: string;
  actorOpenId?: string;
  subjectType: "provider_request";
  subjectId: string;
  provider?: string;
  modelId?: string;
};

async function runObservedProviderRequest<T>({
  observer,
  providerObservation,
  executionId,
  stageKey,
  stage,
  request,
}: {
  observer: AgentExecutionObserver | undefined;
  providerObservation: ProviderObservationBase;
  executionId: string;
  stageKey: "planner" | "renderer";
  stage: "evidence_planning" | "answer_rendering";
  request: () => Promise<T>;
}): Promise<T> {
  const operationPrefix = `provider:${stageKey}`;
  await safelyObserve(observer, {
    ...providerObservation,
    eventType: "provider_request_started",
    phase: "sampling",
    operationKey: createTurnOperationKey(executionId, `${operationPrefix}:started`),
    metadata: { stage },
  });
  try {
    const result = await request();
    await safelyObserve(observer, {
      ...providerObservation,
      eventType: "provider_request_completed",
      phase: "sampling",
      outcome: "success",
      operationKey: createTurnOperationKey(executionId, `${operationPrefix}:completed`),
      metadata: { stage },
    });
    return result;
  } catch (error) {
    await safelyObserve(observer, {
      ...providerObservation,
      eventType: "provider_request_failed",
      phase: "sampling",
      outcome: "error",
      decisionReason: "model_provider_failed",
      operationKey: createTurnOperationKey(executionId, `${operationPrefix}:failed`),
      metadata: { stage },
    });
    throw error;
  }
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

function buildSupplementalRetrievalQueryText(
  question: string,
  liveChatMessages: LiveChatMessage[],
): string | undefined {
  const separator = "\n\nRecent live chat:\n";
  if (
    liveChatMessages.length === 0 ||
    question.length + separator.length >= MAX_ANSWER_DRAFT_QUESTION_CHARS
  ) {
    return undefined;
  }

  const priorMessages = liveChatMessages.filter(
    ({ text }) => text.trim() !== question,
  );
  const liveChatBudget = MAX_ANSWER_DRAFT_QUESTION_CHARS - question.length - separator.length;
  const liveChatQueryText = buildLiveChatRetrievalText(
    priorMessages.slice(-MAX_RETRIEVAL_QUERY_LIVE_CHAT_MESSAGES),
    liveChatBudget,
  );
  if (liveChatQueryText.length === 0) {
    return undefined;
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
  citedSourceRefs: string[],
): AnswerDraftResult {
  return {
    answerText,
    ...(citedSourceRefs.length === 0 ? {} : { citedSourceRefs: [...citedSourceRefs] }),
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

function normalizeCitedSourceRefs(value: unknown, allowedFragmentCount: number): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 12) {
    throw new Error("model citation references are invalid");
  }

  const ranks = new Set<number>();
  for (const candidate of value) {
    if (typeof candidate !== "string" || !/^D(?:[1-9]|1[0-2])$/u.test(candidate)) {
      throw new Error("model citation references are invalid");
    }
    const rank = Number(candidate.slice(1));
    if (rank > allowedFragmentCount) {
      throw new Error(
        `citation reference ${candidate} is outside the allowed prompt window`,
      );
    }
    ranks.add(rank);
  }

  return [...ranks]
    .sort((left, right) => left - right)
    .map((rank) => `D${rank}`);
}
