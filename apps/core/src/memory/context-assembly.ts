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

export function assemblePromptContext(input: PromptContextInput): string {
  const liveChatLimit = sanitizeLiveChatLimit(input.liveChatLimit);
  const liveMessages = liveChatLimit === 0
    ? []
    : input.liveChatMessages.slice(-liveChatLimit);

  return [
    "<background_documents>",
    ...input.backgroundDocuments.map(formatBackgroundDocument),
    "</background_documents>",
    "",
    "<live_chat_context>",
    ...liveMessages.map(formatLiveChatMessage),
    "</live_chat_context>"
  ].join("\n");
}

function formatBackgroundDocument(document: BackgroundDocument): string {
  return `<document source="${escapeXml(document.source)}">${escapeXml(document.text)}</document>`;
}

function formatLiveChatMessage(message: LiveChatMessage): string {
  return `<message speaker="${escapeXml(message.speaker)}">${escapeXml(message.text)}</message>`;
}

function sanitizeLiveChatLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 20;
  }

  return Math.max(0, Math.floor(value));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
