# Iris Reindex Runtime and API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2P of Iris: compose a default Redis/Postgres reindex worker runtime and expose an internal API to enqueue profile reindex jobs.

**Architecture:** Add a `createReindexWorkerRuntime` composer that wires Redis, Postgres repositories, embedding profile resolution, semantic indexing, planner, worker, and polling loop. Update `buildApp` to use this runtime by default and add `POST /internal/reindex/document-profile`, guarded to the runtime's active embedding profile.

**Tech Stack:** TypeScript, Vitest, Fastify, PostgreSQL, Redis npm client, existing Iris reindex modules.

---

## Scope

This plan implements `docs/superpowers/specs/2026-07-02-iris-reindex-runtime-and-api-design.md`.

It includes:

- `apps/core/src/runtime/reindex-worker-runtime.ts`;
- lazy Redis connection adapter for `RedisDocumentReindexQueueClient`;
- runtime active embedding profile resolution;
- app default runtime composition;
- internal manual profile reindex API;
- request validation and error responses;
- deterministic tests with fake dependencies.

It does not include:

- worker health API;
- progress API;
- multi-profile worker routing;
- dead-letter queues;
- public authentication.

## File Structure

Create:

```text
apps/core/src/runtime/reindex-worker-runtime.ts
apps/core/tests/reindex-worker-runtime.test.ts
```

Modify:

```text
apps/core/src/app.ts
apps/core/tests/answer-draft-api.test.ts
```

## Task 1: Add Reindex Worker Runtime Composer

**Files:**
- Create: `apps/core/src/runtime/reindex-worker-runtime.ts`
- Create: `apps/core/tests/reindex-worker-runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Create `apps/core/tests/reindex-worker-runtime.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createReindexWorkerRuntime } from "../src/runtime/reindex-worker-runtime.js";

describe("createReindexWorkerRuntime", () => {
  it("returns undefined when the reindex worker is disabled", () => {
    expect(createReindexWorkerRuntime({ env: {} })).toBeUndefined();
  });

  it("composes Redis, repositories, planner, worker, and loop when enabled", async () => {
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const redisClient = {
      connect: vi.fn(async () => redisClient),
      eval: vi.fn(async () => 1),
      lPop: vi.fn(async () => null),
      quit: vi.fn(async () => undefined),
    };
    const embeddingProfile = {
      id: "openai-compatible:text-embedding-small:1536",
      provider: "openai-compatible" as const,
      model: "text-embedding-small",
      dimensions: 1536,
      displayName: "OpenAI-compatible text-embedding-small (1536d)",
      status: "active" as const,
      createdAt: new Date("2026-07-02T01:00:00.000Z"),
    };
    const snapshots = {
      listSuccessfulSnapshotsMissingProfile: vi.fn(async () => []),
      findSnapshotById: vi.fn(),
    };
    const fragments = {
      replaceFragmentsForSnapshot: vi.fn(),
      hasFragmentsForSnapshotProfile: vi.fn(),
    };
    const loop = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      isRunning: vi.fn(() => false),
    };

    const runtime = createReindexWorkerRuntime({
      env: enabledEnv(),
      dependencies: {
        createPostgresPool: vi.fn(() => pool),
        createRedisClient: vi.fn(() => redisClient),
        createEmbeddingProfileRepository: vi.fn(() => ({
          findOrCreateProfile: vi.fn(async () => embeddingProfile),
          getProfileById: vi.fn(async () => embeddingProfile),
          getStaticDevelopmentProfile: vi.fn(),
        })),
        createDocumentSnapshotRepository: vi.fn(() => snapshots),
        createDocumentFragmentRepository: vi.fn(() => fragments),
        createEmbeddingProvider: vi.fn(() => ({ embedTexts: vi.fn(async () => []) })),
        createWorkerLoop: vi.fn(() => loop),
      },
    });

    expect(runtime).toBeDefined();
    expect(runtime?.activeEmbeddingProfileId).toBe("openai-compatible:text-embedding-small:1536");

    await expect(
      runtime?.planner.planDocumentProfileReindex({
        embeddingProfileId: "openai-compatible:text-embedding-small:1536",
        limit: 10,
      }),
    ).resolves.toEqual({ enqueuedCount: 0, skippedCount: 0 });
    expect(redisClient.eval).not.toHaveBeenCalled();

    runtime?.start();
    expect(loop.start).toHaveBeenCalledOnce();

    await runtime?.close();
    expect(loop.stop).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("rejects planner calls for non-active embedding profiles", async () => {
    const runtime = createReindexWorkerRuntime({
      env: enabledEnv(),
      dependencies: runtimeDependencies(),
    });

    await expect(
      runtime?.planner.planDocumentProfileReindex({
        embeddingProfileId: "other-profile",
        limit: 10,
      }),
    ).rejects.toThrow("embeddingProfileId does not match active reindex profile");
  });

  it("requires embedding provider config when enabled", () => {
    expect(() =>
      createReindexWorkerRuntime({
        env: {
          IRIS_REINDEX_WORKER_ENABLED: "true",
          DATABASE_URL: "postgres://example",
        },
        dependencies: runtimeDependencies(),
      }),
    ).toThrow("IRIS_EMBEDDING_PROVIDER is required when reindex worker is enabled");
  });

  it("requires supported embedding dimensions when enabled", () => {
    expect(() =>
      createReindexWorkerRuntime({
        env: {
          ...enabledEnv(),
          IRIS_EMBEDDING_DIMENSIONS: "3072",
        },
        dependencies: runtimeDependencies(),
      }),
    ).toThrow("Unsupported embedding dimension: 3072");
  });
});

function enabledEnv() {
  return {
    IRIS_REINDEX_WORKER_ENABLED: "true",
    DATABASE_URL: "postgres://example",
    REDIS_URL: "redis://localhost:6379",
    IRIS_EMBEDDING_PROVIDER: "openai-compatible",
    IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
    IRIS_EMBEDDING_API_KEY: "key",
    IRIS_EMBEDDING_MODEL: "text-embedding-small",
    IRIS_EMBEDDING_DIMENSIONS: "1536",
  };
}

function runtimeDependencies() {
  const embeddingProfile = {
    id: "openai-compatible:text-embedding-small:1536",
    provider: "openai-compatible" as const,
    model: "text-embedding-small",
    dimensions: 1536,
    displayName: "OpenAI-compatible text-embedding-small (1536d)",
    status: "active" as const,
    createdAt: new Date("2026-07-02T01:00:00.000Z"),
  };
  const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
  const redisClient = {
    connect: vi.fn(async () => redisClient),
    eval: vi.fn(async () => 1),
    lPop: vi.fn(async () => null),
    quit: vi.fn(async () => undefined),
  };

  return {
    createPostgresPool: vi.fn(() => pool),
    createRedisClient: vi.fn(() => redisClient),
    createEmbeddingProfileRepository: vi.fn(() => ({
      findOrCreateProfile: vi.fn(async () => embeddingProfile),
      getProfileById: vi.fn(async () => embeddingProfile),
      getStaticDevelopmentProfile: vi.fn(),
    })),
    createDocumentSnapshotRepository: vi.fn(() => ({
      listSuccessfulSnapshotsMissingProfile: vi.fn(async () => []),
      findSnapshotById: vi.fn(),
    })),
    createDocumentFragmentRepository: vi.fn(() => ({
      replaceFragmentsForSnapshot: vi.fn(),
      hasFragmentsForSnapshotProfile: vi.fn(),
    })),
    createEmbeddingProvider: vi.fn(() => ({ embedTexts: vi.fn(async () => []) })),
    createWorkerLoop: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      isRunning: vi.fn(() => false),
    })),
  };
}
```

- [ ] **Step 2: Run runtime tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- reindex-worker-runtime.test.ts
```

Expected: FAIL because `reindex-worker-runtime.ts` does not exist.

- [ ] **Step 3: Implement runtime composer**

Create `apps/core/src/runtime/reindex-worker-runtime.ts`:

```ts
import { createClient } from "redis";

import {
  readEmbeddingProviderConfig,
  readReindexWorkerRuntimeConfig,
  type EmbeddingProviderConfig,
  type EnvLike,
} from "../config/env.js";
import { readDatabaseConfig, type DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import { createDocumentChunker } from "../documents/document-chunker.js";
import {
  createDocumentFragmentRepository,
  type DocumentFragmentRepository,
  type Queryable,
} from "../documents/document-fragment-repository.js";
import {
  createDocumentSemanticIndexer,
  type EmbeddingProvider,
} from "../documents/document-semantic-indexer.js";
import {
  createDocumentSnapshotRepository,
  type DocumentSnapshotRepository,
} from "../documents/document-snapshot-repository.js";
import {
  createEmbeddingProfileRepository,
  type EmbeddingProfile,
  type EmbeddingProfileRepository,
} from "../documents/embedding-profile-repository.js";
import { createOpenAICompatibleEmbeddingProvider } from "../model/openai-compatible-embedding-provider.js";
import { createDocumentReindexPlanner } from "../reindex/document-reindex-planner.js";
import { createDocumentReindexWorker } from "../reindex/document-reindex-worker.js";
import {
  createDocumentReindexWorkerLoop,
  type DocumentReindexWorkerLoop,
} from "../reindex/document-reindex-worker-loop.js";
import {
  createRedisDocumentReindexQueue,
  type RedisDocumentReindexQueueClient,
} from "../reindex/redis-document-reindex-queue.js";

export type ReindexWorkerRuntime = {
  activeEmbeddingProfileId: string;
  planner: {
    planDocumentProfileReindex(input: {
      embeddingProfileId: string;
      limit: number;
    }): Promise<{ enqueuedCount: number; skippedCount: number }>;
  };
  start(): void;
  close(): Promise<void>;
};

type RedisClient = RedisDocumentReindexQueueClient & {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
};

export type ReindexWorkerRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => Queryable & { end(): Promise<void> };
  createRedisClient?: (url: string) => RedisClient;
  createEmbeddingProfileRepository?: (dependencies: { queryable: Queryable }) => Pick<
    EmbeddingProfileRepository,
    "findOrCreateProfile" | "getProfileById" | "getStaticDevelopmentProfile"
  >;
  createDocumentSnapshotRepository?: (dependencies: {
    queryable: Queryable;
  }) => Pick<
    DocumentSnapshotRepository,
    "listSuccessfulSnapshotsMissingProfile" | "findSnapshotById"
  >;
  createDocumentFragmentRepository?: (dependencies: {
    queryable: Queryable;
    embeddingProfiles: Pick<EmbeddingProfileRepository, "getProfileById">;
  }) => Pick<
    DocumentFragmentRepository,
    "replaceFragmentsForSnapshot" | "hasFragmentsForSnapshotProfile"
  >;
  createEmbeddingProvider?: (config: EmbeddingProviderConfig) => EmbeddingProvider;
  createWorkerLoop?: typeof createDocumentReindexWorkerLoop;
};

export function createReindexWorkerRuntime({
  env = process.env,
  dependencies = {},
}: {
  env?: EnvLike;
  dependencies?: ReindexWorkerRuntimeDependencies;
} = {}): ReindexWorkerRuntime | undefined {
  const runtimeConfig = readReindexWorkerRuntimeConfig(env);
  if (!runtimeConfig.enabled) {
    return undefined;
  }

  const embeddingConfig = readEmbeddingProviderConfig(env);
  if (embeddingConfig === undefined) {
    throw new Error("IRIS_EMBEDDING_PROVIDER is required when reindex worker is enabled");
  }
  if (embeddingConfig.dimensions === undefined) {
    throw new Error("IRIS_EMBEDDING_DIMENSIONS is required when reindex worker is enabled");
  }
  assertSupportedRuntimeEmbeddingDimension(embeddingConfig.dimensions);

  const createPool = dependencies.createPostgresPool ?? createPostgresPool;
  const createRedis =
    dependencies.createRedisClient ??
    ((url: string) => createClient({ url }) as unknown as RedisClient);
  const createProfiles =
    dependencies.createEmbeddingProfileRepository ?? createEmbeddingProfileRepository;
  const createSnapshots =
    dependencies.createDocumentSnapshotRepository ?? createDocumentSnapshotRepository;
  const createFragments =
    dependencies.createDocumentFragmentRepository ?? createDocumentFragmentRepository;
  const createEmbedding =
    dependencies.createEmbeddingProvider ??
    ((config: EmbeddingProviderConfig) => createOpenAICompatibleEmbeddingProvider({ config }));
  const createLoop = dependencies.createWorkerLoop ?? createDocumentReindexWorkerLoop;

  const pool = createPool(readDatabaseConfig(env));
  const redis = createRedis(runtimeConfig.redisUrl);
  const redisConnection = redis.connect().then(() => redis);
  const redisQueueClient = createLazyRedisQueueClient(redisConnection);
  const queue = createRedisDocumentReindexQueue({ client: redisQueueClient });
  const profiles = createProfiles({ queryable: pool });
  const activeEmbeddingProfileId = profileId(
    "openai-compatible",
    embeddingConfig.model,
    embeddingConfig.dimensions,
  );
  const activeProfilePromise = profiles.findOrCreateProfile({
    provider: "openai-compatible",
    model: embeddingConfig.model,
    dimensions: embeddingConfig.dimensions,
    displayName: `OpenAI-compatible ${embeddingConfig.model} (${embeddingConfig.dimensions}d)`,
  });
  const snapshots = createSnapshots({ queryable: pool });
  const fragments = createFragments({ queryable: pool, embeddingProfiles: profiles });
  const embedder = createEmbedding(embeddingConfig);
  const indexer = {
    async indexSnapshot(snapshot: Parameters<ReturnType<typeof createDocumentSemanticIndexer>["indexSnapshot"]>[0]) {
      const activeProfile = await activeProfilePromise;
      return createDocumentSemanticIndexer({
        chunker: createDocumentChunker(),
        embedder,
        embeddingProfileId: activeProfile.id,
        fragments,
      }).indexSnapshot(snapshot);
    },
  };
  const worker = createDocumentReindexWorker({
    queue,
    snapshots,
    fragments,
    indexer,
  });
  const loop = createLoop({
    worker,
    intervalMs: runtimeConfig.intervalMs,
    batchLimit: runtimeConfig.batchLimit,
    onError: () => undefined,
  });
  const planner = createDocumentReindexPlanner({ snapshots, queue });

  return {
    activeEmbeddingProfileId,
    planner: {
      async planDocumentProfileReindex(input) {
        if (input.embeddingProfileId !== activeEmbeddingProfileId) {
          throw new Error("embeddingProfileId does not match active reindex profile");
        }
        await activeProfilePromise;
        return planner.planDocumentProfileReindex(input);
      },
    },
    start() {
      loop.start();
    },
    async close() {
      await loop.stop();
      await redisConnection.then((client) => client.quit());
      await pool.end();
    },
  };
}

function createLazyRedisQueueClient(
  redisConnection: Promise<RedisClient>,
): RedisDocumentReindexQueueClient {
  return {
    async eval(script, options) {
      const client = await redisConnection;
      return client.eval(script, options);
    },
    async lPop(key) {
      const client = await redisConnection;
      return client.lPop(key);
    },
  };
}

function assertSupportedRuntimeEmbeddingDimension(dimension: number): void {
  if (dimension !== 6 && dimension !== 1536) {
    throw new Error(`Unsupported embedding dimension: ${dimension}`);
  }
}

function profileId(provider: "openai-compatible", model: string, dimensions: number): string {
  return `${provider}:${model}:${dimensions}`;
}
```

- [ ] **Step 4: Run runtime tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- reindex-worker-runtime.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit runtime composer**

Run:

```powershell
git add apps/core/src/runtime/reindex-worker-runtime.ts apps/core/tests/reindex-worker-runtime.test.ts
git commit -m "feat: compose reindex worker runtime"
```

Expected: commit succeeds.

## Task 2: Add Internal Reindex API

**Files:**
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [ ] **Step 1: Write failing API tests**

Append to `apps/core/tests/answer-draft-api.test.ts`:

```ts
describe("POST /internal/reindex/document-profile", () => {
  it("returns 503 when reindex runtime is unavailable", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/reindex/document-profile",
      payload: {
        embeddingProfileId: "openai-compatible:text-embedding-small:1536",
        limit: 10,
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "reindex_worker_unavailable" });
  });

  it("returns 400 for invalid reindex requests", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => fakeReindexRuntime(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/reindex/document-profile",
      payload: { embeddingProfileId: " ", limit: 0 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("rejects profile ids that do not match the active runtime profile", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => fakeReindexRuntime(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/reindex/document-profile",
      payload: { embeddingProfileId: "other-profile", limit: 10 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("plans document profile reindex jobs", async () => {
    const runtime = fakeReindexRuntime();
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/reindex/document-profile",
      payload: {
        embeddingProfileId: "openai-compatible:text-embedding-small:1536",
        limit: 10,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, enqueuedCount: 2, skippedCount: 0 });
    expect(runtime.planner.planDocumentProfileReindex).toHaveBeenCalledWith({
      embeddingProfileId: "openai-compatible:text-embedding-small:1536",
      limit: 10,
    });
  });

  it("returns 500 when reindex planning fails", async () => {
    const runtime = fakeReindexRuntime({
      planner: {
        planDocumentProfileReindex: vi.fn(async () => {
          throw new Error("planner failed");
        }),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/reindex/document-profile",
      payload: {
        embeddingProfileId: "openai-compatible:text-embedding-small:1536",
        limit: 10,
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ ok: false, error: "reindex_plan_failed" });
  });
});

function fakeReindexRuntime(overrides: Partial<ReturnType<typeof fakeReindexRuntime>> = {}) {
  return {
    activeEmbeddingProfileId: "openai-compatible:text-embedding-small:1536",
    planner: {
      planDocumentProfileReindex: vi.fn(async () => ({
        enqueuedCount: 2,
        skippedCount: 0,
      })),
    },
    start: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}
```

- [ ] **Step 2: Run API tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts
```

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement app route and default runtime composition**

Modify `apps/core/src/app.ts`:

Add import:

```ts
import {
  createReindexWorkerRuntime,
  type ReindexWorkerRuntime
} from "./runtime/reindex-worker-runtime.js";
```

Remove the local `ReindexWorkerRuntime` type from `app.ts`.

Change runtime creation:

```ts
  const reindexWorkerRuntime =
    (dependencies.createReindexWorkerRuntime ?? createReindexWorkerRuntime)();
```

Add request type:

```ts
type ReindexDocumentProfileRequest = {
  embeddingProfileId: string;
  limit: number;
};
```

Add route before `/health`:

```ts
  app.post("/internal/reindex/document-profile", async (request, reply) => {
    if (reindexWorkerRuntime === undefined) {
      return reply.code(503).send({ ok: false, error: "reindex_worker_unavailable" });
    }

    const body = isParsedJsonBody(request.body) ? request.body.parsedBody : request.body;
    const parsedRequest = parseReindexDocumentProfileRequest(
      body,
      reindexWorkerRuntime.activeEmbeddingProfileId,
    );
    if (parsedRequest === undefined) {
      return reply.code(400).send({ ok: false, error: "invalid_request" });
    }

    try {
      const result = await reindexWorkerRuntime.planner.planDocumentProfileReindex(parsedRequest);
      return { ok: true, ...result };
    } catch {
      return reply.code(500).send({ ok: false, error: "reindex_plan_failed" });
    }
  });
```

Add parser:

```ts
function parseReindexDocumentProfileRequest(
  value: unknown,
  activeEmbeddingProfileId: string,
): ReindexDocumentProfileRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const embeddingProfileId =
    typeof value.embeddingProfileId === "string" ? value.embeddingProfileId.trim() : "";
  if (embeddingProfileId.length === 0 || embeddingProfileId !== activeEmbeddingProfileId) {
    return undefined;
  }
  if (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit <= 0) {
    return undefined;
  }

  return { embeddingProfileId, limit: value.limit };
}
```

- [ ] **Step 4: Run API tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit internal API**

Run:

```powershell
git add apps/core/src/app.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: add internal document reindex API"
```

Expected: commit succeeds.

## Task 3: Final Verification and PR Update

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
$phase2P = "- Add Phase 2P reindex runtime and API: default Redis/Postgres worker runtime composer and internal document-profile reindex trigger."
if ($body -notlike "*Phase 2P reindex runtime and API*") {
  $body = $body -replace "(## Test Plan)", "$phase2P`n`n`$1"
}
$body | gh pr edit 3 --repo xfbbert-dotcom/iris --body-file -
gh pr view 3 --repo xfbbert-dotcom/iris --json number,state,isDraft,mergeable,headRefOid,url
```

Expected: push succeeds and PR remains open and mergeable.

## Self-Review Checklist

- Runtime disabled mode returns `undefined` without connecting Redis or Postgres.
- Runtime enabled mode requires embedding provider and dimensions.
- Runtime only serves one active embedding profile.
- Internal API rejects profile ids that do not match the active runtime profile.
- Internal API only enqueues jobs and does not embed synchronously.
- App default startup remains safe because reindex worker config is disabled by default.
- Final checks run from a clean worktree before pushing.
