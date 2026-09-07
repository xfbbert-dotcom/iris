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
  parentMessageId?: string;
  rootMessageId?: string;
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
const MAX_HISTORY_PAGES = 2;
const MAX_HISTORY_MESSAGES = 100;
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
          const messagesById = new Map<string, FeishuChatHistoryMessage>();
          const seenPageTokens = new Set<string>();
          let pageToken: string | undefined;
          for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES; pageIndex += 1) {
            const cursorQuery = pageToken === undefined ? "" : `&page_token=${encodeURIComponent(pageToken)}`;
            const response = await fetch(
              `${baseUrl.replace(/\/+$/u, "")}/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chatId)}&page_size=${MAX_HISTORY_PAGE_ITEMS}&sort_type=ByCreateTimeDesc${cursorQuery}`,
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
            if (controller.signal.aborted) throw new FeishuChatHistoryError();
            const page = readHistoryPage(body);
            for (const item of page.items) {
              const message = readHistoryMessage(item, chatId);
              if (message === undefined) continue;
              const previous = messagesById.get(message.messageId);
              if (previous === undefined || previous.sentAt.getTime() < message.sentAt.getTime()) {
                messagesById.set(message.messageId, message);
              }
            }

            if (messagesById.size >= limit || !page.hasMore) break;
            const nextPageToken = readIdentifier(page.pageToken);
            if (nextPageToken === undefined || seenPageTokens.has(nextPageToken)) {
              throw new FeishuChatHistoryError();
            }
            seenPageTokens.add(nextPageToken);
            pageToken = nextPageToken;
          }

          return [...messagesById.values()]
            .sort((left, right) => right.sentAt.getTime() - left.sentAt.getTime())
            .slice(0, limit);
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        throw new FeishuChatHistoryError();
      }
    },
  };
}

function readHistoryPage(body: unknown): { items: unknown[]; hasMore: boolean; pageToken: unknown } {
  if (
    !isRecord(body) || body.code !== 0 || !isRecord(body.data) ||
    !Array.isArray(body.data.items) || body.data.items.length > MAX_HISTORY_PAGE_ITEMS ||
    typeof body.data.has_more !== "boolean"
  ) {
    throw new FeishuChatHistoryError();
  }
  return { items: body.data.items, hasMore: body.data.has_more, pageToken: body.data.page_token };
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
  const parentMessageId = readIdentifier(value.parent_id);
  const rootMessageId = readIdentifier(value.root_id);
  return {
    messageId,
    chatId,
    senderId,
    text,
    sentAt,
    ...(parentMessageId === undefined ? {} : { parentMessageId }),
    ...(rootMessageId === undefined ? {} : { rootMessageId }),
  };
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
