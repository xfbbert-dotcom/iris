import type { ModelProvider } from "../agent/answer-draft-orchestrator.js";
import type {
  ConversationMessage,
  ConversationMessageRepository,
} from "../conversation/conversation-message-repository.js";
import type { DocumentSnapshotRepository } from "../documents/document-snapshot-repository.js";
import type { DocumentSource } from "../documents/document-source-registry.js";
import type { AsyncDocumentSourceRegistry } from
  "../documents/postgres-document-source-registry.js";
import { assemblePromptContext } from "../memory/context-assembly.js";
import type { FeishuDocumentPermissionChecker } from
  "../permissions/feishu-document-permission-checker.js";
import {
  KNOWLEDGE_DRAFT_CONTENT_MAX_CHARS,
  KNOWLEDGE_DRAFT_TITLE_MAX_CHARS,
  type KnowledgeDraftEvidenceReference,
} from "./knowledge-draft.js";

const MESSAGE_SCAN_LIMIT = 60;
const MESSAGE_CONTEXT_LIMIT = 20;
const MAX_REQUEST_TEXT_CHARS = 2_000;
const RECENT_DOCUMENT_LOOKBACK_MS = 10 * 60 * 1_000;

export type ChatKnowledgeDraftGeneratorResult =
  | {
      status: "generated";
      title: string;
      content: string;
      evidence: KnowledgeDraftEvidenceReference[];
    }
  | { status: "no_context" }
  | { status: "document_unavailable" };

export type ChatKnowledgeDraftGenerator = {
  generate(input: {
    chatId: string;
    requesterOpenId: string;
    requestText: string;
    source?: { type: "document"; referenceMessageId?: string };
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
  documentSources,
  snapshots,
  permissionChecker,
  canReadDocuments = () => false,
}: {
  repository: Pick<ConversationMessageRepository, "listRecentByChat">;
  model: Pick<ModelProvider, "generateAnswerDraft">;
  canReadGroupContext(groupId: string): boolean;
  documentSources?: Pick<
    AsyncDocumentSourceRegistry,
    "listSourcesByGroupId" | "markPermissionStateIfCurrent"
  >;
  snapshots?: Pick<DocumentSnapshotRepository, "findLatestSnapshotForSource">;
  permissionChecker?: Pick<FeishuDocumentPermissionChecker, "canReadSource">;
  canReadDocuments?: () => boolean;
}): ChatKnowledgeDraftGenerator {
  return {
    async generate(input) {
      const chatId = requireNonBlank(input.chatId, "chatId");
      const requesterOpenId = requireNonBlank(input.requesterOpenId, "requesterOpenId");
      const requestText = requireNonBlank(input.requestText, "requestText");
      const observedAt = requireDate(input.observedAt);
      if (!readContextGate(canReadGroupContext, chatId)) return { status: "no_context" };
      if (input.source?.type === "document") {
        return generateFromDocument({
          chatId,
          observedAt,
          referenceMessageId: input.source.referenceMessageId,
          canReadGroupContext,
          canReadDocuments,
          documentSources,
          snapshots,
          permissionChecker,
        });
      }
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

async function generateFromDocument(input: {
  chatId: string;
  observedAt: Date;
  referenceMessageId?: string;
  canReadGroupContext(groupId: string): boolean;
  canReadDocuments(): boolean;
  documentSources: Pick<
    AsyncDocumentSourceRegistry,
    "listSourcesByGroupId" | "markPermissionStateIfCurrent"
  > | undefined;
  snapshots: Pick<DocumentSnapshotRepository, "findLatestSnapshotForSource"> | undefined;
  permissionChecker: Pick<FeishuDocumentPermissionChecker, "canReadSource"> | undefined;
}): Promise<ChatKnowledgeDraftGeneratorResult> {
  if (
    !readGate(input.canReadDocuments) ||
    input.documentSources === undefined ||
    input.snapshots === undefined ||
    input.permissionChecker === undefined
  ) return { status: "document_unavailable" };

  let sources: DocumentSource[];
  try {
    sources = await input.documentSources.listSourcesByGroupId(input.chatId);
  } catch {
    return { status: "document_unavailable" };
  }
  const candidates = selectDocumentCandidates({
    sources,
    chatId: input.chatId,
    observedAt: input.observedAt,
    referenceMessageId: input.referenceMessageId,
  });
  if (candidates.length !== 1) return { status: "document_unavailable" };
  const source = candidates[0]!;

  let liveReadable: boolean;
  try {
    liveReadable = await input.permissionChecker.canReadSource(source);
  } catch {
    return { status: "document_unavailable" };
  }
  if (!liveReadable) return { status: "document_unavailable" };

  let snapshot: Awaited<ReturnType<DocumentSnapshotRepository["findLatestSnapshotForSource"]>>;
  try {
    snapshot = await input.snapshots.findLatestSnapshotForSource(source.id);
  } catch {
    return { status: "document_unavailable" };
  }
  const body = snapshot?.fetchStatus === "succeeded"
    ? normalizeDocumentBody(snapshot.bodyText)
    : undefined;
  if (body === undefined) return { status: "document_unavailable" };
  if (
    !readContextGate(input.canReadGroupContext, input.chatId) ||
    !readGate(input.canReadDocuments)
  ) return { status: "document_unavailable" };

  let currentSource = source;
  if (source.permissionState === "unknown") {
    try {
      const attested = await input.documentSources.markPermissionStateIfCurrent({
        id: source.id,
        permissionState: "readable",
        expectedUpdatedAt: source.updatedAt,
      });
      if (attested === undefined) return { status: "document_unavailable" };
      currentSource = attested;
    } catch {
      return { status: "document_unavailable" };
    }
  }
  if (!isCurrentDocumentSource(currentSource, input.chatId)) {
    return { status: "document_unavailable" };
  }

  return {
    status: "generated",
    title: documentDraftTitle(currentSource, body),
    content: body,
    evidence: [{
      type: "document_source",
      id: currentSource.id,
      expectedUpdatedAt: new Date(currentSource.updatedAt),
    }],
  };
}

function selectDocumentCandidates(input: {
  sources: readonly DocumentSource[];
  chatId: string;
  observedAt: Date;
  referenceMessageId?: string;
}): DocumentSource[] {
  const observedMs = input.observedAt.getTime();
  return input.sources.filter((source) => {
    if (!isCurrentDocumentSource(source, input.chatId)) return false;
    const matchingEvidence = source.evidence.filter((evidence) => (
      evidence.kind === "group_message" &&
      evidence.groupId === input.chatId &&
      evidence.observedAt.getTime() <= observedMs
    ));
    if (input.referenceMessageId !== undefined) {
      return source.originMessageId === input.referenceMessageId ||
        matchingEvidence.some((evidence) => evidence.messageId === input.referenceMessageId);
    }
    return matchingEvidence.some((evidence) => (
      observedMs - evidence.observedAt.getTime() <= RECENT_DOCUMENT_LOOKBACK_MS
    ));
  });
}

function isCurrentDocumentSource(source: DocumentSource, chatId: string): boolean {
  return (
    source.syncState === "synced" &&
    (source.permissionState === "unknown" || source.permissionState === "readable") &&
    source.canUseForKnowledgeDrafts &&
    source.evidence.some((evidence) => (
      evidence.kind === "group_message" && evidence.groupId === chatId
    ))
  );
}

function normalizeDocumentBody(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const body = value.trim();
  return body.length > 0 && body.length <= KNOWLEDGE_DRAFT_CONTENT_MAX_CHARS
    ? body
    : undefined;
}

function documentDraftTitle(source: DocumentSource, body: string): string {
  const firstLine = body.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? "";
  const title = (source.title ?? firstLine).replace(/^#{1,6}\s+/u, "").trim();
  if (title.length === 0) return "文档知识草稿";
  return title.slice(0, KNOWLEDGE_DRAFT_TITLE_MAX_CHARS);
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

function readGate(read: () => boolean): boolean {
  try {
    return read();
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
