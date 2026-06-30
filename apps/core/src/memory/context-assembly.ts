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
  const liveChatLimit = input.liveChatLimit ?? 20;
  const liveMessages = input.liveChatMessages.slice(-liveChatLimit);

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

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
