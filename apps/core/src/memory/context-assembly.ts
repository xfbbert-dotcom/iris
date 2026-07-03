export type BackgroundDocument = {
  source: string;
  text: string;
};

export type LiveChatMessage = {
  speaker: string;
  text: string;
};

export type PromptContextInput = {
  backgroundDocuments: BackgroundDocument[];
  liveChatMessages: LiveChatMessage[];
  liveChatLimit?: number;
};

const DEFAULT_LIVE_CHAT_LIMIT = 20;
const MAX_LIVE_CHAT_LIMIT = 20;
const MAX_BACKGROUND_DOCUMENT_LIMIT = 12;

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

  return [
    "<background_documents>",
    ...backgroundDocuments.map(formatBackgroundDocument),
    "</background_documents>",
    "",
    "<live_chat_context>",
    ...liveMessages.map(formatLiveChatMessage),
    "</live_chat_context>"
  ].join("\n");
}

function formatBackgroundDocument(document: BackgroundDocument): string {
  return `<document source="${escapeXml(document.source.trim())}">${escapeXml(
    document.text.trim(),
  )}</document>`;
}

function formatLiveChatMessage(message: LiveChatMessage): string {
  return `<message speaker="${escapeXml(message.speaker.trim())}">${escapeXml(
    message.text.trim(),
  )}</message>`;
}

function sanitizeLiveChatLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
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
