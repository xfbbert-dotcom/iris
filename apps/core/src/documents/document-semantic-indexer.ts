import type { DocumentChunk, DocumentChunker } from "./document-chunker.js";
import type { DocumentFragmentRepository } from "./document-fragment-repository.js";
import type { DocumentSnapshot } from "./document-snapshot-repository.js";

export interface EmbeddingProvider {
  embedTexts(texts: string[]): Promise<number[][]>;
}

export type DocumentSemanticIndexResult =
  | { status: "indexed"; snapshotId: string; fragmentCount: number }
  | { status: "skipped"; snapshotId: string; reason: "snapshot_not_successful" | "empty_body" };

export interface DocumentSemanticIndexer {
  indexSnapshot(snapshot: DocumentSnapshot): Promise<DocumentSemanticIndexResult>;
}

const DEFAULT_EMBEDDING_BATCH_SIZE = 64;

export function createDocumentSemanticIndexer({
  chunker,
  embedder,
  embeddingProfileId,
  fragments,
  embeddingBatchSize = DEFAULT_EMBEDDING_BATCH_SIZE,
}: {
  chunker: DocumentChunker;
  embedder: EmbeddingProvider;
  embeddingProfileId: string;
  fragments: Pick<DocumentFragmentRepository, "replaceFragmentsForSnapshot">;
  embeddingBatchSize?: number;
}): DocumentSemanticIndexer {
  const safeEmbeddingBatchSize = sanitizePositiveSafeInteger(
    "embeddingBatchSize",
    embeddingBatchSize,
  );

  return {
    async indexSnapshot(snapshot) {
      if (snapshot.fetchStatus !== "succeeded") {
        return { status: "skipped", snapshotId: snapshot.id, reason: "snapshot_not_successful" };
      }
      if (snapshot.bodyText === undefined || snapshot.bodyText.trim().length === 0) {
        return { status: "skipped", snapshotId: snapshot.id, reason: "empty_body" };
      }

      const chunks = chunker.chunkText(snapshot.bodyText);
      if (chunks.length === 0) {
        return { status: "skipped", snapshotId: snapshot.id, reason: "empty_body" };
      }

      const embeddings = await embedChunksInBatches({
        chunks,
        embedder,
        batchSize: safeEmbeddingBatchSize,
      });
      validateEmbeddings(chunks, embeddings);

      await fragments.replaceFragmentsForSnapshot({
        documentSourceId: snapshot.documentSourceId,
        documentSnapshotId: snapshot.id,
        sourceUri: snapshot.sourceUri,
        embeddingProfileId,
        chunks,
        embeddings,
      });

      return { status: "indexed", snapshotId: snapshot.id, fragmentCount: chunks.length };
    },
  };
}

async function embedChunksInBatches({
  chunks,
  embedder,
  batchSize,
}: {
  chunks: DocumentChunk[];
  embedder: EmbeddingProvider;
  batchSize: number;
}): Promise<number[][]> {
  const embeddings: number[][] = [];

  for (let index = 0; index < chunks.length; index += batchSize) {
    const batch = chunks.slice(index, index + batchSize);
    const batchEmbeddings = await embedder.embedTexts(batch.map((chunk) => chunk.text));
    if (batchEmbeddings.length !== batch.length) {
      throw new Error("embedding count mismatch");
    }
    embeddings.push(...batchEmbeddings);
  }

  return embeddings;
}

function validateEmbeddings(chunks: DocumentChunk[], embeddings: number[][]): void {
  if (embeddings.length !== chunks.length) {
    throw new Error("embedding count mismatch");
  }

  for (const vector of embeddings) {
    if (vector.length === 0) {
      throw new Error("embedding vector must not be empty");
    }
    for (const value of vector) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("embedding vector contains invalid value");
      }
    }
  }
}

function sanitizePositiveSafeInteger(fieldName: string, value: number): number {
  if (!Number.isInteger(value) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive safe integer`);
  }

  return value;
}
