# Iris Document Semantic Indexer Embedding Batches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Batch document chunk embedding requests so large synced documents do not create one huge
embedding provider request.

**Architecture:** Add `embeddingBatchSize` to `createDocumentSemanticIndexer`, default it to `64`,
validate it as a positive safe integer, embed chunks sequentially in slices, and preserve the
existing fragment replacement behavior after all embeddings are collected.

**Tech Stack:** TypeScript, Vitest, existing document semantic indexer tests.

---

### Task 1: Write Failing Tests

**Files:**
- Modify: `apps/core/tests/document-semantic-indexer.test.ts`

- [x] **Step 1: Add batching behavior test**

Add a test that creates an indexer with:

```ts
chunker: createDocumentChunker({ maxChunkChars: 3, minChunkChars: 1 }),
embeddingBatchSize: 2,
```

Index `snapshot({ bodyText: "abcdefghi" })`. Expect `embedTexts` to be called with:

```ts
["abc", "def"]
["ghi"]
```

and `replaceFragmentsForSnapshot` to receive three chunks and three embeddings in order.

- [x] **Step 2: Add batch mismatch test**

Add a test where the first batch receives two chunks but returns one vector. Expect:

```ts
await expect(indexer.indexSnapshot(snapshot({ bodyText: "abcdef" }))).rejects.toThrow(
  "embedding count mismatch",
);
expect(fragments.replaceFragmentsForSnapshot).not.toHaveBeenCalled();
```

- [x] **Step 3: Add invalid batch size test**

Assert `createDocumentSemanticIndexer({ ..., embeddingBatchSize: 0 })` throws:

```ts
"embeddingBatchSize must be a positive safe integer"
```

- [x] **Step 4: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- document-semantic-indexer.test.ts -t "batch"
```

Expected: the new tests fail because the indexer embeds all chunks in one request and does not
accept `embeddingBatchSize`.

Observed: batching and invalid-size tests failed because the indexer embedded all chunks in one
request and did not reject `embeddingBatchSize: 0`.

### Task 2: Implement Embedding Batches

**Files:**
- Modify: `apps/core/src/documents/document-semantic-indexer.ts`

- [x] **Step 1: Add option and default**

Add:

```ts
const DEFAULT_EMBEDDING_BATCH_SIZE = 64;
```

and an optional `embeddingBatchSize?: number` parameter to `createDocumentSemanticIndexer`.

- [x] **Step 2: Validate batch size**

Add a local positive safe integer sanitizer and call it with:

```ts
const safeEmbeddingBatchSize = sanitizePositiveSafeInteger(
  "embeddingBatchSize",
  embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE,
);
```

- [x] **Step 3: Embed in slices**

Replace the single `embedder.embedTexts(chunks.map(...))` call with a helper that loops over chunks
in `safeEmbeddingBatchSize` slices, validates each batch response count, and appends embeddings in
order.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- document-semantic-indexer.test.ts -t "batch"
```

Expected: focused batching tests pass.

Observed: focused batching tests passed.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-document-semantic-indexer-embedding-batches-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-document-semantic-indexer-embedding-batches.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core 758 passed / 4 skipped, Python 7 passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the embedding batching update, push `codex/iris-document-source-registry`, update PR #3, and
confirm GitHub Actions Core and AI Worker checks pass.
