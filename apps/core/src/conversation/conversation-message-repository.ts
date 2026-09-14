export type ConversationMessageMention = {
  key: string;
  openId: string;
};

const MAX_CONVERSATION_MESSAGE_TEXT_CHARS = 8000;
const CONVERSATION_MESSAGE_TRUNCATION_MARKER = " ... [truncated]";

export function normalizeConversationMessageTextForStorage(
  value: string | undefined,
): string | null {
  if (value === undefined) return null;
  if (value.length <= MAX_CONVERSATION_MESSAGE_TEXT_CHARS) return value;

  const prefixChars = MAX_CONVERSATION_MESSAGE_TEXT_CHARS
    - CONVERSATION_MESSAGE_TRUNCATION_MARKER.length;
  return `${value.slice(0, prefixChars).trimEnd()}${CONVERSATION_MESSAGE_TRUNCATION_MARKER}`;
}

export type ConversationMessage = {
  id: string;
  provider: "feishu";
  providerMessageId: string;
  chatId: string;
  senderId?: string;
  senderOpenId?: string;
  senderUnionId?: string;
  senderUserId?: string;
  messageType: string;
  text?: string;
  mentions?: ConversationMessageMention[];
  sentAt: Date;
  rawEventIdempotencyKey: string;
  createdAt: Date;
};

export type UpsertConversationMessageInput = {
  provider: "feishu";
  providerMessageId: string;
  chatId: string;
  senderId?: string;
  senderOpenId?: string;
  senderUnionId?: string;
  senderUserId?: string;
  messageType: string;
  text?: string;
  mentions?: ConversationMessageMention[];
  sentAt: Date;
  rawEventIdempotencyKey: string;
};

export type ConversationMessageEvidence = ConversationMessage & {
  tombstoned: boolean;
};

export interface ConversationMessageRepository {
  upsertMessage(input: UpsertConversationMessageInput): Promise<ConversationMessage>;
  listRecentByChat(input: { chatId: string; limit: number }): Promise<ConversationMessage[]>;
  findByIds(input: {
    chatId: string;
    ids: readonly string[];
  }): Promise<ConversationMessageEvidence[]>;
}
