import type { EmbeddingProvider } from "../documents/document-semantic-indexer.js";
import type { EmbeddingProviderConfig } from "../config/env.js";
import { readPositiveSafeInteger } from "../config/numeric-guards.js";

export type OpenAICompatibleEmbeddingProviderDependencies = {
  config: EmbeddingProviderConfig;
  fetch?: typeof fetch;
};

export function createOpenAICompatibleEmbeddingProvider({
  config,
  fetch = globalThis.fetch,
}: OpenAICompatibleEmbeddingProviderDependencies): EmbeddingProvider {
  const timeoutMs = readPositiveSafeInteger(
    config.timeoutMs,
    "embedding provider timeoutMs",
  );

  return {
    async embedTexts(texts) {
      if (texts.length === 0) {
        return [];
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(joinBaseUrl(config.baseUrl, "/embeddings"), {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            input: texts,
            ...(config.dimensions === undefined ? {} : { dimensions: config.dimensions }),
          }),
          signal: controller.signal,
        });
        const responseBody = await readJsonResponse(response);

        if (!response.ok) {
          throw new Error(
            `embedding provider request failed with status ${response.status}: ${readErrorMessage(
              responseBody,
            )}`,
          );
        }

        const embeddings = readEmbeddingVectors(responseBody);
        if (embeddings.length !== texts.length) {
          throw new Error("embedding response count mismatch");
        }

        return embeddings;
      } catch (error) {
        if (isAbortError(error)) {
          throw new Error("embedding provider request timed out");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function joinBaseUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}${path}`;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new Error("embedding provider response was not valid JSON");
  }
}

function readEmbeddingVectors(responseBody: unknown): number[][] {
  if (!isRecord(responseBody) || !Array.isArray(responseBody.data)) {
    throw new Error("embedding provider response did not include embedding data");
  }

  const items = [...responseBody.data];
  if (items.every((item) => isRecord(item) && typeof item.index === "number")) {
    items.sort((a, b) => {
      const left = isRecord(a) && typeof a.index === "number" ? a.index : 0;
      const right = isRecord(b) && typeof b.index === "number" ? b.index : 0;
      return left - right;
    });
  }

  return items.map((item) => {
    if (!isRecord(item) || !Array.isArray(item.embedding)) {
      throw new Error("embedding provider response did not include embedding data");
    }

    return item.embedding.map((value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("embedding vector contains invalid value");
      }

      return value;
    });
  });
}

function readErrorMessage(responseBody: unknown): string {
  if (isRecord(responseBody) && isRecord(responseBody.error)) {
    const message = responseBody.error.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }

  return "unknown error";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
