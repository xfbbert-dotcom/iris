import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";
import {
  DocumentSourceGroupGrantConflictError,
  DocumentSourceGroupGrantNotFoundError,
  createPostgresDocumentSourceGroupGrantRepository,
  type PostgresDocumentSourceGroupGrantDataSource,
} from "../src/documents/postgres-document-source-group-grant-repository.js";

type QueryResult = { rows: Record<string, unknown>[] };
type RecordedQuery = { sql: string; values?: unknown[] };

const at = new Date("2026-08-18T04:00:00.000Z");
const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim().toLowerCase();
}

function grantRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "grant-1",
    document_source_id: "source-1",
    grantor_group_id: "group-source",
    grantee_group_id: "group-reader",
    state: "active",
    version: "1",
    created_by: "operator-1",
    updated_by: "operator-1",
    created_at: at,
    updated_at: at,
    ...overrides,
  };
}

function grantFingerprint(overrides: Record<string, unknown> = {}): string {
  return createHash("sha256").update(JSON.stringify({
    action: "grant",
    documentSourceId: "source-1",
    grantorGroupId: "group-source",
    granteeGroupId: "group-reader",
    expectedVersion: 0,
    actorRef: "operator-1",
    ...overrides,
  })).digest("hex");
}

function createSequentialDataSource(results: QueryResult[]) {
  const queries: RecordedQuery[] = [];
  const release = vi.fn();
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    const normalized = normalizeSql(sql);
    if (normalized === "begin" || normalized === "commit" || normalized === "rollback") {
      return { rows: [] };
    }
    const next = results.shift();
    if (next === undefined) throw new Error(`unexpected query: ${normalized}`);
    return next;
  });
  const client = { query, release };
  const dataSource = {
    query,
    connect: vi.fn(async () => client),
  } as unknown as PostgresDocumentSourceGroupGrantDataSource;
  return { dataSource, queries, release, remaining: results };
}

function operationKinds(queries: RecordedQuery[]): string[] {
  return queries.map(({ sql }) => {
    const normalized = normalizeSql(sql);
    if (["begin", "commit", "rollback"].includes(normalized)) return normalized;
    if (normalized.includes("pg_advisory_xact_lock")) return "lock operation";
    if (normalized.startsWith("select") && normalized.includes("from document_source_group_grant_events")) return "load operation";
    if (normalized.startsWith("select") && normalized.includes("from document_sources") && normalized.includes("for update")) return "lock source";
    if (normalized.startsWith("select") && normalized.includes("from document_source_evidence")) return "check grantor evidence";
    if (normalized.startsWith("select") && normalized.includes("from document_source_group_grants") && normalized.includes("for update")) return "lock grant";
    if (normalized.startsWith("insert into document_source_group_grants")) return "insert grant";
    if (normalized.startsWith("update document_source_group_grants")) return "update grant";
    if (normalized.startsWith("insert into document_source_group_grant_events")) return "insert event";
    if (normalized.includes("from answer_reply_source_traces") && normalized.includes("for update of delivery")) return "lock active answers";
    return normalized;
  });
}

describe("createPostgresDocumentSourceGroupGrantRepository", () => {
  it("lists bounded grant metadata and finds an exact grant without a transaction", async () => {
    const fake = createSequentialDataSource([
      { rows: [grantRow(), grantRow({ id: "grant-2", state: "revoked", version: "2" })] },
      { rows: [grantRow({ id: "grant-2", state: "revoked", version: "2" })] },
      { rows: [] },
    ]);
    const repository = createPostgresDocumentSourceGroupGrantRepository({
      dataSource: fake.dataSource,
    });

    await expect(repository.listForSource({
      documentSourceId: "source-1",
      limit: 10,
    })).resolves.toMatchObject([
      { id: "grant-1", state: "active", version: 1 },
      { id: "grant-2", state: "revoked", version: 2 },
    ]);
    await expect(repository.findById("grant-2")).resolves.toMatchObject({
      id: "grant-2",
      state: "revoked",
      version: 2,
    });
    await expect(repository.findById("missing-grant")).resolves.toBeUndefined();

    expect(fake.queries.map(({ values }) => values)).toEqual([
      ["source-1", 10],
      ["grant-2"],
      ["missing-grant"],
    ]);
    expect(fake.release).not.toHaveBeenCalled();
    expect(fake.remaining).toHaveLength(0);
  });

  it("returns an empty bounded list without querying storage", async () => {
    const fake = createSequentialDataSource([]);
    const repository = createPostgresDocumentSourceGroupGrantRepository({
      dataSource: fake.dataSource,
    });

    await expect(repository.listForSource({
      documentSourceId: "source-1",
      limit: 0,
    })).resolves.toEqual([]);
    expect(fake.queries).toEqual([]);
  });

  it("locks source before projection and appends one event when granting", async () => {
    const fake = createSequentialDataSource([
      { rows: [] },
      { rows: [] },
      { rows: [{ id: "source-1", source_type: "group_visible_document", origin_group_id: "group-source" }] },
      { rows: [{ authorized: true }] },
      { rows: [] },
      { rows: [grantRow()] },
      { rows: [] },
    ]);
    const ids = ["grant-1", "event-1"];
    const repository = createPostgresDocumentSourceGroupGrantRepository({
      dataSource: fake.dataSource,
      createId: () => ids.shift() ?? "unexpected-id",
    });

    const result = await repository.grant({
      documentSourceId: " source-1 ",
      grantorGroupId: "group-source",
      granteeGroupId: "group-reader",
      expectedVersion: 0,
      operationKey: "grant-operation-1",
      actorRef: "operator-1",
      at,
    });

    expect(result).toEqual({
      outcome: "applied",
      grant: {
        id: "grant-1",
        documentSourceId: "source-1",
        grantorGroupId: "group-source",
        granteeGroupId: "group-reader",
        state: "active",
        version: 1,
        createdBy: "operator-1",
        updatedBy: "operator-1",
        createdAt: at,
        updatedAt: at,
      },
    });
    expect(operationKinds(fake.queries)).toEqual([
      "begin",
      "lock operation",
      "load operation",
      "lock source",
      "check grantor evidence",
      "lock grant",
      "insert grant",
      "insert event",
      "commit",
    ]);
    expect(fake.release).toHaveBeenCalledTimes(1);
    expect(fake.remaining).toHaveLength(0);
  });

  it("regrants only the exact revoked version", async () => {
    const fake = createSequentialDataSource([
      { rows: [] },
      { rows: [] },
      { rows: [{ id: "source-1", source_type: "group_visible_document", origin_group_id: "group-source" }] },
      { rows: [{ authorized: true }] },
      { rows: [grantRow({ state: "revoked", version: "2" })] },
      { rows: [grantRow({ version: "3", updated_by: "operator-2" })] },
      { rows: [] },
    ]);
    const repository = createPostgresDocumentSourceGroupGrantRepository({
      dataSource: fake.dataSource,
      createId: () => "event-2",
    });

    await expect(repository.grant({
      documentSourceId: "source-1",
      grantorGroupId: "group-source",
      granteeGroupId: "group-reader",
      expectedVersion: 2,
      operationKey: "regrant-operation-1",
      actorRef: "operator-2",
      at,
    })).resolves.toMatchObject({ outcome: "applied", grant: { state: "active", version: 3 } });
    expect(operationKinds(fake.queries)).toContain("update grant");
  });

  it("replays only the exact operation fingerprint", async () => {
    const replay = createSequentialDataSource([
      { rows: [] },
      { rows: [{
        grant_id: "grant-1",
        event_type: "granted",
        operation_fingerprint: grantFingerprint(),
      }] },
      { rows: [grantRow()] },
    ]);
    const repository = createPostgresDocumentSourceGroupGrantRepository({
      dataSource: replay.dataSource,
    });
    await expect(repository.grant({
      documentSourceId: "source-1",
      grantorGroupId: "group-source",
      granteeGroupId: "group-reader",
      expectedVersion: 0,
      operationKey: "grant-operation-1",
      actorRef: "operator-1",
      at,
    })).resolves.toMatchObject({ outcome: "already_applied", grant: { id: "grant-1" } });

    const conflict = createSequentialDataSource([
      { rows: [] },
      { rows: [{
        grant_id: "grant-1",
        event_type: "granted",
        operation_fingerprint: grantFingerprint({ actorRef: "other-operator" }),
      }] },
    ]);
    const conflictingRepository = createPostgresDocumentSourceGroupGrantRepository({
      dataSource: conflict.dataSource,
    });
    await expect(conflictingRepository.grant({
      documentSourceId: "source-1",
      grantorGroupId: "group-source",
      granteeGroupId: "group-reader",
      expectedVersion: 0,
      operationKey: "grant-operation-1",
      actorRef: "operator-1",
      at,
    })).rejects.toBeInstanceOf(DocumentSourceGroupGrantConflictError);
  });

  it("rejects non-group sources and grantors without source evidence", async () => {
    const wrongType = createSequentialDataSource([
      { rows: [] },
      { rows: [] },
      { rows: [{ id: "source-1", source_type: "authorized_wiki_document", origin_group_id: null }] },
    ]);
    const wrongTypeRepository = createPostgresDocumentSourceGroupGrantRepository({
      dataSource: wrongType.dataSource,
    });
    await expect(wrongTypeRepository.grant({
      documentSourceId: "source-1",
      grantorGroupId: "group-source",
      granteeGroupId: "group-reader",
      expectedVersion: 0,
      operationKey: "grant-operation-1",
      actorRef: "operator-1",
      at,
    })).rejects.toBeInstanceOf(DocumentSourceGroupGrantConflictError);

    const noEvidence = createSequentialDataSource([
      { rows: [] },
      { rows: [] },
      { rows: [{ id: "source-1", source_type: "group_visible_document", origin_group_id: "other-group" }] },
      { rows: [{ authorized: false }] },
    ]);
    const noEvidenceRepository = createPostgresDocumentSourceGroupGrantRepository({
      dataSource: noEvidence.dataSource,
    });
    await expect(noEvidenceRepository.grant({
      documentSourceId: "source-1",
      grantorGroupId: "group-source",
      granteeGroupId: "group-reader",
      expectedVersion: 0,
      operationKey: "grant-operation-1",
      actorRef: "operator-1",
      at,
    })).rejects.toBeInstanceOf(DocumentSourceGroupGrantConflictError);
  });

  it("locks bound answer deliveries before revoking", async () => {
    const fake = createSequentialDataSource([
      { rows: [] },
      { rows: [] },
      { rows: [grantRow()] },
      { rows: [] },
      { rows: [grantRow({ state: "revoked", version: "2", updated_by: "operator-2" })] },
      { rows: [] },
    ]);
    const repository = createPostgresDocumentSourceGroupGrantRepository({
      dataSource: fake.dataSource,
      createId: () => "event-2",
    });

    await expect(repository.revoke({
      grantId: "grant-1",
      expectedVersion: 1,
      operationKey: "revoke-operation-1",
      actorRef: "operator-2",
      at,
    })).resolves.toMatchObject({ outcome: "applied", grant: { state: "revoked", version: 2 } });
    expect(operationKinds(fake.queries)).toEqual([
      "begin",
      "lock operation",
      "load operation",
      "lock grant",
      "lock active answers",
      "update grant",
      "insert event",
      "commit",
    ]);
  });

  it("rejects revocation while a bound answer is sending", async () => {
    const fake = createSequentialDataSource([
      { rows: [] },
      { rows: [] },
      { rows: [grantRow()] },
      { rows: [{ id: "delivery-1" }] },
    ]);
    const repository = createPostgresDocumentSourceGroupGrantRepository({
      dataSource: fake.dataSource,
    });

    await expect(repository.revoke({
      grantId: "grant-1",
      expectedVersion: 1,
      operationKey: "revoke-operation-1",
      actorRef: "operator-2",
      at,
    })).rejects.toBeInstanceOf(DocumentSourceGroupGrantConflictError);
    expect(operationKinds(fake.queries).at(-1)).toBe("rollback");
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it("returns exact active bindings and validates all identity fields", async () => {
    const active = createSequentialDataSource([{ rows: [grantRow()] }]);
    const activeRepository = createPostgresDocumentSourceGroupGrantRepository({
      dataSource: active.dataSource,
    });
    await expect(activeRepository.findActiveForSourceAndGrantee({
      documentSourceId: "source-1",
      granteeGroupId: "group-reader",
    })).resolves.toMatchObject({ id: "grant-1", version: 1, state: "active" });

    const exact = createSequentialDataSource([{ rows: [{ valid: true }] }]);
    const exactRepository = createPostgresDocumentSourceGroupGrantRepository({
      dataSource: exact.dataSource,
    });
    await expect(exactRepository.validateExact({
      grantId: "grant-1",
      version: 1,
      documentSourceId: "source-1",
      grantorGroupId: "group-source",
      granteeGroupId: "group-reader",
    })).resolves.toBe(true);
    expect(normalizeSql(exact.queries[0]?.sql ?? "")).toContain("grant.state = 'active'");
    expect(normalizeSql(exact.queries[0]?.sql ?? "")).toContain("document_source_evidence");
  });

  it("fails closed on stale versions, missing grants, and invalid input", async () => {
    const stale = createSequentialDataSource([
      { rows: [] },
      { rows: [] },
      { rows: [{ id: "source-1", source_type: "group_visible_document", origin_group_id: "group-source" }] },
      { rows: [{ authorized: true }] },
      { rows: [grantRow({ state: "revoked", version: "2" })] },
    ]);
    const staleRepository = createPostgresDocumentSourceGroupGrantRepository({
      dataSource: stale.dataSource,
    });
    await expect(staleRepository.grant({
      documentSourceId: "source-1",
      grantorGroupId: "group-source",
      granteeGroupId: "group-reader",
      expectedVersion: 1,
      operationKey: "regrant-operation-1",
      actorRef: "operator-1",
      at,
    })).rejects.toBeInstanceOf(DocumentSourceGroupGrantConflictError);

    const missing = createSequentialDataSource([{ rows: [] }, { rows: [] }, { rows: [] }]);
    const missingRepository = createPostgresDocumentSourceGroupGrantRepository({
      dataSource: missing.dataSource,
    });
    await expect(missingRepository.revoke({
      grantId: "missing",
      expectedVersion: 1,
      operationKey: "revoke-operation-1",
      actorRef: "operator-1",
      at,
    })).rejects.toBeInstanceOf(DocumentSourceGroupGrantNotFoundError);

    const invalid = createSequentialDataSource([]);
    const invalidRepository = createPostgresDocumentSourceGroupGrantRepository({
      dataSource: invalid.dataSource,
    });
    await expect(invalidRepository.grant({
      documentSourceId: "source-1",
      grantorGroupId: "same-group",
      granteeGroupId: "same-group",
      expectedVersion: 0,
      operationKey: "grant-operation-1",
      actorRef: "operator-1",
      at,
    })).rejects.toThrow(/distinct/iu);
    expect(invalid.dataSource.connect).not.toHaveBeenCalled();
  });
});

runIfDatabase("document source group grants with PostgreSQL", () => {
  let pool: pg.Pool;
  let schema: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    schema = `document_source_group_grants_${randomUUID().replaceAll("-", "")}`;
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally {
      client.release();
    }
    await pool.query(`SET search_path TO ${schema}, public`);
    await pool.query(`
      INSERT INTO document_sources (
        id, source_type, source_uri, origin_group_id, origin_message_id,
        permission_state, sync_state, can_use_for_answering,
        can_use_for_knowledge_drafts, created_at, updated_at
      ) VALUES (
        'source-1', 'group_visible_document', 'https://example.com/group-document',
        'group-source', 'message-source', 'readable', 'synced', TRUE, TRUE, $1, $1
      );
      INSERT INTO document_source_evidence (
        document_source_id, kind, source_uri, group_id, message_id, observed_at, created_at
      ) VALUES (
        'source-1', 'group_message', 'https://example.com/group-document',
        'group-source', 'message-source', $1, $1
      );
    `, [at]);
  });

  afterAll(async () => {
    if (pool === undefined || schema === undefined) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await pool.end();
  });

  it("persists idempotent versioned transitions and immutable exact receipt bindings", async () => {
    const repository = createPostgresDocumentSourceGroupGrantRepository({ dataSource: pool });
    const grantInput = {
      documentSourceId: "source-1",
      grantorGroupId: "group-source",
      granteeGroupId: "group-reader",
      expectedVersion: 0,
      operationKey: "grant-operation-1",
      actorRef: "operator-1",
      at,
    };

    const granted = await repository.grant(grantInput);
    expect(granted).toMatchObject({ outcome: "applied", grant: { state: "active", version: 1 } });
    await expect(repository.grant({ ...grantInput, at: new Date(at.getTime() + 1_000) }))
      .resolves.toMatchObject({ outcome: "already_applied", grant: { id: granted.grant.id } });
    await expect(repository.grant({ ...grantInput, actorRef: "different-operator" }))
      .rejects.toBeInstanceOf(DocumentSourceGroupGrantConflictError);
    await expect(repository.validateExact({
      grantId: granted.grant.id,
      version: 1,
      documentSourceId: "source-1",
      grantorGroupId: "group-source",
      granteeGroupId: "group-reader",
    })).resolves.toBe(true);

    const revoked = await repository.revoke({
      grantId: granted.grant.id,
      expectedVersion: 1,
      operationKey: "revoke-operation-1",
      actorRef: "operator-2",
      at: new Date(at.getTime() + 2_000),
    });
    expect(revoked).toMatchObject({ outcome: "applied", grant: { state: "revoked", version: 2 } });
    await expect(repository.validateExact({
      grantId: granted.grant.id,
      version: 1,
      documentSourceId: "source-1",
      grantorGroupId: "group-source",
      granteeGroupId: "group-reader",
    })).resolves.toBe(false);

    const regranted = await repository.grant({
      ...grantInput,
      expectedVersion: 2,
      operationKey: "regrant-operation-1",
      actorRef: "operator-3",
      at: new Date(at.getTime() + 3_000),
    });
    expect(regranted).toMatchObject({ outcome: "applied", grant: { state: "active", version: 3 } });
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM document_source_group_grant_events",
    )).resolves.toMatchObject({ rows: [{ count: 3 }] });

    await pool.query(`
      INSERT INTO answer_reply_deliveries (
        id, provider, incoming_message_id, chat_id, reply_uuid, safe_notice_uuid,
        state, prepared_reply_text, rendered_reply_fingerprint, semantic_fingerprint,
        created_at, updated_at
      ) VALUES (
        'delivery-1', 'feishu', 'incoming-1', 'group-reader',
        'reply-1', 'safe-1', 'prepared', 'Prepared reply', repeat('a', 64),
        repeat('b', 64), $1, $1
      )
    `, [at]);
    await expect(pool.query(`
      INSERT INTO answer_reply_source_traces (
        id, delivery_id, prompt_rank, citation_rank, document_source_id,
        document_snapshot_id, fragment_id, chunk_index, source_type, source_uri,
        content_hash, embedding_profile_id, initial_permission_checked_at,
        cross_group_grant_id, cross_group_grant_version,
        cross_group_grantor_group_id, cross_group_grantee_group_id
      ) VALUES (
        'trace-1', 'delivery-1', 1, 1, 'source-1', 'snapshot-1', 'fragment-1', 0,
        'feishu_group_document', 'https://example.com/group-document', repeat('c', 64),
        'embedding-profile-1', $1, $2, 3, 'group-source', 'group-reader'
      )
    `, [at, granted.grant.id])).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query(`
      INSERT INTO answer_reply_source_traces (
        id, delivery_id, prompt_rank, document_source_id, document_snapshot_id,
        fragment_id, chunk_index, source_type, source_uri, content_hash,
        embedding_profile_id, initial_permission_checked_at, cross_group_grant_id
      ) VALUES (
        'trace-partial', 'delivery-1', 2, 'source-1', 'snapshot-1', 'fragment-2', 1,
        'feishu_group_document', 'https://example.com/group-document', repeat('d', 64),
        'embedding-profile-1', $1, $2
      )
    `, [at, granted.grant.id])).rejects.toMatchObject({
      constraint: "answer_reply_source_traces_cross_group_grant_shape_check",
    });
    await expect(pool.query(
      "UPDATE document_source_group_grant_events SET actor_ref = 'changed'",
    )).rejects.toThrow(/append-only/iu);
    await expect(pool.query("DELETE FROM document_source_group_grant_events"))
      .rejects.toThrow(/append-only/iu);
    await expect(pool.query("TRUNCATE document_source_group_grant_events"))
      .rejects.toThrow(/append-only/iu);
  });
});
