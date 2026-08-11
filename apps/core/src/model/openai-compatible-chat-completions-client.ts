import type { ModelProviderConfig } from "../config/env.js";
import { readPositiveSafeInteger } from "../config/numeric-guards.js";
import { readBoundedJsonResponse } from "../integrations/bounded-json-response.js";
import { readExternalErrorMessage } from "../integrations/external-error-message.js";
import { ModelProviderHttpError } from "./model-provider-error.js";

const MAX_MODEL_RESPONSE_BYTES = 262_144;
const MAX_MODEL_RESPONSE_FORMAT_BYTES = 32_768;
const MAX_MODEL_REQUEST_ATTEMPTS = 2;
const MODEL_RETRY_BASE_DELAY_MS = 750;
const MODEL_RETRY_JITTER_MS = 250;
const RETRYABLE_MODEL_HTTP_STATUSES = new Set([408, 500, 502, 503, 504]);

export type OpenAICompatibleChatMessage = {
  role: "system" | "user";
  content: string;
};

export type OpenAICompatibleJsonSchemaResponseFormat = {
  type: "json_schema";
  json_schema: {
    name: string;
    strict: true;
    schema: Record<string, unknown>;
  };
};

export type OpenAICompatibleChatCompletionOptions = {
  responseFormat?: OpenAICompatibleJsonSchemaResponseFormat;
};

export interface OpenAICompatibleChatCompletionsClient {
  complete(
    messages: readonly OpenAICompatibleChatMessage[],
    options?: OpenAICompatibleChatCompletionOptions,
  ): Promise<string>;
}

export type OpenAICompatibleChatCompletionsClientDependencies = {
  config: ModelProviderConfig;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  scheduleTimeout?: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  cancelTimeout?: (timeout: ReturnType<typeof setTimeout>) => void;
};

export function createOpenAICompatibleChatCompletionsClient({
  config,
  fetch = globalThis.fetch,
  sleep = sleepWithTimer,
  random = Math.random,
  now = Date.now,
  scheduleTimeout = scheduleTimer,
  cancelTimeout = cancelTimer,
}: OpenAICompatibleChatCompletionsClientDependencies): OpenAICompatibleChatCompletionsClient {
  const timeoutMs = readPositiveSafeInteger(config.timeoutMs, "model provider timeoutMs");

  return {
    async complete(messages, options) {
      const deadlineAt = now() + timeoutMs;
      const responseFormat = normalizeResponseFormat(options?.responseFormat);
      for (let attempt = 0; attempt < MAX_MODEL_REQUEST_ATTEMPTS; attempt += 1) {
        const remainingMs = deadlineAt - now();
        if (remainingMs <= 0) {
          throw new Error("model provider request timed out");
        }

        try {
          return await completeAttempt({
            fetch,
            url: joinBaseUrl(config.baseUrl, "/chat/completions"),
            headers: {
              authorization: `Bearer ${config.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: config.model,
              messages,
              ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
            }),
            timeoutMs: remainingMs,
            scheduleTimeout,
            cancelTimeout,
          });
        } catch (error) {
          if (isAbortError(error)) {
            throw new Error("model provider request timed out");
          }
          if (
            attempt + 1 < MAX_MODEL_REQUEST_ATTEMPTS &&
            isRetryableModelRequestError(error)
          ) {
            const retryDelayMs = readRetryDelayMs(random);
            if (deadlineAt - now() <= retryDelayMs) {
              throw unwrapModelTransportError(error);
            }
            await sleep(retryDelayMs);
            if (deadlineAt - now() <= 0) {
              throw unwrapModelTransportError(error);
            }
            continue;
          }
          throw unwrapModelTransportError(error);
        }
      }

      throw new Error("model provider request attempts exhausted");
    },
  };
}

function normalizeResponseFormat(
  value: OpenAICompatibleJsonSchemaResponseFormat | undefined,
): OpenAICompatibleJsonSchemaResponseFormat | undefined {
  if (value === undefined) return undefined;
  if (
    value.type !== "json_schema" ||
    value.json_schema.strict !== true ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value.json_schema.name) ||
    !isRecord(value.json_schema.schema) ||
    Array.isArray(value.json_schema.schema)
  ) {
    throw new Error("model provider response format is invalid");
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("model provider response format is invalid");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_MODEL_RESPONSE_FORMAT_BYTES) {
    throw new Error(
      `model provider response format exceeds ${MAX_MODEL_RESPONSE_FORMAT_BYTES} bytes`,
    );
  }
  return JSON.parse(serialized) as OpenAICompatibleJsonSchemaResponseFormat;
}

class OpenAICompatibleChatHttpError extends ModelProviderHttpError {
  readonly responseBodyWasReadable: boolean;

  constructor(statusCode: number, message: string, responseBodyWasReadable: boolean) {
    super(statusCode, message);
    this.responseBodyWasReadable = responseBodyWasReadable;
  }
}

class ModelProviderTransportError extends Error {
  readonly originalError: TypeError;

  constructor(originalError: TypeError) {
    super(originalError.message);
    this.name = "ModelProviderTransportError";
    this.originalError = originalError;
  }
}

async function completeAttempt({
  fetch,
  url,
  headers,
  body,
  timeoutMs,
  scheduleTimeout,
  cancelTimeout,
}: {
  fetch: typeof globalThis.fetch;
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  scheduleTimeout: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  cancelTimeout: (timeout: ReturnType<typeof setTimeout>) => void;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = scheduleTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchModelResponse({
      fetch,
      url,
      init: {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      },
    });
    if (!response.ok) {
      const errorResponse = await readOptionalErrorResponse(response);
      throw new OpenAICompatibleChatHttpError(
        response.status,
        `model provider request failed with status ${response.status}: ${readExternalErrorMessage(errorResponse.body)}`,
        errorResponse.wasReadable,
      );
    }

    return readAnswerContent(await readJsonResponse(response));
  } finally {
    cancelTimeout(timeout);
  }
}

async function fetchModelResponse({
  fetch,
  url,
  init,
}: {
  fetch: typeof globalThis.fetch;
  url: string;
  init: RequestInit;
}): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ModelProviderTransportError(error);
    }
    throw error;
  }
}

function isRetryableModelRequestError(error: unknown): boolean {
  return (
    error instanceof ModelProviderTransportError ||
    (error instanceof OpenAICompatibleChatHttpError &&
      error.responseBodyWasReadable &&
      RETRYABLE_MODEL_HTTP_STATUSES.has(error.statusCode))
  );
}

function unwrapModelTransportError(error: unknown): unknown {
  return error instanceof ModelProviderTransportError ? error.originalError : error;
}

function readRetryDelayMs(random: () => number): number {
  const normalizedRandom = Math.min(1, Math.max(0, random()));
  return MODEL_RETRY_BASE_DELAY_MS + Math.floor(normalizedRandom * MODEL_RETRY_JITTER_MS);
}

function joinBaseUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}${path}`;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  return readBoundedJsonResponse({
    response,
    invalidJsonErrorMessage: "model provider response was not valid JSON",
    maxResponseBytes: MAX_MODEL_RESPONSE_BYTES,
    responseSizeErrorMessage: `model provider response exceeds ${MAX_MODEL_RESPONSE_BYTES} bytes`,
  });
}

async function readOptionalErrorResponse(
  response: Response,
): Promise<{ body: unknown; wasReadable: boolean }> {
  try {
    return { body: await readJsonResponse(response), wasReadable: true };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return { body: undefined, wasReadable: false };
  }
}

function readAnswerContent(responseBody: unknown): string {
  if (!isRecord(responseBody) || !Array.isArray(responseBody.choices)) {
    throw new Error("model provider response did not include answer content");
  }
  const firstChoice = responseBody.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new Error("model provider response did not include answer content");
  }
  if (
    firstChoice.finish_reason !== undefined &&
    firstChoice.finish_reason !== null &&
    firstChoice.finish_reason !== "stop"
  ) {
    throw new Error("model provider response did not finish normally");
  }
  const content = firstChoice.message.content;
  if (typeof content !== "string") {
    throw new Error("model provider response did not include answer content");
  }
  return content;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleepWithTimer(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function scheduleTimer(
  callback: () => void,
  milliseconds: number,
): ReturnType<typeof setTimeout> {
  return setTimeout(callback, milliseconds);
}

function cancelTimer(timeout: ReturnType<typeof setTimeout>): void {
  clearTimeout(timeout);
}
