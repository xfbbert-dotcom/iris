import { randomUUID } from "node:crypto";

import pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { readDatabaseConfig } from "../src/database/database-config.js";
import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";
import {
  createDocumentSnapshotRepository,
  type DocumentSnapshot,
  type Queryable,
} from "../src/documents/document-snapshot-repository.js";

const databaseUrl = process.env.DATABASE_URL;
const runIfDatabase = databaseUrl ? describe : describe.skip;

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function queryableFrom(query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>): Queryable {
  return { query: query as Queryable["query"] };
}

describe("DocumentSnapshotRepository", () => {
  it("inserts succeeded snapshots and maps database rows", async () => {
    const fetchedAt = new Date("2026-07-02T01:00:00.000Z");
    const createdAt = new Date("2026-07-02T01:00:01.000Z");
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(normalizeSql(sql)).toContain("insert into document_snapshots");
      expect(normalizeSql(sql)).toContain("returning *");
      expect(values).toEqual([
        "snapshot-1",
        "source-1",
        "https://example.feishu.cn/docx/A",
        "succeeded",
        "Hello",
        "hash-1",
        "v1",
        fetchedAt,
        null,
        createdAt,
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
            fetched_at: fetchedAt,
            error_message: null,
            created_at: createdAt,
          },
        ],
      };
    });
    const repository = createDocumentSnapshotRepository({
      queryable: queryableFrom(query),
      createId: () => "snapshot-1",
      now: () => createdAt,
    });

    const snapshot = await repository.insertSucceededSnapshot({
      documentSourceId: "source-1",
      sourceUri: "https://example.feishu.cn/docx/A",
      bodyText: "Hello",
      contentHash: "hash-1",
      sourceVersion: "v1",
      fetchedAt,
    });

    expect(snapshot).toEqual<DocumentSnapshot>({
      id: "snapshot-1",
      documentSourceId: "source-1",
      sourceUri: "https://example.feishu.cn/docx/A",
      fetchStatus: "succeeded",
      bodyText: "Hello",
      contentHash: "hash-1",
      sourceVersion: "v1",
      fetchedAt,
      errorMessage: undefined,
      createdAt,
    });
  });

  it("defaults succeeded snapshot content hashes to sha256 body hex", async () => {
    const query = vi.fn(async (_sql: string, values?: unknown[]) => {
      expect(values?.[5]).toBe(
        "185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969",
      );

      return {
        rows: [
          {
            id: "snapshot-1",
            document_source_id: "source-1",
            source_uri: "uri",
            fetch_status: "succeeded",
            body_text: "Hello",
            content_hash:
              "185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969",
            source_version: null,
            fetched_at: new Date("2026-07-02T01:00:00.000Z"),
            error_message: null,
            created_at: new Date("2026-07-02T01:00:01.000Z"),
          },
        ],
      };
    });
    const repository = createDocumentSnapshotRepository({
      queryable: queryableFrom(query),
      createId: () => "snapshot-1",
      now: () => new Date("2026-07-02T01:00:01.000Z"),
    });

    await repository.insertSucceededSnapshot({
      documentSourceId: "source-1",
      sourceUri: "uri",
      bodyText: "Hello",
      fetchedAt: new Date("2026-07-02T01:00:00.000Z"),
    });
  });

  it("inserts failed snapshots with an error message", async () => {
    const fetchedAt = new Date("2026-07-02T01:00:00.000Z");
    const createdAt = new Date("2026-07-02T01:00:01.000Z");
    const query = vi.fn(async (_sql: string, values?: unknown[]) => {
      expect(values).toEqual([
        "snapshot-failed",
        "source-1",
        "https://example.feishu.cn/docx/A",
        "failed",
        null,
        null,
        null,
        fetchedAt,
        "Feishu returned 403",
        createdAt,
      ]);

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
            fetched_at: fetchedAt,
            error_message: "Feishu returned 403",
            created_at: createdAt,
          },
        ],
      };
    });
    const repository = createDocumentSnapshotRepository({
      queryable: queryableFrom(query),
      createId: () => "snapshot-failed",
      now: () => createdAt,
    });

    const snapshot = await repository.insertFailedSnapshot({
      documentSourceId: "source-1",
      sourceUri: "https://example.feishu.cn/docx/A",
      errorMessage: "Feishu returned 403",
      fetchedAt,
    });

    expect(snapshot).toMatchObject({
      id: "snapshot-failed",
      fetchStatus: "failed",
      bodyText: undefined,
      contentHash: undefined,
      sourceVersion: undefined,
      errorMessage: "Feishu returned 403",
    });
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
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(normalizeSql(sql)).toContain(
        "where document_source_id = $1 order by fetched_at desc, id asc",
      );
      expect(values).toEqual(["source-1"]);
      return { rows };
    });
    const repository = createDocumentSnapshotRepository({ queryable: queryableFrom(query) });

    await expect(repository.listSnapshotsForSource("source-1")).resolves.toEqual([
      expect.objectContaining({
        id: "snapshot-2",
        documentSourceId: "source-1",
        bodyText: "new",
      }),
    ]);
    await expect(repository.findLatestSnapshotForSource("source-1")).resolves.toMatchObject({
      id: "snapshot-2",
      bodyText: "new",
    });
  });
});

runIfDatabase("DocumentSnapshotRepository with Postgres", () => {
  let pool: pg.Pool;
  const sourceId = `snapshot-source-${randomUUID()}`;
  const sourceUri = `https://example.com/postgres-snapshots/${sourceId}`;

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
  title,
  origin_group_id,
  origin_message_id,
  submitted_by_user_id,
  authorized_space_id,
  permission_state,
  sync_state,
  can_use_for_answering,
  can_use_for_knowledge_drafts,
  created_at,
  updated_at
)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
`,
      [
        sourceId,
        "group_visible_document",
        sourceUri,
        "Snapshot integration source",
        "group-1",
        "message-1",
        null,
        null,
        "readable",
        "pending",
        true,
        true,
        new Date("2026-07-02T01:00:00.000Z"),
        new Date("2026-07-02T01:00:00.000Z"),
      ],
    );
  });

  afterAll(async () => {
    await pool.query("delete from document_sources where id = $1", [sourceId]);
    await pool.end();
  });

  it("persists succeeded snapshots and reads back the latest body text", async () => {
    const repository = createDocumentSnapshotRepository({ queryable: pool });
    const bodyText = "Postgres snapshot body";

    await repository.insertSucceededSnapshot({
      documentSourceId: sourceId,
      sourceUri,
      bodyText,
      fetchedAt: new Date("2026-07-02T02:00:00.000Z"),
    });

    await expect(repository.findLatestSnapshotForSource(sourceId)).resolves.toMatchObject({
      documentSourceId: sourceId,
      sourceUri,
      fetchStatus: "succeeded",
      bodyText,
      errorMessage: undefined,
    });
  });
});
