import type { FeishuTenantAccessTokenProvider } from "./feishu-tenant-access-token-provider.js";
import { readPositiveSafeInteger } from "../config/numeric-guards.js";
import { readBoundedJsonResponse } from "../integrations/bounded-json-response.js";
import { readExternalErrorMessage } from "../integrations/external-error-message.js";

export type FeishuMessageReplier = {
  replyText(input: {
    messageId: string;
    text: string;
    uuid?: string;
    replyInThread?: boolean;
  }): Promise<{ replyMessageId?: string }>;
};

export type FeishuMessageReplierDependencies = {
  baseUrl: string;
  tokenProvider: FeishuTenantAccessTokenProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_FEISHU_MESSAGE_REPLY_TIMEOUT_MS = 10_000;
const MAX_FEISHU_REPLY_MESSAGE_ID_CHARS = 512;
const MAX_FEISHU_REPLY_TEXT_CHARS = 8000;
const MAX_FEISHU_REPLY_UUID_CHARS = 50;
const MAX_FEISHU_REPLY_RESPONSE_BYTES = 65_536;

export function createFeishuMessageReplier({
  baseUrl,
  tokenProvider,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_FEISHU_MESSAGE_REPLY_TIMEOUT_MS,
}: FeishuMessageReplierDependencies): FeishuMessageReplier {
  const safeTimeoutMs = readPositiveSafeInteger(timeoutMs, "Feishu message reply timeoutMs");

  return {
    async replyText(input) {
      const messageId = normalizeRequiredString(
        "messageId",
        input.messageId,
        MAX_FEISHU_REPLY_MESSAGE_ID_CHARS,
      );
      const text = normalizeRequiredString("text", input.text, MAX_FEISHU_REPLY_TEXT_CHARS);
      const uuid =
        input.uuid === undefined
          ? undefined
          : normalizeRequiredString("uuid", input.uuid, MAX_FEISHU_REPLY_UUID_CHARS);
      const tenantAccessToken = await tokenProvider.getTenantAccessToken();

      const { response, responseBody } = await fetchJsonWithTimeout({
        fetch,
        url: `${trimTrailingSlash(baseUrl)}/open-apis/im/v1/messages/${encodeURIComponent(
          messageId,
        )}/reply`,
        init: {
          method: "POST",
          headers: {
            authorization: `Bearer ${tenantAccessToken}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(buildTextReplyBody({
            text,
            uuid,
            replyInThread: input.replyInThread,
          })),
        },
        timeoutMs: safeTimeoutMs,
      });

      if (!response.ok) {
        throw new Error(
          `Feishu message reply request failed with status ${
            response.status
          }: ${readExternalErrorMessage(responseBody)}`,
        );
      }

      return { replyMessageId: readSuccessfulReplyMessageId(responseBody) };
    },
  };
}

function buildTextReplyBody({
  text,
  uuid,
  replyInThread,
}: {
  text: string;
  uuid: string | undefined;
  replyInThread: boolean | undefined;
}): Record<string, unknown> {
  return {
    msg_type: "text",
    content: JSON.stringify({ text }),
    ...(replyInThread === undefined ? {} : { reply_in_thread: replyInThread }),
    ...(uuid === undefined ? {} : { uuid }),
  };
}

async function fetchJsonWithTimeout({
  fetch,
  url,
  init,
  timeoutMs,
}: {
  fetch: typeof globalThis.fetch;
  url: string;
  init: RequestInit;
  timeoutMs: number;
}): Promise<{ response: Response; responseBody: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const responseBody = await readBoundedJsonResponse({
      response,
      invalidJsonErrorMessage: "Feishu message reply response was not valid JSON",
      maxResponseBytes: MAX_FEISHU_REPLY_RESPONSE_BYTES,
      responseSizeErrorMessage: `Feishu message reply response exceeds ${MAX_FEISHU_REPLY_RESPONSE_BYTES} bytes`,
    });

    return { response, responseBody };
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error("Feishu message reply request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function readSuccessfulReplyMessageId(responseBody: unknown): string | undefined {
  if (!isRecord(responseBody)) {
    throw new Error("Feishu message reply response did not include code");
  }

  const code = responseBody.code;
  if (typeof code !== "number") {
    throw new Error("Feishu message reply response did not include code");
  }
  if (code !== 0) {
    throw new Error(`Feishu message reply request failed: ${readExternalErrorMessage(responseBody)}`);
  }

  if (!isRecord(responseBody) || !isRecord(responseBody.data)) {
    return undefined;
  }

  const messageId = responseBody.data.message_id;
  return typeof messageId === "string" && messageId.trim().length > 0
    ? messageId.trim()
    : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function normalizeRequiredString(fieldName: string, value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} must not be blank`);
  }
  if (trimmed.length > maxChars) {
    throw new Error(`${fieldName} must be at most ${maxChars} characters`);
  }

  return trimmed;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
