import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { readDatabaseConfig } from "../src/database/database-config.js";
import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";
import {
  createDocumentFragmentRepository,
  serializeVector,
  type DocumentFragment,
  type Queryable,
} from "../src/documents/document-fragment-repository.js";

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function queryableFrom(query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>): Queryable {
  return { query: query as Queryable["query"] };
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
      "b1a96dd646bccaa24cef7a3db22a6f995f05658f4f1c3272913e258c03e6fb24",
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

    await expect(
      repository.searchSimilarFragments({ embedding: [1, 2, 3, 4, 5, 6], limit: 3 }),
    ).resolves.toEqual([]);
  });
});

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
