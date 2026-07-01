# Iris Database Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2C of Iris: a Postgres database foundation with migrations and a durable Document Source Registry implementation.

**Architecture:** Keep the existing in-memory registry as the fast domain implementation, introduce a `pg`-based database layer, add SQL migrations, and implement a Postgres-backed registry that preserves the same document-source semantics with durable rows and database-level evidence idempotency.

**Tech Stack:** TypeScript, Vitest, Node.js, `pg`, PostgreSQL 16 with pgvector image from Docker Compose, SQL migrations.

---

## Scope

This plan implements the approved design in `docs/superpowers/specs/2026-07-01-iris-database-foundation-design.md`.

It includes:

- database env/config boundary;
- Postgres connection pool module;
- SQL migration runner;
- first migration for `document_sources` and `document_source_evidence`;
- `PostgresDocumentSourceRegistry`;
- optional integration tests gated by `DATABASE_URL`;
- npm scripts for migration and DB tests.

It intentionally does not implement:

- Feishu document body fetching;
- Feishu wiki traversal;
- document parsing/chunking/embeddings;
- pgvector vector tables;
- real-time Feishu permission API calls;
- admin UI screens.

## File Structure

Create:

```text
apps/core/migrations/
  0001_document_sources.sql

apps/core/src/database/
  database-config.ts
  postgres.ts
  migrate.ts

apps/core/src/documents/
  postgres-document-source-registry.ts

apps/core/tests/
  database-config.test.ts
  migration-runner.test.ts
  postgres-document-source-registry.test.ts
```

Modify:

```text
apps/core/package.json
apps/core/src/documents/document-source-registry.ts
```

Responsibilities:

- `database-config.ts`: reads `DATABASE_URL` and throws typed missing-config errors for DB-only code paths.
- `postgres.ts`: creates/closes `pg` pools and runs a health query.
- `migrate.ts`: runs SQL migration files in lexical order and records applied migrations.
- `0001_document_sources.sql`: creates the first fact-layer tables and constraints.
- `postgres-document-source-registry.ts`: implements the existing `DocumentSourceRegistry` interface with Postgres persistence.
- Registry tests: preserve existing in-memory tests and add optional Postgres integration coverage.

## Task 1: Add Database Dependency And Config Boundary

**Files:**
- Modify: `apps/core/package.json`
- Create: `apps/core/src/database/database-config.ts`
- Create: `apps/core/tests/database-config.test.ts`

- [ ] **Step 1: Write failing config tests**

Create `apps/core/tests/database-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  MissingDatabaseConfigError,
  readDatabaseConfig,
} from "../src/database/database-config.js";

describe("readDatabaseConfig", () => {
  it("reads a trimmed DATABASE_URL", () => {
    expect(
      readDatabaseConfig({
        DATABASE_URL: " postgres://iris:iris@localhost:5432/iris ",
      }),
    ).toEqual({
      databaseUrl: "postgres://iris:iris@localhost:5432/iris",
    });
  });

  it("throws a typed error when DATABASE_URL is missing", () => {
    expect(() => readDatabaseConfig({})).toThrow(MissingDatabaseConfigError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- database-config.test.ts
```

Expected: FAIL because `database-config.ts` does not exist.

- [ ] **Step 3: Add `pg` dependency and implement config module**

Modify `apps/core/package.json` dependencies:

```json
"pg": "^8.13.0"
```

Add dev dependency:

```json
"@types/pg": "^8.11.0"
```

Create `apps/core/src/database/database-config.ts`:

```ts
export type DatabaseConfig = {
  databaseUrl: string;
};

export type DatabaseEnv = Record<string, string | undefined>;

export class MissingDatabaseConfigError extends Error {
  constructor() {
    super("DATABASE_URL is required for database operations");
    this.name = "MissingDatabaseConfigError";
  }
}

export function readDatabaseConfig(env: DatabaseEnv = process.env): DatabaseConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new MissingDatabaseConfigError();
  }

  return { databaseUrl };
}
```

- [ ] **Step 4: Install dependencies and run focused test**

Run:

```powershell
npm install
npm --workspace apps/core test -- database-config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run:

```powershell
npm run typecheck
git add package-lock.json apps/core/package.json apps/core/src/database/database-config.ts apps/core/tests/database-config.test.ts
git commit -m "feat: add database config boundary"
```

Expected: typecheck PASS and commit succeeds.

## Task 2: Add Postgres Pool And Health Check

**Files:**
- Create: `apps/core/src/database/postgres.ts`
- Create: `apps/core/tests/postgres.test.ts`

- [ ] **Step 1: Write failing pool tests with a fake queryable**

Create `apps/core/tests/postgres.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { checkDatabaseHealth, createPostgresPool } from "../src/database/postgres.js";

describe("postgres database helpers", () => {
  it("creates a pool from database config", () => {
    const pool = createPostgresPool({
      databaseUrl: "postgres://iris:iris@localhost:5432/iris",
    });

    expect(pool.options.connectionString).toBe("postgres://iris:iris@localhost:5432/iris");
    void pool.end();
  });

  it("checks database health with select 1", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] });

    await expect(checkDatabaseHealth({ query })).resolves.toEqual({ ok: true });
    expect(query).toHaveBeenCalledWith("select 1 as ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- postgres.test.ts
```

Expected: FAIL because `postgres.ts` does not exist.

- [ ] **Step 3: Implement Postgres helpers**

Create `apps/core/src/database/postgres.ts`:

```ts
import pg from "pg";
import type { DatabaseConfig } from "./database-config.js";

export type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<unknown>;
};

export type DatabaseHealth = {
  ok: boolean;
};

export function createPostgresPool(config: DatabaseConfig): pg.Pool {
  return new pg.Pool({
    connectionString: config.databaseUrl,
  });
}

export async function checkDatabaseHealth(queryable: Queryable): Promise<DatabaseHealth> {
  await queryable.query("select 1 as ok");
  return { ok: true };
}
```

- [ ] **Step 4: Run focused tests**

Run:

```powershell
npm --workspace apps/core test -- postgres.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run:

```powershell
npm run typecheck
git add apps/core/src/database/postgres.ts apps/core/tests/postgres.test.ts
git commit -m "feat: add postgres pool helpers"
```

Expected: typecheck PASS and commit succeeds.

## Task 3: Add SQL Migration And Runner

**Files:**
- Create: `apps/core/migrations/0001_document_sources.sql`
- Create: `apps/core/src/database/migrate.ts`
- Create: `apps/core/tests/migration-runner.test.ts`
- Modify: `apps/core/package.json`

- [ ] **Step 1: Write migration SQL**

Create `apps/core/migrations/0001_document_sources.sql`:

```sql
create table document_sources (
  id text primary key,
  source_type text not null check (
    source_type in (
      'group_visible_document',
      'authorized_wiki_document',
      'user_submitted_document'
    )
  ),
  source_uri text not null unique,
  title text,
  origin_group_id text,
  origin_message_id text,
  submitted_by_user_id text,
  authorized_space_id text,
  permission_state text not null check (
    permission_state in ('unknown', 'readable', 'denied', 'stale')
  ),
  sync_state text not null check (
    sync_state in ('pending', 'syncing', 'synced', 'failed')
  ),
  can_use_for_answering boolean not null,
  can_use_for_knowledge_drafts boolean not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index document_sources_updated_at_id_idx
  on document_sources (updated_at desc, id asc);

create index document_sources_source_type_idx
  on document_sources (source_type);

create index document_sources_origin_group_id_idx
  on document_sources (origin_group_id);

create index document_sources_authorized_space_id_idx
  on document_sources (authorized_space_id);

create index document_sources_submitted_by_user_id_idx
  on document_sources (submitted_by_user_id);

create table document_source_evidence (
  id bigserial primary key,
  document_source_id text not null references document_sources(id) on delete cascade,
  kind text not null check (
    kind in ('group_message', 'admin_authorization', 'user_submission')
  ),
  source_uri text not null,
  group_id text,
  message_id text,
  user_id text,
  space_id text,
  observed_at timestamptz not null,
  created_at timestamptz not null
);

create unique index document_source_evidence_dedupe_idx
  on document_source_evidence (
    kind,
    source_uri,
    coalesce(group_id, ''),
    coalesce(message_id, ''),
    coalesce(user_id, ''),
    coalesce(space_id, '')
  );

create index document_source_evidence_document_source_id_idx
  on document_source_evidence (document_source_id);

create index document_source_evidence_group_id_idx
  on document_source_evidence (group_id);

create index document_source_evidence_space_id_idx
  on document_source_evidence (space_id);

create index document_source_evidence_user_id_idx
  on document_source_evidence (user_id);
```

- [ ] **Step 2: Write failing migration runner unit tests**

Create `apps/core/tests/migration-runner.test.ts`:

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/database/migrate.js";

describe("runMigrations", () => {
  it("runs unapplied sql files in lexical order and records them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iris-migrations-"));
    await writeFile(join(dir, "0002_second.sql"), "select 2;");
    await writeFile(join(dir, "0001_first.sql"), "select 1;");

    const applied = new Set<string>();
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        if (sql.includes("select name from schema_migrations")) {
          return { rows: Array.from(applied).map((name) => ({ name })) };
        }
        if (sql.includes("insert into schema_migrations")) {
          applied.add(String(values?.[0]));
        }
        return { rows: [] };
      }),
    };

    const result = await runMigrations({ client, migrationsDir: dir });

    expect(result.applied).toEqual(["0001_first.sql", "0002_second.sql"]);
    expect(queries.map((entry) => entry.sql)).toContain("select 1;");
    expect(queries.map((entry) => entry.sql)).toContain("select 2;");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- migration-runner.test.ts
```

Expected: FAIL because `migrate.ts` does not exist.

- [ ] **Step 4: Implement migration runner**

Create `apps/core/src/database/migrate.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDatabaseConfig } from "./database-config.js";
import { createPostgresPool, type Queryable } from "./postgres.js";

export type MigrationResult = {
  applied: string[];
  skipped: string[];
};

export type MigrationClient = Queryable;

export type RunMigrationsInput = {
  client: MigrationClient;
  migrationsDir: string;
};

export async function runMigrations(input: RunMigrationsInput): Promise<MigrationResult> {
  await input.client.query("begin");
  try {
    await input.client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    const appliedResult = await input.client.query(
      "select name from schema_migrations order by name asc",
    ) as { rows: Array<{ name: string }> };
    const alreadyApplied = new Set(appliedResult.rows.map((row) => row.name));
    const migrationNames = (await readdir(input.migrationsDir))
      .filter((name) => name.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const migrationName of migrationNames) {
      if (alreadyApplied.has(migrationName)) {
        skipped.push(migrationName);
        continue;
      }

      const sql = await readFile(join(input.migrationsDir, migrationName), "utf8");
      await input.client.query(sql);
      await input.client.query(
        "insert into schema_migrations (name) values ($1)",
        [migrationName],
      );
      applied.push(migrationName);
    }

    await input.client.query("commit");
    return { applied, skipped };
  } catch (error) {
    await input.client.query("rollback");
    throw error;
  }
}

export function defaultMigrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../migrations");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const pool = createPostgresPool(readDatabaseConfig());
  try {
    const result = await runMigrations({
      client: pool,
      migrationsDir: defaultMigrationsDir(),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}
```

- [ ] **Step 5: Add npm script**

Modify `apps/core/package.json` scripts:

```json
"db:migrate": "tsx src/database/migrate.ts"
```

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- migration-runner.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit migration foundation**

Run:

```powershell
git add apps/core/migrations/0001_document_sources.sql apps/core/src/database/migrate.ts apps/core/tests/migration-runner.test.ts apps/core/package.json
git commit -m "feat: add database migrations"
```

Expected: commit succeeds.

## Task 4: Extract Shared Registry Helpers

**Files:**
- Modify: `apps/core/src/documents/document-source-registry.ts`
- Modify: `apps/core/tests/document-source-registry.test.ts`

- [ ] **Step 1: Run existing registry tests as baseline**

Run:

```powershell
npm --workspace apps/core test -- document-source-registry.test.ts
```

Expected: PASS.

- [ ] **Step 2: Export small shared helpers needed by Postgres implementation**

Modify `apps/core/src/documents/document-source-registry.ts` to export:

```ts
export function documentSourceTypePriority(sourceType: DocumentSourceType): number {
  return sourceTypePriority[sourceType];
}

export function higherPriorityDocumentSourceType(
  first: DocumentSourceType,
  second: DocumentSourceType,
): DocumentSourceType {
  return higherPrioritySourceType(first, second);
}

export function documentSourceEvidenceKey(evidence: DocumentSourceEvidence): string {
  return evidenceKey(evidence);
}
```

Keep existing internal functions in place and have these exported wrappers delegate to them. Do not change existing behavior.

- [ ] **Step 3: Add helper tests**

Append to `apps/core/tests/document-source-registry.test.ts`:

```ts
import {
  documentSourceEvidenceKey,
  documentSourceTypePriority,
  higherPriorityDocumentSourceType,
} from "../src/documents/document-source-registry.js";

it("exposes source type priority helpers for persistent registries", () => {
  expect(documentSourceTypePriority("authorized_wiki_document")).toBeGreaterThan(
    documentSourceTypePriority("group_visible_document"),
  );
  expect(
    higherPriorityDocumentSourceType("authorized_wiki_document", "group_visible_document"),
  ).toBe("authorized_wiki_document");
});

it("exposes the evidence idempotency key without observedAt", () => {
  const first = documentSourceEvidenceKey({
    kind: "group_message",
    sourceUri: "https://example.feishu.cn/docx/A",
    groupId: "chat-a",
    messageId: "msg-a",
    observedAt: new Date("2026-07-01T00:00:00.000Z"),
  });
  const second = documentSourceEvidenceKey({
    kind: "group_message",
    sourceUri: "https://example.feishu.cn/docx/A",
    groupId: "chat-a",
    messageId: "msg-a",
    observedAt: new Date("2026-07-01T00:01:00.000Z"),
  });

  expect(first).toBe(second);
});
```

If import style conflicts with the existing file, merge these names into the existing import block instead of adding a second conflicting import.

- [ ] **Step 4: Run tests and commit**

Run:

```powershell
npm --workspace apps/core test -- document-source-registry.test.ts
npm run typecheck
git add apps/core/src/documents/document-source-registry.ts apps/core/tests/document-source-registry.test.ts
git commit -m "refactor: expose document source merge helpers"
```

Expected: PASS and commit succeeds.

## Task 5: Implement Postgres Document Source Registry

**Files:**
- Create: `apps/core/src/documents/postgres-document-source-registry.ts`
- Create: `apps/core/tests/postgres-document-source-registry.test.ts`

- [ ] **Step 1: Write optional integration tests gated by `DATABASE_URL`**

Create `apps/core/tests/postgres-document-source-registry.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { readDatabaseConfig } from "../src/database/database-config.js";
import { createPostgresPool } from "../src/database/postgres.js";
import { runMigrations, defaultMigrationsDir } from "../src/database/migrate.js";
import { createPostgresDocumentSourceRegistry } from "../src/documents/postgres-document-source-registry.js";

const databaseUrl = process.env.DATABASE_URL;
const runIfDatabase = databaseUrl ? describe : describe.skip;

runIfDatabase("PostgresDocumentSourceRegistry", () => {
  const pool = createPostgresPool(readDatabaseConfig());
  const namespace = randomUUID();

  beforeAll(async () => {
    await runMigrations({ client: pool, migrationsDir: defaultMigrationsDir() });
  });

  it("persists group-visible sources and deduplicates retried message evidence", async () => {
    const registry = createPostgresDocumentSourceRegistry(pool, {
      createId: () => `source-${namespace}`,
      now: () => new Date("2026-07-01T00:00:00.000Z"),
    });
    const sourceUri = `https://example.feishu.cn/docx/${namespace}`;

    await registry.registerGroupVisibleDocument({
      sourceUri,
      originGroupId: "chat-a",
      originMessageId: "msg-a",
      observedAt: new Date("2026-07-01T00:01:00.000Z"),
      title: "Persistent Source",
    });
    const repeated = await registry.registerGroupVisibleDocument({
      sourceUri,
      originGroupId: "chat-a",
      originMessageId: "msg-a",
      observedAt: new Date("2026-07-01T00:02:00.000Z"),
    });

    expect(repeated.title).toBe("Persistent Source");
    expect(repeated.evidence).toHaveLength(1);
  });

  it("keeps admin-disabled answering disabled across registry instances", async () => {
    const sourceUri = `https://example.feishu.cn/wiki/${namespace}`;
    const first = createPostgresDocumentSourceRegistry(pool, {
      createId: () => `wiki-${namespace}`,
      now: () => new Date("2026-07-01T00:00:00.000Z"),
    });

    const source = await first.registerAuthorizedWikiDocument({
      sourceUri,
      authorizedSpaceId: "space-a",
      observedAt: new Date("2026-07-01T00:01:00.000Z"),
    });
    await first.setAnsweringEnabled(source.id, false);

    const second = createPostgresDocumentSourceRegistry(pool, {
      createId: () => `unused-${namespace}`,
      now: () => new Date("2026-07-01T00:02:00.000Z"),
    });
    const repeated = await second.registerAuthorizedWikiDocument({
      sourceUri,
      authorizedSpaceId: "space-a",
      observedAt: new Date("2026-07-01T00:03:00.000Z"),
    });

    expect(repeated.id).toBe(source.id);
    expect(repeated.canUseForAnswering).toBe(false);
  });
});
```

These tests are skipped when `DATABASE_URL` is absent, so normal `npm test` still works without Docker.

- [ ] **Step 2: Run focused test to verify it fails when DB is available or skips cleanly when unavailable**

Run:

```powershell
npm --workspace apps/core test -- postgres-document-source-registry.test.ts
```

Expected without `DATABASE_URL`: PASS with skipped suite.

Expected with `DATABASE_URL`: FAIL because implementation does not exist.

- [ ] **Step 3: Implement async Postgres registry**

Create `apps/core/src/documents/postgres-document-source-registry.ts`.

Important type decision: because Postgres calls are async, export an async interface:

```ts
import type pg from "pg";
import {
  type DocumentPermissionState,
  type DocumentSource,
  type DocumentSourceEvidence,
  type DocumentSourceRegistryDependencies,
  type DocumentSourceType,
  type DocumentSyncState,
  type RegisterAuthorizedWikiDocumentInput,
  type RegisterGroupVisibleDocumentInput,
  type RegisterUserSubmittedDocumentInput,
  DocumentSourceValidationError,
  higherPriorityDocumentSourceType,
} from "./document-source-registry.js";

export interface AsyncDocumentSourceRegistry {
  registerGroupVisibleDocument(input: RegisterGroupVisibleDocumentInput): Promise<DocumentSource>;
  registerAuthorizedWikiDocument(input: RegisterAuthorizedWikiDocumentInput): Promise<DocumentSource>;
  registerUserSubmittedDocument(input: RegisterUserSubmittedDocumentInput): Promise<DocumentSource>;
  markPermissionState(id: string, permissionState: DocumentPermissionState): Promise<DocumentSource>;
  markSyncState(id: string, syncState: DocumentSyncState): Promise<DocumentSource>;
  setAnsweringEnabled(id: string, enabled: boolean): Promise<DocumentSource>;
  setKnowledgeDraftsEnabled(id: string, enabled: boolean): Promise<DocumentSource>;
  listSources(): Promise<DocumentSource[]>;
  listSourcesByType(sourceType: DocumentSourceType): Promise<DocumentSource[]>;
  findSourceById(id: string): Promise<DocumentSource | undefined>;
  findSourceByUri(sourceUri: string): Promise<DocumentSource | undefined>;
  listSourcesUsableForAnswering(): Promise<DocumentSource[]>;
  listSourcesByGroupId(groupId: string): Promise<DocumentSource[]>;
  listSourcesByAuthorizedSpaceId(spaceId: string): Promise<DocumentSource[]>;
  listSourcesBySubmittingUserId(userId: string): Promise<DocumentSource[]>;
}
```

Implementation requirements:

- use `pool.connect()` and transactions for registration;
- validate blank required inputs like the in-memory registry;
- select existing source by `source_uri`;
- insert new source when absent;
- merge existing source when present using `higherPriorityDocumentSourceType`;
- keep existing title/capability flags unless existing fields are missing;
- insert evidence with `on conflict do nothing`;
- fetch source plus evidence before returning;
- mutation methods update rows and return source plus evidence;
- `setAnsweringEnabled(id, true)` must keep `false` if `permission_state = 'denied'`;
- list methods use `order by updated_at desc, id asc`;
- group/space/user filters use `exists` subqueries against evidence in addition to top-level columns.

Use row mapping helpers:

```ts
type DocumentSourceRow = {
  id: string;
  source_type: DocumentSourceType;
  source_uri: string;
  title: string | null;
  origin_group_id: string | null;
  origin_message_id: string | null;
  submitted_by_user_id: string | null;
  authorized_space_id: string | null;
  permission_state: DocumentPermissionState;
  sync_state: DocumentSyncState;
  can_use_for_answering: boolean;
  can_use_for_knowledge_drafts: boolean;
  created_at: Date;
  updated_at: Date;
};

type EvidenceRow = {
  kind: DocumentSourceEvidence["kind"];
  source_uri: string;
  group_id: string | null;
  message_id: string | null;
  user_id: string | null;
  space_id: string | null;
  observed_at: Date;
};
```

- [ ] **Step 4: Run focused tests**

Run:

```powershell
npm --workspace apps/core test -- postgres-document-source-registry.test.ts
npm run typecheck
```

Expected without `DATABASE_URL`: skipped suite and typecheck PASS.

Expected with `DATABASE_URL`: tests PASS.

- [ ] **Step 5: Commit Postgres registry**

Run:

```powershell
git add apps/core/src/documents/postgres-document-source-registry.ts apps/core/tests/postgres-document-source-registry.test.ts
git commit -m "feat: add postgres document source registry"
```

Expected: commit succeeds.

## Task 6: Add Database Script Documentation And Final Verification

**Files:**
- Modify: `README.md` if it exists; otherwise create a concise root `README.md`.

- [ ] **Step 1: Document local database commands**

Add or update root `README.md` with:

````md
## Local Database

Start local infrastructure:

```powershell
docker compose up -d
```

Run database migrations:

```powershell
$env:DATABASE_URL="postgres://iris:iris@localhost:5432/iris"
npm --workspace apps/core run db:migrate
```

Run optional Postgres integration tests:

```powershell
$env:DATABASE_URL="postgres://iris:iris@localhost:5432/iris"
npm --workspace apps/core test -- postgres-document-source-registry.test.ts
```
````

- [ ] **Step 2: Run TypeScript typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run all TypeScript tests**

Run:

```powershell
npm test
```

Expected: PASS. Postgres integration tests should skip when `DATABASE_URL` is not set.

- [ ] **Step 4: Run Python worker tests**

Run from `workers/ai`:

```powershell
python -m pytest
```

Expected: PASS.

- [ ] **Step 5: Validate Docker Compose if available**

Run:

```powershell
docker compose config
```

Expected when Docker CLI is installed: resolved compose config prints successfully.

Expected in the current local environment if Docker is still absent: command fails with `docker` not recognized. Report this as an environment limitation, not a product failure.

- [ ] **Step 6: Commit docs and final status**

Run:

```powershell
git add README.md
git commit -m "docs: add database development commands"
git status --short --branch
```

Expected: clean implementation branch after commit.

## Self-Review Checklist

- The plan implements the approved B option: database infrastructure first, not a minimal registry patch.
- It keeps Postgres as fact layer and does not introduce ORM lock-in.
- Evidence idempotency is enforced both in application semantics and database unique index.
- Admin-disabled source state is durable once Postgres registry is used.
- Tests can still pass without Docker or a local Postgres server.
- No document body fetching, pgvector indexing, or Feishu permission API calls are included in this phase.
