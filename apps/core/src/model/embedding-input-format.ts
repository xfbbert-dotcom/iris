import type { EmbeddingProvider } from "../documents/document-semantic-indexer.js";

const EMBEDDING_GEMMA_MODEL_PREFIX = "embeddinggemma:";

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
    format: (text) => `task: search result | query: ${text}`,
  });
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
