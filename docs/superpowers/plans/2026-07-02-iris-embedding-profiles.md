# Iris Embedding Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2L of Iris: add embedding profiles so fragments, indexing, and answer-time retrieval are scoped to one explicit embedding vector space.

**Architecture:** Add a durable `embedding_profiles` table and repository, then make `document_fragments`, semantic indexing, document retrieval, and answer draft runtime carry an `embeddingProfileId`. Runtime uses the static development profile by default and can wire the OpenAI-compatible embedding provider only when dimensions are explicitly `6` until vector storage is migrated.

**Tech Stack:** TypeScript, Vitest, PostgreSQL, pgvector, existing migration runner, existing OpenAI-compatible embedding provider.

---

## Scope

This plan implements the approved Phase 2L design in `docs/superpowers/specs/2026-07-02-iris-embedding-profiles-design.md`.

It includes:

- migration `0004_embedding_profiles.sql`;
- `EmbeddingProfileRepository`;
- `embeddingProfileId` on fragment writes, reads, and vector search;
- `embeddingProfileId` on semantic indexing and retrieval context;
- answer draft runtime profile resolution and embedding provider wiring guards.

It intentionally does not implement:

- production-sized vector storage;
- automatic full reindexing;
- profile admin UI;
- vector index tuning;
- Feishu live permission API calls.

## File Structure

Create:

```text
apps/core/migrations/0004_embedding_profiles.sql
apps/core/src/documents/embedding-profile-repository.ts
apps/core/tests/embedding-profile-repository.test.ts
```

Modify:

```text
apps/core/src/documents/document-fragment-repository.ts
apps/core/src/documents/document-semantic-indexer.ts
apps/core/src/memory/document-retrieval-context.ts
apps/core/src/runtime/answer-draft-runtime.ts
apps/core/tests/document-fragment-repository.test.ts
apps/core/tests/document-semantic-indexer.test.ts
apps/core/tests/document-retrieval-context.test.ts
apps/core/tests/answer-draft-runtime.test.ts
```

Responsibilities:

- migration: create profile table, static dev profile, fragment foreign key, and profile-aware index;
- profile repository: profile lookup/creation and static development profile access;
- fragment repository: persist and search fragments by profile id;
- semantic indexer: require profile id from caller;
- retrieval context: require active profile id for search;
- runtime: resolve active profile and query embedder.

## Task 1: Add Embedding Profiles Migration

**Files:**
- Create: `apps/core/migrations/0004_embedding_profiles.sql`
- Test: `apps/core/tests/migration-runner.test.ts`

- [ ] **Step 1: Add failing migration presence test**

Append this test to the `defaultMigrationsDir` describe block in `apps/core/tests/migration-runner.test.ts`:

```ts
  it("includes embedding profile migration after document fragments", async () => {
    const names = (await import("node:fs/promises")).readdir(defaultMigrationsDir());

    await expect(names).resolves.toEqual(
      expect.arrayContaining(["0003_document_fragments.sql", "0004_embedding_profiles.sql"]),
    );
  });
```

- [ ] **Step 2: Run migration test to verify failure**

Run:

```powershell
npm --workspace apps/core test -- migration-runner.test.ts
```

Expected: FAIL because `0004_embedding_profiles.sql` does not exist.

- [ ] **Step 3: Create migration**

Create `apps/core/migrations/0004_embedding_profiles.sql`:

```sql
create table if not exists embedding_profiles (
  id text primary key,
  provider text not null check (length(trim(provider)) > 0),
  model text not null check (length(trim(model)) > 0),
  dimensions integer not null check (dimensions > 0),
  display_name text not null check (length(trim(display_name)) > 0),
  status text not null check (status in ('active', 'deprecated')),
  created_at timestamptz not null,
  unique (provider, model, dimensions)
);

insert into embedding_profiles (
  id,
  provider,
  model,
  dimensions,
  display_name,
  status,
  created_at
)
values (
  'static-dev-6d',
  'static-dev',
  'static-dev-6d',
  6,
  'Static development embeddings (6d)',
  'active',
  now()
)
on conflict (provider, model, dimensions) do nothing;

alter table document_fragments
  add column if not exists embedding_profile_id text;

update document_fragments
set embedding_profile_id = 'static-dev-6d'
where embedding_profile_id is null;

alter table document_fragments
  alter column embedding_profile_id set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_fragments_embedding_profile_id_fkey'
  ) then
    alter table document_fragments
      add constraint document_fragments_embedding_profile_id_fkey
      foreign key (embedding_profile_id)
      references embedding_profiles(id);
  end if;
end $$;

create index if not exists document_fragments_profile_chunk_idx
on document_fragments (embedding_profile_id, document_source_id, chunk_index asc, id asc);
```

- [ ] **Step 4: Run migration test**

Run:

```powershell
npm --workspace apps/core test -- migration-runner.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit migration**

Run:

```powershell
git add apps/core/migrations/0004_embedding_profiles.sql apps/core/tests/migration-runner.test.ts
git commit -m "feat: add embedding profiles migration"
```

Expected: commit succeeds.

## Task 2: Add Embedding Profile Repository

**Files:**
- Create: `apps/core/src/documents/embedding-profile-repository.ts`
- Create: `apps/core/tests/embedding-profile-repository.test.ts`

- [ ] **Step 1: Write failing repository tests**

Create `apps/core/tests/embedding-profile-repository.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import {
  createEmbeddingProfileRepository,
  staticDevelopmentEmbeddingProfile,
  type Queryable,
} from "../src/documents/embedding-profile-repository.js";

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function queryableFrom(query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>): Queryable {
  return { query: query as Queryable["query"] };
}

describe("EmbeddingProfileRepository", () => {
  it("returns the static development profile", async () => {
    const createdAt = new Date("2026-07-02T01:00:00.000Z");
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(normalizeSql(sql)).toContain("select * from embedding_profiles");
      expect(values).toEqual(["static-dev-6d"]);
      return {
        rows: [
          {
            id: "static-dev-6d",
            provider: "static-dev",
            model: "static-dev-6d",
            dimensions: 6,
            display_name: "Static development embeddings (6d)",
            status: "active",
            created_at: createdAt,
          },
        ],
      };
    });
    const repository = createEmbeddingProfileRepository({ queryable: queryableFrom(query) });

    await expect(repository.getStaticDevelopmentProfile()).resolves.toEqual({
      ...staticDevelopmentEmbeddingProfile,
      createdAt,
    });
  });

  it("finds or creates an active profile using provider model and dimensions", async () => {
    const createdAt = new Date("2026-07-02T02:00:00.000Z");
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(normalizeSql(sql)).toContain("insert into embedding_profiles");
      expect(values).toEqual([
        "openai-compatible:text-embedding-small:6",
        "openai-compatible",
        "text-embedding-small",
        6,
        "OpenAI-compatible text-embedding-small (6d)",
        "active",
      ]);
      return {
        rows: [
          {
            id: "openai-compatible:text-embedding-small:6",
            provider: "openai-compatible",
            model: "text-embedding-small",
            dimensions: 6,
            display_name: "OpenAI-compatible text-embedding-small (6d)",
            status: "active",
            created_at: createdAt,
          },
        ],
      };
    });
    const repository = createEmbeddingProfileRepository({ queryable: queryableFrom(query) });

    await expect(
      repository.findOrCreateProfile({
        provider: "openai-compatible",
        model: "text-embedding-small",
        dimensions: 6,
        displayName: "OpenAI-compatible text-embedding-small (6d)",
      }),
    ).resolves.toEqual({
      id: "openai-compatible:text-embedding-small:6",
      provider: "openai-compatible",
      model: "text-embedding-small",
      dimensions: 6,
      displayName: "OpenAI-compatible text-embedding-small (6d)",
      status: "active",
      createdAt,
    });
  });

  it("throws when the static development profile is missing", async () => {
    const repository = createEmbeddingProfileRepository({
      queryable: queryableFrom(vi.fn(async () => ({ rows: [] }))),
    });

    await expect(repository.getStaticDevelopmentProfile()).rejects.toThrow(
      "static development embedding profile was not found",
    );
  });
});
```

- [ ] **Step 2: Run repository tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- embedding-profile-repository.test.ts
```

Expected: FAIL because repository module does not exist.

- [ ] **Step 3: Implement repository**

Create `apps/core/src/documents/embedding-profile-repository.ts`:

```ts
export type Queryable = {
  query: <T = unknown>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

export type EmbeddingProfileProvider = "static-dev" | "openai-compatible";
export type EmbeddingProfileStatus = "active" | "deprecated";

export type EmbeddingProfile = {
  id: string;
  provider: EmbeddingProfileProvider;
  model: string;
  dimensions: number;
  displayName: string;
  status: EmbeddingProfileStatus;
  createdAt: Date;
};

export type FindOrCreateEmbeddingProfileInput = {
  provider: EmbeddingProfileProvider;
  model: string;
  dimensions: number;
  displayName: string;
};

export type EmbeddingProfileRepositoryDependencies = {
  queryable: Queryable;
};

export interface EmbeddingProfileRepository {
  findOrCreateProfile(input: FindOrCreateEmbeddingProfileInput): Promise<EmbeddingProfile>;
  getStaticDevelopmentProfile(): Promise<EmbeddingProfile>;
}

export const staticDevelopmentEmbeddingProfile = {
  id: "static-dev-6d",
  provider: "static-dev" as const,
  model: "static-dev-6d",
  dimensions: 6,
  displayName: "Static development embeddings (6d)",
  status: "active" as const,
};

type EmbeddingProfileRow = {
  id: string;
  provider: string;
  model: string;
  dimensions: number;
  display_name: string;
  status: string;
  created_at: Date;
};

export function createEmbeddingProfileRepository(
  dependencies: EmbeddingProfileRepositoryDependencies,
): EmbeddingProfileRepository {
  return {
    async findOrCreateProfile(input) {
      const id = profileId(input.provider, input.model, input.dimensions);
      const result = await dependencies.queryable.query<EmbeddingProfileRow>(
        `
insert into embedding_profiles (
  id,
  provider,
  model,
  dimensions,
  display_name,
  status,
  created_at
)
values ($1, $2, $3, $4, $5, $6, now())
on conflict (provider, model, dimensions)
do update set display_name = excluded.display_name
returning *
`,
        [id, input.provider, input.model, input.dimensions, input.displayName, "active"],
      );

      return mapProfileRow(readSingleRow(result.rows, "embedding profile was not returned"));
    },

    async getStaticDevelopmentProfile() {
      const result = await dependencies.queryable.query<EmbeddingProfileRow>(
        `
select *
from embedding_profiles
where id = $1
`,
        [staticDevelopmentEmbeddingProfile.id],
      );

      return mapProfileRow(
        readSingleRow(result.rows, "static development embedding profile was not found"),
      );
    },
  };
}

function profileId(provider: EmbeddingProfileProvider, model: string, dimensions: number): string {
  return `${provider}:${model}:${dimensions}`;
}

function readSingleRow<T>(rows: T[], errorMessage: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(errorMessage);
  }

  return row;
}

function mapProfileRow(row: EmbeddingProfileRow): EmbeddingProfile {
  if (row.provider !== "static-dev" && row.provider !== "openai-compatible") {
    throw new Error(`Unsupported embedding profile provider: ${row.provider}`);
  }
  if (row.status !== "active" && row.status !== "deprecated") {
    throw new Error(`Unsupported embedding profile status: ${row.status}`);
  }

  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    dimensions: Number(row.dimensions),
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
  };
}
```

- [ ] **Step 4: Run repository tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- embedding-profile-repository.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit repository**

Run:

```powershell
git add apps/core/src/documents/embedding-profile-repository.ts apps/core/tests/embedding-profile-repository.test.ts
git commit -m "feat: add embedding profile repository"
```

Expected: commit succeeds.

## Task 3: Bind Fragments, Indexing, and Retrieval to Profiles

**Files:**
- Modify: `apps/core/src/documents/document-fragment-repository.ts`
- Modify: `apps/core/src/documents/document-semantic-indexer.ts`
- Modify: `apps/core/src/memory/document-retrieval-context.ts`
- Modify: `apps/core/tests/document-fragment-repository.test.ts`
- Modify: `apps/core/tests/document-semantic-indexer.test.ts`
- Modify: `apps/core/tests/document-retrieval-context.test.ts`

- [ ] **Step 1: Update fragment repository tests first**

Change `apps/core/tests/document-fragment-repository.test.ts`:

1. Add `embedding_profile_id: "static-dev-6d"` to fake rows.
2. Add `embeddingProfileId: "static-dev-6d"` to `replaceFragmentsForSnapshot` calls.
3. Expect insert values to include `"static-dev-6d"` immediately before `createdAt`.
4. Expect returned fragments to include `embeddingProfileId: "static-dev-6d"`.
5. Change search call to:

```ts
repository.searchSimilarFragments({
  embeddingProfileId: "static-dev-6d",
  embedding: [1, 2, 3, 4, 5, 6],
  limit: 3,
})
```

6. In the search SQL assertion, add:

```ts
expect(normalizeSql(sql)).toContain("where embedding_profile_id = $1");
expect(values).toEqual(["static-dev-6d", "[1,2,3,4,5,6]", 3]);
```

- [ ] **Step 2: Update indexer and retrieval tests first**

Change `apps/core/tests/document-semantic-indexer.test.ts`:

1. Create indexer with:

```ts
embeddingProfileId: "static-dev-6d",
```

2. Expect replacement input to include:

```ts
embeddingProfileId: "static-dev-6d",
```

Change `apps/core/tests/document-retrieval-context.test.ts`:

1. Create context builders with:

```ts
embeddingProfileId: "static-dev-6d",
```

2. Expect search input to include:

```ts
embeddingProfileId: "static-dev-6d",
```

3. Add `embeddingProfileId: "static-dev-6d"` to helper fragments and explicit fragment fixtures.

- [ ] **Step 3: Run tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts document-semantic-indexer.test.ts document-retrieval-context.test.ts
```

Expected: FAIL because production types and SQL have not been updated.

- [ ] **Step 4: Update fragment repository implementation**

Modify `apps/core/src/documents/document-fragment-repository.ts`:

1. Add to `DocumentFragment`:

```ts
embeddingProfileId: string;
```

2. Add to `ReplaceFragmentsInput` and `SearchSimilarFragmentsInput`:

```ts
embeddingProfileId: string;
```

3. Add to row type:

```ts
embedding_profile_id: string;
```

4. Change search SQL:

```sql
select *, embedding <=> $2::vector as distance
from document_fragments
where embedding_profile_id = $1
order by embedding <=> $2::vector asc
limit $3
```

Use values:

```ts
[input.embeddingProfileId, serializeVector(input.embedding), input.limit]
```

5. Include `embedding_profile_id` in insert column list and values.
6. Add `embeddingProfileId: row.embedding_profile_id` in `mapFragmentRow`.

- [ ] **Step 5: Update semantic indexer implementation**

Modify `apps/core/src/documents/document-semantic-indexer.ts`:

1. Add constructor dependency:

```ts
embeddingProfileId: string;
```

2. Pass it into `fragments.replaceFragmentsForSnapshot`.

- [ ] **Step 6: Update retrieval context implementation**

Modify `apps/core/src/memory/document-retrieval-context.ts`:

1. Add builder dependency:

```ts
embeddingProfileId: string;
```

2. Pass it into `fragments.searchSimilarFragments`.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts document-semantic-indexer.test.ts document-retrieval-context.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit profile binding**

Run:

```powershell
git add apps/core/src/documents/document-fragment-repository.ts apps/core/src/documents/document-semantic-indexer.ts apps/core/src/memory/document-retrieval-context.ts apps/core/tests/document-fragment-repository.test.ts apps/core/tests/document-semantic-indexer.test.ts apps/core/tests/document-retrieval-context.test.ts
git commit -m "feat: scope document fragments to embedding profiles"
```

Expected: commit succeeds.

## Task 4: Wire Profiles into Answer Draft Runtime

**Files:**
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`
- Modify: `apps/core/tests/answer-draft-runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Update `apps/core/tests/answer-draft-runtime.test.ts`:

1. Import `type EmbeddingProfile`:

```ts
import type { EmbeddingProfile } from "../src/documents/embedding-profile-repository.js";
```

2. Add helper:

```ts
function profile(overrides: Partial<EmbeddingProfile> = {}): EmbeddingProfile {
  return {
    id: "static-dev-6d",
    provider: "static-dev",
    model: "static-dev-6d",
    dimensions: 6,
    displayName: "Static development embeddings (6d)",
    status: "active",
    createdAt: new Date("2026-07-02T01:00:00.000Z"),
    ...overrides,
  };
}
```

3. In existing runtime dependency tests, add:

```ts
createEmbeddingProfileRepository: vi.fn(() => ({
  getStaticDevelopmentProfile: vi.fn(async () => profile()),
  findOrCreateProfile: vi.fn(),
})),
```

4. In the working orchestrator test, expect:

```ts
expect(fragments.searchSimilarFragments).toHaveBeenCalledWith({
  embeddingProfileId: "static-dev-6d",
  embedding: [1, 0, 0, 0, 0, 0],
  limit: 8,
});
```

5. Add test:

```ts
  it("uses configured OpenAI-compatible embedding provider when dimensions are 6", async () => {
    const embeddingProvider = { embedTexts: vi.fn(async () => [[0, 1, 0, 0, 0, 0]]) };
    const embeddingProfiles = {
      getStaticDevelopmentProfile: vi.fn(),
      findOrCreateProfile: vi.fn(async () =>
        profile({
          id: "openai-compatible:text-embedding-small:6",
          provider: "openai-compatible",
          model: "text-embedding-small",
          dimensions: 6,
          displayName: "OpenAI-compatible text-embedding-small (6d)",
        }),
      ),
    };
    const fragments = { searchSimilarFragments: vi.fn(async () => []) };
    const runtime = createAnswerDraftRuntime({
      env: {
        ...enabledEnv(),
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "embed-key",
        IRIS_EMBEDDING_MODEL: "text-embedding-small",
        IRIS_EMBEDDING_DIMENSIONS: "6",
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
      question: "Use real embedder?",
      liveChatMessages: [],
    });

    expect(embeddingProfiles.findOrCreateProfile).toHaveBeenCalledWith({
      provider: "openai-compatible",
      model: "text-embedding-small",
      dimensions: 6,
      displayName: "OpenAI-compatible text-embedding-small (6d)",
    });
    expect(embeddingProvider.embedTexts).toHaveBeenCalledWith(["Use real embedder?"]);
    expect(fragments.searchSimilarFragments).toHaveBeenCalledWith({
      embeddingProfileId: "openai-compatible:text-embedding-small:6",
      embedding: [0, 1, 0, 0, 0, 0],
      limit: 8,
    });
  });
```

6. Add test:

```ts
  it("rejects configured embedding provider without dimensions when generating a draft", async () => {
    const runtime = createAnswerDraftRuntime({
      env: {
        ...enabledEnv(),
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "embed-key",
        IRIS_EMBEDDING_MODEL: "text-embedding-small",
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
        })),
      },
    });

    await expect(
      runtime?.answerDraftOrchestrator.generateDraft({
        question: "bad",
        liveChatMessages: [],
      }),
    ).rejects.toThrow(
      "IRIS_EMBEDDING_DIMENSIONS is required when internal answer drafts use an embedding provider",
    );
  });
```

7. Add test:

```ts
  it("rejects non-6 embedding dimensions until vector storage is migrated when generating a draft", async () => {
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
          createDocumentFragmentRepository: vi.fn(() => ({ searchSimilarFragments: vi.fn(async () => []) })),
          createModelProvider: vi.fn(() => ({
            generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft" })),
          })),
          createEmbeddingProfileRepository: vi.fn(() => ({
            getStaticDevelopmentProfile: vi.fn(),
            findOrCreateProfile: vi.fn(),
          })),
        },
      });

    await expect(
      runtime?.answerDraftOrchestrator.generateDraft({
        question: "bad",
        liveChatMessages: [],
      }),
    ).rejects.toThrow(
      "IRIS_EMBEDDING_DIMENSIONS must be 6 until document_fragments vector storage is migrated",
    );
  });
```

- [ ] **Step 2: Run runtime test to verify failure**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-runtime.test.ts
```

Expected: FAIL because runtime dependencies and profile resolution are not implemented.

- [ ] **Step 3: Implement runtime wiring**

Modify `apps/core/src/runtime/answer-draft-runtime.ts`:

1. Import:

```ts
import {
  createEmbeddingProfileRepository,
  type EmbeddingProfile,
  type EmbeddingProfileRepository,
} from "../documents/embedding-profile-repository.js";
import { createOpenAICompatibleEmbeddingProvider } from "../model/openai-compatible-embedding-provider.js";
import {
  readEmbeddingProviderConfig,
  type EmbeddingProviderConfig,
} from "../config/env.js";
```

2. Add dependencies:

```ts
  createEmbeddingProfileRepository?: (dependencies: { queryable: Queryable }) => Pick<
    EmbeddingProfileRepository,
    "getStaticDevelopmentProfile" | "findOrCreateProfile"
  >;
  createEmbeddingProvider?: (config: EmbeddingProviderConfig) => {
    embedTexts(texts: string[]): Promise<number[][]>;
  };
```

3. Keep `createAnswerDraftRuntime` synchronous. Resolve the active embedding profile lazily inside the returned orchestrator's `generateDraft`.

```ts
  const embeddingConfig = readEmbeddingProviderConfig(env);
  const createProfiles =
    dependencies.createEmbeddingProfileRepository ?? createEmbeddingProfileRepository;
  const profiles = createProfiles({ queryable: pool });
  const createEmbedding =
    dependencies.createEmbeddingProvider ??
    ((config: EmbeddingProviderConfig) => createOpenAICompatibleEmbeddingProvider({ config }));
  let runtimeEmbeddingPromise: Promise<RuntimeEmbedding> | undefined;
```

4. Replace eager `contextBuilder` and `answerDraftOrchestrator` construction with a lazy orchestrator:

```ts
const answerDraftOrchestrator = {
  async generateDraft(input) {
    runtimeEmbeddingPromise ??= resolveRuntimeEmbedding({
      embeddingConfig,
      profiles,
      createEmbeddingProvider: createEmbedding,
    });
    const runtimeEmbedding = await runtimeEmbeddingPromise;
    const contextBuilder = createDocumentRetrievalContextBuilder({
      embeddingProfileId: runtimeEmbedding.profile.id,
      embedder: runtimeEmbedding.embedder,
      fragments,
      canReadDocument: async () => true,
    });
    return createAnswerDraftOrchestrator({
      contextBuilder,
      model,
    }).generateDraft(input);
  },
};
```

This preserves the existing synchronous app startup API.

5. Add helper types and function:

```ts
type RuntimeEmbedding = {
  profile: EmbeddingProfile;
  embedder: { embedTexts(texts: string[]): Promise<number[][]> };
};

async function resolveRuntimeEmbedding({
  embeddingConfig,
  profiles,
  createEmbeddingProvider,
}: {
  embeddingConfig: EmbeddingProviderConfig | undefined;
  profiles: Pick<EmbeddingProfileRepository, "getStaticDevelopmentProfile" | "findOrCreateProfile">;
  createEmbeddingProvider: (config: EmbeddingProviderConfig) => {
    embedTexts(texts: string[]): Promise<number[][]>;
  };
}): Promise<RuntimeEmbedding> {
  if (embeddingConfig === undefined) {
    return {
      profile: await profiles.getStaticDevelopmentProfile(),
      embedder: createStaticQueryEmbeddingProvider(),
    };
  }

  if (embeddingConfig.dimensions === undefined) {
    throw new Error("IRIS_EMBEDDING_DIMENSIONS is required when internal answer drafts use an embedding provider");
  }
  if (embeddingConfig.dimensions !== 6) {
    throw new Error("IRIS_EMBEDDING_DIMENSIONS must be 6 until document_fragments vector storage is migrated");
  }

  return {
    profile: await profiles.findOrCreateProfile({
      provider: "openai-compatible",
      model: embeddingConfig.model,
      dimensions: embeddingConfig.dimensions,
      displayName: `OpenAI-compatible ${embeddingConfig.model} (${embeddingConfig.dimensions}d)`,
    }),
    embedder: createEmbeddingProvider(embeddingConfig),
  };
}
```

- [ ] **Step 4: Verify app caller remains synchronous**

Search:

```powershell
rg "createAnswerDraftRuntime" apps/core/src apps/core/tests
```

Expected: `apps/core/src/app.ts` still calls `createAnswerDraftRuntime()` synchronously and does not need async startup changes.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-runtime.test.ts answer-draft-api.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit runtime wiring**

Run:

```powershell
git add apps/core/src/runtime/answer-draft-runtime.ts apps/core/tests/answer-draft-runtime.test.ts
git commit -m "feat: wire answer runtime to embedding profiles"
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

Run:

```powershell
python -m pytest
```

from `workers/ai`.

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
gh pr view 3 --repo xfbbert-dotcom/iris --json body --jq .body
```

Append to PR summary:

```text
- Add Phase 2L embedding profiles: durable profile metadata, static development profile, profile-scoped fragments, indexing, retrieval, and runtime embedding profile resolution.
```

Run:

```powershell
$body = gh pr view 3 --repo xfbbert-dotcom/iris --json body --jq .body
$phase2L = "- Add Phase 2L embedding profiles: durable profile metadata, static development profile, profile-scoped fragments, indexing, retrieval, and runtime embedding profile resolution."
if ($body -notlike "*Phase 2L embedding profiles*") {
  $body = $body -replace "(## Test Plan)", "$phase2L`n`n`$1"
}
gh pr edit 3 --repo xfbbert-dotcom/iris --body $body
gh pr view 3 --repo xfbbert-dotcom/iris --json number,state,isDraft,mergeable,headRefOid,url
```

Expected: PR remains open and mergeable.

## Self-Review Checklist

- Every vector search is scoped by `embeddingProfileId`.
- Existing static 6d behavior is represented as `static-dev-6d`, not hidden.
- Runtime does not silently fall back to static embeddings when a real provider is configured.
- Runtime rejects non-6 dimensions until vector storage migration exists.
- No real embedding API calls happen in tests.
- No production-sized vector storage migration is included in this phase.
