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

export function createDocumentSemanticIndexer({
  chunker,
  embedder,
  embeddingProfileId,
  fragments,
}: {
  chunker: DocumentChunker;
  embedder: EmbeddingProvider;
  embeddingProfileId: string;
  fragments: Pick<DocumentFragmentRepository, "replaceFragmentsForSnapshot">;
}): DocumentSemanticIndexer {
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

      const embeddings = await embedder.embedTexts(chunks.map((chunk) => chunk.text));
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
