import type { EmbeddingProvider } from "../documents/document-semantic-indexer.js";
import type { EmbeddingProviderConfig } from "../config/env.js";

export type OpenAICompatibleEmbeddingProviderDependencies = {
  config: EmbeddingProviderConfig;
  fetch?: typeof fetch;
};

export function createOpenAICompatibleEmbeddingProvider({
  config,
  fetch = globalThis.fetch,
}: OpenAICompatibleEmbeddingProviderDependencies): EmbeddingProvider {
  return {
    async embedTexts(texts) {
      if (texts.length === 0) {
        return [];
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

      let response: Response;
      try {
        response = await fetch(joinBaseUrl(config.baseUrl, "/embeddings"), {
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
      } catch (error) {
        if (isAbortError(error)) {
          throw new Error("embedding provider request timed out");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }

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
    },
  };
}

function joinBaseUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}${path}`;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
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
