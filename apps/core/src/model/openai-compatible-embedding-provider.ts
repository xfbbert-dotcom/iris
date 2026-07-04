import type { EmbeddingProvider } from "../documents/document-semantic-indexer.js";
import type { EmbeddingProviderConfig } from "../config/env.js";
import { readPositiveSafeInteger } from "../config/numeric-guards.js";
import { readExternalErrorMessage } from "../integrations/external-error-message.js";

const MAX_EMBEDDING_INPUT_TEXTS = 64;

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
      if (texts.length > MAX_EMBEDDING_INPUT_TEXTS) {
        throw new Error(
          `embedding input batch must include at most ${MAX_EMBEDDING_INPUT_TEXTS} texts`,
        );
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
            `embedding provider request failed with status ${response.status}: ${readExternalErrorMessage(
              responseBody,
            )}`,
          );
        }

        const embeddings = readEmbeddingVectors(responseBody, config.dimensions);
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

function readEmbeddingVectors(
  responseBody: unknown,
  expectedDimensions: number | undefined,
): number[][] {
  if (!isRecord(responseBody) || !Array.isArray(responseBody.data)) {
    throw new Error("embedding provider response did not include embedding data");
  }

  const items = [...responseBody.data];
  const indexes = items.map((item) => (isRecord(item) ? item.index : undefined));
  if (indexes.some((index) => index !== undefined)) {
    const validIndexes = indexes.filter((index): index is number =>
      isValidEmbeddingResponseIndex(index, items.length),
    );
    if (validIndexes.length !== items.length || new Set(validIndexes).size !== items.length) {
      throw new Error("embedding response indices were invalid");
    }

    items.sort(
      (left, right) => readEmbeddingResponseIndex(left) - readEmbeddingResponseIndex(right),
    );
  }

  return items.map((item) => {
    if (!isRecord(item) || !Array.isArray(item.embedding)) {
      throw new Error("embedding provider response did not include embedding data");
    }

    const vector = item.embedding.map((value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("embedding vector contains invalid value");
      }

      return value;
    });

    if (expectedDimensions !== undefined && vector.length !== expectedDimensions) {
      throw new Error(
        `embedding vector length ${vector.length} does not match configured dimension ${expectedDimensions}`,
      );
    }

    return vector;
  });
}

function isValidEmbeddingResponseIndex(index: unknown, itemCount: number): index is number {
  return (
    typeof index === "number" &&
    Number.isInteger(index) &&
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < itemCount
  );
}

function readEmbeddingResponseIndex(item: unknown): number {
  if (!isRecord(item) || !isValidEmbeddingResponseIndex(item.index, Number.MAX_SAFE_INTEGER)) {
    throw new Error("embedding response indices were invalid");
  }

  return item.index;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
