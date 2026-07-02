import { describe, expect, it, vi } from "vitest";

import {
  createDocumentRetrievalContextBuilder,
  type QueryEmbeddingProvider,
} from "../src/memory/document-retrieval-context.js";

describe("DocumentRetrievalContextBuilder", () => {
  it("retrieves fragments, filters permissions, and anchors live chat last", async () => {
    const embedder: QueryEmbeddingProvider = {
      embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]),
    };
    const fragments = {
      searchSimilarFragments: vi.fn(async () => [
        {
          id: "fragment-allowed",
          documentSourceId: "source-allowed",
          documentSnapshotId: "snapshot-1",
          sourceUri: "https://example.com/doc-a",
          chunkIndex: 0,
          text: "Allowed document text",
          contentHash: "hash-a",
          embedding: [1, 0, 0, 0, 0, 0],
          embeddingProfileId: "static-dev-6d",
          createdAt: new Date("2026-07-02T01:00:00.000Z"),
          distance: 0.1,
        },
        {
          id: "fragment-denied",
          documentSourceId: "source-denied",
          documentSnapshotId: "snapshot-2",
          sourceUri: "https://example.com/doc-b",
          chunkIndex: 1,
          text: "Denied document text",
          contentHash: "hash-b",
          embedding: [0, 1, 0, 0, 0, 0],
          embeddingProfileId: "static-dev-6d",
          createdAt: new Date("2026-07-02T01:00:00.000Z"),
          distance: 0.2,
        },
      ]),
    };
    const canReadDocument = vi.fn(async (documentId: string) => documentId === "source-allowed");
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder,
      fragments,
      canReadDocument,
    });

    const result = await builder.buildContext({
      queryText: "What did the document say?",
      fragmentLimit: 5,
      liveChatMessages: [{ speaker: "Alice", text: "Please answer from the latest chat." }],
    });

    expect(embedder.embedTexts).toHaveBeenCalledWith(["What did the document say?"]);
    expect(fragments.searchSimilarFragments).toHaveBeenCalledWith({
      embeddingProfileId: "static-dev-6d",
      embedding: [1, 0, 0, 0, 0, 0],
      limit: 5,
    });
    expect(canReadDocument).toHaveBeenCalledWith("source-allowed");
    expect(canReadDocument).toHaveBeenCalledWith("source-denied");
    expect(result.allowedFragments).toEqual([
      expect.objectContaining({ id: "fragment-allowed", documentSourceId: "source-allowed" }),
    ]);
    expect(result.deniedDocumentIds).toEqual(["source-denied"]);
    expect(result.retrievedFragmentCount).toBe(2);
    expect(result.promptContext).toContain(
      '<document source="https://example.com/doc-a#chunk-0">Allowed document text</document>',
    );
    expect(result.promptContext).not.toContain("Denied document text");
    expect(result.promptContext.indexOf("<background_documents>")).toBeLessThan(
      result.promptContext.indexOf("<live_chat_context>"),
    );
    expect(result.promptContext.trim().endsWith("</live_chat_context>")).toBe(true);
  });

  it("returns live chat context when no fragments are retrieved", async () => {
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder: { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) },
      fragments: { searchSimilarFragments: vi.fn(async () => []) },
      canReadDocument: vi.fn(),
    });

    const result = await builder.buildContext({
      queryText: "No docs?",
      liveChatMessages: [{ speaker: "Bob", text: "Use live chat." }],
    });

    expect(result.allowedFragments).toEqual([]);
    expect(result.deniedDocumentIds).toEqual([]);
    expect(result.retrievedFragmentCount).toBe(0);
    expect(result.promptContext).toContain("<background_documents>");
    expect(result.promptContext).toContain('<message speaker="Bob">Use live chat.</message>');
  });

  it("deduplicates permission checks by document source id", async () => {
    const canReadDocument = vi.fn(async () => true);
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder: { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) },
      fragments: {
        searchSimilarFragments: vi.fn(async () => [
          fragment({ id: "fragment-1", documentSourceId: "source-1", chunkIndex: 0 }),
          fragment({ id: "fragment-2", documentSourceId: "source-1", chunkIndex: 1 }),
        ]),
      },
      canReadDocument,
    });

    await builder.buildContext({
      queryText: "same source",
      liveChatMessages: [],
    });

    expect(canReadDocument).toHaveBeenCalledTimes(1);
  });

  it("rejects missing query embedding", async () => {
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder: { embedTexts: vi.fn(async () => []) },
      fragments: { searchSimilarFragments: vi.fn() },
      canReadDocument: vi.fn(),
    });

    await expect(builder.buildContext({ queryText: "bad", liveChatMessages: [] })).rejects.toThrow(
      "query embedding provider must return exactly one vector",
    );
  });

  it("rejects invalid query embedding values", async () => {
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder: { embedTexts: vi.fn(async () => [[Number.POSITIVE_INFINITY]]) },
      fragments: { searchSimilarFragments: vi.fn() },
      canReadDocument: vi.fn(),
    });

    await expect(builder.buildContext({ queryText: "bad", liveChatMessages: [] })).rejects.toThrow(
      "query embedding contains invalid value",
    );
  });
});

function fragment(overrides: {
  id: string;
  documentSourceId: string;
  chunkIndex: number;
}) {
  return {
    documentSnapshotId: "snapshot-1",
    sourceUri: "https://example.com/doc",
    text: `text-${overrides.chunkIndex}`,
    contentHash: `hash-${overrides.chunkIndex}`,
    embedding: [1, 0, 0, 0, 0, 0],
    embeddingProfileId: "static-dev-6d",
    createdAt: new Date("2026-07-02T01:00:00.000Z"),
    ...overrides,
  };
}
