import { readPositiveSafeInteger } from "../config/numeric-guards.js";
import { readBoundedJsonResponse } from "../integrations/bounded-json-response.js";
import type { FeishuTenantAccessTokenProvider } from "./feishu-tenant-access-token-provider.js";

export type FeishuBotChatAccessChecker = {
  canAccessChat(input: { chatId: string }): Promise<boolean>;
};

export type FeishuBotChatAccessCheckerDependencies = {
  baseUrl: string;
  tokenProvider: FeishuTenantAccessTokenProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class FeishuBotChatAccessError extends Error {
  readonly code = "membership_unavailable";

  constructor() {
    super("Feishu bot chat access unavailable");
    this.name = "FeishuBotChatAccessError";
  }
}

const DEFAULT_FEISHU_BOT_CHAT_ACCESS_TIMEOUT_MS = 10_000;
const MAX_FEISHU_IDENTIFIER_CHARS = 512;
const MAX_FEISHU_CHAT_RESPONSE_BYTES = 65_536;
const AUTHORITATIVE_DENIAL_STATUS_CODES = new Set([400, 403, 404]);

export function createFeishuBotChatAccessChecker({
  baseUrl,
  tokenProvider,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_FEISHU_BOT_CHAT_ACCESS_TIMEOUT_MS,
}: FeishuBotChatAccessCheckerDependencies): FeishuBotChatAccessChecker {
  const safeTimeoutMs = readPositiveSafeInteger(
    timeoutMs,
    "Feishu bot chat access timeoutMs",
  );

  return {
    async canAccessChat(input) {
      try {
        const chatId = readIdentifier(input.chatId);
        const tenantAccessToken = await tokenProvider.getTenantAccessToken();
        const { response, responseBody } = await requestChat({
          baseUrl,
          chatId,
          tenantAccessToken,
          fetch,
          timeoutMs: safeTimeoutMs,
        });

        if (AUTHORITATIVE_DENIAL_STATUS_CODES.has(response.status)) {
          return false;
        }
        if (!response.ok) {
          throw new FeishuBotChatAccessError();
        }
        if (!isRecord(responseBody) || typeof responseBody.code !== "number") {
          throw new FeishuBotChatAccessError();
        }
        if (responseBody.code !== 0) {
          return false;
        }
        if (!isRecord(responseBody.data)) {
          throw new FeishuBotChatAccessError();
        }
        return true;
      } catch (error) {
        if (error instanceof FeishuBotChatAccessError) {
          throw error;
        }
        throw new FeishuBotChatAccessError();
      }
    },
  };
}

async function requestChat({
  baseUrl,
  chatId,
  tenantAccessToken,
  fetch,
  timeoutMs,
}: {
  baseUrl: string;
  chatId: string;
  tenantAccessToken: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
}): Promise<{ response: Response; responseBody: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${trimTrailingSlash(baseUrl)}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${tenantAccessToken}` },
        signal: controller.signal,
      },
    );
    const responseBody = await readBoundedJsonResponse({
      response,
      invalidJsonErrorMessage: "Feishu bot chat response was not valid JSON",
      maxResponseBytes: MAX_FEISHU_CHAT_RESPONSE_BYTES,
      responseSizeErrorMessage:
        `Feishu bot chat response exceeds ${MAX_FEISHU_CHAT_RESPONSE_BYTES} bytes`,
    });
    return { response, responseBody };
  } finally {
    clearTimeout(timeout);
  }
}

function readIdentifier(value: unknown): string {
  if (typeof value !== "string") {
    throw new FeishuBotChatAccessError();
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_FEISHU_IDENTIFIER_CHARS) {
    throw new FeishuBotChatAccessError();
  }
  return normalized;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
