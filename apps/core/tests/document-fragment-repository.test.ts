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
      return { rows: [] };
    });
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

    const fragments = await repository.replaceFragmentsForSnapshot({
      documentSourceId: "source-1",
      documentSnapshotId: "snapshot-1",
      sourceUri: "https://example.com/doc",
      embeddingProfileId: "static-dev-6d",
      chunks: [{ chunkIndex: 0, text: "Alpha" }],
      embeddings: [[1, 2, 3, 4, 5, 6]],
    });

    expect(normalizeSql(calls[0]?.sql ?? "")).toBe(
      "delete from document_fragments where document_snapshot_id = $1 and embedding_profile_id = $2",
    );
    expect(calls[0]?.values).toEqual(["snapshot-1", "static-dev-6d"]);
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
  });

  it("serializes vectors for pgvector", () => {
    expect(serializeVector([1, 0.5, -2])).toBe("[1,0.5,-2]");
  });

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

  it("rejects invalid replacement vectors before deleting existing fragments", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(query),
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({ id: "static-dev-6d", dimensions: 6 })),
      },
    });

    await expect(
      repository.replaceFragmentsForSnapshot({
        documentSourceId: "source-1",
        documentSnapshotId: "snapshot-1",
        sourceUri: "https://example.com/doc",
        embeddingProfileId: "static-dev-6d",
        chunks: [{ chunkIndex: 0, text: "Alpha" }],
        embeddings: [[Number.NaN, 0, 0, 0, 0, 0]],
      }),
    ).rejects.toThrow("embedding vector contains invalid value");
    expect(query).not.toHaveBeenCalled();
  });

  it("wraps fragment replacement mutations in a transaction when the queryable supports clients", async () => {
    const createdAt = new Date("2026-07-05T01:00:00.000Z");
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        const normalized = normalizeSql(sql);
        if (normalized === "begin" || normalized === "commit" || normalized === "rollback") {
          calls.push(normalized);
          return { rows: [] };
        }
        if (normalized.startsWith("delete from document_fragments")) {
          calls.push("delete fragments");
          return { rows: [] };
        }
        if (normalized.startsWith("insert into document_fragments")) {
          calls.push("insert fragment");
          return {
            rows: [
              {
                id: "fragment-tx",
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
        if (normalized.startsWith("insert into document_fragment_embeddings_6")) {
          calls.push("insert embedding");
          return { rows: [] };
        }
        throw new Error(`unexpected SQL: ${normalized}`);
      }),
      release: vi.fn(() => {
        calls.push("release");
      }),
    };
    const queryable = {
      query: vi.fn(async () => {
        throw new Error("direct query should not be used for transactional replacement");
      }),
      connect: vi.fn(async () => client),
    };
    const repository = createDocumentFragmentRepository({
      queryable,
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({ id: "static-dev-6d", dimensions: 6 })),
      },
      createId: () => "fragment-tx",
      now: () => createdAt,
    });

    await expect(
      repository.replaceFragmentsForSnapshot({
        documentSourceId: "source-1",
        documentSnapshotId: "snapshot-1",
        sourceUri: "https://example.com/doc",
        embeddingProfileId: "static-dev-6d",
        chunks: [{ chunkIndex: 0, text: "Alpha" }],
        embeddings: [[1, 0, 0, 0, 0, 0]],
      }),
    ).resolves.toEqual([
      {
        id: "fragment-tx",
        documentSourceId: "source-1",
        documentSnapshotId: "snapshot-1",
        sourceUri: "https://example.com/doc",
        chunkIndex: 0,
        text: "Alpha",
        contentHash: "hash-alpha",
        embedding: [1, 0, 0, 0, 0, 0],
        embeddingProfileId: "static-dev-6d",
        createdAt,
      },
    ]);
    expect(queryable.connect).toHaveBeenCalledOnce();
    expect(queryable.query).not.toHaveBeenCalled();
    expect(calls).toEqual([
      "begin",
      "delete fragments",
      "insert fragment",
      "insert embedding",
      "commit",
      "release",
    ]);
  });

  it("rolls back transactional fragment replacement when a mutation fails", async () => {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        const normalized = normalizeSql(sql);
        if (normalized === "begin" || normalized === "rollback") {
          calls.push(normalized);
          return { rows: [] };
        }
        if (normalized === "commit") {
          calls.push("commit");
          return { rows: [] };
        }
        if (normalized.startsWith("delete from document_fragments")) {
          calls.push("delete fragments");
          return { rows: [] };
        }
        if (normalized.startsWith("insert into document_fragments")) {
          calls.push("insert fragment");
          return {
            rows: [
              {
                id: "fragment-rollback",
                document_source_id: "source-1",
                document_snapshot_id: "snapshot-1",
                source_uri: "https://example.com/doc",
                chunk_index: 0,
                text: "Alpha",
                content_hash: "hash-alpha",
                embedding_profile_id: "static-dev-6d",
                created_at: new Date("2026-07-05T01:00:00.000Z"),
              },
            ],
          };
        }
        if (normalized.startsWith("insert into document_fragment_embeddings_6")) {
          calls.push("insert embedding");
          throw new Error("embedding write failed");
        }
        throw new Error(`unexpected SQL: ${normalized}`);
      }),
      release: vi.fn(() => {
        calls.push("release");
      }),
    };
    const queryable = {
      query: vi.fn(async () => {
        throw new Error("direct query should not be used for transactional replacement");
      }),
      connect: vi.fn(async () => client),
    };
    const repository = createDocumentFragmentRepository({
      queryable,
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({ id: "static-dev-6d", dimensions: 6 })),
      },
      createId: () => "fragment-rollback",
      now: () => new Date("2026-07-05T01:00:00.000Z"),
    });

    await expect(
      repository.replaceFragmentsForSnapshot({
        documentSourceId: "source-1",
        documentSnapshotId: "snapshot-1",
        sourceUri: "https://example.com/doc",
        embeddingProfileId: "static-dev-6d",
        chunks: [{ chunkIndex: 0, text: "Alpha" }],
        embeddings: [[1, 0, 0, 0, 0, 0]],
      }),
    ).rejects.toThrow("embedding write failed");
    expect(queryable.connect).toHaveBeenCalledOnce();
    expect(queryable.query).not.toHaveBeenCalled();
    expect(calls).toEqual([
      "begin",
      "delete fragments",
      "insert fragment",
      "insert embedding",
      "rollback",
      "release",
    ]);
  });

  it("builds vector search query with limit", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(normalizeSql(sql)).toContain("from document_fragments f");
      expect(normalizeSql(sql)).toContain("join document_fragment_embeddings_6 e");
      expect(normalizeSql(sql)).toContain("where f.embedding_profile_id = $1");
      expect(normalizeSql(sql)).toContain("and e.embedding_profile_id = $1");
      expect(normalizeSql(sql)).toContain("order by e.embedding <=> $2::vector asc");
      expect(values).toEqual(["static-dev-6d", "[1,2,3,4,5,6]", 3]);
      return { rows: [] };
    });
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(query),
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({ id: "static-dev-6d", dimensions: 6 })),
      },
    });

    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId: "static-dev-6d",
        embedding: [1, 2, 3, 4, 5, 6],
        limit: 3,
      }),
    ).resolves.toEqual([]);
  });

  it("limits vector search to the latest successful snapshot for each document source", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      const normalized = normalizeSql(sql);
      expect(normalized).toContain("from document_snapshots");
      expect(normalized).toContain("where fetch_status = 'succeeded'");
      expect(normalized).toContain("distinct on (document_source_id)");
      expect(normalized).toContain("order by document_source_id asc, fetched_at desc, id asc");
      expect(normalized).toContain("f.document_snapshot_id = latest_snapshots.id");
      expect(normalized).toContain(
        "order by e.embedding <=> $2::vector asc, f.document_source_id asc, f.chunk_index asc, f.id asc",
      );
      expect(values).toEqual(["static-dev-6d", "[1,2,3,4,5,6]", 3]);
      return { rows: [] };
    });
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(query),
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({ id: "static-dev-6d", dimensions: 6 })),
      },
    });

    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId: "static-dev-6d",
        embedding: [1, 2, 3, 4, 5, 6],
        limit: 3,
      }),
    ).resolves.toEqual([]);
  });

  it("caps oversized vector search limits before querying fragments", async () => {
    const query = vi.fn(async (_sql: string, values?: unknown[]) => {
      expect(values).toEqual(["static-dev-6d", "[1,2,3,4,5,6]", 100]);
      return { rows: [] };
    });
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(query),
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({ id: "static-dev-6d", dimensions: 6 })),
      },
    });

    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId: "static-dev-6d",
        embedding: [1, 2, 3, 4, 5, 6],
        limit: 101,
      }),
    ).resolves.toEqual([]);
  });

  it("rejects non-finite vector search limits before querying profiles or fragments", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const getProfileById = vi.fn(async () => ({ id: "static-dev-6d", dimensions: 6 }));
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(query),
      embeddingProfiles: {
        getProfileById,
      },
    });

    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId: "static-dev-6d",
        embedding: [1, 2, 3, 4, 5, 6],
        limit: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow("fragment search limit must be a finite safe-magnitude number");
    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId: "static-dev-6d",
        embedding: [1, 2, 3, 4, 5, 6],
        limit: Number.NaN,
      }),
    ).rejects.toThrow("fragment search limit must be a finite safe-magnitude number");

    expect(getProfileById).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects unsafe vector search limits before querying profiles or fragments", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const getProfileById = vi.fn(async () => ({ id: "static-dev-6d", dimensions: 6 }));
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(query),
      embeddingProfiles: {
        getProfileById,
      },
    });

    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId: "static-dev-6d",
        embedding: [1, 2, 3, 4, 5, 6],
        limit: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow("fragment search limit must be a finite safe-magnitude number");
    expect(getProfileById).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

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

    const repository = createDocumentFragmentRepository({
      queryable: pool,
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({ id: "static-dev-6d", dimensions: 6 })),
      },
    });

    await repository.replaceFragmentsForSnapshot({
      documentSourceId: sourceId,
      documentSnapshotId: snapshotId,
      sourceUri,
      embeddingProfileId: "static-dev-6d",
      chunks: [{ chunkIndex: 0, text: "Alpha body" }],
      embeddings: [[1, 0, 0, 0, 0, 0]],
    });

    await expect(repository.listFragmentsForSnapshot(snapshotId)).resolves.toEqual([
      expect.objectContaining({
        documentSourceId: sourceId,
        documentSnapshotId: snapshotId,
        text: "Alpha body",
        embedding: [],
        embeddingProfileId: "static-dev-6d",
      }),
    ]);
  });
});
