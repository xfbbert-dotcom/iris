# Iris Document Semantic Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2E of Iris: convert successful document snapshots into durable, embedded document fragments that later retrieval and answer assembly can use.

**Architecture:** Add a `document_fragments` migration, a deterministic chunker, a fragment repository, and a semantic indexer. Keep embeddings behind a replaceable `EmbeddingProvider` interface and use fake deterministic vectors in tests.

**Tech Stack:** TypeScript, Vitest, Node.js `crypto`, PostgreSQL, pgvector, existing migration runner and document snapshot types.

---

## Scope

This plan implements the approved Phase 2E design in `docs/superpowers/specs/2026-07-02-iris-document-semantic-indexing-design.md`.

It includes:

- `document_fragments` migration;
- deterministic plain-text chunking;
- embedding provider interface;
- fragment repository;
- semantic indexer;
- fake-embedding tests;
- optional Postgres integration coverage.

It intentionally does not implement:

- real Feishu document fetching;
- real vendor embedding calls;
- full answer orchestration;
- prompt assembly;
- live Feishu permission API calls;
- background job scheduling.

## File Structure

Create:

```text
apps/core/migrations/
  0003_document_fragments.sql

apps/core/src/documents/
  document-chunker.ts
  document-fragment-repository.ts
  document-semantic-indexer.ts

apps/core/tests/
  document-chunker.test.ts
  document-fragment-repository.test.ts
  document-semantic-indexer.test.ts
```

Responsibilities:

- `document-chunker.ts`: deterministic plain-text chunking only.
- `document-fragment-repository.ts`: fragment types, row mapping, replace/list/search persistence helpers.
- `document-semantic-indexer.ts`: coordinates snapshot validation, chunking, embedding, vector validation, and repository replacement.
- Tests use fake queryables and fake embeddings first. Postgres integration remains optional and gated by `DATABASE_URL`.

## Task 1: Add Document Fragment Migration

**Files:**
- Create: `apps/core/migrations/0003_document_fragments.sql`

- [ ] **Step 1: Create migration SQL**

Create `apps/core/migrations/0003_document_fragments.sql`:

```sql
create extension if not exists vector;

create table document_fragments (
  id text primary key,
  document_source_id text not null references document_sources(id) on delete cascade,
  document_snapshot_id text not null references document_snapshots(id) on delete cascade,
  source_uri text not null,
  chunk_index integer not null check (chunk_index >= 0),
  text text not null check (length(trim(text)) > 0),
  content_hash text not null,
  embedding vector(6) not null,
  created_at timestamptz not null,
  unique (document_snapshot_id, chunk_index)
);

create index document_fragments_document_source_id_idx
  on document_fragments (document_source_id, chunk_index asc, id asc);

create index document_fragments_document_snapshot_id_idx
  on document_fragments (document_snapshot_id, chunk_index asc, id asc);
```

- [ ] **Step 2: Run migration tests**

Run:

```powershell
npm --workspace apps/core test -- migration-runner.test.ts
```

Expected: PASS. The existing migration runner should still discover and run ordered `.sql` files.

- [ ] **Step 3: Commit migration**

Run:

```powershell
git add apps/core/migrations/0003_document_fragments.sql
git commit -m "feat: add document fragment migration"
```

Expected: commit succeeds.

## Task 2: Add Deterministic Document Chunker

**Files:**
- Create: `apps/core/src/documents/document-chunker.ts`
- Create: `apps/core/tests/document-chunker.test.ts`

- [ ] **Step 1: Write failing chunker tests**

Create `apps/core/tests/document-chunker.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createDocumentChunker } from "../src/documents/document-chunker.js";

describe("DocumentChunker", () => {
  it("splits paragraphs deterministically and preserves order", () => {
    const chunker = createDocumentChunker({ maxChunkChars: 80, minChunkChars: 20 });

    expect(
      chunker.chunkText(" Alpha paragraph. \r\n\r\nBeta paragraph.\n\nGamma paragraph. "),
    ).toEqual([
      { chunkIndex: 0, text: "Alpha paragraph.\n\nBeta paragraph." },
      { chunkIndex: 1, text: "Gamma paragraph." },
    ]);
  });

  it("hard-splits a single long block", () => {
    const chunker = createDocumentChunker({ maxChunkChars: 10, minChunkChars: 4 });

    expect(chunker.chunkText("abcdefghijklmnopqrstuvwxyz")).toEqual([
      { chunkIndex: 0, text: "abcdefghij" },
      { chunkIndex: 1, text: "klmnopqrst" },
      { chunkIndex: 2, text: "uvwxyz" },
    ]);
  });

  it("returns no chunks for blank text", () => {
    const chunker = createDocumentChunker();

    expect(chunker.chunkText(" \n\n\t ")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- document-chunker.test.ts
```

Expected: FAIL because `document-chunker.ts` does not exist.

- [ ] **Step 3: Implement chunker**

Create `apps/core/src/documents/document-chunker.ts`:

```ts
export type DocumentChunk = {
  chunkIndex: number;
  text: string;
};

export type DocumentChunkerOptions = {
  maxChunkChars?: number;
  minChunkChars?: number;
};

export interface DocumentChunker {
  chunkText(text: string): DocumentChunk[];
}

export function createDocumentChunker(options: DocumentChunkerOptions = {}): DocumentChunker {
  const maxChunkChars = options.maxChunkChars ?? 1200;
  const minChunkChars = options.minChunkChars ?? 80;

  if (maxChunkChars < 1) {
    throw new Error("maxChunkChars must be greater than 0");
  }
  if (minChunkChars < 1) {
    throw new Error("minChunkChars must be greater than 0");
  }
  if (minChunkChars > maxChunkChars) {
    throw new Error("minChunkChars must be less than or equal to maxChunkChars");
  }

  return {
    chunkText(text) {
      const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
      if (normalized.length === 0) {
        return [];
      }

      const blocks = normalized
        .split(/\n[ \t]*\n+/)
        .map((block) => block.trim())
        .filter((block) => block.length > 0);

      const chunkTexts = mergeBlocks(blocks, { maxChunkChars, minChunkChars }).flatMap((block) =>
        hardSplit(block, maxChunkChars),
      );

      return chunkTexts.map((chunk, index) => ({
        chunkIndex: index,
        text: chunk,
      }));
    },
  };
}

function mergeBlocks(
  blocks: string[],
  options: { maxChunkChars: number; minChunkChars: number },
): string[] {
  const merged: string[] = [];
  let current = "";

  for (const block of blocks) {
    if (current.length === 0) {
      current = block;
      continue;
    }

    const candidate = `${current}\n\n${block}`;
    if (candidate.length <= options.maxChunkChars && current.length < options.minChunkChars) {
      current = candidate;
      continue;
    }
    if (candidate.length <= options.maxChunkChars && block.length < options.minChunkChars) {
      current = candidate;
      continue;
    }

    merged.push(current);
    current = block;
  }

  if (current.length > 0) {
    merged.push(current);
  }

  return merged;
}

function hardSplit(text: string, maxChunkChars: number): string[] {
  if (text.length <= maxChunkChars) {
    return [text];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxChunkChars) {
    const chunk = text.slice(index, index + maxChunkChars).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
  }
  return chunks;
}
```

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- document-chunker.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit chunker**

Run:

```powershell
git add apps/core/src/documents/document-chunker.ts apps/core/tests/document-chunker.test.ts
git commit -m "feat: add document chunker"
```

Expected: commit succeeds.

## Task 3: Add Document Fragment Repository

**Files:**
- Create: `apps/core/src/documents/document-fragment-repository.ts`
- Create: `apps/core/tests/document-fragment-repository.test.ts`

- [ ] **Step 1: Write failing repository tests**

Create `apps/core/tests/document-fragment-repository.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import {
  createDocumentFragmentRepository,
  serializeVector,
  type DocumentFragment,
  type Queryable,
} from "../src/documents/document-fragment-repository.js";

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function queryableFrom(query: Queryable["query"]): Queryable {
  return { query };
}

describe("DocumentFragmentRepository", () => {
  it("replaces fragments for a snapshot in deterministic order", async () => {
    const createdAt = new Date("2026-07-02T01:00:00.000Z");
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (normalizeSql(sql).startsWith("delete from document_fragments")) {
        return { rows: [] };
      }
      return {
        rows: [
          {
            id: "fragment-1",
            document_source_id: "source-1",
            document_snapshot_id: "snapshot-1",
            source_uri: "https://example.com/doc",
            chunk_index: 0,
            text: "Alpha",
            content_hash: "hash-alpha",
            embedding: "[1,2,3,4,5,6]",
            created_at: createdAt,
          },
        ],
      };
    });
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(query),
      createId: () => "fragment-1",
      now: () => createdAt,
    });

    const fragments = await repository.replaceFragmentsForSnapshot({
      documentSourceId: "source-1",
      documentSnapshotId: "snapshot-1",
      sourceUri: "https://example.com/doc",
      chunks: [{ chunkIndex: 0, text: "Alpha" }],
      embeddings: [[1, 2, 3, 4, 5, 6]],
    });

    expect(normalizeSql(calls[0]?.sql ?? "")).toBe(
      "delete from document_fragments where document_snapshot_id = $1",
    );
    expect(calls[0]?.values).toEqual(["snapshot-1"]);
    expect(normalizeSql(calls[1]?.sql ?? "")).toContain("insert into document_fragments");
    expect(calls[1]?.values).toEqual([
      "fragment-1",
      "source-1",
      "snapshot-1",
      "https://example.com/doc",
      0,
      "Alpha",
      "b1a96dd646bccaa24cef7a3db22a6f995f05658f4f1c3272913e258a3f6a68b8",
      "[1,2,3,4,5,6]",
      createdAt,
    ]);
    expect(fragments).toEqual<DocumentFragment[]>([
      {
        id: "fragment-1",
        documentSourceId: "source-1",
        documentSnapshotId: "snapshot-1",
        sourceUri: "https://example.com/doc",
        chunkIndex: 0,
        text: "Alpha",
        contentHash: "hash-alpha",
        embedding: [1, 2, 3, 4, 5, 6],
        createdAt,
      },
    ]);
  });

  it("serializes vectors for pgvector", () => {
    expect(serializeVector([1, 0.5, -2])).toBe("[1,0.5,-2]");
  });

  it("builds vector search query with limit", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(normalizeSql(sql)).toContain("order by embedding <=> $1::vector asc");
      expect(values).toEqual(["[1,2,3,4,5,6]", 3]);
      return { rows: [] };
    });
    const repository = createDocumentFragmentRepository({ queryable: queryableFrom(query) });

    await expect(repository.searchSimilarFragments({ embedding: [1, 2, 3, 4, 5, 6], limit: 3 })).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts
```

Expected: FAIL because `document-fragment-repository.ts` does not exist.

- [ ] **Step 3: Implement repository**

Create `apps/core/src/documents/document-fragment-repository.ts` with:

```ts
import { createHash, randomUUID } from "node:crypto";

import type { DocumentChunk } from "./document-chunker.js";

export type Queryable = {
  query: <T = unknown>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

export type DocumentFragment = {
  id: string;
  documentSourceId: string;
  documentSnapshotId: string;
  sourceUri: string;
  chunkIndex: number;
  text: string;
  contentHash: string;
  embedding: number[];
  createdAt: Date;
};

export type RetrievedDocumentFragment = DocumentFragment & {
  distance?: number;
};

export type ReplaceFragmentsInput = {
  documentSourceId: string;
  documentSnapshotId: string;
  sourceUri: string;
  chunks: DocumentChunk[];
  embeddings: number[][];
};

export type SearchSimilarFragmentsInput = {
  embedding: number[];
  limit: number;
};

export interface DocumentFragmentRepository {
  replaceFragmentsForSnapshot(input: ReplaceFragmentsInput): Promise<DocumentFragment[]>;
  listFragmentsForSource(documentSourceId: string): Promise<DocumentFragment[]>;
  listFragmentsForSnapshot(documentSnapshotId: string): Promise<DocumentFragment[]>;
  searchSimilarFragments(input: SearchSimilarFragmentsInput): Promise<RetrievedDocumentFragment[]>;
}
```

Implement:

- `createDocumentFragmentRepository({ queryable, createId?, now? })`;
- `replaceFragmentsForSnapshot`;
- `listFragmentsForSource`;
- `listFragmentsForSnapshot`;
- `searchSimilarFragments`;
- exported `serializeVector(vector: number[]): string`;
- SHA-256 content hash helper;
- row mapper that parses either pgvector strings like `"[1,2]"` or arrays if a driver returns arrays.

Use one delete followed by one insert per chunk. Keep transaction ownership outside this repository for Phase 2E.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit repository**

Run:

```powershell
git add apps/core/src/documents/document-fragment-repository.ts apps/core/tests/document-fragment-repository.test.ts
git commit -m "feat: add document fragment repository"
```

Expected: commit succeeds.

## Task 4: Add Document Semantic Indexer

**Files:**
- Create: `apps/core/src/documents/document-semantic-indexer.ts`
- Create: `apps/core/tests/document-semantic-indexer.test.ts`

- [ ] **Step 1: Write failing indexer tests**

Create `apps/core/tests/document-semantic-indexer.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createDocumentChunker } from "../src/documents/document-chunker.js";
import { createDocumentSemanticIndexer, type EmbeddingProvider } from "../src/documents/document-semantic-indexer.js";
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
      embedTexts: vi.fn(async (texts) => texts.map((text) => [text.length, 0, 0, 0, 0, 0])),
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

    await expect(indexer.indexSnapshot(snapshot())).rejects.toThrow("embedding vector contains invalid value");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- document-semantic-indexer.test.ts
```

Expected: FAIL because `document-semantic-indexer.ts` does not exist.

- [ ] **Step 3: Implement indexer**

Create `apps/core/src/documents/document-semantic-indexer.ts`:

```ts
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
  fragments,
}: {
  chunker: DocumentChunker;
  embedder: EmbeddingProvider;
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
    for (const value of vector) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("embedding vector contains invalid value");
      }
    }
  }
}
```

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- document-semantic-indexer.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit indexer**

Run:

```powershell
git add apps/core/src/documents/document-semantic-indexer.ts apps/core/tests/document-semantic-indexer.test.ts
git commit -m "feat: add document semantic indexer"
```

Expected: commit succeeds.

## Task 5: Add Optional Postgres Fragment Integration Test

**Files:**
- Modify: `apps/core/tests/document-fragment-repository.test.ts`

- [ ] **Step 1: Append gated Postgres integration test**

Append to `apps/core/tests/document-fragment-repository.test.ts`, merging imports with the existing file:

```ts
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll } from "vitest";

import { readDatabaseConfig } from "../src/database/database-config.js";
import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";
```

Add:

```ts
const databaseUrl = process.env.DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;

runIfDatabase("DocumentFragmentRepository with Postgres", () => {
  let pool: pg.Pool | undefined;
  const sourceId = `fragment-source-${randomUUID()}`;
  const snapshotId = `fragment-snapshot-${randomUUID()}`;
  const sourceUri = `https://example.com/postgres-fragments/${sourceId}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: readDatabaseConfig().databaseUrl });
    const client = await pool.connect();
    try {
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally {
      client.release();
    }

    await pool.query(
      `
insert into document_sources (
  id,
  source_type,
  source_uri,
  permission_state,
  sync_state,
  can_use_for_answering,
  can_use_for_knowledge_drafts,
  created_at,
  updated_at
)
values ($1, 'group_visible_document', $2, 'readable', 'synced', true, true, $3, $3)
`,
      [sourceId, sourceUri, new Date("2026-07-02T01:00:00.000Z")],
    );

    await pool.query(
      `
insert into document_snapshots (
  id,
  document_source_id,
  source_uri,
  fetch_status,
  body_text,
  content_hash,
  source_version,
  fetched_at,
  error_message,
  created_at
)
values ($1, $2, $3, 'succeeded', 'Alpha body', 'hash', 'v1', $4, null, $4)
`,
      [snapshotId, sourceId, sourceUri, new Date("2026-07-02T01:00:00.000Z")],
    );
  });

  afterAll(async () => {
    if (!pool) {
      return;
    }

    try {
      await pool.query("delete from document_sources where id = $1", [sourceId]);
    } finally {
      await pool.end();
    }
  });

  it("replaces and lists fragments", async () => {
    if (!pool) {
      throw new Error("Expected Postgres pool to be initialized");
    }

    const repository = createDocumentFragmentRepository({ queryable: pool });

    await repository.replaceFragmentsForSnapshot({
      documentSourceId: sourceId,
      documentSnapshotId: snapshotId,
      sourceUri,
      chunks: [{ chunkIndex: 0, text: "Alpha body" }],
      embeddings: [[1, 0, 0, 0, 0, 0]],
    });

    await expect(repository.listFragmentsForSnapshot(snapshotId)).resolves.toEqual([
      expect.objectContaining({
        documentSourceId: sourceId,
        documentSnapshotId: snapshotId,
        text: "Alpha body",
        embedding: [1, 0, 0, 0, 0, 0],
      }),
    ]);
  });
});
```

- [ ] **Step 2: Run focused tests without database**

Run:

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts
```

Expected without `DATABASE_URL`: unit tests PASS, Postgres suite skipped.

- [ ] **Step 3: Verify blank database URL skip**

Run:

```powershell
$env:DATABASE_URL='   '; npm --workspace apps/core test -- document-fragment-repository.test.ts; Remove-Item Env:DATABASE_URL
```

Expected: PASS and Postgres suite skipped.

- [ ] **Step 4: Commit integration test**

Run:

```powershell
npm run typecheck
git add apps/core/tests/document-fragment-repository.test.ts
git commit -m "test: cover document fragments with postgres"
```

Expected: PASS and commit succeeds.

## Task 6: Final Verification

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

Expected: PASS. Postgres integration tests should skip when `DATABASE_URL` is not set.

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

- [ ] **Step 5: Check git status**

Run:

```powershell
git status --short --branch
```

Expected: clean implementation branch after commits.

- [ ] **Step 6: Push branch and update PR**

Run:

```powershell
git push origin codex/iris-document-source-registry
gh pr view 3 --repo xfbbert-dotcom/iris --json number,state,isDraft,mergeable,headRefOid,url
```

Expected: push succeeds and PR #3 remains open and mergeable.

## Self-Review Checklist

- The plan implements Phase 2E only: fragments, chunker, fake embedding boundary, repository, indexer.
- Every fragment preserves document source id and snapshot id for later permission checks.
- No real Feishu or real embedding provider is introduced.
- Empty and failed snapshots do not create fragments.
- Embedding provider output is validated before persistence.
- Tests remain useful without `DATABASE_URL`.
- `docker compose config` is part of final verification.
