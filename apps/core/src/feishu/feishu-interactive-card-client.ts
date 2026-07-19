import type { FeishuTenantAccessTokenProvider } from "./feishu-tenant-access-token-provider.js";
import { readPositiveSafeInteger } from "../config/numeric-guards.js";
import { readBoundedJsonResponse } from "../integrations/bounded-json-response.js";

export type FeishuInteractiveCardClient = {
  sendCard(input: { chatId: string; cardJson: string; uuid: string }): Promise<{ messageId: string }>;
  updateCard(input: { messageId: string; cardJson: string }): Promise<void>;
};

export type FeishuInteractiveCardClientDependencies = {
  baseUrl: string;
  tokenProvider: FeishuTenantAccessTokenProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type FeishuInteractiveCardClientErrorClassification =
  | "request_not_sent"
  | "remote_rejected"
  | "retryable_remote_failure"
  | "outcome_unknown";

export class FeishuInteractiveCardClientError extends Error {
  constructor(
    readonly classification: FeishuInteractiveCardClientErrorClassification,
    readonly code: string,
  ) {
    super(`Feishu interactive card request failed (${classification}:${code})`);
    this.name = "FeishuInteractiveCardClientError";
  }
}

const DEFAULT_FEISHU_INTERACTIVE_CARD_TIMEOUT_MS = 10_000;
const MAX_FEISHU_IDENTIFIER_CHARS = 512;
const MAX_FEISHU_CARD_UUID_CHARS = 50;
const MAX_FEISHU_CARD_JSON_BYTES = 24 * 1024;
const MAX_FEISHU_CARD_RESPONSE_BYTES = 65_536;

export function createFeishuInteractiveCardClient({
  baseUrl,
  tokenProvider,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_FEISHU_INTERACTIVE_CARD_TIMEOUT_MS,
}: FeishuInteractiveCardClientDependencies): FeishuInteractiveCardClient {
  const safeTimeoutMs = readPositiveSafeInteger(
    timeoutMs,
    "Feishu interactive card timeoutMs",
  );

  return {
    async sendCard(input) {
      const chatId = readRequiredIdentifier(input.chatId);
      const cardJson = readCardJson(input.cardJson);
      const uuid = readUuid(input.uuid);
      const tenantAccessToken = await readTenantAccessToken(tokenProvider);
      const responseBody = await requestFeishuJson({
        fetch,
        url: `${trimTrailingSlash(baseUrl)}/open-apis/im/v1/messages?receive_id_type=chat_id`,
        init: {
          method: "POST",
          headers: {
            authorization: `Bearer ${tenantAccessToken}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            receive_id: chatId,
            msg_type: "interactive",
            content: cardJson,
            uuid,
          }),
        },
        timeoutMs: safeTimeoutMs,
      });

      return { messageId: readSentMessageId(responseBody) };
    },

    async updateCard(input) {
      const messageId = readRequiredIdentifier(input.messageId);
      const cardJson = readCardJson(input.cardJson);
      const tenantAccessToken = await readTenantAccessToken(tokenProvider);
      const responseBody = await requestFeishuJson({
        fetch,
        url: `${trimTrailingSlash(baseUrl)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        init: {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${tenantAccessToken}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({ content: cardJson }),
        },
        timeoutMs: safeTimeoutMs,
      });

      assertSuccessfulFeishuResponse(responseBody);
    },
  };
}

async function readTenantAccessToken(tokenProvider: FeishuTenantAccessTokenProvider): Promise<string> {
  try {
    return await tokenProvider.getTenantAccessToken();
  } catch {
    throw new FeishuInteractiveCardClientError("request_not_sent", "token_unavailable");
  }
}

async function requestFeishuJson({
  fetch,
  url,
  init,
  timeoutMs,
}: {
  fetch: typeof globalThis.fetch;
  url: string;
  init: RequestInit;
  timeoutMs: number;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw new FeishuInteractiveCardClientError("outcome_unknown", "timeout");
      }
      throw new FeishuInteractiveCardClientError("outcome_unknown", "network_failure");
    }

    if (!response.ok) {
      throw httpError(response.status);
    }

    let responseBody: unknown;
    try {
      responseBody = await readBoundedJsonResponse({
        response,
        invalidJsonErrorMessage: "Feishu interactive card response was not valid JSON",
        maxResponseBytes: MAX_FEISHU_CARD_RESPONSE_BYTES,
        responseSizeErrorMessage: `Feishu interactive card response exceeds ${MAX_FEISHU_CARD_RESPONSE_BYTES} bytes`,
      });
    } catch {
      throw new FeishuInteractiveCardClientError("outcome_unknown", "invalid_response");
    }

    return responseBody;
  } finally {
    clearTimeout(timeout);
  }
}

function readSentMessageId(responseBody: unknown): string {
  assertSuccessfulFeishuResponse(responseBody);
  if (!isRecord(responseBody) || !isRecord(responseBody.data)) {
    throw new FeishuInteractiveCardClientError("outcome_unknown", "invalid_response");
  }

  try {
    return readRequiredIdentifier(responseBody.data.message_id);
  } catch {
    throw new FeishuInteractiveCardClientError("outcome_unknown", "invalid_response");
  }
}

function assertSuccessfulFeishuResponse(responseBody: unknown): void {
  if (!isRecord(responseBody) || typeof responseBody.code !== "number") {
    throw new FeishuInteractiveCardClientError("outcome_unknown", "invalid_response");
  }
  if (responseBody.code !== 0) {
    throw new FeishuInteractiveCardClientError("remote_rejected", boundedFeishuCode(responseBody.code));
  }
}

function httpError(status: number): FeishuInteractiveCardClientError {
  const code = boundedHttpCode(status);
  if (status === 429 || status >= 500) {
    return new FeishuInteractiveCardClientError("retryable_remote_failure", code);
  }
  return new FeishuInteractiveCardClientError("remote_rejected", code);
}

function readRequiredIdentifier(value: unknown): string {
  return readBoundedRequiredString(value, MAX_FEISHU_IDENTIFIER_CHARS);
}

function readUuid(value: unknown): string {
  return readBoundedRequiredString(value, MAX_FEISHU_CARD_UUID_CHARS);
}

function readCardJson(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FeishuInteractiveCardClientError("request_not_sent", "invalid_input");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_FEISHU_CARD_JSON_BYTES) {
    throw new FeishuInteractiveCardClientError("request_not_sent", "invalid_input");
  }
  return value;
}

function readBoundedRequiredString(value: unknown, maxChars: number): string {
  if (typeof value !== "string") {
    throw new FeishuInteractiveCardClientError("request_not_sent", "invalid_input");
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxChars) {
    throw new FeishuInteractiveCardClientError("request_not_sent", "invalid_input");
  }
  return normalized;
}

function boundedFeishuCode(code: number): string {
  return Number.isSafeInteger(code) && code > 0 && code <= 999_999_999
    ? `feishu_${code}`
    : "feishu_unknown";
}

function boundedHttpCode(status: number): string {
  return Number.isSafeInteger(status) && status >= 100 && status <= 599
    ? `http_${status}`
    : "http_unknown";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
