# Iris Dimension-Sharded Vector Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2M of Iris: route fragment embeddings into dimension-specific pgvector tables so 6-dimensional development vectors and 1536-dimensional production vectors can coexist safely.

**Architecture:** Keep `document_fragments` as fragment metadata, add `document_fragment_embeddings_6` and `document_fragment_embeddings_1536`, and make `DocumentFragmentRepository` resolve the embedding table from `embedding_profiles.dimensions`. Runtime should allow configured 1536-dimensional embedding providers once the repository can route 1536-dimensional search.

**Tech Stack:** TypeScript, Vitest, PostgreSQL, pgvector, existing migration runner, existing embedding profile repository, existing OpenAI-compatible embedding provider.

---

## Scope

This plan implements the approved Phase 2M design in `docs/superpowers/specs/2026-07-02-iris-dimension-sharded-vector-storage-design.md`.

It includes:

- migration `0005_dimension_sharded_vector_storage.sql`;
- `document_fragment_embeddings_6`;
- `document_fragment_embeddings_1536`;
- static 6-dimensional backfill from `document_fragments.embedding`;
- `EmbeddingProfileRepository.getProfileById`;
- fragment repository write/search routing by profile dimensions;
- vector length validation against profile dimensions;
- runtime support for `IRIS_EMBEDDING_DIMENSIONS=1536`;
- explicit unsupported-dimension errors.

It intentionally does not implement:

- 3072-dimensional storage;
- automatic reindexing;
- vector HNSW/IVFFlat indexes;
- profile admin UI;
- live Feishu permission API calls.

## File Structure

Create:

```text
apps/core/migrations/0005_dimension_sharded_vector_storage.sql
```

Modify:

```text
apps/core/src/documents/embedding-profile-repository.ts
apps/core/src/documents/document-fragment-repository.ts
apps/core/src/runtime/answer-draft-runtime.ts
apps/core/tests/embedding-profile-repository.test.ts
apps/core/tests/document-fragment-repository.test.ts
apps/core/tests/answer-draft-runtime.test.ts
apps/core/tests/migration-runner.test.ts
```

Responsibilities:

- migration: create dimension-specific embedding tables and backfill 6d embeddings;
- embedding profile repository: load a profile by id for storage routing;
- document fragment repository: store metadata in `document_fragments`, vectors in dimension-specific tables, and search via dimension-specific joins;
- runtime: allow supported dimensions `6` and `1536`.

## Task 1: Add Dimension-Sharded Storage Migration

**Files:**
- Create: `apps/core/migrations/0005_dimension_sharded_vector_storage.sql`
- Modify: `apps/core/tests/migration-runner.test.ts`

- [ ] **Step 1: Add failing migration presence test**

Append this test to the `defaultMigrationsDir` describe block in `apps/core/tests/migration-runner.test.ts`:

```ts
  it("includes dimension-sharded vector storage migration after embedding profiles", async () => {
    await expect(readdir(defaultMigrationsDir())).resolves.toEqual(
      expect.arrayContaining([
        "0004_embedding_profiles.sql",
        "0005_dimension_sharded_vector_storage.sql",
      ]),
    );
  });
```

- [ ] **Step 2: Run migration tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- migration-runner.test.ts
```

Expected: FAIL because `0005_dimension_sharded_vector_storage.sql` does not exist.

- [ ] **Step 3: Create migration**

Create `apps/core/migrations/0005_dimension_sharded_vector_storage.sql`:

```sql
create table if not exists document_fragment_embeddings_6 (
  document_fragment_id text primary key references document_fragments(id) on delete cascade,
  embedding_profile_id text not null references embedding_profiles(id),
  embedding vector(6) not null,
  created_at timestamptz not null
);

create index if not exists document_fragment_embeddings_6_profile_idx
on document_fragment_embeddings_6 (embedding_profile_id);

create table if not exists document_fragment_embeddings_1536 (
  document_fragment_id text primary key references document_fragments(id) on delete cascade,
  embedding_profile_id text not null references embedding_profiles(id),
  embedding vector(1536) not null,
  created_at timestamptz not null
);

create index if not exists document_fragment_embeddings_1536_profile_idx
on document_fragment_embeddings_1536 (embedding_profile_id);

insert into document_fragment_embeddings_6 (
  document_fragment_id,
  embedding_profile_id,
  embedding,
  created_at
)
select
  id,
  embedding_profile_id,
  embedding,
  created_at
from document_fragments
where embedding_profile_id = 'static-dev-6d'
on conflict (document_fragment_id) do nothing;

alter table document_fragments
  alter column embedding drop not null;
```

- [ ] **Step 4: Run migration tests**

Run:

```powershell
npm --workspace apps/core test -- migration-runner.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit migration**

Run:

```powershell
git add apps/core/migrations/0005_dimension_sharded_vector_storage.sql apps/core/tests/migration-runner.test.ts
git commit -m "feat: add dimension-sharded vector storage migration"
```

Expected: commit succeeds.

## Task 2: Add Profile Lookup by ID

**Files:**
- Modify: `apps/core/src/documents/embedding-profile-repository.ts`
- Modify: `apps/core/tests/embedding-profile-repository.test.ts`

- [ ] **Step 1: Write failing getProfileById test**

Append to `apps/core/tests/embedding-profile-repository.test.ts`:

```ts
  it("reads a profile by id", async () => {
    const createdAt = new Date("2026-07-02T03:00:00.000Z");
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(normalizeSql(sql)).toContain("select * from embedding_profiles");
      expect(values).toEqual(["openai-compatible:text-embedding-small:1536"]);
      return {
        rows: [
          {
            id: "openai-compatible:text-embedding-small:1536",
            provider: "openai-compatible",
            model: "text-embedding-small",
            dimensions: 1536,
            display_name: "OpenAI-compatible text-embedding-small (1536d)",
            status: "active",
            created_at: createdAt,
          },
        ],
      };
    });
    const repository = createEmbeddingProfileRepository({ queryable: queryableFrom(query) });

    await expect(
      repository.getProfileById("openai-compatible:text-embedding-small:1536"),
    ).resolves.toEqual({
      id: "openai-compatible:text-embedding-small:1536",
      provider: "openai-compatible",
      model: "text-embedding-small",
      dimensions: 1536,
      displayName: "OpenAI-compatible text-embedding-small (1536d)",
      status: "active",
      createdAt,
    });
  });
```

Also append:

```ts
  it("throws when a profile id is missing", async () => {
    const repository = createEmbeddingProfileRepository({
      queryable: queryableFrom(vi.fn(async () => ({ rows: [] }))),
    });

    await expect(repository.getProfileById("missing-profile")).rejects.toThrow(
      "embedding profile was not found: missing-profile",
    );
  });
```

- [ ] **Step 2: Run repository test to verify failure**

Run:

```powershell
npm --workspace apps/core test -- embedding-profile-repository.test.ts
```

Expected: FAIL because `getProfileById` does not exist.

- [ ] **Step 3: Implement getProfileById**

Modify `apps/core/src/documents/embedding-profile-repository.ts`:

1. Add to `EmbeddingProfileRepository`:

```ts
getProfileById(id: string): Promise<EmbeddingProfile>;
```

2. Add method in `createEmbeddingProfileRepository`:

```ts
    async getProfileById(id) {
      const result = await dependencies.queryable.query<EmbeddingProfileRow>(
        `
select *
from embedding_profiles
where id = $1
`,
        [id],
      );

      return mapProfileRow(readSingleRow(result.rows, `embedding profile was not found: ${id}`));
    },
```

- [ ] **Step 4: Run repository tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- embedding-profile-repository.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit profile lookup**

Run:

```powershell
git add apps/core/src/documents/embedding-profile-repository.ts apps/core/tests/embedding-profile-repository.test.ts
git commit -m "feat: add embedding profile lookup by id"
```

Expected: commit succeeds.

## Task 3: Route Fragment Writes and Search by Dimension

**Files:**
- Modify: `apps/core/src/documents/document-fragment-repository.ts`
- Modify: `apps/core/tests/document-fragment-repository.test.ts`

- [ ] **Step 1: Update repository tests for routed 6d writes**

In `apps/core/tests/document-fragment-repository.test.ts`, update the repository construction in `"replaces fragments for a snapshot in deterministic order"`:

```ts
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(query),
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({
          id: "static-dev-6d",
          dimensions: 6,
        })),
      },
      createId: () => "fragment-1",
      now: () => createdAt,
    });
```

Update fake query behavior:

```ts
      if (normalizeSql(sql).startsWith("insert into document_fragments")) {
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
              embedding_profile_id: "static-dev-6d",
              created_at: createdAt,
            },
          ],
        };
      }
      if (normalizeSql(sql).startsWith("insert into document_fragment_embeddings_6")) {
        return { rows: [] };
      }
```

Update insert assertions:

```ts
    expect(normalizeSql(calls[1]?.sql ?? "")).toContain("insert into document_fragments");
    expect(calls[1]?.values).toEqual([
      "fragment-1",
      "source-1",
      "snapshot-1",
      "https://example.com/doc",
      0,
      "Alpha",
      "b1a96dd646bccaa24cef7a3db22a6f995f05658f4f1c3272913e258c03e6fb24",
      "static-dev-6d",
      createdAt,
    ]);
    expect(normalizeSql(calls[2]?.sql ?? "")).toContain(
      "insert into document_fragment_embeddings_6",
    );
    expect(calls[2]?.values).toEqual(["fragment-1", "static-dev-6d", "[1,2,3,4,5,6]", createdAt]);
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
        embeddingProfileId: "static-dev-6d",
        createdAt,
      },
    ]);
```

- [ ] **Step 2: Add 1536d write routing test**

Append to `DocumentFragmentRepository` describe block:

```ts
  it("routes 1536-dimensional writes to the 1536 embedding table", async () => {
    const createdAt = new Date("2026-07-02T01:00:00.000Z");
    const vector = Array.from({ length: 1536 }, (_, index) => index / 1536);
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (normalizeSql(sql).startsWith("delete from document_fragments")) {
        return { rows: [] };
      }
      if (normalizeSql(sql).startsWith("insert into document_fragments")) {
        return {
          rows: [
            {
              id: "fragment-1536",
              document_source_id: "source-1",
              document_snapshot_id: "snapshot-1",
              source_uri: "https://example.com/doc",
              chunk_index: 0,
              text: "Alpha",
              content_hash: "hash-alpha",
              embedding_profile_id: "openai-compatible:text-embedding-small:1536",
              created_at: createdAt,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(query),
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({
          id: "openai-compatible:text-embedding-small:1536",
          dimensions: 1536,
        })),
      },
      createId: () => "fragment-1536",
      now: () => createdAt,
    });

    await repository.replaceFragmentsForSnapshot({
      documentSourceId: "source-1",
      documentSnapshotId: "snapshot-1",
      sourceUri: "https://example.com/doc",
      embeddingProfileId: "openai-compatible:text-embedding-small:1536",
      chunks: [{ chunkIndex: 0, text: "Alpha" }],
      embeddings: [vector],
    });

    expect(normalizeSql(calls[2]?.sql ?? "")).toContain(
      "insert into document_fragment_embeddings_1536",
    );
    expect(calls[2]?.values).toEqual([
      "fragment-1536",
      "openai-compatible:text-embedding-small:1536",
      `[${vector.join(",")}]`,
      createdAt,
    ]);
  });
```

- [ ] **Step 3: Update search test for routed query**

Change `"builds vector search query with limit"` repository construction:

```ts
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(query),
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({ id: "static-dev-6d", dimensions: 6 })),
      },
    });
```

Change fake query assertions:

```ts
      expect(normalizeSql(sql)).toContain("from document_fragments f");
      expect(normalizeSql(sql)).toContain("join document_fragment_embeddings_6 e");
      expect(normalizeSql(sql)).toContain("where f.embedding_profile_id = $1");
      expect(normalizeSql(sql)).toContain("and e.embedding_profile_id = $1");
      expect(normalizeSql(sql)).toContain("order by e.embedding <=> $2::vector asc");
      expect(values).toEqual(["static-dev-6d", "[1,2,3,4,5,6]", 3]);
```

- [ ] **Step 4: Add unsupported dimension and vector length tests**

Append:

```ts
  it("rejects unsupported embedding dimensions", async () => {
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(vi.fn(async () => ({ rows: [] }))),
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({ id: "profile-3072", dimensions: 3072 })),
      },
    });

    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId: "profile-3072",
        embedding: [1, 2, 3],
        limit: 3,
      }),
    ).rejects.toThrow("Unsupported embedding dimension: 3072");
  });

  it("rejects vectors whose length does not match the profile dimension", async () => {
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(vi.fn(async () => ({ rows: [] }))),
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({ id: "static-dev-6d", dimensions: 6 })),
      },
    });

    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId: "static-dev-6d",
        embedding: [1, 2, 3],
        limit: 3,
      }),
    ).rejects.toThrow("embedding vector length 3 does not match profile dimension 6");
  });
```

- [ ] **Step 5: Run fragment repository tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts
```

Expected: FAIL because repository still writes/searches the old `document_fragments.embedding` column.

- [ ] **Step 6: Implement repository routing**

Modify `apps/core/src/documents/document-fragment-repository.ts`.

Add types:

```ts
export type EmbeddingProfileLookup = {
  getProfileById(id: string): Promise<{ id: string; dimensions: number }>;
};

type SupportedEmbeddingDimension = 6 | 1536;
type EmbeddingTable = "document_fragment_embeddings_6" | "document_fragment_embeddings_1536";
```

Change dependencies:

```ts
export type DocumentFragmentRepositoryDependencies = {
  queryable: Queryable;
  embeddingProfiles: EmbeddingProfileLookup;
  createId?: () => string;
  now?: () => Date;
};
```

Change `DocumentFragmentRow`:

```ts
type DocumentFragmentRow = {
  id: string;
  document_source_id: string;
  document_snapshot_id: string;
  source_uri: string;
  chunk_index: number;
  text: string;
  content_hash: string;
  embedding?: string | number[];
  embedding_profile_id: string;
  created_at: Date;
};
```

At the start of `replaceFragmentsForSnapshot`, resolve profile:

```ts
const profile = await dependencies.embeddingProfiles.getProfileById(input.embeddingProfileId);
const embeddingTable = resolveEmbeddingTable(profile.dimensions);
```

When inserting a fragment, remove `embedding` from the fragment passed to metadata insert. After `insertFragment`, insert vector:

```ts
const inserted = await insertFragment(dependencies.queryable, {
  id: createId(),
  documentSourceId: input.documentSourceId,
  documentSnapshotId: input.documentSnapshotId,
  sourceUri: input.sourceUri,
  chunkIndex: chunk.chunkIndex,
  text: chunk.text,
  contentHash: hashText(chunk.text),
  embeddingProfileId: input.embeddingProfileId,
  createdAt: now(),
});
await insertFragmentEmbedding(dependencies.queryable, embeddingTable, {
  documentFragmentId: inserted.id,
  embeddingProfileId: input.embeddingProfileId,
  embedding,
  createdAt: inserted.createdAt,
});
fragments.push({ ...inserted, embedding });
```

`insertFragment` should insert only metadata:

```sql
insert into document_fragments (
  id,
  document_source_id,
  document_snapshot_id,
  source_uri,
  chunk_index,
  text,
  content_hash,
  embedding_profile_id,
  created_at
)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
returning *
```

Use an empty vector when mapping metadata-only rows that do not include a joined embedding:

```ts
embedding: row.embedding === undefined ? [] : parseVector(row.embedding),
```

Add `insertFragmentEmbedding`:

```ts
async function insertFragmentEmbedding(
  queryable: Queryable,
  table: EmbeddingTable,
  input: {
    documentFragmentId: string;
    embeddingProfileId: string;
    embedding: number[];
    createdAt: Date;
  },
): Promise<void> {
  await queryable.query(
    `
insert into ${table} (
  document_fragment_id,
  embedding_profile_id,
  embedding,
  created_at
)
values ($1, $2, $3::vector, $4)
on conflict (document_fragment_id)
do update set
  embedding_profile_id = excluded.embedding_profile_id,
  embedding = excluded.embedding,
  created_at = excluded.created_at
`,
    [
      input.documentFragmentId,
      input.embeddingProfileId,
      serializeVector(input.embedding),
      input.createdAt,
    ],
  );
}
```

Change `searchSimilarFragments`:

```ts
const profile = await dependencies.embeddingProfiles.getProfileById(input.embeddingProfileId);
const embeddingTable = resolveEmbeddingTable(profile.dimensions);
validateVectorDimension(input.embedding, profile.dimensions);
const result = await dependencies.queryable.query<RetrievedDocumentFragmentRow>(
  `
select
  f.*,
  e.embedding,
  e.embedding <=> $2::vector as distance
from document_fragments f
join ${embeddingTable} e
  on e.document_fragment_id = f.id
where f.embedding_profile_id = $1
  and e.embedding_profile_id = $1
order by e.embedding <=> $2::vector asc
limit $3
`,
  [input.embeddingProfileId, serializeVector(input.embedding), input.limit],
);
```

Add helpers:

```ts
function resolveEmbeddingTable(dimension: number): EmbeddingTable {
  if (dimension === 6) {
    return "document_fragment_embeddings_6";
  }
  if (dimension === 1536) {
    return "document_fragment_embeddings_1536";
  }
  throw new Error(`Unsupported embedding dimension: ${dimension}`);
}

function validateVectorDimension(vector: number[], dimension: number): void {
  if (vector.length !== dimension) {
    throw new Error(`embedding vector length ${vector.length} does not match profile dimension ${dimension}`);
  }
}
```

Call `validateVectorDimension(embedding, profile.dimensions)` before each write.

- [ ] **Step 7: Update repository construction call sites**

Search:

```powershell
rg "createDocumentFragmentRepository" apps/core/src apps/core/tests
```

Update `AnswerDraftRuntimeDependencies.createDocumentFragmentRepository` to accept `embeddingProfiles`:

```ts
  createDocumentFragmentRepository?: (dependencies: {
    queryable: Queryable;
    embeddingProfiles: Pick<EmbeddingProfileRepository, "getProfileById">;
  }) => Pick<DocumentFragmentRepository, "searchSimilarFragments">;
```

Update every production call to pass `embeddingProfiles`. In runtime, construct profiles first:

```ts
const profiles = createProfiles({ queryable: pool });
const fragments = createFragments({ queryable: pool, embeddingProfiles: profiles });
```

In tests that do not exercise routing, inject:

```ts
embeddingProfiles: {
  getProfileById: vi.fn(async () => ({ id: "static-dev-6d", dimensions: 6 })),
}
```

- [ ] **Step 8: Run focused tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts answer-draft-runtime.test.ts document-retrieval-context.test.ts document-semantic-indexer.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit repository routing**

Run:

```powershell
git add apps/core/src/documents/document-fragment-repository.ts apps/core/src/runtime/answer-draft-runtime.ts apps/core/tests/document-fragment-repository.test.ts apps/core/tests/answer-draft-runtime.test.ts apps/core/tests/document-retrieval-context.test.ts apps/core/tests/document-semantic-indexer.test.ts
git commit -m "feat: route fragment embeddings by profile dimension"
```

Expected: commit succeeds.

## Task 4: Allow 1536-Dimensional Runtime Profiles

**Files:**
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`
- Modify: `apps/core/tests/answer-draft-runtime.test.ts`

- [ ] **Step 1: Update runtime tests**

In `apps/core/tests/answer-draft-runtime.test.ts`, change the test named:

```text
rejects non-6 embedding dimensions until vector storage is migrated when generating a draft
```

to:

```text
uses configured OpenAI-compatible embedding provider when dimensions are 1536
```

Use:

```ts
  it("uses configured OpenAI-compatible embedding provider when dimensions are 1536", async () => {
    const vector = Array.from({ length: 1536 }, (_, index) => index / 1536);
    const embeddingProvider = { embedTexts: vi.fn(async () => [vector]) };
    const embeddingProfiles = {
      getStaticDevelopmentProfile: vi.fn(),
      findOrCreateProfile: vi.fn(async () =>
        profile({
          id: "openai-compatible:text-embedding-small:1536",
          provider: "openai-compatible",
          model: "text-embedding-small",
          dimensions: 1536,
          displayName: "OpenAI-compatible text-embedding-small (1536d)",
        }),
      ),
      getProfileById: vi.fn(async () => ({
        id: "openai-compatible:text-embedding-small:1536",
        dimensions: 1536,
      })),
    };
    const fragments = { searchSimilarFragments: vi.fn(async () => []) };
    const runtime = createAnswerDraftRuntime({
      env: {
        ...enabledEnv(),
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "embed-key",
        IRIS_EMBEDDING_MODEL: "text-embedding-small",
        IRIS_EMBEDDING_DIMENSIONS: "1536",
      },
      dependencies: {
        createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
        createDocumentFragmentRepository: vi.fn(() => fragments),
        createModelProvider: vi.fn(() => ({
          generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft" })),
        })),
        createEmbeddingProfileRepository: vi.fn(() => embeddingProfiles),
        createEmbeddingProvider: vi.fn(() => embeddingProvider),
      },
    });

    await runtime?.answerDraftOrchestrator.generateDraft({
      question: "Use production embedder?",
      liveChatMessages: [],
    });

    expect(embeddingProfiles.findOrCreateProfile).toHaveBeenCalledWith({
      provider: "openai-compatible",
      model: "text-embedding-small",
      dimensions: 1536,
      displayName: "OpenAI-compatible text-embedding-small (1536d)",
    });
    expect(fragments.searchSimilarFragments).toHaveBeenCalledWith({
      embeddingProfileId: "openai-compatible:text-embedding-small:1536",
      embedding: vector,
      limit: 8,
    });
  });
```

Add new unsupported dimension test:

```ts
  it("rejects unsupported embedding dimensions when generating a draft", async () => {
    const runtime = createAnswerDraftRuntime({
      env: {
        ...enabledEnv(),
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "embed-key",
        IRIS_EMBEDDING_MODEL: "text-embedding-large",
        IRIS_EMBEDDING_DIMENSIONS: "3072",
      },
      dependencies: {
        createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
        createDocumentFragmentRepository: vi.fn(() => ({ searchSimilarFragments: vi.fn(async () => []) })),
        createModelProvider: vi.fn(() => ({
          generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft" })),
        })),
        createEmbeddingProfileRepository: vi.fn(() => ({
          getStaticDevelopmentProfile: vi.fn(),
          findOrCreateProfile: vi.fn(),
          getProfileById: vi.fn(),
        })),
      },
    });

    await expect(
      runtime?.answerDraftOrchestrator.generateDraft({
        question: "bad",
        liveChatMessages: [],
      }),
    ).rejects.toThrow("Unsupported embedding dimension: 3072");
  });
```

- [ ] **Step 2: Run runtime test to verify failure**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-runtime.test.ts
```

Expected: FAIL because runtime still rejects all non-6 configured dimensions.

- [ ] **Step 3: Implement supported dimension guard**

Modify `apps/core/src/runtime/answer-draft-runtime.ts`.

Replace:

```ts
  if (embeddingConfig.dimensions !== 6) {
    throw new Error(
      "IRIS_EMBEDDING_DIMENSIONS must be 6 until document_fragments vector storage is migrated",
    );
  }
```

with:

```ts
  assertSupportedRuntimeEmbeddingDimension(embeddingConfig.dimensions);
```

Add helper:

```ts
function assertSupportedRuntimeEmbeddingDimension(dimension: number): void {
  if (dimension !== 6 && dimension !== 1536) {
    throw new Error(`Unsupported embedding dimension: ${dimension}`);
  }
}
```

- [ ] **Step 4: Run runtime tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-runtime.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit runtime dimension support**

Run:

```powershell
git add apps/core/src/runtime/answer-draft-runtime.ts apps/core/tests/answer-draft-runtime.test.ts
git commit -m "feat: allow 1536-dimensional embedding runtime"
```

Expected: commit succeeds.

## Task 5: Final Verification and PR Update

**Files:**
- Modify PR body only.

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
$body = gh pr view 3 --repo xfbbert-dotcom/iris --json body --jq .body
$phase2M = "- Add Phase 2M dimension-sharded vector storage: 6d and 1536d embedding tables, profile-dimension routing, vector length validation, and 1536-dimensional runtime support."
if ($body -notlike "*Phase 2M dimension-sharded vector storage*") {
  $body = $body -replace "(## Test Plan)", "$phase2M`n`n`$1"
}
$body | gh pr edit 3 --repo xfbbert-dotcom/iris --body-file -
gh pr view 3 --repo xfbbert-dotcom/iris --json number,state,isDraft,mergeable,headRefOid,url
```

Expected: push succeeds and PR remains open and mergeable.

## Self-Review Checklist

- `document_fragments.embedding` is no longer used for repository writes or search.
- Search SQL always joins a closed-mapping embedding table.
- Table names are never derived from user input.
- `embeddingProfileId` remains required at call boundaries.
- 6d and 1536d profiles route to different physical tables.
- Unsupported dimensions fail explicitly.
- Vector length mismatches fail before SQL writes/searches.
- Runtime allows 1536 and rejects 3072.
- Tests do not call real embedding APIs.
