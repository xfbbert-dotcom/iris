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
          sourceType: "authorized_wiki_document" as const,
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
          sourceType: "authorized_wiki_document" as const,
          distance: 0.2,
        },
      ]),
    };
    const canReadDocument = vi.fn(async (documentId: string) => documentId === "source-allowed");
    const onPermissionDecision = vi.fn(async (_decision: {
      documentId: string;
      outcome: "allowed" | "denied" | "error";
    }) => undefined);
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder,
      fragments,
      canReadDocument,
      onPermissionDecision,
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
      limit: 15,
    });
    expect(canReadDocument).toHaveBeenCalledWith("source-allowed");
    expect(canReadDocument).toHaveBeenCalledWith("source-denied");
    expect(onPermissionDecision.mock.calls.map(([decision]) => decision)).toEqual([
      { documentId: "source-allowed", outcome: "allowed" },
      { documentId: "source-denied", outcome: "denied" },
    ]);
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

  it("forwards current group scope to fragment search", async () => {
    const fragments = { searchSimilarFragments: vi.fn(async () => []) };
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder: { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) },
      fragments,
      groupId: "chat-current",
      canReadDocument: vi.fn(),
    });

    await builder.buildContext({ queryText: "current group", liveChatMessages: [] });

    expect(fragments.searchSimilarFragments).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "chat-current" }),
    );
  });

  it("loads current-group memories and exposes evidence metadata", async () => {
    const groupMemoryContextProvider = {
      loadActiveMemories: vi.fn(async () => [{
        id: "memory-1",
        scope: "group" as const,
        category: "decision" as const,
        content: "Launch Thursday.",
        evidenceMessageIds: ["msg-1"],
      }]),
    };
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder: { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) },
      fragments: { searchSimilarFragments: vi.fn(async () => []) },
      memoryGroupId: "chat-current",
      groupMemoryContextProvider,
      canReadDocument: vi.fn(),
    });

    const result = await builder.buildContext({
      queryText: "When is launch?",
      liveChatMessages: [{ speaker: "Alice", text: "Please use the current plan." }],
    });

    expect(groupMemoryContextProvider.loadActiveMemories).toHaveBeenCalledWith({
      groupId: "chat-current",
      limit: 8,
    });
    expect(result.usedGroupMemories).toEqual([{
      id: "memory-1",
      scope: "group",
      category: "decision",
      content: "Launch Thursday.",
      evidenceMessageIds: ["msg-1"],
    }]);
    expect(result.promptContext).toContain('id="memory-1"');
    expect(result.promptContext.trim().endsWith("</live_chat_context>")).toBe(true);
  });

  it("loads discussion state independently of document retrieval and keeps live chat last", async () => {
    const conversationStateContextProvider = {
      loadRelevant: vi.fn(async () => ({
        threads: [{
          id: "thread-1",
          status: "open" as const,
          summary: "Launch remains Thursday.",
          evidenceMessageIds: ["thread-message-1"],
        }],
        actions: [{
          id: "action-1",
          threadId: "thread-1",
          status: "open" as const,
          description: "Publish the announcement.",
          ownerRef: "user-1",
          evidenceMessageIds: ["action-message-1"],
        }],
      })),
    };
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder: { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) },
      fragments: { searchSimilarFragments: vi.fn(async () => []) },
      conversationStateGroupId: "chat-current",
      conversationStateContextProvider,
      canReadDocument: vi.fn(),
    });

    const result = await builder.buildContext({
      queryText: "When is launch?",
      askerId: "user-1",
      fragmentLimit: 0,
      liveChatMessages: Array.from({ length: 22 }, (_, index) => ({
        speaker: "Alice",
        text: `live-${index + 1}`,
      })),
    });

    expect(conversationStateContextProvider.loadRelevant).toHaveBeenCalledWith({
      groupId: "chat-current",
      queryText: "When is launch?",
      askerId: "user-1",
      limit: 6,
    });
    expect((result.usedDiscussionThreads ?? []).map((thread) => thread.id)).toEqual(["thread-1"]);
    expect((result.usedActionItems ?? []).map((action) => action.id)).toEqual(["action-1"]);
    expect(result.promptContext.indexOf("<background_documents>")).toBeLessThan(
      result.promptContext.indexOf("<group_memories>"),
    );
    expect(result.promptContext.indexOf("<group_memories>")).toBeLessThan(
      result.promptContext.indexOf("<discussion_threads>"),
    );
    expect(result.promptContext.indexOf("<discussion_threads>")).toBeLessThan(
      result.promptContext.indexOf("<action_items>"),
    );
    expect(result.promptContext.trim().endsWith("</live_chat_context>")).toBe(true);
    expect(result.promptContext).not.toContain("live-1</message>");
    expect(result.promptContext).toContain("live-3</message>");
  });

  it("loads group memories independently when document retrieval is disabled", async () => {
    const groupMemoryContextProvider = {
      loadActiveMemories: vi.fn(async () => [{
        id: "memory-1",
        scope: "group" as const,
        category: "decision" as const,
        content: "Launch Thursday.",
        evidenceMessageIds: ["msg-1"],
      }]),
    };
    const embedder = { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) };
    const fragments = { searchSimilarFragments: vi.fn(async () => []) };
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder,
      fragments,
      memoryGroupId: "chat-current",
      groupMemoryContextProvider,
      canReadDocument: vi.fn(),
    });

    const result = await builder.buildContext({
      queryText: "Memory only",
      fragmentLimit: 0,
      liveChatMessages: [],
    });

    expect(groupMemoryContextProvider.loadActiveMemories).toHaveBeenCalledOnce();
    expect(result.usedGroupMemories.map((memory) => memory.id)).toEqual(["memory-1"]);
    expect(result.promptContext).toContain("Launch Thursday.");
    expect(embedder.embedTexts).not.toHaveBeenCalled();
    expect(fragments.searchSimilarFragments).not.toHaveBeenCalled();
  });

  it("does not load memories without a current group boundary", async () => {
    const groupMemoryContextProvider = { loadActiveMemories: vi.fn(async () => []) };
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder: { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) },
      fragments: { searchSimilarFragments: vi.fn(async () => []) },
      groupMemoryContextProvider,
      canReadDocument: vi.fn(),
    });

    const result = await builder.buildContext({ queryText: "No group", liveChatMessages: [] });

    expect(groupMemoryContextProvider.loadActiveMemories).not.toHaveBeenCalled();
    expect(result.usedGroupMemories).toEqual([]);
  });

  it("fails closed when current-group memory retrieval fails", async () => {
    const embedder = { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) };
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder,
      fragments: { searchSimilarFragments: vi.fn(async () => []) },
      memoryGroupId: "chat-current",
      groupMemoryContextProvider: {
        loadActiveMemories: vi.fn(async () => { throw new Error("memory unavailable"); }),
      },
      canReadDocument: vi.fn(),
    });

    await expect(builder.buildContext({
      queryText: "Fail closed",
      liveChatMessages: [],
    })).rejects.toThrow("memory unavailable");
    expect(embedder.embedTexts).not.toHaveBeenCalled();
  });

  it("skips embedding, search, and permission checks when fragmentLimit is 0", async () => {
    const embedder = { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) };
    const fragments = { searchSimilarFragments: vi.fn(async () => []) };
    const canReadDocument = vi.fn(async () => true);
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder,
      fragments,
      canReadDocument,
    });

    const result = await builder.buildContext({
      queryText: "Live chat only",
      fragmentLimit: 0,
      liveChatMessages: [{ speaker: "Bob", text: "Use live chat." }],
    });

    expect(embedder.embedTexts).not.toHaveBeenCalled();
    expect(fragments.searchSimilarFragments).not.toHaveBeenCalled();
    expect(canReadDocument).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      allowedFragments: [],
      deniedDocumentIds: [],
      retrievedFragmentCount: 0,
    });
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

  it("caps overfetched explicit fragment limits before searching similar fragments", async () => {
    const fragments = {
      searchSimilarFragments: vi.fn(async () => []),
    };
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder: { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) },
      fragments,
      canReadDocument: vi.fn(),
    });

    await builder.buildContext({
      queryText: "large retrieval",
      fragmentLimit: 999,
      liveChatMessages: [],
    });

    expect(fragments.searchSimilarFragments).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 36 }),
    );
  });

  it("rejects unsafe fragment limits before embedding or vector search", async () => {
    const embedder = { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) };
    const fragments = {
      searchSimilarFragments: vi.fn(async () => []),
    };
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder,
      fragments,
      canReadDocument: vi.fn(),
    });

    await expect(
      builder.buildContext({
        queryText: "unsafe limit",
        fragmentLimit: Number.MAX_SAFE_INTEGER + 1,
        liveChatMessages: [],
      }),
    ).rejects.toThrow("fragmentLimit must be a finite safe-magnitude number");
    expect(embedder.embedTexts).not.toHaveBeenCalled();
    expect(fragments.searchSimilarFragments).not.toHaveBeenCalled();
  });

  it("rejects non-finite fragment limits before embedding or vector search", async () => {
    const embedder = { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) };
    const fragments = {
      searchSimilarFragments: vi.fn(async () => []),
    };
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder,
      fragments,
      canReadDocument: vi.fn(),
    });

    await expect(
      builder.buildContext({
        queryText: "unsafe limit",
        fragmentLimit: Number.NaN,
        liveChatMessages: [],
      }),
    ).rejects.toThrow("fragmentLimit must be a finite safe-magnitude number");
    expect(embedder.embedTexts).not.toHaveBeenCalled();
    expect(fragments.searchSimilarFragments).not.toHaveBeenCalled();
  });

  it("rejects oversized query text before embedding or vector search", async () => {
    const embedder = { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) };
    const fragments = {
      searchSimilarFragments: vi.fn(async () => []),
    };
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder,
      fragments,
      canReadDocument: vi.fn(),
    });

    await expect(
      builder.buildContext({
        queryText: "q".repeat(4001),
        liveChatMessages: [],
      }),
    ).rejects.toThrow("queryText must be at most 4000 characters");
    expect(embedder.embedTexts).not.toHaveBeenCalled();
    expect(fragments.searchSimilarFragments).not.toHaveBeenCalled();
  });

  it("overfetches before permission filtering and keeps only the requested allowed fragments", async () => {
    const fragments = {
      searchSimilarFragments: vi.fn(async () => [
        fragment({
          id: "denied-1",
          documentSourceId: "source-denied-1",
          chunkIndex: 0,
          text: "Denied one",
        }),
        fragment({
          id: "denied-2",
          documentSourceId: "source-denied-2",
          chunkIndex: 1,
          text: "Denied two",
        }),
        fragment({
          id: "allowed-1",
          documentSourceId: "source-allowed-1",
          chunkIndex: 2,
          text: "Allowed one",
        }),
        fragment({
          id: "allowed-2",
          documentSourceId: "source-allowed-2",
          chunkIndex: 3,
          text: "Allowed two",
        }),
        fragment({
          id: "allowed-3",
          documentSourceId: "source-allowed-3",
          chunkIndex: 4,
          text: "Allowed three",
        }),
      ]),
    };
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder: { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) },
      fragments,
      canReadDocument: vi.fn(async (documentId: string) => documentId.startsWith("source-allowed")),
    });

    const result = await builder.buildContext({
      queryText: "permission filtered docs",
      fragmentLimit: 2,
      liveChatMessages: [],
    });

    expect(fragments.searchSimilarFragments).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 6 }),
    );
    expect(result.retrievedFragmentCount).toBe(5);
    expect(result.deniedDocumentIds).toEqual(["source-denied-1", "source-denied-2"]);
    expect(result.allowedFragments.map((item) => item.id)).toEqual(["allowed-1", "allowed-2"]);
    expect(result.promptContext).toContain("Allowed one");
    expect(result.promptContext).toContain("Allowed two");
    expect(result.promptContext).not.toContain("Allowed three");
    expect(result.promptContext).not.toContain("Denied one");
    expect(result.promptContext).not.toContain("Denied two");
  });

  it("does not allow duplicate fragment IDs to leak denied document text", async () => {
    const fragments = {
      searchSimilarFragments: vi.fn(async () => [
        fragment({
          id: "fragment-duplicate",
          documentSourceId: "source-allowed",
          chunkIndex: 0,
          text: "Allowed duplicate text",
        }),
        fragment({
          id: "fragment-duplicate",
          documentSourceId: "source-denied",
          chunkIndex: 1,
          text: "Denied duplicate text",
        }),
      ]),
    };
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder: { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) },
      fragments,
      canReadDocument: vi.fn(async (documentId: string) => documentId === "source-allowed"),
    });

    const result = await builder.buildContext({
      queryText: "duplicate fragment ids",
      liveChatMessages: [],
    });

    expect(result.allowedFragments).toEqual([
      expect.objectContaining({
        id: "fragment-duplicate",
        documentSourceId: "source-allowed",
        text: "Allowed duplicate text",
      }),
    ]);
    expect(result.deniedDocumentIds).toEqual(["source-denied"]);
    expect(result.promptContext).toContain("Allowed duplicate text");
    expect(result.promptContext).not.toContain("Denied duplicate text");
  });

  it("filters blank allowed fragments from prompt context and returned metadata", async () => {
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder: { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) },
      fragments: {
        searchSimilarFragments: vi.fn(async () => [
          fragment({
            id: "blank-fragment",
            documentSourceId: "source-1",
            chunkIndex: 0,
            text: " \n\t ",
          }),
          fragment({
            id: "useful-fragment",
            documentSourceId: "source-2",
            chunkIndex: 1,
            text: "Useful context",
          }),
        ]),
      },
      canReadDocument: vi.fn(async () => true),
    });

    const result = await builder.buildContext({
      queryText: "blank chunks",
      liveChatMessages: [],
    });

    expect(result.retrievedFragmentCount).toBe(2);
    expect(result.allowedFragments.map((item) => item.id)).toEqual(["useful-fragment"]);
    expect(result.promptContext).toContain("Useful context");
    expect(result.promptContext).not.toContain("blank-fragment");
    expect(result.promptContext).not.toContain("> \n\t </document>");
  });

  it("skips live permission checks for blank fragments", async () => {
    const canReadDocument = vi.fn(async () => true);
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder: { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) },
      fragments: {
        searchSimilarFragments: vi.fn(async () => [
          fragment({
            id: "blank-fragment",
            documentSourceId: "source-blank",
            chunkIndex: 0,
            text: " \n\t ",
          }),
          fragment({
            id: "useful-fragment",
            documentSourceId: "source-useful",
            chunkIndex: 1,
            text: "Useful context",
          }),
        ]),
      },
      canReadDocument,
    });

    const result = await builder.buildContext({
      queryText: "blank chunks",
      liveChatMessages: [],
    });

    expect(canReadDocument).toHaveBeenCalledTimes(1);
    expect(canReadDocument).toHaveBeenCalledWith("source-useful");
    expect(canReadDocument).not.toHaveBeenCalledWith("source-blank");
    expect(result.retrievedFragmentCount).toBe(2);
    expect(result.allowedFragments.map((item) => item.id)).toEqual(["useful-fragment"]);
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

  it("rejects empty query embeddings before vector search", async () => {
    const fragments = { searchSimilarFragments: vi.fn() };
    const builder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: "static-dev-6d",
      embedder: { embedTexts: vi.fn(async () => [[]]) },
      fragments,
      canReadDocument: vi.fn(),
    });

    await expect(builder.buildContext({ queryText: "bad", liveChatMessages: [] })).rejects.toThrow(
      "query embedding must not be empty",
    );
    expect(fragments.searchSimilarFragments).not.toHaveBeenCalled();
  });
});

function fragment(overrides: {
  id: string;
  documentSourceId: string;
  chunkIndex: number;
  text?: string;
}) {
  return {
    documentSnapshotId: "snapshot-1",
    sourceUri: "https://example.com/doc",
    text: `text-${overrides.chunkIndex}`,
    contentHash: `hash-${overrides.chunkIndex}`,
    embedding: [1, 0, 0, 0, 0, 0],
    embeddingProfileId: "static-dev-6d",
    createdAt: new Date("2026-07-02T01:00:00.000Z"),
    sourceType: "authorized_wiki_document" as const,
    ...overrides,
  };
}
