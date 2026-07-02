# Iris Answer-Time Document Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2F of Iris: retrieve document fragments for a query, filter them through live permissions, and assemble safe prompt context with live chat anchored last.

**Architecture:** Add a focused `DocumentRetrievalContextBuilder` that composes the existing fragment repository, embedding provider interface, permission guard, and context assembly. The builder produces prompt context and metadata only; it does not call an LLM.

**Tech Stack:** TypeScript, Vitest, existing `DocumentFragmentRepository`, existing `EmbeddingProvider`, existing `filterFragmentsByLivePermission`, existing `assemblePromptContext`.

---

## Scope

This plan implements the approved Phase 2F design in `docs/superpowers/specs/2026-07-02-iris-answer-time-document-context-design.md`.

It includes:

- answer-time document retrieval context builder;
- query embedding validation;
- fragment permission filtering;
- prompt context assembly through existing Context Anchor logic;
- unit tests with fake embedding, fake fragment retrieval, and fake permission checks.

It intentionally does not implement:

- real LLM calls;
- real embedding provider calls;
- Feishu replies;
- live Feishu permission API integration;
- citations in final generated answers;
- UI.

## File Structure

Create:

```text
apps/core/src/memory/
  document-retrieval-context.ts

apps/core/tests/
  document-retrieval-context.test.ts
```

Responsibilities:

- `document-retrieval-context.ts`: owns the answer-time context builder and metadata types.
- `document-retrieval-context.test.ts`: proves retrieval, permission filtering, metadata, and prompt ordering.

## Task 1: Add Document Retrieval Context Builder

**Files:**
- Create: `apps/core/src/memory/document-retrieval-context.ts`
- Create: `apps/core/tests/document-retrieval-context.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/core/tests/document-retrieval-context.test.ts`:

```ts
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
          createdAt: new Date("2026-07-02T01:00:00.000Z"),
          distance: 0.2,
        },
      ]),
    };
    const canReadDocument = vi.fn(async (documentId: string) => documentId === "source-allowed");
    const builder = createDocumentRetrievalContextBuilder({
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
    createdAt: new Date("2026-07-02T01:00:00.000Z"),
    ...overrides,
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- document-retrieval-context.test.ts
```

Expected: FAIL because `document-retrieval-context.ts` does not exist.

- [ ] **Step 3: Implement context builder**

Create `apps/core/src/memory/document-retrieval-context.ts`:

```ts
import type {
  DocumentFragmentRepository,
  RetrievedDocumentFragment,
} from "../documents/document-fragment-repository.js";
import type { EmbeddingProvider } from "../documents/document-semantic-indexer.js";
import {
  filterFragmentsByLivePermission,
  type RetrievedDocumentFragment as PermissionGuardFragment,
} from "../permissions/permission-guard.js";
import type { AuditLog } from "../audit/audit-log.js";
import {
  assemblePromptContext,
  type LiveChatMessage,
} from "./context-assembly.js";

export type QueryEmbeddingProvider = Pick<EmbeddingProvider, "embedTexts">;

export type DocumentRetrievalContextInput = {
  queryText: string;
  liveChatMessages: LiveChatMessage[];
  fragmentLimit?: number;
  liveChatLimit?: number;
};

export type DocumentRetrievalContextResult = {
  promptContext: string;
  allowedFragments: RetrievedDocumentFragment[];
  deniedDocumentIds: string[];
  retrievedFragmentCount: number;
};

export interface DocumentRetrievalContextBuilder {
  buildContext(input: DocumentRetrievalContextInput): Promise<DocumentRetrievalContextResult>;
}
```

Implement `createDocumentRetrievalContextBuilder`:

- default `fragmentLimit` to `8`;
- call `embedder.embedTexts([input.queryText])`;
- require exactly one query vector;
- validate all query vector values are finite numbers;
- call `fragments.searchSimilarFragments({ embedding: queryEmbedding, limit })`;
- map retrieved fragments into permission guard shape with `documentId = fragment.documentSourceId`;
- call `filterFragmentsByLivePermission`;
- map allowed guard fragments back to original retrieved fragments by id;
- call `assemblePromptContext` with background docs built from allowed fragments and the input live chat;
- return prompt context plus metadata.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- document-retrieval-context.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit context builder**

Run:

```powershell
git add apps/core/src/memory/document-retrieval-context.ts apps/core/tests/document-retrieval-context.test.ts
git commit -m "feat: add answer-time document context builder"
```

Expected: commit succeeds.

## Task 2: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run TypeScript typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run all TypeScript tests**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 3: Run Python worker tests**

Run from `workers/ai`:

```powershell
python -m pytest
```

Expected: PASS.

- [ ] **Step 4: Validate Docker Compose**

Run:

```powershell
docker compose config
```

Expected: resolved compose config prints successfully.

- [ ] **Step 5: Push branch and update PR**

Run:

```powershell
git push origin codex/iris-document-source-registry
gh pr view 3 --repo xfbbert-dotcom/iris --json number,state,isDraft,mergeable,headRefOid,url
```

Expected: push succeeds and PR #3 remains open and mergeable.

## Self-Review Checklist

- The builder does not call an LLM.
- Permission guard runs before context assembly.
- Denied fragments do not enter prompt context.
- Live chat remains last through `assemblePromptContext`.
- Query embedding output is validated.
- Tests remain deterministic and do not require network access.
