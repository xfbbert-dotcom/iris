import type { EmbeddingProvider } from "../documents/document-semantic-indexer.js";

const EMBEDDING_GEMMA_MODEL_PREFIX = "embeddinggemma:";
const EMBEDDING_GEMMA_QUERY_MAX_BYTES = 512;

export function createDocumentEmbeddingProvider({
  model,
  delegate,
}: {
  model: string;
  delegate: EmbeddingProvider;
}): EmbeddingProvider {
  return createFormattedEmbeddingProvider({
    model,
    delegate,
    format: (text) => `title: none | text: ${text}`,
  });
}

export function createQueryEmbeddingProvider({
  model,
  delegate,
}: {
  model: string;
  delegate: EmbeddingProvider;
}): EmbeddingProvider {
  return createFormattedEmbeddingProvider({
    model,
    delegate,
    // Bound only search vectors for the small local runner, not answer evidence
    // or stored document vectors (which would require reindexing).
    format: (text) => truncateUtf8(
      `task: search result | query: ${text}`,
      EMBEDDING_GEMMA_QUERY_MAX_BYTES,
    ),
  });
}

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of text) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > maxBytes) break;
    result += character;
  }
  return result;
}

function createFormattedEmbeddingProvider({
  model,
  delegate,
  format,
}: {
  model: string;
  delegate: EmbeddingProvider;
  format: (text: string) => string;
}): EmbeddingProvider {
  if (!model.startsWith(EMBEDDING_GEMMA_MODEL_PREFIX)) {
    return delegate;
  }

  return {
    embedTexts(texts) {
      return delegate.embedTexts(texts.map(format));
    },
  };
}
