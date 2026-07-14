import type {
  GroupMemoryCategory,
  GroupMemoryScope,
} from "./group-memory-repository.js";

export type BackgroundDocument = {
  source: string;
  text: string;
};

export type LiveChatMessage = {
  speaker: string;
  text: string;
};

export type PromptGroupMemory = {
  id: string;
  scope: GroupMemoryScope;
  category: GroupMemoryCategory;
  content: string;
  evidenceMessageIds: string[];
};

export type PromptContextInput = {
  backgroundDocuments: BackgroundDocument[];
  groupMemories?: PromptGroupMemory[];
  liveChatMessages: LiveChatMessage[];
  liveChatLimit?: number;
};

const DEFAULT_LIVE_CHAT_LIMIT = 20;
const MAX_LIVE_CHAT_LIMIT = 20;
const MAX_BACKGROUND_DOCUMENT_LIMIT = 12;
const MAX_BACKGROUND_DOCUMENT_SOURCE_ATTRIBUTE_CHARS = 512;
const MAX_BACKGROUND_DOCUMENT_TEXT_CHARS = 1200;
const MAX_GROUP_MEMORY_LIMIT = 8;
const MAX_GROUP_MEMORY_ID_ATTRIBUTE_CHARS = 512;
const MAX_GROUP_MEMORY_EVIDENCE_ATTRIBUTE_CHARS = 1024;
const MAX_GROUP_MEMORY_TEXT_CHARS = 600;
const MAX_LIVE_CHAT_SPEAKER_ATTRIBUTE_CHARS = 256;
const MAX_LIVE_CHAT_MESSAGE_TEXT_CHARS = 2000;
const TRUNCATION_MARKER = " ... [truncated]";

export function assemblePromptContext(input: PromptContextInput): string {
  const liveChatLimit = sanitizeLiveChatLimit(input.liveChatLimit);
  const backgroundDocuments = input.backgroundDocuments
    .filter(
      (document) => document.source.trim().length > 0 && document.text.trim().length > 0,
    )
    .slice(0, MAX_BACKGROUND_DOCUMENT_LIMIT);
  const meaningfulLiveChatMessages = input.liveChatMessages.filter(
    (message) => message.speaker.trim().length > 0 && message.text.trim().length > 0,
  );
  const liveMessages = liveChatLimit === 0
    ? []
    : meaningfulLiveChatMessages.slice(-liveChatLimit);
  const groupMemories = (input.groupMemories ?? [])
    .filter((memory) => memory.id.trim().length > 0 && memory.content.trim().length > 0)
    .slice(0, MAX_GROUP_MEMORY_LIMIT);

  return [
    "<background_documents>",
    ...backgroundDocuments.map(formatBackgroundDocument),
    "</background_documents>",
    "",
    "<group_memories>",
    ...groupMemories.map(formatGroupMemory),
    "</group_memories>",
    "",
    "<live_chat_context>",
    ...liveMessages.map(formatLiveChatMessage),
    "</live_chat_context>"
  ].join("\n");
}

function formatGroupMemory(memory: PromptGroupMemory): string {
  const evidenceMessageIds = memory.evidenceMessageIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .join(",");
  return `<memory id="${formatXmlAttribute(
    memory.id,
    MAX_GROUP_MEMORY_ID_ATTRIBUTE_CHARS,
  )}" scope="${memory.scope}" category="${memory.category}" evidence_message_ids="${formatXmlAttribute(
    evidenceMessageIds,
    MAX_GROUP_MEMORY_EVIDENCE_ATTRIBUTE_CHARS,
  )}">${formatXmlText(memory.content, MAX_GROUP_MEMORY_TEXT_CHARS)}</memory>`;
}

function formatBackgroundDocument(document: BackgroundDocument): string {
  return `<document source="${formatXmlAttribute(
    document.source,
    MAX_BACKGROUND_DOCUMENT_SOURCE_ATTRIBUTE_CHARS,
  )}">${formatXmlText(document.text, MAX_BACKGROUND_DOCUMENT_TEXT_CHARS)}</document>`;
}

function formatLiveChatMessage(message: LiveChatMessage): string {
  return `<message speaker="${formatXmlAttribute(
    message.speaker,
    MAX_LIVE_CHAT_SPEAKER_ATTRIBUTE_CHARS,
  )}">${formatXmlText(message.text, MAX_LIVE_CHAT_MESSAGE_TEXT_CHARS)}</message>`;
}

function formatXmlText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  const escaped = escapeXml(trimmed);
  if (escaped.length <= maxChars) {
    return escaped;
  }

  let low = 0;
  let high = trimmed.length;
  let best = escapeXml(TRUNCATION_MARKER);

  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = escapeXml(`${trimmed.slice(0, midpoint).trimEnd()}${TRUNCATION_MARKER}`);
    if (candidate.length <= maxChars) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function formatXmlAttribute(value: string, maxChars: number): string {
  const trimmed = value.trim();
  const escaped = escapeXml(trimmed);
  if (escaped.length <= maxChars) {
    return escaped;
  }

  let low = 0;
  let high = trimmed.length;
  let best = escapeXml(TRUNCATION_MARKER);

  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = escapeXml(`${trimmed.slice(0, midpoint).trimEnd()}${TRUNCATION_MARKER}`);
    if (candidate.length <= maxChars) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function sanitizeLiveChatLimit(value: number | undefined): number {
  if (
    value !== undefined &&
    (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("liveChatLimit must be a finite safe-magnitude number");
  }
  if (value === undefined) {
    return DEFAULT_LIVE_CHAT_LIMIT;
  }

  return Math.min(MAX_LIVE_CHAT_LIMIT, Math.max(0, Math.floor(value)));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
