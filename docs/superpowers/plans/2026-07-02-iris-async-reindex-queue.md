# Iris Async Reindex Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2N of Iris: add an asynchronous document reindex queue, planner, and worker so snapshots can be indexed for a target embedding profile outside request paths.

**Architecture:** Add a small `DocumentReindexQueue` boundary with an in-memory implementation, extend snapshot/fragment repositories with profile-coverage queries, then add a planner, sync enqueue helper, and idempotent worker. Redis production wiring is deferred, but the queue contract is shaped so a Redis driver can replace the in-memory implementation later.

**Tech Stack:** TypeScript, Vitest, PostgreSQL query repositories, existing `DocumentSemanticIndexer`, existing migration-free repository additions.

---

## Scope

This plan implements the approved Phase 2N design in `docs/superpowers/specs/2026-07-02-iris-async-reindex-queue-design.md`.

It includes:

- `DocumentReindexQueue` interface;
- `InMemoryDocumentReindexQueue`;
- idempotency key helper;
- snapshot repository methods for profile-missing snapshots;
- fragment repository method for snapshot/profile coverage;
- planner for manual profile reindex;
- sync success enqueue helper;
- idempotent worker for dequeued jobs.

It intentionally does not implement:

- Redis production driver;
- retry backoff;
- dead-letter queue;
- long-running worker entrypoint;
- HTTP reindex trigger route;
- admin progress UI.

## File Structure

Create:

```text
apps/core/src/reindex/document-reindex-queue.ts
apps/core/src/reindex/in-memory-document-reindex-queue.ts
apps/core/src/reindex/document-reindex-planner.ts
apps/core/src/reindex/document-reindex-worker.ts
apps/core/tests/document-reindex-queue.test.ts
apps/core/tests/document-reindex-planner.test.ts
apps/core/tests/document-reindex-worker.test.ts
```

Modify:

```text
apps/core/src/documents/document-snapshot-repository.ts
apps/core/src/documents/document-fragment-repository.ts
apps/core/tests/document-snapshot-repository.test.ts
apps/core/tests/document-fragment-repository.test.ts
```

Responsibilities:

- queue files: job contract, idempotency, in-memory queue behavior;
- snapshot repository: load by id and list successful snapshots missing a profile;
- fragment repository: check if snapshot/profile fragments already exist;
- planner: enqueue manual profile reindex jobs;
- worker: dequeue and process jobs idempotently through `DocumentSemanticIndexer`.

## Task 1: Add Reindex Queue Contract

**Files:**
- Create: `apps/core/src/reindex/document-reindex-queue.ts`
- Create: `apps/core/src/reindex/in-memory-document-reindex-queue.ts`
- Create: `apps/core/tests/document-reindex-queue.test.ts`

- [ ] **Step 1: Write failing queue tests**

Create `apps/core/tests/document-reindex-queue.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  createDocumentReindexIdempotencyKey,
  type DocumentReindexJob,
} from "../src/reindex/document-reindex-queue.js";
import { InMemoryDocumentReindexQueue } from "../src/reindex/in-memory-document-reindex-queue.js";

describe("InMemoryDocumentReindexQueue", () => {
  it("deduplicates jobs by idempotency key", async () => {
    const queue = new InMemoryDocumentReindexQueue();
    const job = jobFixture();

    await queue.enqueue(job);
    await queue.enqueue({ ...job, enqueuedAt: new Date("2026-07-02T02:00:00.000Z") });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([job]);
    await expect(queue.dequeueBatch(10)).resolves.toEqual([]);
  });

  it("dequeues at most the requested batch size in FIFO order", async () => {
    const queue = new InMemoryDocumentReindexQueue();
    const first = jobFixture({ documentSnapshotId: "snapshot-1" });
    const second = jobFixture({ documentSnapshotId: "snapshot-2" });

    await queue.enqueue(first);
    await queue.enqueue(second);

    await expect(queue.dequeueBatch(1)).resolves.toEqual([first]);
    await expect(queue.dequeueBatch(10)).resolves.toEqual([second]);
  });

  it("creates stable idempotency keys", () => {
    expect(
      createDocumentReindexIdempotencyKey({
        embeddingProfileId: "profile-1",
        documentSnapshotId: "snapshot-1",
      }),
    ).toBe("reindex:profile-1:snapshot-1");
  });
});

function jobFixture(overrides: Partial<DocumentReindexJob> = {}): DocumentReindexJob {
  const embeddingProfileId = overrides.embeddingProfileId ?? "profile-1";
  const documentSnapshotId = overrides.documentSnapshotId ?? "snapshot-1";

  return {
    idempotencyKey: createDocumentReindexIdempotencyKey({
      embeddingProfileId,
      documentSnapshotId,
    }),
    embeddingProfileId,
    documentSnapshotId,
    reason: "manual_profile_reindex",
    enqueuedAt: new Date("2026-07-02T01:00:00.000Z"),
    ...overrides,
  };
}
```

- [ ] **Step 2: Run queue tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- document-reindex-queue.test.ts
```

Expected: FAIL because reindex queue modules do not exist.

- [ ] **Step 3: Implement queue contract**

Create `apps/core/src/reindex/document-reindex-queue.ts`:

```ts
export type DocumentReindexReason = "document_synced" | "manual_profile_reindex";

export type DocumentReindexJob = {
  idempotencyKey: string;
  embeddingProfileId: string;
  documentSnapshotId: string;
  reason: DocumentReindexReason;
  enqueuedAt: Date;
};

export type CreateDocumentReindexIdempotencyKeyInput = {
  embeddingProfileId: string;
  documentSnapshotId: string;
};

export interface DocumentReindexQueue {
  enqueue(job: DocumentReindexJob): Promise<void>;
  dequeueBatch(limit: number): Promise<DocumentReindexJob[]>;
}

export function createDocumentReindexIdempotencyKey(
  input: CreateDocumentReindexIdempotencyKeyInput,
): string {
  return `reindex:${input.embeddingProfileId}:${input.documentSnapshotId}`;
}
```

Create `apps/core/src/reindex/in-memory-document-reindex-queue.ts`:

```ts
import type { DocumentReindexJob, DocumentReindexQueue } from "./document-reindex-queue.js";

export class InMemoryDocumentReindexQueue implements DocumentReindexQueue {
  private readonly jobs: DocumentReindexJob[] = [];
  private readonly seenKeys = new Set<string>();

  async enqueue(job: DocumentReindexJob): Promise<void> {
    if (this.seenKeys.has(job.idempotencyKey)) {
      return;
    }

    this.seenKeys.add(job.idempotencyKey);
    this.jobs.push(job);
  }

  async dequeueBatch(limit: number): Promise<DocumentReindexJob[]> {
    const safeLimit = Math.max(0, Math.floor(limit));
    return this.jobs.splice(0, safeLimit);
  }
}
```

- [ ] **Step 4: Run queue tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- document-reindex-queue.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit queue contract**

Run:

```powershell
git add apps/core/src/reindex/document-reindex-queue.ts apps/core/src/reindex/in-memory-document-reindex-queue.ts apps/core/tests/document-reindex-queue.test.ts
git commit -m "feat: add document reindex queue contract"
```

Expected: commit succeeds.

## Task 2: Add Repository Coverage Methods

**Files:**
- Modify: `apps/core/src/documents/document-snapshot-repository.ts`
- Modify: `apps/core/src/documents/document-fragment-repository.ts`
- Modify: `apps/core/tests/document-snapshot-repository.test.ts`
- Modify: `apps/core/tests/document-fragment-repository.test.ts`

- [ ] **Step 1: Write failing snapshot repository tests**

Append to `apps/core/tests/document-snapshot-repository.test.ts`:

```ts
  it("finds a snapshot by id", async () => {
    const createdAt = new Date("2026-07-02T01:00:00.000Z");
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(sql.toLowerCase()).toContain("where id = $1");
      expect(values).toEqual(["snapshot-1"]);
      return {
        rows: [
          {
            id: "snapshot-1",
            document_source_id: "source-1",
            source_uri: "https://example.com/doc",
            fetch_status: "succeeded",
            body_text: "Alpha body",
            content_hash: "hash",
            source_version: "v1",
            fetched_at: createdAt,
            error_message: null,
            created_at: createdAt,
          },
        ],
      };
    });
    const repository = createDocumentSnapshotRepository({ queryable: queryableFrom(query) });

    await expect(repository.findSnapshotById("snapshot-1")).resolves.toEqual(
      expect.objectContaining({
        id: "snapshot-1",
        fetchStatus: "succeeded",
        bodyText: "Alpha body",
      }),
    );
  });

  it("lists successful snapshots missing a profile", async () => {
    const createdAt = new Date("2026-07-02T01:00:00.000Z");
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      expect(normalized).toContain("fetch_status = 'succeeded'");
      expect(normalized).toContain("not exists");
      expect(normalized).toContain("embedding_profile_id = $1");
      expect(values).toEqual(["profile-1536", 25]);
      return {
        rows: [
          {
            id: "snapshot-1",
            document_source_id: "source-1",
            source_uri: "https://example.com/doc",
            fetch_status: "succeeded",
            body_text: "Alpha body",
            content_hash: "hash",
            source_version: "v1",
            fetched_at: createdAt,
            error_message: null,
            created_at: createdAt,
          },
        ],
      };
    });
    const repository = createDocumentSnapshotRepository({ queryable: queryableFrom(query) });

    await expect(
      repository.listSuccessfulSnapshotsMissingProfile({
        embeddingProfileId: "profile-1536",
        limit: 25,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "snapshot-1",
        fetchStatus: "succeeded",
      }),
    ]);
  });
```

If `queryableFrom` is not currently present in that file, add:

```ts
function queryableFrom(query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>): Queryable {
  return { query: query as Queryable["query"] };
}
```

- [ ] **Step 2: Write failing fragment repository coverage test**

Append to `apps/core/tests/document-fragment-repository.test.ts`:

```ts
  it("checks whether fragments exist for a snapshot profile", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      const normalized = normalizeSql(sql);
      expect(normalized).toContain("from document_fragments");
      expect(normalized).toContain("document_snapshot_id = $1");
      expect(normalized).toContain("embedding_profile_id = $2");
      expect(values).toEqual(["snapshot-1", "profile-1536"]);
      return { rows: [{ exists: true }] };
    });
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(query),
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({ id: "profile-1536", dimensions: 1536 })),
      },
    });

    await expect(
      repository.hasFragmentsForSnapshotProfile({
        documentSnapshotId: "snapshot-1",
        embeddingProfileId: "profile-1536",
      }),
    ).resolves.toBe(true);
  });
```

- [ ] **Step 3: Run repository tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- document-snapshot-repository.test.ts document-fragment-repository.test.ts
```

Expected: FAIL because the new repository methods do not exist.

- [ ] **Step 4: Implement snapshot repository methods**

Modify `apps/core/src/documents/document-snapshot-repository.ts`.

Add to `DocumentSnapshotRepository`:

```ts
findSnapshotById(id: string): Promise<DocumentSnapshot | undefined>;
listSuccessfulSnapshotsMissingProfile(input: {
  embeddingProfileId: string;
  limit: number;
}): Promise<DocumentSnapshot[]>;
```

Add methods inside `createDocumentSnapshotRepository`:

```ts
    async findSnapshotById(id) {
      const result = await dependencies.queryable.query<DocumentSnapshotRow>(
        `
select *
from document_snapshots
where id = $1
`,
        [id],
      );

      const row = result.rows[0];
      return row === undefined ? undefined : mapSnapshotRow(row);
    },

    async listSuccessfulSnapshotsMissingProfile(input) {
      const result = await dependencies.queryable.query<DocumentSnapshotRow>(
        `
select *
from document_snapshots s
where s.fetch_status = 'succeeded'
  and not exists (
    select 1
    from document_fragments f
    where f.document_snapshot_id = s.id
      and f.embedding_profile_id = $1
  )
order by s.fetched_at asc, s.id asc
limit $2
`,
        [input.embeddingProfileId, Math.max(0, Math.floor(input.limit))],
      );

      return result.rows.map(mapSnapshotRow);
    },
```

- [ ] **Step 5: Implement fragment coverage method**

Modify `apps/core/src/documents/document-fragment-repository.ts`.

Add to `DocumentFragmentRepository`:

```ts
hasFragmentsForSnapshotProfile(input: {
  documentSnapshotId: string;
  embeddingProfileId: string;
}): Promise<boolean>;
```

Add method in repository object:

```ts
    async hasFragmentsForSnapshotProfile(input) {
      const result = await dependencies.queryable.query<{ exists: boolean }>(
        `
select exists (
  select 1
  from document_fragments
  where document_snapshot_id = $1
    and embedding_profile_id = $2
) as exists
`,
        [input.documentSnapshotId, input.embeddingProfileId],
      );

      return result.rows[0]?.exists === true;
    },
```

- [ ] **Step 6: Run repository tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- document-snapshot-repository.test.ts document-fragment-repository.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit repository methods**

Run:

```powershell
git add apps/core/src/documents/document-snapshot-repository.ts apps/core/src/documents/document-fragment-repository.ts apps/core/tests/document-snapshot-repository.test.ts apps/core/tests/document-fragment-repository.test.ts
git commit -m "feat: add reindex repository coverage queries"
```

Expected: commit succeeds.

## Task 3: Add Reindex Planner and Sync Helper

**Files:**
- Create: `apps/core/src/reindex/document-reindex-planner.ts`
- Create: `apps/core/tests/document-reindex-planner.test.ts`

- [ ] **Step 1: Write failing planner tests**

Create `apps/core/tests/document-reindex-planner.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createDocumentReindexPlanner } from "../src/reindex/document-reindex-planner.js";
import { createDocumentReindexIdempotencyKey } from "../src/reindex/document-reindex-queue.js";
import type { DocumentSnapshot } from "../src/documents/document-snapshot-repository.js";

describe("DocumentReindexPlanner", () => {
  it("enqueues missing successful snapshots for a manual profile reindex", async () => {
    const snapshots = [snapshot("snapshot-1"), snapshot("snapshot-2")];
    const queue = { enqueue: vi.fn(async () => undefined) };
    const planner = createDocumentReindexPlanner({
      snapshots: {
        listSuccessfulSnapshotsMissingProfile: vi.fn(async () => snapshots),
      },
      queue,
      now: () => new Date("2026-07-02T01:00:00.000Z"),
    });

    await expect(
      planner.planDocumentProfileReindex({
        embeddingProfileId: "profile-1536",
        limit: 100,
      }),
    ).resolves.toEqual({ enqueuedCount: 2, skippedCount: 0 });
    expect(queue.enqueue).toHaveBeenCalledWith({
      idempotencyKey: createDocumentReindexIdempotencyKey({
        embeddingProfileId: "profile-1536",
        documentSnapshotId: "snapshot-1",
      }),
      embeddingProfileId: "profile-1536",
      documentSnapshotId: "snapshot-1",
      reason: "manual_profile_reindex",
      enqueuedAt: new Date("2026-07-02T01:00:00.000Z"),
    });
  });

  it("sanitizes invalid limits to zero", async () => {
    const snapshots = { listSuccessfulSnapshotsMissingProfile: vi.fn(async () => []) };
    const planner = createDocumentReindexPlanner({
      snapshots,
      queue: { enqueue: vi.fn() },
      now: () => new Date("2026-07-02T01:00:00.000Z"),
    });

    await planner.planDocumentProfileReindex({
      embeddingProfileId: "profile-1536",
      limit: Number.NaN,
    });

    expect(snapshots.listSuccessfulSnapshotsMissingProfile).toHaveBeenCalledWith({
      embeddingProfileId: "profile-1536",
      limit: 0,
    });
  });

  it("enqueues a document synced job for a specific snapshot", async () => {
    const queue = { enqueue: vi.fn(async () => undefined) };
    const planner = createDocumentReindexPlanner({
      snapshots: { listSuccessfulSnapshotsMissingProfile: vi.fn() },
      queue,
      now: () => new Date("2026-07-02T01:00:00.000Z"),
    });

    await planner.enqueueSyncedSnapshotReindex({
      embeddingProfileId: "profile-1536",
      documentSnapshotId: "snapshot-1",
    });

    expect(queue.enqueue).toHaveBeenCalledWith({
      idempotencyKey: "reindex:profile-1536:snapshot-1",
      embeddingProfileId: "profile-1536",
      documentSnapshotId: "snapshot-1",
      reason: "document_synced",
      enqueuedAt: new Date("2026-07-02T01:00:00.000Z"),
    });
  });
});

function snapshot(id: string): DocumentSnapshot {
  return {
    id,
    documentSourceId: "source-1",
    sourceUri: "https://example.com/doc",
    fetchStatus: "succeeded",
    bodyText: "Alpha body",
    fetchedAt: new Date("2026-07-02T00:00:00.000Z"),
    createdAt: new Date("2026-07-02T00:00:00.000Z"),
  };
}
```

- [ ] **Step 2: Run planner tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- document-reindex-planner.test.ts
```

Expected: FAIL because planner module does not exist.

- [ ] **Step 3: Implement planner**

Create `apps/core/src/reindex/document-reindex-planner.ts`:

```ts
import type { DocumentSnapshot } from "../documents/document-snapshot-repository.js";
import {
  createDocumentReindexIdempotencyKey,
  type DocumentReindexQueue,
} from "./document-reindex-queue.js";

export type PlanDocumentProfileReindexInput = {
  embeddingProfileId: string;
  limit: number;
};

export type EnqueueSyncedSnapshotReindexInput = {
  embeddingProfileId: string;
  documentSnapshotId: string;
};

export type DocumentReindexPlanResult = {
  enqueuedCount: number;
  skippedCount: number;
};

export type DocumentReindexPlannerDependencies = {
  snapshots: {
    listSuccessfulSnapshotsMissingProfile(input: {
      embeddingProfileId: string;
      limit: number;
    }): Promise<DocumentSnapshot[]>;
  };
  queue: Pick<DocumentReindexQueue, "enqueue">;
  now?: () => Date;
};

export function createDocumentReindexPlanner({
  snapshots,
  queue,
  now = () => new Date(),
}: DocumentReindexPlannerDependencies) {
  return {
    async planDocumentProfileReindex(input: PlanDocumentProfileReindexInput): Promise<DocumentReindexPlanResult> {
      const limit = sanitizeLimit(input.limit);
      const missingSnapshots = await snapshots.listSuccessfulSnapshotsMissingProfile({
        embeddingProfileId: input.embeddingProfileId,
        limit,
      });

      for (const snapshot of missingSnapshots) {
        await queue.enqueue({
          idempotencyKey: createDocumentReindexIdempotencyKey({
            embeddingProfileId: input.embeddingProfileId,
            documentSnapshotId: snapshot.id,
          }),
          embeddingProfileId: input.embeddingProfileId,
          documentSnapshotId: snapshot.id,
          reason: "manual_profile_reindex",
          enqueuedAt: now(),
        });
      }

      return { enqueuedCount: missingSnapshots.length, skippedCount: 0 };
    },

    enqueueSyncedSnapshotReindex(input: EnqueueSyncedSnapshotReindexInput): Promise<void> {
      return queue.enqueue({
        idempotencyKey: createDocumentReindexIdempotencyKey(input),
        embeddingProfileId: input.embeddingProfileId,
        documentSnapshotId: input.documentSnapshotId,
        reason: "document_synced",
        enqueuedAt: now(),
      });
    },
  };
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}
```

- [ ] **Step 4: Run planner tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- document-reindex-planner.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit planner**

Run:

```powershell
git add apps/core/src/reindex/document-reindex-planner.ts apps/core/tests/document-reindex-planner.test.ts
git commit -m "feat: add document reindex planner"
```

Expected: commit succeeds.

## Task 4: Add Idempotent Reindex Worker

**Files:**
- Create: `apps/core/src/reindex/document-reindex-worker.ts`
- Create: `apps/core/tests/document-reindex-worker.test.ts`

- [ ] **Step 1: Write failing worker tests**

Create `apps/core/tests/document-reindex-worker.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createDocumentReindexWorker } from "../src/reindex/document-reindex-worker.js";
import type { DocumentReindexJob } from "../src/reindex/document-reindex-queue.js";
import type { DocumentSnapshot } from "../src/documents/document-snapshot-repository.js";

describe("DocumentReindexWorker", () => {
  it("indexes missing successful snapshot profile jobs", async () => {
    const indexer = {
      indexSnapshot: vi.fn(async () => ({ status: "indexed" as const, snapshotId: "snapshot-1", fragmentCount: 3 })),
    };
    const worker = createDocumentReindexWorker({
      queue: { dequeueBatch: vi.fn(async () => [job()]) },
      snapshots: { findSnapshotById: vi.fn(async () => snapshot({ id: "snapshot-1" })) },
      fragments: { hasFragmentsForSnapshotProfile: vi.fn(async () => false) },
      indexer,
    });

    await expect(worker.processBatch({ limit: 10 })).resolves.toEqual([
      {
        status: "indexed",
        documentSnapshotId: "snapshot-1",
        embeddingProfileId: "profile-1536",
        fragmentCount: 3,
      },
    ]);
    expect(indexer.indexSnapshot).toHaveBeenCalledWith(snapshot({ id: "snapshot-1" }));
  });

  it("skips missing snapshots", async () => {
    const worker = createDocumentReindexWorker({
      queue: { dequeueBatch: vi.fn(async () => [job()]) },
      snapshots: { findSnapshotById: vi.fn(async () => undefined) },
      fragments: { hasFragmentsForSnapshotProfile: vi.fn() },
      indexer: { indexSnapshot: vi.fn() },
    });

    await expect(worker.processBatch({ limit: 10 })).resolves.toEqual([
      {
        status: "skipped",
        documentSnapshotId: "snapshot-1",
        embeddingProfileId: "profile-1536",
        reason: "snapshot_not_found",
      },
    ]);
  });

  it("skips failed snapshots", async () => {
    const worker = createDocumentReindexWorker({
      queue: { dequeueBatch: vi.fn(async () => [job()]) },
      snapshots: { findSnapshotById: vi.fn(async () => snapshot({ fetchStatus: "failed", bodyText: undefined })) },
      fragments: { hasFragmentsForSnapshotProfile: vi.fn() },
      indexer: { indexSnapshot: vi.fn() },
    });

    await expect(worker.processBatch({ limit: 10 })).resolves.toEqual([
      {
        status: "skipped",
        documentSnapshotId: "snapshot-1",
        embeddingProfileId: "profile-1536",
        reason: "snapshot_not_successful",
      },
    ]);
  });

  it("skips already indexed snapshot profile jobs", async () => {
    const worker = createDocumentReindexWorker({
      queue: { dequeueBatch: vi.fn(async () => [job()]) },
      snapshots: { findSnapshotById: vi.fn(async () => snapshot()) },
      fragments: { hasFragmentsForSnapshotProfile: vi.fn(async () => true) },
      indexer: { indexSnapshot: vi.fn() },
    });

    await expect(worker.processBatch({ limit: 10 })).resolves.toEqual([
      {
        status: "skipped",
        documentSnapshotId: "snapshot-1",
        embeddingProfileId: "profile-1536",
        reason: "already_indexed",
      },
    ]);
  });
});

function job(overrides: Partial<DocumentReindexJob> = {}): DocumentReindexJob {
  return {
    idempotencyKey: "reindex:profile-1536:snapshot-1",
    embeddingProfileId: "profile-1536",
    documentSnapshotId: "snapshot-1",
    reason: "manual_profile_reindex",
    enqueuedAt: new Date("2026-07-02T01:00:00.000Z"),
    ...overrides,
  };
}

function snapshot(overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  return {
    id: "snapshot-1",
    documentSourceId: "source-1",
    sourceUri: "https://example.com/doc",
    fetchStatus: "succeeded",
    bodyText: "Alpha body",
    fetchedAt: new Date("2026-07-02T00:00:00.000Z"),
    createdAt: new Date("2026-07-02T00:00:00.000Z"),
    ...overrides,
  };
}
```

- [ ] **Step 2: Run worker tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- document-reindex-worker.test.ts
```

Expected: FAIL because worker module does not exist.

- [ ] **Step 3: Implement worker**

Create `apps/core/src/reindex/document-reindex-worker.ts`:

```ts
import type { DocumentSnapshot } from "../documents/document-snapshot-repository.js";
import type { DocumentSemanticIndexResult } from "../documents/document-semantic-indexer.js";
import type { DocumentReindexJob, DocumentReindexQueue } from "./document-reindex-queue.js";

export type DocumentReindexJobResult =
  | { status: "indexed"; documentSnapshotId: string; embeddingProfileId: string; fragmentCount: number }
  | {
      status: "skipped";
      documentSnapshotId: string;
      embeddingProfileId: string;
      reason: "already_indexed" | "snapshot_not_successful" | "snapshot_not_found";
    };

export type DocumentReindexWorkerDependencies = {
  queue: Pick<DocumentReindexQueue, "dequeueBatch">;
  snapshots: {
    findSnapshotById(id: string): Promise<DocumentSnapshot | undefined>;
  };
  fragments: {
    hasFragmentsForSnapshotProfile(input: {
      documentSnapshotId: string;
      embeddingProfileId: string;
    }): Promise<boolean>;
  };
  indexer: {
    indexSnapshot(snapshot: DocumentSnapshot): Promise<DocumentSemanticIndexResult>;
  };
};

export function createDocumentReindexWorker(dependencies: DocumentReindexWorkerDependencies) {
  return {
    async processBatch({ limit }: { limit: number }): Promise<DocumentReindexJobResult[]> {
      const jobs = await dependencies.queue.dequeueBatch(Math.max(0, Math.floor(limit)));
      const results: DocumentReindexJobResult[] = [];

      for (const job of jobs) {
        results.push(await processJob(dependencies, job));
      }

      return results;
    },
  };
}

async function processJob(
  dependencies: DocumentReindexWorkerDependencies,
  job: DocumentReindexJob,
): Promise<DocumentReindexJobResult> {
  const snapshot = await dependencies.snapshots.findSnapshotById(job.documentSnapshotId);
  if (snapshot === undefined) {
    return skipped(job, "snapshot_not_found");
  }
  if (snapshot.fetchStatus !== "succeeded") {
    return skipped(job, "snapshot_not_successful");
  }

  const alreadyIndexed = await dependencies.fragments.hasFragmentsForSnapshotProfile({
    documentSnapshotId: job.documentSnapshotId,
    embeddingProfileId: job.embeddingProfileId,
  });
  if (alreadyIndexed) {
    return skipped(job, "already_indexed");
  }

  const indexResult = await dependencies.indexer.indexSnapshot(snapshot);
  if (indexResult.status === "skipped") {
    return skipped(job, indexResult.reason === "snapshot_not_successful" ? "snapshot_not_successful" : "snapshot_not_successful");
  }

  return {
    status: "indexed",
    documentSnapshotId: job.documentSnapshotId,
    embeddingProfileId: job.embeddingProfileId,
    fragmentCount: indexResult.fragmentCount,
  };
}

function skipped(
  job: DocumentReindexJob,
  reason: "already_indexed" | "snapshot_not_successful" | "snapshot_not_found",
): DocumentReindexJobResult {
  return {
    status: "skipped",
    documentSnapshotId: job.documentSnapshotId,
    embeddingProfileId: job.embeddingProfileId,
    reason,
  };
}
```

- [ ] **Step 4: Run worker tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- document-reindex-worker.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit worker**

Run:

```powershell
git add apps/core/src/reindex/document-reindex-worker.ts apps/core/tests/document-reindex-worker.test.ts
git commit -m "feat: add idempotent document reindex worker"
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
$phase2N = "- Add Phase 2N async reindex queue semantics: in-memory reindex queue, snapshot/profile coverage queries, manual reindex planner, synced-snapshot enqueue helper, and idempotent reindex worker."
if ($body -notlike "*Phase 2N async reindex queue semantics*") {
  $body = $body -replace "(## Test Plan)", "$phase2N`n`n`$1"
}
$body | gh pr edit 3 --repo xfbbert-dotcom/iris --body-file -
gh pr view 3 --repo xfbbert-dotcom/iris --json number,state,isDraft,mergeable,headRefOid,url
```

Expected: push succeeds and PR remains open and mergeable.

## Self-Review Checklist

- Queue deduplicates by idempotency key.
- Planner only enqueues and never embeds.
- Worker checks snapshot/profile coverage before indexing.
- Worker skips missing, failed, and already-indexed snapshots.
- Reindex jobs never run from Feishu callback acknowledgement.
- Redis production driver remains out of scope for Phase 2N.
- Tests use fake repositories and do not call real embedding APIs.
