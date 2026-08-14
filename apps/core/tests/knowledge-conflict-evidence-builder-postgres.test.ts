import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { readDatabaseConfig } from "../src/database/database-config.js";
import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";
import { createDocumentFragmentRepository } from "../src/documents/document-fragment-repository.js";
import { createDocumentSnapshotRepository } from "../src/documents/document-snapshot-repository.js";
import { createKnowledgeConflictEvidenceBuilder } from "../src/knowledge-conflicts/knowledge-conflict-evidence-builder.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;

runIfDatabase("KnowledgeConflictEvidenceBuilder with Postgres", () => {
  let pool: pg.Pool | undefined;
  const suffix = randomUUID();
  const sourceId = `conflict-denied-source-${suffix}`;
  const snapshotId = `conflict-denied-snapshot-${suffix}`;
  const embeddingProfileId = `openai-compatible:conflict-denied-${suffix}:6`;
  const embeddingModel = `conflict-denied-${suffix}`;
  const authorizedSpaceId = `conflict-space-${suffix}`;
  const sourceUri = `https://example.com/conflict-denied/${suffix}`;
  const fetchedAt = new Date("2026-08-13T01:00:00.000Z");

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: readDatabaseConfig().databaseUrl });
    const client = await pool.connect();
    try {
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally {
      client.release();
    }
    await pool.query(
      `insert into embedding_profiles (
         id, provider, model, dimensions, display_name, status, created_at
       ) values ($1, 'openai-compatible', $2, 6, 'Conflict denial integration test', 'active', $3)`,
      [embeddingProfileId, embeddingModel, fetchedAt],
    );
    await pool.query(
      `insert into document_sources (
         id, source_type, source_uri, title, authorized_space_id, permission_state, sync_state,
         can_use_for_answering, can_use_for_knowledge_drafts, created_at, updated_at
       ) values ($1, 'authorized_wiki_document', $2, 'Denied source', $3, 'readable', 'synced',
                 false, true, $4, $4)`,
      [sourceId, sourceUri, authorizedSpaceId, fetchedAt],
    );
    await pool.query(
      `insert into document_snapshots (
         id, document_source_id, source_uri, fetch_status, body_text, content_hash,
         source_version, fetched_at, created_at
       ) values ($1, $2, $3, 'succeeded', 'SECRET DOCUMENT BODY', $4, 'v1', $5, $5)`,
      [snapshotId, sourceId, sourceUri, "a".repeat(64), fetchedAt],
    );
    const fragments = createDocumentFragmentRepository({
      queryable: pool,
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({ id: embeddingProfileId, dimensions: 6 })),
      },
    });
    await fragments.replaceFragmentsForSnapshot({
      documentSourceId: sourceId,
      documentSnapshotId: snapshotId,
      sourceUri,
      embeddingProfileId,
      chunks: [{ chunkIndex: 0, text: "SECRET FRAGMENT TEXT" }],
      embeddings: [[1, 0, 0, 0, 0, 0]],
    });
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query("delete from document_sources where id = $1", [sourceId]);
      await pool.query("delete from embedding_profiles where id = $1", [embeddingProfileId]);
    } finally {
      await pool.end();
    }
  });

  it("denies live permission without issuing a snapshot-body or fragment-text query", async () => {
    if (!pool) throw new Error("Expected Postgres pool to be initialized");
    const sqlLog: string[] = [];
    const queryable = {
      query: async <T = unknown>(sql: string, values?: unknown[]) => {
        sqlLog.push(sql);
        const result = await pool!.query(sql, values);
        return { rows: result.rows as unknown as T[] };
      },
    };
    const fragments = createDocumentFragmentRepository({
      queryable,
      embeddingProfiles: {
        getProfileById: vi.fn(async () => ({ id: embeddingProfileId, dimensions: 6 })),
      },
    });
    const builder = createKnowledgeConflictEvidenceBuilder({
      embeddingProfileId,
      embedder: { embedTexts: vi.fn(async () => [[1, 0, 0, 0, 0, 0]]) },
      fragments,
      messages: {
        findByIds: vi.fn(async () => [{
          id: "feishu:message-denied",
          provider: "feishu" as const,
          providerMessageId: "message-denied",
          chatId: "group-denied",
          messageType: "text",
          text: "New policy",
          sentAt: new Date("2026-08-13T02:00:00.000Z"),
          rawEventIdempotencyKey: "raw-event-denied",
          createdAt: new Date("2026-08-13T02:00:00.000Z"),
          tombstoned: false,
        }]),
      },
      documentSources: {
        findSourceById: vi.fn(async (id: string) => id === sourceId ? {
          id: sourceId,
          sourceType: "authorized_wiki_document" as const,
          sourceUri,
          title: "Denied source",
          authorizedSpaceId,
          permissionState: "readable" as const,
          syncState: "synced" as const,
          canUseForAnswering: false,
          canUseForKnowledgeDrafts: true,
          createdAt: fetchedAt,
          updatedAt: fetchedAt,
          evidence: [],
        } : undefined),
      },
      snapshots: createDocumentSnapshotRepository({ queryable }),
      publicationTargets: {
        listTargetPolicies: vi.fn(async () => [{
          id: "policy-denied",
          spaceId: authorizedSpaceId,
          displayName: "Denied target",
          allowedGroupIds: ["group-denied"],
          allowedRiskLevels: ["medium" as const],
          enabled: true,
          version: 1,
          createdAt: fetchedAt,
          updatedAt: fetchedAt,
        }]),
      },
      permissionChecker: { canReadSource: vi.fn(async () => false) },
      now: () => new Date("2026-08-13T03:00:00.000Z"),
    });

    await expect(builder.build({
      memory: {
        id: "memory-denied",
        groupId: "group-denied",
        scope: "group",
        category: "decision",
        content: "New policy",
        importance: 4,
        confidence: 0.9,
        status: "active",
        idempotencyKey: "memory-denied-key",
        origin: "extractor",
        createdBy: "system",
        evidenceMessageIds: ["feishu:message-denied"],
        createdAt: new Date("2026-08-13T02:00:00.000Z"),
        updatedAt: new Date("2026-08-13T02:00:00.000Z"),
      },
    })).resolves.toEqual({ outcome: "permission_blocked", reasonCode: "permission_denied" });

    const normalizedSql = sqlLog.map((sql) => sql.replace(/\s+/g, " ").trim().toLowerCase());
    expect(normalizedSql.some((sql) => sql.includes("from ranked_candidates"))).toBe(true);
    expect(normalizedSql.some((sql) => sql.includes("from document_snapshots"))).toBe(true);
    expect(normalizedSql.every((sql) => !sql.includes("body_text"))).toBe(true);
    expect(normalizedSql.every((sql) => !sql.includes("select * from document_fragments"))).toBe(true);
  });
});
