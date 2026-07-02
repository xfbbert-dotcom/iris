# Iris Document Sync Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2D of Iris: a testable document sync pipeline skeleton that selects pending document sources, fetches body text through a replaceable fetcher interface, persists document snapshots, and updates source sync state.

**Architecture:** Add a second SQL migration for document snapshots, implement a Postgres snapshot repository, keep fetch behavior behind a `DocumentBodyFetcher` interface, and build planner/runner modules that operate on the existing async Postgres Document Source Registry without calling real Feishu APIs.

**Tech Stack:** TypeScript, Vitest, Node.js, `pg`, PostgreSQL migrations, existing Document Source Registry.

---

## Scope

This plan implements the approved Phase 2D design in `docs/superpowers/specs/2026-07-02-iris-document-sync-pipeline-design.md`.

It includes:

- `document_snapshots` migration;
- snapshot repository;
- `DocumentBodyFetcher` interface and sync result types;
- sync planner;
- sync runner;
- fake-fetcher tests and optional Postgres integration tests.

It intentionally does not implement:

- real Feishu document body fetching;
- Feishu wiki traversal;
- OAuth/token refresh;
- docx/wiki/PDF parsing;
- chunking, embeddings, or pgvector;
- real-time permission guard calls;
- admin UI.

## File Structure

Create:

```text
apps/core/migrations/
  0002_document_snapshots.sql

apps/core/src/documents/
  document-snapshot-repository.ts
  document-sync-pipeline.ts

apps/core/tests/
  document-snapshot-repository.test.ts
  document-sync-pipeline.test.ts
```

Modify only if needed:

```text
apps/core/src/documents/postgres-document-source-registry.ts
```

Responsibilities:

- `document-snapshot-repository.ts`: owns snapshot types and Postgres persistence helpers.
- `document-sync-pipeline.ts`: owns fetcher interface, planner, runner, and sync result types.
- `document-snapshot-repository.test.ts`: tests snapshot persistence with fake queryables and optional Postgres integration.
- `document-sync-pipeline.test.ts`: tests planner and runner state-machine behavior with fake registries/fetchers.

## Task 1: Add Document Snapshot Migration

**Files:**
- Create: `apps/core/migrations/0002_document_snapshots.sql`

- [ ] **Step 1: Create migration SQL**

Create `apps/core/migrations/0002_document_snapshots.sql`:

```sql
create table document_snapshots (
  id text primary key,
  document_source_id text not null references document_sources(id) on delete cascade,
  source_uri text not null,
  fetch_status text not null check (fetch_status in ('succeeded', 'failed')),
  body_text text,
  content_hash text,
  source_version text,
  fetched_at timestamptz not null,
  error_message text,
  created_at timestamptz not null
);

create index document_snapshots_document_source_id_idx
  on document_snapshots (document_source_id);

create index document_snapshots_fetched_at_idx
  on document_snapshots (fetched_at desc, id asc);
```

- [ ] **Step 2: Run migration runner unit tests**

Run:

```powershell
npm --workspace apps/core test -- migration-runner.test.ts
```

Expected: PASS. The unit runner should discover `.sql` files by directory when provided a temp dir; adding a new real migration should not break it.

- [ ] **Step 3: Commit migration**

Run:

```powershell
git add apps/core/migrations/0002_document_snapshots.sql
git commit -m "feat: add document snapshot migration"
```

Expected: commit succeeds.

## Task 2: Add Snapshot Repository

**Files:**
- Create: `apps/core/src/documents/document-snapshot-repository.ts`
- Create: `apps/core/tests/document-snapshot-repository.test.ts`

- [ ] **Step 1: Write failing unit tests with a fake queryable**

Create `apps/core/tests/document-snapshot-repository.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  createDocumentSnapshotRepository,
  type DocumentSnapshot,
} from "../src/documents/document-snapshot-repository.js";

describe("DocumentSnapshotRepository", () => {
  it("inserts succeeded snapshots and maps database rows", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(sql).toContain("insert into document_snapshots");
      expect(values).toEqual([
        "snapshot-1",
        "source-1",
        "https://example.feishu.cn/docx/A",
        "succeeded",
        "Hello",
        "hash-1",
        "v1",
        new Date("2026-07-02T01:00:00.000Z"),
        null,
        new Date("2026-07-02T01:00:01.000Z"),
      ]);

      return {
        rows: [
          {
            id: "snapshot-1",
            document_source_id: "source-1",
            source_uri: "https://example.feishu.cn/docx/A",
            fetch_status: "succeeded",
            body_text: "Hello",
            content_hash: "hash-1",
            source_version: "v1",
            fetched_at: new Date("2026-07-02T01:00:00.000Z"),
            error_message: null,
            created_at: new Date("2026-07-02T01:00:01.000Z"),
          },
        ],
      };
    });
    const repository = createDocumentSnapshotRepository({
      queryable: { query },
      createId: () => "snapshot-1",
      now: () => new Date("2026-07-02T01:00:01.000Z"),
    });

    const snapshot = await repository.insertSucceededSnapshot({
      documentSourceId: "source-1",
      sourceUri: "https://example.feishu.cn/docx/A",
      bodyText: "Hello",
      contentHash: "hash-1",
      sourceVersion: "v1",
      fetchedAt: new Date("2026-07-02T01:00:00.000Z"),
    });

    expect(snapshot).toEqual<DocumentSnapshot>({
      id: "snapshot-1",
      documentSourceId: "source-1",
      sourceUri: "https://example.feishu.cn/docx/A",
      fetchStatus: "succeeded",
      bodyText: "Hello",
      contentHash: "hash-1",
      sourceVersion: "v1",
      fetchedAt: new Date("2026-07-02T01:00:00.000Z"),
      errorMessage: undefined,
      createdAt: new Date("2026-07-02T01:00:01.000Z"),
    });
  });

  it("inserts failed snapshots with an error message", async () => {
    const query = vi.fn(async (_sql: string, values?: unknown[]) => {
      expect(values?.[3]).toBe("failed");
      expect(values?.[4]).toBeNull();
      expect(values?.[8]).toBe("Feishu returned 403");
      return {
        rows: [
          {
            id: "snapshot-failed",
            document_source_id: "source-1",
            source_uri: "https://example.feishu.cn/docx/A",
            fetch_status: "failed",
            body_text: null,
            content_hash: null,
            source_version: null,
            fetched_at: new Date("2026-07-02T01:00:00.000Z"),
            error_message: "Feishu returned 403",
            created_at: new Date("2026-07-02T01:00:01.000Z"),
          },
        ],
      };
    });
    const repository = createDocumentSnapshotRepository({
      queryable: { query },
      createId: () => "snapshot-failed",
      now: () => new Date("2026-07-02T01:00:01.000Z"),
    });

    const snapshot = await repository.insertFailedSnapshot({
      documentSourceId: "source-1",
      sourceUri: "https://example.feishu.cn/docx/A",
      errorMessage: "Feishu returned 403",
      fetchedAt: new Date("2026-07-02T01:00:00.000Z"),
    });

    expect(snapshot.fetchStatus).toBe("failed");
    expect(snapshot.errorMessage).toBe("Feishu returned 403");
  });

  it("lists snapshots for a source and fetches the latest snapshot", async () => {
    const rows = [
      {
        id: "snapshot-2",
        document_source_id: "source-1",
        source_uri: "uri",
        fetch_status: "succeeded",
        body_text: "new",
        content_hash: null,
        source_version: null,
        fetched_at: new Date("2026-07-02T02:00:00.000Z"),
        error_message: null,
        created_at: new Date("2026-07-02T02:00:01.000Z"),
      },
    ];
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("order by fetched_at desc, id asc");
      return { rows };
    });
    const repository = createDocumentSnapshotRepository({ queryable: { query } });

    await expect(repository.listSnapshotsForSource("source-1")).resolves.toHaveLength(1);
    await expect(repository.findLatestSnapshotForSource("source-1")).resolves.toMatchObject({
      id: "snapshot-2",
      bodyText: "new",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- document-snapshot-repository.test.ts
```

Expected: FAIL because `document-snapshot-repository.ts` does not exist.

- [ ] **Step 3: Implement snapshot repository**

Create `apps/core/src/documents/document-snapshot-repository.ts`:

```ts
import { createHash, randomUUID } from "node:crypto";

export type DocumentFetchStatus = "succeeded" | "failed";

export interface DocumentSnapshot {
  id: string;
  documentSourceId: string;
  sourceUri: string;
  fetchStatus: DocumentFetchStatus;
  bodyText?: string;
  contentHash?: string;
  sourceVersion?: string;
  fetchedAt: Date;
  errorMessage?: string;
  createdAt: Date;
}

export type Queryable = {
  query: <T = unknown>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

export type DocumentSnapshotRepositoryDependencies = {
  queryable: Queryable;
  createId?: () => string;
  now?: () => Date;
};

export type InsertSucceededSnapshotInput = {
  documentSourceId: string;
  sourceUri: string;
  bodyText: string;
  contentHash?: string;
  sourceVersion?: string;
  fetchedAt: Date;
};

export type InsertFailedSnapshotInput = {
  documentSourceId: string;
  sourceUri: string;
  errorMessage: string;
  fetchedAt: Date;
};

export interface DocumentSnapshotRepository {
  insertSucceededSnapshot(input: InsertSucceededSnapshotInput): Promise<DocumentSnapshot>;
  insertFailedSnapshot(input: InsertFailedSnapshotInput): Promise<DocumentSnapshot>;
  listSnapshotsForSource(documentSourceId: string): Promise<DocumentSnapshot[]>;
  findLatestSnapshotForSource(documentSourceId: string): Promise<DocumentSnapshot | undefined>;
}

export function createDocumentSnapshotRepository(
  dependencies: DocumentSnapshotRepositoryDependencies,
): DocumentSnapshotRepository {
  const createId = dependencies.createId ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());

  return {
    async insertSucceededSnapshot(input) {
      const contentHash = input.contentHash ?? hashBody(input.bodyText);
      return insertSnapshot(dependencies.queryable, {
        id: createId(),
        documentSourceId: input.documentSourceId,
        sourceUri: input.sourceUri,
        fetchStatus: "succeeded",
        bodyText: input.bodyText,
        contentHash,
        sourceVersion: input.sourceVersion,
        fetchedAt: input.fetchedAt,
        errorMessage: undefined,
        createdAt: now(),
      });
    },

    async insertFailedSnapshot(input) {
      return insertSnapshot(dependencies.queryable, {
        id: createId(),
        documentSourceId: input.documentSourceId,
        sourceUri: input.sourceUri,
        fetchStatus: "failed",
        bodyText: undefined,
        contentHash: undefined,
        sourceVersion: undefined,
        fetchedAt: input.fetchedAt,
        errorMessage: input.errorMessage,
        createdAt: now(),
      });
    },

    async listSnapshotsForSource(documentSourceId) {
      const result = await dependencies.queryable.query<DocumentSnapshotRow>(
        `
select *
from document_snapshots
where document_source_id = $1
order by fetched_at desc, id asc
`,
        [documentSourceId],
      );
      return result.rows.map(mapSnapshotRow);
    },

    async findLatestSnapshotForSource(documentSourceId) {
      const snapshots = await this.listSnapshotsForSource(documentSourceId);
      return snapshots[0];
    },
  };
}
```

Then add row mapping, `insertSnapshot`, and `hashBody` helpers. `hashBody` should use SHA-256 hex.

- [ ] **Step 4: Run focused tests and commit**

Run:

```powershell
npm --workspace apps/core test -- document-snapshot-repository.test.ts
npm run typecheck
git add apps/core/src/documents/document-snapshot-repository.ts apps/core/tests/document-snapshot-repository.test.ts
git commit -m "feat: add document snapshot repository"
```

Expected: PASS and commit succeeds.

## Task 3: Add Sync Planner

**Files:**
- Create: `apps/core/src/documents/document-sync-pipeline.ts`
- Create: `apps/core/tests/document-sync-pipeline.test.ts`

- [ ] **Step 1: Write failing planner tests**

Create `apps/core/tests/document-sync-pipeline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { DocumentSource } from "../src/documents/document-source-registry.js";
import { createDocumentSyncPlanner } from "../src/documents/document-sync-pipeline.js";

function source(overrides: Partial<DocumentSource>): DocumentSource {
  return {
    id: "source-1",
    sourceType: "group_visible_document",
    sourceUri: "https://example.feishu.cn/docx/A",
    permissionState: "unknown",
    syncState: "pending",
    canUseForAnswering: true,
    canUseForKnowledgeDrafts: true,
    createdAt: new Date("2026-07-02T00:00:00.000Z"),
    updatedAt: new Date("2026-07-02T00:00:00.000Z"),
    evidence: [],
    ...overrides,
  };
}

describe("DocumentSyncPlanner", () => {
  it("selects pending eligible sources", async () => {
    const planner = createDocumentSyncPlanner({
      registry: {
        listSources: async () => [
          source({ id: "source-a" }),
          source({ id: "source-b", syncState: "synced" }),
        ],
      },
    });

    await expect(planner.listSyncCandidates()).resolves.toEqual([
      expect.objectContaining({ id: "source-a" }),
    ]);
  });

  it("excludes denied and fully disabled sources", async () => {
    const planner = createDocumentSyncPlanner({
      registry: {
        listSources: async () => [
          source({ id: "denied", permissionState: "denied" }),
          source({
            id: "disabled",
            canUseForAnswering: false,
            canUseForKnowledgeDrafts: false,
          }),
          source({ id: "eligible" }),
        ],
      },
    });

    await expect(planner.listSyncCandidates()).resolves.toEqual([
      expect.objectContaining({ id: "eligible" }),
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- document-sync-pipeline.test.ts
```

Expected: FAIL because `document-sync-pipeline.ts` does not exist.

- [ ] **Step 3: Implement planner types and logic**

Create `apps/core/src/documents/document-sync-pipeline.ts` with:

```ts
import type { DocumentSource } from "./document-source-registry.js";
import type { AsyncDocumentSourceRegistry } from "./postgres-document-source-registry.js";

export type DocumentSyncRegistryReader = Pick<AsyncDocumentSourceRegistry, "listSources">;

export interface DocumentSyncPlanner {
  listSyncCandidates(): Promise<DocumentSource[]>;
}

export function createDocumentSyncPlanner(input: {
  registry: DocumentSyncRegistryReader;
}): DocumentSyncPlanner {
  return {
    async listSyncCandidates() {
      const sources = await input.registry.listSources();
      return sources.filter(isSyncCandidate);
    },
  };
}

export function isSyncCandidate(source: DocumentSource): boolean {
  return (
    source.syncState === "pending" &&
    source.permissionState !== "denied" &&
    (source.canUseForAnswering || source.canUseForKnowledgeDrafts)
  );
}
```

- [ ] **Step 4: Run focused tests and commit**

Run:

```powershell
npm --workspace apps/core test -- document-sync-pipeline.test.ts
npm run typecheck
git add apps/core/src/documents/document-sync-pipeline.ts apps/core/tests/document-sync-pipeline.test.ts
git commit -m "feat: add document sync planner"
```

Expected: PASS and commit succeeds.

## Task 4: Add Sync Runner State Machine

**Files:**
- Modify: `apps/core/src/documents/document-sync-pipeline.ts`
- Modify: `apps/core/tests/document-sync-pipeline.test.ts`

- [ ] **Step 1: Add failing runner tests**

Append tests to `apps/core/tests/document-sync-pipeline.test.ts`:

```ts
import { vi } from "vitest";
import {
  createDocumentSyncRunner,
  type DocumentBodyFetcher,
} from "../src/documents/document-sync-pipeline.js";

describe("DocumentSyncRunner", () => {
  it("marks source syncing, stores a successful snapshot, and marks source synced", async () => {
    const sourceToSync = source({ id: "source-a", syncState: "pending" });
    const registry = {
      findSourceById: vi.fn(async () => sourceToSync),
      markSyncState: vi.fn(async (id: string, syncState: DocumentSource["syncState"]) => ({
        ...sourceToSync,
        id,
        syncState,
      })),
    };
    const snapshots = {
      insertSucceededSnapshot: vi.fn(async () => ({
        id: "snapshot-1",
        documentSourceId: "source-a",
        sourceUri: sourceToSync.sourceUri,
        fetchStatus: "succeeded" as const,
        bodyText: "Fetched body",
        contentHash: "hash",
        fetchedAt: new Date("2026-07-02T01:00:00.000Z"),
        createdAt: new Date("2026-07-02T01:00:00.000Z"),
      })),
    };
    const fetcher: DocumentBodyFetcher = {
      fetch: vi.fn(async () => ({
        bodyText: "Fetched body",
        sourceVersion: "v1",
        fetchedAt: new Date("2026-07-02T01:00:00.000Z"),
      })),
    };
    const runner = createDocumentSyncRunner({ registry, snapshots, fetcher });

    const result = await runner.syncSourceById("source-a");

    expect(registry.markSyncState).toHaveBeenNthCalledWith(1, "source-a", "syncing");
    expect(fetcher.fetch).toHaveBeenCalledWith(sourceToSync);
    expect(snapshots.insertSucceededSnapshot).toHaveBeenCalledWith({
      documentSourceId: "source-a",
      sourceUri: sourceToSync.sourceUri,
      bodyText: "Fetched body",
      sourceVersion: "v1",
      fetchedAt: new Date("2026-07-02T01:00:00.000Z"),
    });
    expect(registry.markSyncState).toHaveBeenNthCalledWith(2, "source-a", "synced");
    expect(result.status).toBe("synced");
  });

  it("stores a failed snapshot and marks source failed when fetcher throws", async () => {
    const sourceToSync = source({ id: "source-a", syncState: "pending" });
    const registry = {
      findSourceById: vi.fn(async () => sourceToSync),
      markSyncState: vi.fn(async (id: string, syncState: DocumentSource["syncState"]) => ({
        ...sourceToSync,
        id,
        syncState,
      })),
    };
    const snapshots = {
      insertFailedSnapshot: vi.fn(async () => ({
        id: "snapshot-failed",
        documentSourceId: "source-a",
        sourceUri: sourceToSync.sourceUri,
        fetchStatus: "failed" as const,
        fetchedAt: new Date("2026-07-02T01:00:00.000Z"),
        errorMessage: "network down",
        createdAt: new Date("2026-07-02T01:00:00.000Z"),
      })),
    };
    const fetcher: DocumentBodyFetcher = {
      fetch: vi.fn(async () => {
        throw new Error("network down");
      }),
    };
    const runner = createDocumentSyncRunner({
      registry,
      snapshots,
      fetcher,
      now: () => new Date("2026-07-02T01:00:00.000Z"),
    });

    const result = await runner.syncSourceById("source-a");

    expect(snapshots.insertFailedSnapshot).toHaveBeenCalledWith({
      documentSourceId: "source-a",
      sourceUri: sourceToSync.sourceUri,
      errorMessage: "network down",
      fetchedAt: new Date("2026-07-02T01:00:00.000Z"),
    });
    expect(registry.markSyncState).toHaveBeenLastCalledWith("source-a", "failed");
    expect(result).toMatchObject({ status: "failed", errorMessage: "network down" });
  });

  it("does not call the fetcher for denied sources", async () => {
    const denied = source({ id: "source-denied", permissionState: "denied" });
    const registry = {
      findSourceById: vi.fn(async () => denied),
      markSyncState: vi.fn(),
    };
    const fetcher = { fetch: vi.fn() };
    const runner = createDocumentSyncRunner({
      registry,
      snapshots: {},
      fetcher,
    });

    const result = await runner.syncSourceById("source-denied");

    expect(fetcher.fetch).not.toHaveBeenCalled();
    expect(registry.markSyncState).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "rejected",
      source: denied,
      reason: "permission_denied",
    });
  });

  it("skips already syncing or synced sources", async () => {
    const syncing = source({ id: "source-syncing", syncState: "syncing" });
    const registry = {
      findSourceById: vi.fn(async () => syncing),
      markSyncState: vi.fn(),
    };
    const fetcher = { fetch: vi.fn() };
    const runner = createDocumentSyncRunner({
      registry,
      snapshots: {},
      fetcher,
    });

    const result = await runner.syncSourceById("source-syncing");

    expect(fetcher.fetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "skipped",
      source: syncing,
      reason: "already_syncing",
    });
  });
});
```

If import blocks conflict, merge imports cleanly.

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- document-sync-pipeline.test.ts
```

Expected: FAIL because runner exports do not exist.

- [ ] **Step 3: Implement sync runner**

Modify `apps/core/src/documents/document-sync-pipeline.ts` to add:

```ts
export type DocumentBodyFetchResult = {
  bodyText: string;
  sourceVersion?: string;
  fetchedAt: Date;
};

export interface DocumentBodyFetcher {
  fetch(source: DocumentSource): Promise<DocumentBodyFetchResult>;
}

export type DocumentSyncResult =
  | { status: "synced"; source: DocumentSource; snapshot: DocumentSnapshot }
  | { status: "failed"; source: DocumentSource; snapshot: DocumentSnapshot; errorMessage: string }
  | { status: "skipped"; source: DocumentSource; reason: "already_syncing" | "already_synced" }
  | { status: "rejected"; source: DocumentSource; reason: "permission_denied" | "capability_disabled" }
  | { status: "not_found"; sourceId: string };
```

Then implement `createDocumentSyncRunner` with dependencies:

```ts
type SyncRunnerRegistry = Pick<
  AsyncDocumentSourceRegistry,
  "findSourceById" | "markSyncState"
>;
```

Runner behavior:

- `findSourceById` missing -> `{ status: "not_found", sourceId }`;
- denied -> rejected;
- both capabilities disabled -> rejected;
- `syncState = syncing` -> skipped already_syncing;
- `syncState = synced` -> skipped already_synced;
- otherwise mark syncing, fetch, insert succeeded snapshot, mark synced;
- on fetch error, insert failed snapshot, mark failed, return failed.

- [ ] **Step 4: Run focused tests and commit**

Run:

```powershell
npm --workspace apps/core test -- document-sync-pipeline.test.ts
npm run typecheck
git add apps/core/src/documents/document-sync-pipeline.ts apps/core/tests/document-sync-pipeline.test.ts
git commit -m "feat: add document sync runner"
```

Expected: PASS and commit succeeds.

## Task 5: Optional Postgres Snapshot Integration Test

**Files:**
- Modify: `apps/core/tests/document-snapshot-repository.test.ts`

- [ ] **Step 1: Add gated Postgres integration test**

Append to `apps/core/tests/document-snapshot-repository.test.ts`:

```ts
import pg from "pg";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe } from "vitest";
import { readDatabaseConfig } from "../src/database/database-config.js";
import { runMigrations, defaultMigrationsDir } from "../src/database/migrate.js";

const databaseUrl = process.env.DATABASE_URL;
const runIfDatabase = databaseUrl ? describe : describe.skip;

runIfDatabase("DocumentSnapshotRepository Postgres integration", () => {
  let pool: pg.Pool;
  const sourceId = `source-${randomUUID()}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: readDatabaseConfig().databaseUrl });
    const client = await pool.connect();
    try {
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
      await pool.query(
        `
insert into document_sources (
  id, source_type, source_uri, permission_state, sync_state,
  can_use_for_answering, can_use_for_knowledge_drafts, created_at, updated_at
)
values ($1, 'group_visible_document', $2, 'unknown', 'pending', true, true, now(), now())
`,
        [sourceId, `https://example.feishu.cn/docx/${sourceId}`],
      );
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.query("delete from document_sources where id = $1", [sourceId]);
    await pool.end();
  });

  it("persists and reads snapshots", async () => {
    const repository = createDocumentSnapshotRepository({ queryable: pool });
    const snapshot = await repository.insertSucceededSnapshot({
      documentSourceId: sourceId,
      sourceUri: `https://example.feishu.cn/docx/${sourceId}`,
      bodyText: "Integration body",
      fetchedAt: new Date("2026-07-02T01:00:00.000Z"),
    });

    await expect(repository.findLatestSnapshotForSource(sourceId)).resolves.toMatchObject({
      id: snapshot.id,
      bodyText: "Integration body",
    });
  });
});
```

Merge imports as needed. The test should skip cleanly without `DATABASE_URL`.

- [ ] **Step 2: Run focused tests**

Run:

```powershell
npm --workspace apps/core test -- document-snapshot-repository.test.ts
```

Expected without `DATABASE_URL`: unit tests PASS, integration suite skipped.

- [ ] **Step 3: Commit integration test**

Run:

```powershell
npm run typecheck
git add apps/core/tests/document-snapshot-repository.test.ts
git commit -m "test: cover document snapshots with postgres"
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

- [ ] **Step 4: Validate Docker Compose if available**

Run:

```powershell
docker compose config
```

Expected when Docker CLI is installed: resolved compose config prints successfully.

Expected in the current local environment if Docker is still absent: command fails with `docker` not recognized. Report this as an environment limitation, not a product failure.

- [ ] **Step 5: Check git status**

Run:

```powershell
git status --short --branch
```

Expected: clean implementation branch after commits.

## Self-Review Checklist

- The plan implements the approved Phase 2D A option: sync pipeline skeleton, not real Feishu fetching.
- Snapshots preserve source id, source URI, status, body, source version, timestamps, and failure reason.
- Planner is read-only and deterministic.
- Runner owns sync state transitions and records success/failure before final state.
- Tests remain useful without Docker or `DATABASE_URL`.
- No pgvector, real Feishu API, document parsing, permission guard API, or admin UI is included.
