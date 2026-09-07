import type { FeishuTenantAccessTokenProvider } from "./feishu-tenant-access-token-provider.js";
import { readPositiveSafeInteger } from "../config/numeric-guards.js";
import { readBoundedJsonResponse } from "../integrations/bounded-json-response.js";
import { readFeishuMessageText } from "./feishu-message-text.js";

export type FeishuChatHistoryMessage = {
  messageId: string;
  chatId: string;
  senderId: string;
  text: string;
  sentAt: Date;
};

export type FeishuChatHistoryReader = {
  listRecentMessages(input: { chatId: string; limit: number }): Promise<FeishuChatHistoryMessage[]>;
};

export type FeishuChatHistoryReaderDependencies = {
  baseUrl: string;
  tokenProvider: FeishuTenantAccessTokenProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class FeishuChatHistoryError extends Error {
  readonly code = "history_unavailable";

  constructor() {
    super("Feishu chat history unavailable");
    this.name = "FeishuChatHistoryError";
  }
}

const DEFAULT_HISTORY_TIMEOUT_MS = 10_000;
const MAX_HISTORY_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_PAGE_ITEMS = 50;
const MAX_HISTORY_MESSAGES = 20;
const MAX_FEISHU_IDENTIFIER_CHARS = 512;

export function createFeishuChatHistoryReader({
  baseUrl,
  tokenProvider,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_HISTORY_TIMEOUT_MS,
}: FeishuChatHistoryReaderDependencies): FeishuChatHistoryReader {
  const safeTimeoutMs = readPositiveSafeInteger(timeoutMs, "Feishu chat history timeoutMs");

  return {
    async listRecentMessages(input) {
      const limit = Number.isFinite(input.limit)
        ? Math.max(0, Math.min(MAX_HISTORY_MESSAGES, Math.floor(input.limit)))
        : 0;
      if (limit === 0) return [];

      try {
        const chatId = readIdentifier(input.chatId);
        if (chatId === undefined) throw new FeishuChatHistoryError();

        const tenantAccessToken = await tokenProvider.getTenantAccessToken();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), safeTimeoutMs);
        try {
          const response = await fetch(
            `${baseUrl.replace(/\/+$/u, "")}/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chatId)}&page_size=${MAX_HISTORY_PAGE_ITEMS}&sort_type=ByCreateTimeDesc`,
            {
              method: "GET",
              headers: { authorization: `Bearer ${tenantAccessToken}` },
              signal: controller.signal,
            },
          );
          if (!response.ok) throw new FeishuChatHistoryError();
          const body = await readBoundedJsonResponse({
            response,
            invalidJsonErrorMessage: "Feishu chat history unavailable",
            maxResponseBytes: MAX_HISTORY_RESPONSE_BYTES,
            responseSizeErrorMessage: "Feishu chat history unavailable",
          });

          const messages = readHistoryPage(body)
            .flatMap((item) => {
              const message = readHistoryMessage(item, chatId);
              return message === undefined ? [] : [message];
            })
            .sort((left, right) => right.sentAt.getTime() - left.sentAt.getTime());
          const seen = new Set<string>();
          return messages.filter((message) => {
            if (seen.has(message.messageId)) return false;
            seen.add(message.messageId);
            return true;
          }).slice(0, limit);
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        throw new FeishuChatHistoryError();
      }
    },
  };
}

function readHistoryPage(body: unknown): unknown[] {
  if (
    !isRecord(body) || body.code !== 0 || !isRecord(body.data) ||
    !Array.isArray(body.data.items) || body.data.items.length > MAX_HISTORY_PAGE_ITEMS ||
    typeof body.data.has_more !== "boolean"
  ) {
    throw new FeishuChatHistoryError();
  }
  // The newest page is the complete request budget, even when has_more is true.
  return body.data.items;
}

function readHistoryMessage(value: unknown, chatId: string): FeishuChatHistoryMessage | undefined {
  if (
    !isRecord(value) || value.chat_id !== chatId || value.deleted !== false ||
    !isRecord(value.sender) || value.sender.sender_type !== "user" ||
    !isRecord(value.body) || typeof value.msg_type !== "string"
  ) return undefined;

  const messageId = readIdentifier(value.message_id);
  const senderId = readIdentifier(value.sender.id);
  const sentAt = readTimestamp(value.create_time);
  const text = readFeishuMessageText(value.msg_type, value.body.content);
  if (messageId === undefined || senderId === undefined || sentAt === undefined || text === undefined) {
    return undefined;
  }
  return { messageId, chatId, senderId, text, sentAt };
}

function readIdentifier(value: unknown): string | undefined {
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length > MAX_FEISHU_IDENTIFIER_CHARS || value !== value.trim()
  ) return undefined;
  return value;
}

function readTimestamp(value: unknown): Date | undefined {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined;
  const millis = Number(value);
  if (!Number.isSafeInteger(millis) || millis <= 0) return undefined;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
