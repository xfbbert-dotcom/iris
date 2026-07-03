import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";
import { createPostgresDocumentSourceRegistry } from "../src/documents/postgres-document-source-registry.js";

const databaseUrl = process.env.DATABASE_URL;
const runIfDatabase = databaseUrl ? describe : describe.skip;

type TestSourceRow = {
  id: string;
  source_type: string;
  source_uri: string;
  title: string | null;
  origin_group_id: string | null;
  origin_message_id: string | null;
  submitted_by_user_id: string | null;
  authorized_space_id: string | null;
  permission_state: string;
  sync_state: string;
  can_use_for_answering: boolean;
  can_use_for_knowledge_drafts: boolean;
  created_at: Date;
  updated_at: Date;
};

type TestEvidenceRow = {
  document_source_id: string;
  kind: string;
  source_uri: string;
  group_id: string | null;
  message_id: string | null;
  user_id: string | null;
  space_id: string | null;
  observed_at: Date;
};

type RecordedQuery = {
  sql: string;
  values?: unknown[];
};

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function makeSourceRow(overrides: Partial<TestSourceRow> = {}): TestSourceRow {
  const now = new Date("2026-07-01T04:00:00.000Z");

  return {
    id: "source-1",
    source_type: "group_visible_document",
    source_uri: "https://example.com/doc",
    title: "Group Doc",
    origin_group_id: "group-1",
    origin_message_id: "message-1",
    submitted_by_user_id: null,
    authorized_space_id: null,
    permission_state: "unknown",
    sync_state: "pending",
    can_use_for_answering: true,
    can_use_for_knowledge_drafts: true,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeEvidenceRow(
  overrides: Partial<TestEvidenceRow> = {},
): TestEvidenceRow {
  return {
    document_source_id: "source-1",
    kind: "group_message",
    source_uri: "https://example.com/doc",
    group_id: "group-1",
    message_id: "message-1",
    user_id: null,
    space_id: null,
    observed_at: new Date("2026-07-01T04:01:00.000Z"),
    ...overrides,
  };
}

function createFakePool(options: {
  sourceRow?: TestSourceRow;
  evidenceRows?: TestEvidenceRow[];
  failOnSql?: (normalizedSql: string) => Error | undefined;
} = {}) {
  const sourceRow = options.sourceRow ?? makeSourceRow();
  const evidenceRows = options.evidenceRows ?? [makeEvidenceRow()];
  const queries: RecordedQuery[] = [];
  const release = vi.fn();
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    const normalized = normalizeSql(sql);
    const error = options.failOnSql?.(normalized);

    if (error !== undefined) {
      throw error;
    }

    if (
      normalized === "begin" ||
      normalized === "commit" ||
      normalized === "rollback" ||
      normalized.startsWith("insert into document_sources") ||
      normalized.startsWith("insert into document_source_evidence") ||
      (normalized.startsWith("update document_sources") &&
        !normalized.includes("returning *"))
    ) {
      return { rows: [] };
    }

    if (normalized === "select * from document_sources where source_uri = $1 for update") {
      return { rows: [sourceRow] };
    }

    if (
      normalized.startsWith("update document_sources") &&
      normalized.includes("returning *")
    ) {
      return { rows: [sourceRow] };
    }

    if (normalized.startsWith("select * from document_sources")) {
      return { rows: [sourceRow] };
    }

    if (normalized.startsWith("select document_source_id, kind, source_uri")) {
      return { rows: evidenceRows };
    }

    return { rows: [] };
  });
  const client = { query, release };
  const pool = { connect: vi.fn(async () => client) };

  return {
    pool: pool as unknown as pg.Pool,
    queries,
    release,
  };
}

function classifyQuery(sql: string): string {
  const normalized = normalizeSql(sql);

  if (normalized === "begin" || normalized === "commit" || normalized === "rollback") {
    return normalized;
  }
  if (normalized.startsWith("insert into document_sources")) {
    return "insert source";
  }
  if (normalized === "select * from document_sources where source_uri = $1 for update") {
    return "select source for update";
  }
  if (normalized.startsWith("update document_sources")) {
    return "update source";
  }
  if (normalized.startsWith("insert into document_source_evidence")) {
    return "insert evidence";
  }
  if (normalized.startsWith("select * from document_sources")) {
    return "select source";
  }
  if (normalized.startsWith("select document_source_id, kind, source_uri")) {
    return "select evidence";
  }

  return normalized;
}

describe("createPostgresDocumentSourceRegistry without a database", () => {
  it("registerGroupVisibleDocument uses a transaction and releases the client", async () => {
    const fake = createFakePool();
    const registry = createPostgresDocumentSourceRegistry(fake.pool, {
      createId: () => "source-1",
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });

    await registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/doc",
      title: "Group Doc",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });

    expect(fake.queries.map((query) => classifyQuery(query.sql))).toEqual([
      "begin",
      "insert source",
      "select source for update",
      "update source",
      "insert evidence",
      "select source",
      "select evidence",
      "commit",
    ]);
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it("uses the explicit evidence dedupe conflict target", async () => {
    const fake = createFakePool();
    const registry = createPostgresDocumentSourceRegistry(fake.pool);

    await registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/doc",
      title: "Group Doc",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedByUserId: "user-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });

    const evidenceInsert = fake.queries.find((query) =>
      normalizeSql(query.sql).startsWith("insert into document_source_evidence"),
    );

    expect(evidenceInsert).toBeDefined();
    expect(normalizeSql(evidenceInsert?.sql ?? "")).toContain(
      "on conflict ( kind, source_uri, (coalesce(group_id, '')), (coalesce(message_id, '')), (coalesce(user_id, '')), (coalesce(space_id, '')) ) do nothing",
    );
    expect(normalizeSql(evidenceInsert?.sql ?? "")).not.toContain(
      "on conflict do nothing",
    );
    expect(evidenceInsert?.values?.[5]).toBe("user-1");
  });

  it("merges knowledge draft capability when registration upgrades an existing source", async () => {
    const now = new Date("2026-07-01T04:00:00.000Z");
    const fake = createFakePool({
      sourceRow: makeSourceRow({
        source_type: "user_submitted_document",
        authorized_space_id: null,
        can_use_for_knowledge_drafts: false,
      }),
    });
    const registry = createPostgresDocumentSourceRegistry(fake.pool, {
      now: () => now,
    });

    await registry.registerAuthorizedWikiDocument({
      sourceUri: "https://example.com/doc",
      authorizedSpaceId: "space-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });

    const update = fake.queries.find((query) => {
      const normalized = normalizeSql(query.sql);
      return (
        normalized.startsWith("update document_sources") &&
        !normalized.includes("returning *")
      );
    });

    expect(update).toBeDefined();
    expect(normalizeSql(update?.sql ?? "")).toContain(
      "can_use_for_knowledge_drafts = can_use_for_knowledge_drafts or $7",
    );
    expect(update?.values).toEqual([
      "authorized_wiki_document",
      null,
      null,
      null,
      null,
      "space-1",
      true,
      now,
      "source-1",
    ]);
  });

  it("resets failed sync state to pending when registration adds new evidence", async () => {
    const now = new Date("2026-07-01T04:00:00.000Z");
    const fake = createFakePool({
      sourceRow: makeSourceRow({
        sync_state: "failed",
      }),
    });
    const registry = createPostgresDocumentSourceRegistry(fake.pool, {
      now: () => now,
    });

    await registry.registerGroupVisibleDocument({
      sourceUri: "https://example.com/doc",
      originGroupId: "group-1",
      originMessageId: "message-2",
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    });

    const update = fake.queries.find((query) => {
      const normalized = normalizeSql(query.sql);
      return (
        normalized.startsWith("update document_sources") &&
        !normalized.includes("returning *")
      );
    });

    expect(update).toBeDefined();
    expect(normalizeSql(update?.sql ?? "")).toContain(
      "sync_state = case when sync_state = 'failed' then 'pending' else sync_state end",
    );
  });

  it("rolls back and releases the client when registration fails", async () => {
    const fake = createFakePool({
      failOnSql: (sql) =>
        sql.startsWith("insert into document_source_evidence")
          ? new Error("evidence insert failed")
          : undefined,
    });
    const registry = createPostgresDocumentSourceRegistry(fake.pool);

    await expect(
      registry.registerGroupVisibleDocument({
        sourceUri: "https://example.com/doc",
        title: "Group Doc",
        originGroupId: "group-1",
        originMessageId: "message-1",
        observedAt: new Date("2026-07-01T04:01:00.000Z"),
      }),
    ).rejects.toThrow("evidence insert failed");

    expect(fake.queries.map((query) => classifyQuery(query.sql))).toEqual([
      "begin",
      "insert source",
      "select source for update",
      "update source",
      "insert evidence",
      "rollback",
    ]);
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it("setAnsweringEnabled preserves denied sources and passes enabled as $2", async () => {
    const now = new Date("2026-07-01T04:00:00.000Z");
    const fake = createFakePool();
    const registry = createPostgresDocumentSourceRegistry(fake.pool, {
      now: () => now,
    });

    await registry.setAnsweringEnabled("source-1", true);

    const update = fake.queries.find((query) => {
      const normalized = normalizeSql(query.sql);
      return (
        normalized.startsWith("update document_sources") &&
        normalized.includes("returning *")
      );
    });

    expect(update).toBeDefined();
    expect(normalizeSql(update?.sql ?? "")).toContain(
      "can_use_for_answering = case when permission_state = 'denied' then false else $2 end",
    );
    expect(update?.values).toEqual(["source-1", true, now]);
  });
});

runIfDatabase("createPostgresDocumentSourceRegistry", () => {
  let pool: pg.Pool;
  const runId = randomUUID();
  const testSourcePrefix = `https://example.com/postgres-registry/${runId}/`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();

    try {
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally {
      client.release();
    }
  });

  afterEach(async () => {
    await pool.query("delete from document_sources where source_uri like $1", [
      `${testSourcePrefix}%`,
    ]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("persists group visible sources and deduplicates retried message evidence", async () => {
    const registry = createPostgresDocumentSourceRegistry(pool, {
      createId: () => `${runId}-group-source`,
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });
    const sourceUri = `${testSourcePrefix}group-doc`;

    const first = await registry.registerGroupVisibleDocument({
      sourceUri,
      title: "First Title",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });
    const retried = await registry.registerGroupVisibleDocument({
      sourceUri,
      title: "Retried Title",
      originGroupId: "group-1",
      originMessageId: "message-1",
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    });

    expect(retried.id).toBe(first.id);
    expect(retried.title).toBe("First Title");
    expect(retried.evidence).toHaveLength(1);
    expect(retried.evidence[0]).toMatchObject({
      kind: "group_message",
      sourceUri,
      groupId: "group-1",
      messageId: "message-1",
    });
    expect(retried.evidence[0]?.observedAt).toEqual(new Date("2026-07-01T04:01:00.000Z"));
  });

  it("keeps existing source id and disabled answering across registry instances", async () => {
    const sourceUri = `${testSourcePrefix}wiki-doc`;
    const firstRegistry = createPostgresDocumentSourceRegistry(pool, {
      createId: () => `${runId}-wiki-source`,
      now: () => new Date("2026-07-01T04:00:00.000Z"),
    });
    const secondRegistry = createPostgresDocumentSourceRegistry(pool, {
      createId: () => `${runId}-unused-wiki-source`,
      now: () => new Date("2026-07-01T04:05:00.000Z"),
    });

    const first = await firstRegistry.registerAuthorizedWikiDocument({
      sourceUri,
      title: "Wiki Space",
      authorizedSpaceId: "space-1",
      observedAt: new Date("2026-07-01T04:01:00.000Z"),
    });
    await firstRegistry.setAnsweringEnabled(first.id, false);

    const reregistered = await secondRegistry.registerAuthorizedWikiDocument({
      sourceUri,
      title: "Wiki Space Again",
      authorizedSpaceId: "space-1",
      observedAt: new Date("2026-07-01T04:02:00.000Z"),
    });

    expect(reregistered.id).toBe(first.id);
    expect(reregistered.canUseForAnswering).toBe(false);
  });
});
