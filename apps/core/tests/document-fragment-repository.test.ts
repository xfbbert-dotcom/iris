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
import { DOCUMENT_SOURCE_METADATA_MAX_CHARS } from "../src/documents/document-source-registry.js";

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function retrievedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "fragment-1",
    document_source_id: "source-1",
    document_snapshot_id: "snapshot-1",
    source_uri: "https://example.feishu.cn/wiki/wikcnSource1",
    source_title: "Quello Life Engine",
    source_type: "authorized_wiki_document",
    chunk_index: 0,
    text: "Life Engine context",
    content_hash: "a".repeat(64),
    embedding: "[1,0,0,0,0,0]",
    embedding_profile_id: "static-dev-6d",
    created_at: new Date("2026-08-02T02:00:00.000Z"),
    distance: "0.125",
    ...overrides,
  };
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

  it("routes 1024-dimensional writes to the 1024 embedding table", async () => {
    const createdAt = new Date("2026-07-02T01:00:00.000Z");
    const vector = Array.from({ length: 1024 }, (_, index) => index / 1024);
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
              id: "fragment-1024",
              document_source_id: "source-1",
              document_snapshot_id: "snapshot-1",
              source_uri: "https://example.com/doc",
              chunk_index: 0,
              text: "Alpha",
              content_hash: "hash-alpha",
              embedding_profile_id: "openai-compatible:qwen3-embedding:0.6b:1024",
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
          id: "openai-compatible:qwen3-embedding:0.6b:1024",
          dimensions: 1024,
        })),
      },
      createId: () => "fragment-1024",
      now: () => createdAt,
    });

    await repository.replaceFragmentsForSnapshot({
      documentSourceId: "source-1",
      documentSnapshotId: "snapshot-1",
      sourceUri: "https://example.com/doc",
      embeddingProfileId: "openai-compatible:qwen3-embedding:0.6b:1024",
      chunks: [{ chunkIndex: 0, text: "Alpha" }],
      embeddings: [vector],
    });

    expect(normalizeSql(calls[2]?.sql ?? "")).toContain(
      "insert into document_fragment_embeddings_1024",
    );
    expect(calls[2]?.values).toEqual([
      "fragment-1024",
      "openai-compatible:qwen3-embedding:0.6b:1024",
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

  it("carries source metadata through similarity search results", async () => {
    const query = vi.fn(async (sql: string) => {
      const normalized = normalizeSql(sql);
      expect(normalized).toContain("ds.title as source_title");
      expect(normalized).toContain("ds.source_type");
      return {
        rows: [
          {
            id: "fragment-1",
            document_source_id: "source-1",
            document_snapshot_id: "snapshot-1",
            source_uri: "https://example.feishu.cn/wiki/wikcnSource1",
            source_title: " Quello Life Engine ",
            source_type: "authorized_wiki_document",
            chunk_index: 0,
            text: "Life Engine context",
            content_hash: "a".repeat(64),
            embedding: "[1,0,0,0,0,0]",
            embedding_profile_id: "static-dev-6d",
            created_at: new Date("2026-08-02T02:00:00.000Z"),
            distance: "0.125",
          },
        ],
      };
    });
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(query),
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({ id: "static-dev-6d", dimensions: 6 })),
      },
    });

    const result = await repository.searchSimilarFragments({
      embeddingProfileId: "static-dev-6d",
      embedding: [1, 0, 0, 0, 0, 0],
      limit: 1,
    });

    expect(result).toEqual([
      expect.objectContaining({
        sourceTitle: "Quello Life Engine",
        sourceType: "authorized_wiki_document",
        distance: 0.125,
      }),
    ]);
  });

  it("rejects an invalid source type in similarity search results", async () => {
    const query = vi.fn(async () => ({ rows: [retrievedRow({ source_type: "invalid" })] }));
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(query),
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({ id: "static-dev-6d", dimensions: 6 })),
      },
    });

    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId: "static-dev-6d",
        embedding: [1, 0, 0, 0, 0, 0],
        limit: 1,
      }),
    ).rejects.toThrow("invalid document source type");
  });

  it("rejects an overlong source title in similarity search results", async () => {
    const query = vi.fn(async () => ({
      rows: [retrievedRow({ source_title: "x".repeat(DOCUMENT_SOURCE_METADATA_MAX_CHARS + 1) })],
    }));
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(query),
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({ id: "static-dev-6d", dimensions: 6 })),
      },
    });

    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId: "static-dev-6d",
        embedding: [1, 0, 0, 0, 0, 0],
        limit: 1,
      }),
    ).rejects.toThrow(`source title must be at most ${DOCUMENT_SOURCE_METADATA_MAX_CHARS} characters`);
  });

  it("routes 768-dimensional writes to the 768 embedding table", async () => {
    const createdAt = new Date("2026-07-30T07:30:00.000Z");
    const vector = Array.from({ length: 768 }, (_, index) => index / 768);
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
              id: "fragment-768",
              document_source_id: "source-1",
              document_snapshot_id: "snapshot-1",
              source_uri: "https://example.com/doc",
              chunk_index: 0,
              text: "Alpha",
              content_hash: "hash-alpha",
              embedding_profile_id:
                "openai-compatible:embeddinggemma:300m-qat-q4_0:768",
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
          id: "openai-compatible:embeddinggemma:300m-qat-q4_0:768",
          dimensions: 768,
        })),
      },
      createId: () => "fragment-768",
      now: () => createdAt,
    });

    await repository.replaceFragmentsForSnapshot({
      documentSourceId: "source-1",
      documentSnapshotId: "snapshot-1",
      sourceUri: "https://example.com/doc",
      embeddingProfileId: "openai-compatible:embeddinggemma:300m-qat-q4_0:768",
      chunks: [{ chunkIndex: 0, text: "Alpha" }],
      embeddings: [vector],
    });

    expect(normalizeSql(calls[2]?.sql ?? "")).toContain(
      "insert into document_fragment_embeddings_768",
    );
    expect(calls[2]?.values).toEqual([
      "fragment-768",
      "openai-compatible:embeddinggemma:300m-qat-q4_0:768",
      `[${vector.join(",")}]`,
      createdAt,
    ]);
  });

  it("routes 1024-dimensional similarity search to the 1024 embedding table", async () => {
    const vector = Array.from({ length: 1024 }, (_, index) => index / 1024);
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(normalizeSql(sql)).toContain("join document_fragment_embeddings_1024 e");
      expect(values).toEqual([
        "openai-compatible:qwen3-embedding:0.6b:1024",
        `[${vector.join(",")}]`,
        3,
      ]);
      return { rows: [] };
    });
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(query),
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({
          id: "openai-compatible:qwen3-embedding:0.6b:1024",
          dimensions: 1024,
        })),
      },
    });

    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId: "openai-compatible:qwen3-embedding:0.6b:1024",
        embedding: vector,
        limit: 3,
      }),
    ).resolves.toEqual([]);
  });

  it("routes 768-dimensional similarity search to the 768 embedding table", async () => {
    const vector = Array.from({ length: 768 }, (_, index) => index / 768);
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(normalizeSql(sql)).toContain("join document_fragment_embeddings_768 e");
      expect(values).toEqual([
        "openai-compatible:embeddinggemma:300m-qat-q4_0:768",
        `[${vector.join(",")}]`,
        3,
      ]);
      return { rows: [] };
    });
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(query),
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({
          id: "openai-compatible:embeddinggemma:300m-qat-q4_0:768",
          dimensions: 768,
        })),
      },
    });

    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId: "openai-compatible:embeddinggemma:300m-qat-q4_0:768",
        embedding: vector,
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

  it("limits vector search to answering-enabled locally eligible document sources", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      const normalized = normalizeSql(sql);
      expect(normalized).toContain("join document_sources ds");
      expect(normalized).toContain("ds.id = f.document_source_id");
      expect(normalized).toContain("ds.can_use_for_answering = true");
      expect(normalized).toContain("ds.permission_state in ('unknown', 'readable')");
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

  it("limits vector search to requested document source types", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(normalizeSql(sql)).toContain("and ds.source_type = any($4::text[])");
      expect(values).toEqual([
        "static-dev-6d",
        "[1,2,3,4,5,6]",
        3,
        ["user_submitted_document"],
      ]);
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
        sourceTypes: ["user_submitted_document"],
      }),
    ).resolves.toEqual([]);
  });

  it("limits group-visible vector candidates to the current origin or evidence group", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      const normalized = normalizeSql(sql);
      expect(normalized).toContain("ds.source_type <> 'group_visible_document'");
      expect(normalized).toContain("ds.origin_group_id = $5");
      expect(normalized).toContain("from document_source_evidence evidence");
      expect(normalized).toContain("evidence.document_source_id = ds.id");
      expect(normalized).toContain("evidence.group_id = $5");
      expect(values).toEqual([
        "static-dev-6d",
        "[1,2,3,4,5,6]",
        3,
        ["group_visible_document", "authorized_wiki_document"],
        "chat-current",
      ]);
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
        sourceTypes: ["group_visible_document", "authorized_wiki_document"],
        groupId: "chat-current",
      }),
    ).resolves.toEqual([]);
  });

  it("uses the next dynamic parameter for current-group scope without source types", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      const normalized = normalizeSql(sql);
      expect(normalized).toContain("ds.origin_group_id = $4");
      expect(normalized).toContain("evidence.group_id = $4");
      expect(values).toEqual(["static-dev-6d", "[1,2,3,4,5,6]", 3, "chat-current"]);
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
        groupId: "chat-current",
      }),
    ).resolves.toEqual([]);
  });

  it("rejects blank or oversized explicit current-group scope before querying", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const getProfileById = vi.fn(async () => ({ id: "static-dev-6d", dimensions: 6 }));
    const repository = createDocumentFragmentRepository({
      queryable: queryableFrom(query),
      embeddingProfiles: { getProfileById },
    });

    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId: "static-dev-6d",
        embedding: [1, 2, 3, 4, 5, 6],
        limit: 3,
        groupId: "   ",
      }),
    ).rejects.toThrow("groupId must not be blank");
    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId: "static-dev-6d",
        embedding: [1, 2, 3, 4, 5, 6],
        limit: 3,
        groupId: "g".repeat(513),
      }),
    ).rejects.toThrow("groupId must be at most 512 characters");

    expect(getProfileById).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
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
  const embeddingProfileId = `openai-compatible:test-fragment-${randomUUID()}:6`;
  const embeddingModel = `test-fragment-${randomUUID()}`;
  const sourceUri = `https://example.com/postgres-fragments/${sourceId}`;
  const originGroupId = `fragment-origin-group-${randomUUID()}`;
  const evidenceGroupId = `fragment-evidence-group-${randomUUID()}`;

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
insert into embedding_profiles (
  id,
  provider,
  model,
  dimensions,
  display_name,
  status,
  created_at
)
values ($1, 'openai-compatible', $2, 6, 'Document fragment integration test', 'active', $3)
`,
      [embeddingProfileId, embeddingModel, new Date("2026-07-02T01:00:00.000Z")],
    );

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
  origin_group_id,
  created_at,
  updated_at
)
values ($1, 'group_visible_document', $2, 'readable', 'synced', true, true, $3, $4, $4)
`,
      [sourceId, sourceUri, originGroupId, new Date("2026-07-02T01:00:00.000Z")],
    );

    await pool.query(
      `
insert into document_source_evidence (
  document_source_id,
  kind,
  source_uri,
  group_id,
  message_id,
  observed_at,
  created_at
)
values ($1, 'group_message', $2, $3, $4, $5, $5)
`,
      [
        sourceId,
        sourceUri,
        evidenceGroupId,
        `fragment-message-${randomUUID()}`,
        new Date("2026-07-02T01:00:00.000Z"),
      ],
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
      await pool.query("delete from embedding_profiles where id = $1", [embeddingProfileId]);
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
        getProfileById: vi.fn(async () => ({ id: embeddingProfileId, dimensions: 6 })),
      },
    });

    await repository.replaceFragmentsForSnapshot({
      documentSourceId: sourceId,
      documentSnapshotId: snapshotId,
      sourceUri,
      embeddingProfileId,
      chunks: [{ chunkIndex: 0, text: "Alpha body" }],
      embeddings: [[1, 0, 0, 0, 0, 0]],
    });

    await expect(repository.listFragmentsForSnapshot(snapshotId)).resolves.toEqual([
      expect.objectContaining({
        documentSourceId: sourceId,
        documentSnapshotId: snapshotId,
        text: "Alpha body",
        embedding: [],
        embeddingProfileId,
      }),
    ]);

    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId,
        embedding: [1, 0, 0, 0, 0, 0],
        limit: 3,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        documentSourceId: sourceId,
        text: "Alpha body",
      }),
    ]);

    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId,
        embedding: [1, 0, 0, 0, 0, 0],
        limit: 3,
        groupId: originGroupId,
      }),
    ).resolves.toHaveLength(1);

    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId,
        embedding: [1, 0, 0, 0, 0, 0],
        limit: 3,
        groupId: evidenceGroupId,
      }),
    ).resolves.toHaveLength(1);

    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId,
        embedding: [1, 0, 0, 0, 0, 0],
        limit: 3,
        groupId: `fragment-unrelated-group-${randomUUID()}`,
      }),
    ).resolves.toEqual([]);

    await pool.query(
      "update document_sources set permission_state = 'stale' where id = $1",
      [sourceId],
    );

    await expect(
      repository.searchSimilarFragments({
        embeddingProfileId,
        embedding: [1, 0, 0, 0, 0, 0],
        limit: 3,
      }),
    ).resolves.toEqual([]);
  });
});
