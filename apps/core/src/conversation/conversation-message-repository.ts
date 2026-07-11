export type ConversationMessage = {
  id: string;
  provider: "feishu";
  providerMessageId: string;
  chatId: string;
  senderId?: string;
  messageType: string;
  text?: string;
  sentAt: Date;
  rawEventIdempotencyKey: string;
  createdAt: Date;
};

export type UpsertConversationMessageInput = {
  provider: "feishu";
  providerMessageId: string;
  chatId: string;
  senderId?: string;
  messageType: string;
  text?: string;
  sentAt: Date;
  rawEventIdempotencyKey: string;
};

export interface ConversationMessageRepository {
  upsertMessage(input: UpsertConversationMessageInput): Promise<ConversationMessage>;
  listRecentByChat(input: { chatId: string; limit: number }): Promise<ConversationMessage[]>;
}
