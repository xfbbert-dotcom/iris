import { describe, expect, it, vi } from "vitest";

import { createDocumentChunker } from "../src/documents/document-chunker.js";
import {
  createDocumentSemanticIndexer,
  type EmbeddingProvider,
} from "../src/documents/document-semantic-indexer.js";
import type { DocumentSnapshot } from "../src/documents/document-snapshot-repository.js";

function snapshot(overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  return {
    id: "snapshot-1",
    documentSourceId: "source-1",
    sourceUri: "https://example.com/doc",
    fetchStatus: "succeeded",
    bodyText: "Alpha\n\nBeta",
    fetchedAt: new Date("2026-07-02T01:00:00.000Z"),
    createdAt: new Date("2026-07-02T01:00:00.000Z"),
    ...overrides,
  };
}

describe("DocumentSemanticIndexer", () => {
  it("chunks, embeds, and replaces fragments for a successful snapshot", async () => {
    const embedder: EmbeddingProvider = {
      embedTexts: vi.fn(async (texts: string[]) =>
        texts.map((text) => [text.length, 0, 0, 0, 0, 0]),
      ),
    };
    const fragments = {
      replaceFragmentsForSnapshot: vi.fn(async () => []),
    };
    const indexer = createDocumentSemanticIndexer({
      chunker: createDocumentChunker({ maxChunkChars: 80, minChunkChars: 20 }),
      embedder,
      fragments,
    });

    const result = await indexer.indexSnapshot(snapshot());

    expect(embedder.embedTexts).toHaveBeenCalledWith(["Alpha\n\nBeta"]);
    expect(fragments.replaceFragmentsForSnapshot).toHaveBeenCalledWith({
      documentSourceId: "source-1",
      documentSnapshotId: "snapshot-1",
      sourceUri: "https://example.com/doc",
      chunks: [{ chunkIndex: 0, text: "Alpha\n\nBeta" }],
      embeddings: [[11, 0, 0, 0, 0, 0]],
    });
    expect(result).toEqual({ status: "indexed", snapshotId: "snapshot-1", fragmentCount: 1 });
  });

  it("skips failed snapshots without embedding", async () => {
    const embedder = { embedTexts: vi.fn() };
    const fragments = { replaceFragmentsForSnapshot: vi.fn() };
    const indexer = createDocumentSemanticIndexer({
      chunker: createDocumentChunker(),
      embedder,
      fragments,
    });

    await expect(indexer.indexSnapshot(snapshot({ fetchStatus: "failed", bodyText: undefined }))).resolves.toEqual({
      status: "skipped",
      snapshotId: "snapshot-1",
      reason: "snapshot_not_successful",
    });
    expect(embedder.embedTexts).not.toHaveBeenCalled();
    expect(fragments.replaceFragmentsForSnapshot).not.toHaveBeenCalled();
  });

  it("skips blank body text", async () => {
    const indexer = createDocumentSemanticIndexer({
      chunker: createDocumentChunker(),
      embedder: { embedTexts: vi.fn() },
      fragments: { replaceFragmentsForSnapshot: vi.fn() },
    });

    await expect(indexer.indexSnapshot(snapshot({ bodyText: " \n " }))).resolves.toEqual({
      status: "skipped",
      snapshotId: "snapshot-1",
      reason: "empty_body",
    });
  });

  it("rejects mismatched embedding counts", async () => {
    const indexer = createDocumentSemanticIndexer({
      chunker: createDocumentChunker({ maxChunkChars: 5, minChunkChars: 1 }),
      embedder: { embedTexts: vi.fn(async () => [[1, 2, 3, 4, 5, 6]]) },
      fragments: { replaceFragmentsForSnapshot: vi.fn() },
    });

    await expect(indexer.indexSnapshot(snapshot({ bodyText: "abcdefghijkl" }))).rejects.toThrow(
      "embedding count mismatch",
    );
  });

  it("rejects invalid vectors", async () => {
    const indexer = createDocumentSemanticIndexer({
      chunker: createDocumentChunker(),
      embedder: { embedTexts: vi.fn(async () => [[Number.NaN, 0, 0, 0, 0, 0]]) },
      fragments: { replaceFragmentsForSnapshot: vi.fn() },
    });

    await expect(indexer.indexSnapshot(snapshot())).rejects.toThrow(
      "embedding vector contains invalid value",
    );
  });
});
