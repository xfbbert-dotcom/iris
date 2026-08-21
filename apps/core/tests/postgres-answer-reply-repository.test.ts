import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AnswerReplySourceTraceInput } from "../src/answer-replies/answer-source-citation-renderer.js";
import {
  AnswerReplyGrantStaleError,
  AnswerReplyPreparationConflictError,
  AnswerReplyVersionConflictError,
  createAnswerReplyDeliveryId,
  createAnswerReplySafeNoticeUuid,
  createAnswerReplyUuid,
  type PrepareAnswerReplyInput,
} from "../src/answer-replies/answer-reply-repository.js";
import {
  createPostgresAnswerReplyRepository,
  type PostgresAnswerReplyDataSource,
} from "../src/answer-replies/postgres-answer-reply-repository.js";
import {
  DocumentSourceGroupGrantConflictError,
  createPostgresDocumentSourceGroupGrantRepository,
} from "../src/documents/postgres-document-source-group-grant-repository.js";
import {
  KnowledgeConflictDeliveryConflictError,
  createPostgresKnowledgeConflictRepository,
  type PostgresKnowledgeConflictDataSource,
} from "../src/knowledge-conflicts/postgres-knowledge-conflict-repository.js";
import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;
const renderedFingerprint = "2a035ec5e0873f3169db97d0f4c6163bc1b645253b20f41ee5272bcfd12434bf";

describe("answer reply deterministic identifiers", () => {
  it("derives stable bounded delivery and Feishu UUIDs without content", () => {
    expect(createAnswerReplyDeliveryId("feishu", "incoming-deterministic")).toBe(
      createAnswerReplyDeliveryId("feishu", "incoming-deterministic"),
    );
    expect(createAnswerReplyDeliveryId("feishu", "incoming-deterministic")).toMatch(
      /^answer-reply-[0-9a-f]{64}$/u,
    );
    expect(createAnswerReplyUuid("incoming-deterministic")).toBe(
      "iris-56ba81cc07265ce38d47f4b23182c8842260cd449fbc8",
    );
    expect(createAnswerReplySafeNoticeUuid("incoming-deterministic")).toBe(
      "iris-safe-56ba81cc07265ce38d47f4b23182c8842260cd44",
    );
  });

  it("rejects credential-bearing source URIs before persistence", async () => {
    const repository = createPostgresAnswerReplyRepository({
      dataSource: {
        async query() {
          return { rows: [] };
        },
        async connect() {
          throw new Error("unexpected connection");
        },
      },
    });

    await expect(repository.prepare(prepareInput("credential-uri", {
      sourceTraces: [sourceTrace({
        sourceUri: "https://user:secret@tenant.feishu.cn/wiki/document-a",
      })],
    }))).rejects.toThrow("sourceTrace sourceUri is invalid");
  });
});

describe("answer reply persisted row validation", () => {
  it.each([
    ["blank delivery ID", { id: " " }],
    ["oversized reply UUID", { reply_uuid: "u".repeat(51) }],
    ["prepared delivery without text", { prepared_reply_text: null }],
    ["sent delivery retaining text", {
      state: "sent",
      attempt_count: 1,
      last_send_started_at: new Date("2026-08-02T00:01:00.000Z"),
      sent_at: new Date("2026-08-02T00:02:00.000Z"),
    }],
    ["sent delivery without sent timestamp", {
      state: "sent",
      prepared_reply_text: null,
      attempt_count: 1,
      last_send_started_at: new Date("2026-08-02T00:01:00.000Z"),
    }],
    ["permission block after an attempt", {
      state: "permission_blocked",
      prepared_reply_text: null,
      attempt_count: 1,
      last_send_started_at: new Date("2026-08-02T00:01:00.000Z"),
      permission_blocked_at: new Date("2026-08-02T00:02:00.000Z"),
    }],
    ["reconciliation without an attempt", {
      state: "reconciliation_required",
      prepared_reply_text: null,
      reconciliation_required_at: new Date("2026-08-02T00:02:00.000Z"),
    }],
    ["safe notice timestamp without an attempt", {
      state: "permission_blocked",
      prepared_reply_text: null,
      permission_blocked_at: new Date("2026-08-02T00:02:00.000Z"),
      safe_notice_sent_at: new Date("2026-08-02T00:03:00.000Z"),
    }],
  ])("rejects a malformed %s row", async (_label, overrides) => {
    const repository = repositoryForRows({ delivery: deliveryRow(overrides) });

    await expect(findTestReceipt(repository)).rejects.toThrow(
      "answer reply persistence failed",
    );
  });

  it("rejects prepared text that does not match its rendered fingerprint", async () => {
    const repository = repositoryForRows({
      delivery: deliveryRow({ rendered_reply_fingerprint: "d".repeat(64) }),
    });

    await expect(findTestReceipt(repository)).rejects.toMatchObject({
      name: "AnswerReplyPersistenceError",
      message: "answer reply persistence failed",
    });
  });

  it("rejects a semantic fingerprint that does not match the receipt facts", async () => {
    const repository = repositoryForRows({
      delivery: deliveryRow({ semantic_fingerprint: "d".repeat(64) }),
    });

    await expect(findTestReceipt(repository)).rejects.toMatchObject({
      name: "AnswerReplyPersistenceError",
      message: "answer reply persistence failed",
    });
  });

  it.each([
    ["credential-bearing URI", {
      source_uri: "https://user:secret@tenant.feishu.cn/wiki/document-a",
    }],
    ["noncanonical URI", {
      source_uri: "https://tenant.feishu.cn/wiki/document-a?credential=secret",
    }],
    ["blank document source ID", { document_source_id: " " }],
    ["zero prompt rank", { prompt_rank: 0 }],
    ["citation rank above three", { citation_rank: 4 }],
  ])("rejects a malformed source trace with %s", async (_label, overrides) => {
    const repository = repositoryForRows({ sources: [sourceTraceRow(overrides)] });

    await expect(findTestReceipt(repository)).rejects.toThrow(
      "answer reply persistence failed",
    );
  });

  it.each([
    ["multidimensional values", { document_source_ids: [["source-a"]] }],
    ["blank values", { document_source_ids: [" "] }],
    ["oversized values", { document_source_ids: ["x".repeat(513)] }],
    ["duplicate values", { document_source_ids: ["source-a", "source-a"] }],
    ["cardinality above source count", {
      source_count: 1,
      document_source_ids: ["source-a", "source-b"],
    }],
    ["zero event sequence", { sequence: 0 }],
    ["missing send-start attempt", {
      event_type: "send_started",
      attempt_number: null,
    }],
  ])("rejects a malformed event with %s", async (_label, overrides) => {
    const repository = repositoryForRows({ events: [eventRow(overrides)] });

    await expect(findTestReceipt(repository)).rejects.toThrow(
      "answer reply persistence failed",
    );
  });
});

describe("answer reply assembled receipt validation", () => {
  it.each([
    ["source trace IDs", {
      sources: [sourceTraceRow({ id: "answer-reply-source-not-deterministic" })],
    }],
    ["event IDs", {
      events: [eventRow({ id: "answer-reply-event-not-deterministic" })],
    }],
    ["source trace ownership", {
      sources: [sourceTraceRow({ delivery_id: createAnswerReplyDeliveryId(
        "feishu",
        "incoming-other-owner",
      ) })],
    }],
    ["event ownership", {
      events: [eventRow({ delivery_id: createAnswerReplyDeliveryId(
        "feishu",
        "incoming-other-owner",
      ) })],
    }],
  ])("rejects invalid assembled %s", async (_label, rows) => {
    const repository = repositoryForRows(rows);

    await expect(findTestReceipt(repository)).rejects.toThrow(
      "answer reply persistence failed",
    );
  });

  it.each([
    ["a source prompt-rank gap", {
      sources: [sourceTraceRow({
        prompt_rank: 2,
        document_source_id: "source-b",
      })],
      events: [eventRow({
        source_count: 1,
        document_source_ids: ["source-b"],
      })],
    }],
    ["sources returned out of rank order", {
      sources: [
        sourceTraceRow({
          prompt_rank: 2,
          document_source_id: "source-b",
        }),
        sourceTraceRow(),
      ],
      events: [eventRow({
        source_count: 2,
        document_source_ids: ["source-b", "source-a"],
      })],
    }],
    ["an event sequence gap", {
      delivery: sendingDeliveryRow({ version: 2 }),
      events: [
        eventRow(),
        eventRow({
          sequence: 3,
          event_type: "send_started",
          attempt_number: 1,
          created_at: new Date("2026-08-02T00:01:00.000Z"),
        }),
      ],
    }],
    ["events returned out of sequence order", {
      delivery: sendingDeliveryRow({ version: 2 }),
      events: [
        eventRow({
          sequence: 2,
          event_type: "send_started",
          attempt_number: 1,
          created_at: new Date("2026-08-02T00:01:00.000Z"),
        }),
        eventRow(),
      ],
    }],
    ["an event source-count mismatch", {
      events: [eventRow({ source_count: 2 })],
    }],
    ["an unknown event document source ID", {
      events: [eventRow({ document_source_ids: ["source-unknown"] })],
    }],
    ["event document source IDs outside trace order", {
      sources: [
        sourceTraceRow(),
        sourceTraceRow({
          prompt_rank: 2,
          document_source_id: "source-b",
        }),
      ],
      events: [eventRow({
        source_count: 2,
        document_source_ids: ["source-b", "source-a"],
      })],
    }],
    ["a delivery version without its event", {
      delivery: sendingDeliveryRow({ version: 2 }),
      events: [eventRow()],
    }],
    ["a delivery state outside its event history", {
      delivery: deliveryRow({ version: 2 }),
      events: [
        eventRow(),
        eventRow({
          sequence: 2,
          event_type: "permission_blocked",
          created_at: new Date("2026-08-02T00:01:00.000Z"),
        }),
      ],
    }],
    ["a noncontiguous answer attempt number", {
      delivery: sendingDeliveryRow({ version: 2 }),
      events: [
        eventRow(),
        eventRow({
          sequence: 2,
          event_type: "send_started",
          attempt_number: 2,
          created_at: new Date("2026-08-02T00:01:00.000Z"),
        }),
      ],
    }],
  ])("rejects an assembled receipt with %s", async (_label, rows) => {
    const repository = repositoryForRows(rows);

    await expect(findTestReceipt(repository)).rejects.toThrow(
      "answer reply persistence failed",
    );
  });
});

describe("answer reply knowledge-conflict send boundary", () => {
  it("locks and validates the receipt-bound candidate before the answer delivery", async () => {
    const order: string[] = [];
    const fixture = candidateAwareBeginDataSource(order);
    const repository = createPostgresAnswerReplyRepository({ dataSource: fixture.dataSource });

    await expect(repository.beginAnswerSend({
      deliveryId: fixture.deliveryId,
      expectedVersion: 1,
      at: new Date("2026-08-02T00:01:00.000Z"),
    })).resolves.toMatchObject({
      delivery: {
        knowledgeConflictCandidateId: "candidate-boundary",
        state: "sending",
        attemptCount: 1,
        version: 2,
      },
    });
    expect(order.indexOf("candidate")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("candidate")).toBeLessThan(order.indexOf("delivery"));
  });
});

describe("answer reply cross-group grant boundary", () => {
  it("locks grant bindings in stable order during prepare and fails before delivery persistence", async () => {
    const lockedGrantIds: string[] = [];
    const query = async (sql: string, values?: unknown[]) => {
      const normalized = sql.replaceAll(/\s+/gu, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)
        || normalized.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (normalized.includes("FROM document_sources") && normalized.includes("FOR KEY SHARE")) {
        return { rows: [{ id: values?.[0] }] };
      }
      if (normalized.includes("FROM document_source_group_grants")) {
        lockedGrantIds.push(String(values?.[0]));
        return lockedGrantIds.length === 1 ? { rows: [{ id: values?.[0] }] } : { rows: [] };
      }
      throw new Error(`unexpected query: ${normalized}`);
    };
    const repository = createPostgresAnswerReplyRepository({
      dataSource: {
        query,
        async connect() { return { query, release() {} }; },
      } as PostgresAnswerReplyDataSource,
    });
    const grants = (grantId: string, promptRank: number) => sourceTrace({
      promptRank,
      documentSourceId: `source-${grantId}`,
      documentSnapshotId: `snapshot-${grantId}`,
      fragmentId: `fragment-${grantId}`,
      sourceType: "feishu_group_document",
      sourceUri: `https://tenant.feishu.cn/docx/${grantId}`,
      crossGroupGrantId: grantId,
      crossGroupGrantVersion: 1,
      crossGroupGrantorGroupId: "chat-owner",
      crossGroupGranteeGroupId: "chat-a",
    });

    await expect(repository.prepare(prepareInput("grant-order", {
      sourceTraces: [grants("grant-z", 1), grants("grant-a", 2)],
    }))).rejects.toBeInstanceOf(AnswerReplyGrantStaleError);

    expect(lockedGrantIds).toEqual(["grant-a", "grant-z"]);
  });

  it("rejects a stale bound grant before locking or mutating the delivery at send start", async () => {
    const incomingMessageId = "incoming-stale-grant";
    const deliveryId = createAnswerReplyDeliveryId("feishu", incomingMessageId);
    const sources = [sourceTraceRow({
      id: testSourceTraceId(deliveryId, 1),
      delivery_id: deliveryId,
      document_source_id: "source-granted",
      source_type: "feishu_group_document",
      source_uri: "https://tenant.feishu.cn/docx/granted",
      cross_group_grant_id: "grant-stale",
      cross_group_grant_version: 2,
      cross_group_grantor_group_id: "chat-owner",
      cross_group_grantee_group_id: "chat-a",
    })];
    let deliveryLocked = false;
    const query = async (sql: string) => {
      const normalized = sql.replaceAll(/\s+/gu, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)
        || normalized.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (normalized.includes("FROM answer_reply_source_traces")) return { rows: sources };
      if (normalized.includes("FROM document_sources") && normalized.includes("FOR KEY SHARE")) {
        return { rows: [{ id: "source-granted" }] };
      }
      if (normalized.includes("FROM document_source_group_grants")) return { rows: [] };
      if (normalized.includes("FROM answer_reply_deliveries")
        && normalized.includes("FOR UPDATE")) {
        deliveryLocked = true;
      }
      return { rows: [] };
    };
    const repository = createPostgresAnswerReplyRepository({
      dataSource: {
        query,
        async connect() { return { query, release() {} }; },
      } as PostgresAnswerReplyDataSource,
    });

    await expect(repository.beginAnswerSend({
      deliveryId,
      expectedVersion: 1,
      at: new Date("2026-08-02T00:01:00.000Z"),
    })).rejects.toBeInstanceOf(AnswerReplyGrantStaleError);
    expect(deliveryLocked).toBe(false);
  });

  it.each([
    "updating",
    "resync_required",
    "reconciliation_required",
    "blocked",
    "retired",
  ])("rejects a managed source in %s before locking or mutating its prepared delivery", async (state) => {
    const incomingMessageId = `incoming-managed-${state}`;
    const deliveryId = createAnswerReplyDeliveryId("feishu", incomingMessageId);
    const sources = [sourceTraceRow({
      id: testSourceTraceId(deliveryId, 1),
      delivery_id: deliveryId,
      document_source_id: "source-managed",
    })];
    let deliveryLocked = false;
    const query = async (sql: string) => {
      const normalized = sql.replaceAll(/\s+/gu, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)
        || normalized.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (normalized.includes("FROM answer_reply_source_traces")) return { rows: sources };
      if (normalized.includes("FROM managed_knowledge_pages")) {
        return { rows: [{ linked_document_source_id: "source-managed", state }] };
      }
      if (normalized.includes("FROM answer_reply_deliveries")
        && normalized.includes("FOR UPDATE")) {
        deliveryLocked = true;
      }
      return { rows: [] };
    };
    const repository = createPostgresAnswerReplyRepository({
      dataSource: {
        query,
        async connect() { return { query, release() {} }; },
      } as PostgresAnswerReplyDataSource,
    });

    await expect(repository.beginAnswerSend({
      deliveryId,
      expectedVersion: 1,
      at: new Date("2026-08-02T00:01:00.000Z"),
    })).rejects.toBeInstanceOf(AnswerReplyGrantStaleError);
    expect(deliveryLocked).toBe(false);
  });
});

runIfDatabase("PostgresAnswerReplyRepository with isolated Postgres", () => {
  const schema = `answer_reply_${randomUUID().replaceAll("-", "")}`;
  let administrativePool: pg.Pool | undefined;
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    administrativePool = new pg.Pool({ connectionString: databaseUrl });
    const client = await administrativePool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally {
      client.release();
    }
    pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (administrativePool !== undefined) {
      await administrativePool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await administrativePool.end();
    }
  });

  it("prepares delivery, traces, and prepared event in one transaction", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const input = prepareInput("atomic", { sourceTraces: [sourceTrace(), sourceTrace({
      promptRank: 2,
      citationRank: 2,
      documentSourceId: "source-b",
      documentSnapshotId: "snapshot-b",
      fragmentId: "fragment-b",
      chunkIndex: 1,
      sourceType: "feishu_group_document",
      sourceUri: "https://tenant.feishu.cn/docx/document-b",
      sourceTitle: "Document B",
    })] });

    const prepared = await repository.prepare(input);

    expect(prepared.outcome).toBe("applied");
    expect(prepared.receipt.delivery).toMatchObject({
      id: createAnswerReplyDeliveryId("feishu", input.incomingMessageId),
      state: "prepared",
      preparedReplyText: "Answer body",
      renderedReplyFingerprint: renderedFingerprint,
      attemptCount: 0,
      safeNoticeAttemptCount: 0,
      version: 1,
    });
    expect(prepared.receipt.sources).toHaveLength(2);
    expect(prepared.receipt.events).toMatchObject([{
      sequence: 1,
      eventType: "prepared",
      sourceCount: 2,
      documentSourceIds: ["source-a", "source-b"],
    }]);

    const deliveryId = prepared.receipt.delivery.id;
    await expect(pool!.query(
      "SELECT COUNT(*)::integer AS count FROM answer_reply_deliveries WHERE id = $1",
      [deliveryId],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(pool!.query(
      "SELECT COUNT(*)::integer AS count FROM answer_reply_source_traces WHERE delivery_id = $1",
      [deliveryId],
    )).resolves.toMatchObject({ rows: [{ count: 2 }] });
    await expect(pool!.query(
      "SELECT COUNT(*)::integer AS count FROM answer_reply_delivery_events WHERE delivery_id = $1",
      [deliveryId],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });

    const rejectedInput = prepareInput("atomic-rollback", {
      sourceTraces: [sourceTrace(), sourceTrace({
        promptRank: 2,
        documentSourceId: "reject-atomic",
        documentSnapshotId: "snapshot-reject",
        fragmentId: "fragment-reject",
      })],
    });
    const rejectedDeliveryId = createAnswerReplyDeliveryId(
      rejectedInput.provider,
      rejectedInput.incomingMessageId,
    );
    await pool!.query(
      "ALTER TABLE answer_reply_source_traces ADD CONSTRAINT answer_reply_test_atomic_reject CHECK (document_source_id <> 'reject-atomic')",
    );
    try {
      await expect(repository.prepare(rejectedInput)).rejects.toThrow(
        "answer reply persistence failed",
      );
      await expect(pool!.query(
        "SELECT COUNT(*)::integer AS count FROM answer_reply_deliveries WHERE id = $1",
        [rejectedDeliveryId],
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(pool!.query(
        "SELECT COUNT(*)::integer AS count FROM answer_reply_source_traces WHERE delivery_id = $1",
        [rejectedDeliveryId],
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(pool!.query(
        "SELECT COUNT(*)::integer AS count FROM answer_reply_delivery_events WHERE delivery_id = $1",
        [rejectedDeliveryId],
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await pool!.query(
        "ALTER TABLE answer_reply_source_traces DROP CONSTRAINT answer_reply_test_atomic_reject",
      );
    }
  });

  it("atomically prepares a permission-blocked receipt for a denied prompt candidate", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const input = prepareInput("preflight-blocked", {
      sourceTraces: [],
      blockedDocumentSourceIds: ["source-revoked"],
    });

    const prepared = await repository.prepare(input);

    expect(prepared.outcome).toBe("applied");
    expect(prepared.receipt.delivery).toMatchObject({
      state: "permission_blocked",
      attemptCount: 0,
      version: 2,
      permissionBlockedAt: input.at,
    });
    expect(prepared.receipt.delivery.preparedReplyText).toBeUndefined();
    expect(prepared.receipt.sources).toEqual([]);
    expect(prepared.receipt.events).toMatchObject([
      {
        sequence: 1,
        eventType: "prepared",
        sourceCount: 0,
        documentSourceIds: [],
      },
      {
        sequence: 2,
        eventType: "permission_blocked",
        sourceCount: 1,
        documentSourceIds: ["source-revoked"],
      },
    ]);
  });

  it("keeps allowed traces separate while atomically blocking an external denied source", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const input = prepareInput("preflight-blocked-with-trace", {
      blockedDocumentSourceIds: ["source-revoked"],
    });

    const prepared = await repository.prepare(input);

    expect(prepared.receipt.sources).toHaveLength(1);
    expect(prepared.receipt.events).toMatchObject([
      {
        sequence: 1,
        eventType: "prepared",
        sourceCount: 1,
        documentSourceIds: ["source-a"],
      },
      {
        sequence: 2,
        eventType: "permission_blocked",
        sourceCount: 2,
        documentSourceIds: ["source-revoked"],
      },
    ]);
  });

  it("atomically upgrades an unsent semantic replay when a preflight denial arrives", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const input = prepareInput("preflight-blocked-replay");
    const first = await repository.prepare(input);
    const blockedAt = new Date("2026-08-02T01:00:00.000Z");

    const replay = await repository.prepare({
      ...input,
      renderedText: "Answer withheld by the live permission guard.",
      sourceTraces: [],
      blockedDocumentSourceIds: ["source-revoked"],
      at: blockedAt,
    });

    expect(first.receipt.delivery).toMatchObject({ state: "prepared", version: 1 });
    expect(replay.outcome).toBe("applied");
    expect(replay.receipt.delivery).toMatchObject({
      state: "permission_blocked",
      version: 2,
      attemptCount: 0,
      permissionBlockedAt: blockedAt,
      updatedAt: blockedAt,
    });
    expect(replay.receipt.delivery.preparedReplyText).toBeUndefined();
    expect(replay.receipt.sources).toEqual(first.receipt.sources);
    expect(replay.receipt.events.at(-1)).toMatchObject({
      eventType: "permission_blocked",
      sourceCount: 2,
      documentSourceIds: ["source-revoked"],
      createdAt: blockedAt,
    });
  });

  it("records a replay denial as traced evidence when it matches a persisted source", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const input = prepareInput("preflight-blocked-trace-replay");
    const first = await repository.prepare(input);
    const blockedAt = new Date("2026-08-02T01:00:00.000Z");

    const replay = await repository.prepare({
      ...input,
      renderedText: "Answer withheld by the live permission guard.",
      sourceTraces: [],
      blockedDocumentSourceIds: ["source-a"],
      at: blockedAt,
    });

    expect(replay.outcome).toBe("applied");
    expect(replay.receipt.delivery).toMatchObject({
      state: "permission_blocked",
      version: 2,
      attemptCount: 0,
      permissionBlockedAt: blockedAt,
    });
    expect(replay.receipt.sources).toEqual(first.receipt.sources);
    expect(replay.receipt.events.at(-1)).toMatchObject({
      eventType: "permission_blocked",
      sourceCount: 1,
      documentSourceIds: ["source-a"],
      createdAt: blockedAt,
    });
  });

  it("uses one traced provenance class when replay denials mix persisted and external IDs", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const input = prepareInput("preflight-blocked-mixed-replay");
    const first = await repository.prepare(input);
    const blockedAt = new Date("2026-08-02T01:00:00.000Z");
    const blockedInput = {
      ...input,
      renderedText: "Answer withheld by the live permission guard.",
      sourceTraces: [],
      blockedDocumentSourceIds: ["source-a", "source-revoked"],
      at: blockedAt,
    };

    const replay = await repository.prepare(blockedInput);
    const exactReplay = await repository.prepare({
      ...blockedInput,
      at: new Date("2026-08-02T01:01:00.000Z"),
    });

    expect(replay.outcome).toBe("applied");
    expect(replay.receipt.sources).toEqual(first.receipt.sources);
    expect(replay.receipt.events.at(-1)).toMatchObject({
      eventType: "permission_blocked",
      sourceCount: 1,
      documentSourceIds: ["source-a"],
    });
    expect(exactReplay.outcome).toBe("already_applied");
    expect(exactReplay.receipt).toEqual(replay.receipt);
  });

  it("orders replay denial evidence by the persisted prompt trace", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const input = prepareInput("preflight-blocked-trace-order", {
      sourceTraces: [sourceTrace(), sourceTrace({
        promptRank: 2,
        citationRank: 2,
        documentSourceId: "source-b",
        documentSnapshotId: "snapshot-b",
        fragmentId: "fragment-b",
        sourceUri: "https://tenant.feishu.cn/wiki/document-b",
        sourceTitle: "Document B",
        contentHash: "b".repeat(64),
      })],
    });
    await repository.prepare(input);

    const replay = await repository.prepare({
      ...input,
      renderedText: "Answer withheld by the live permission guard.",
      sourceTraces: [],
      blockedDocumentSourceIds: ["source-b", "source-a"],
      at: new Date("2026-08-02T01:00:00.000Z"),
    });

    expect(replay.receipt.events.at(-1)).toMatchObject({
      eventType: "permission_blocked",
      sourceCount: 2,
      documentSourceIds: ["source-a", "source-b"],
    });
  });

  it("rejects a replay that changes the preflight-denied source facts", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const input = prepareInput("preflight-blocked-conflict", {
      blockedDocumentSourceIds: ["source-revoked"],
    });
    await repository.prepare(input);

    await expect(repository.prepare({
      ...input,
      blockedDocumentSourceIds: ["source-other"],
      at: new Date("2026-08-02T01:00:00.000Z"),
    })).rejects.toBeInstanceOf(AnswerReplyPreparationConflictError);
  });

  it("reuses the exact preflight-denied facts without appending another event", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const input = prepareInput("preflight-blocked-exact-replay", {
      blockedDocumentSourceIds: ["source-revoked"],
    });
    const first = await repository.prepare(input);

    const replay = await repository.prepare({
      ...input,
      at: new Date("2026-08-02T01:00:00.000Z"),
    });

    expect(replay.outcome).toBe("already_applied");
    expect(replay.receipt.delivery).toEqual(first.receipt.delivery);
    expect(replay.receipt.events).toEqual(first.receipt.events);
  });

  it("treats regenerated row IDs and changed timestamps as exact semantic replay", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const input = prepareInput("replay");
    const first = await repository.prepare(input);
    const replay = await repository.prepare({
      ...input,
      at: new Date("2026-08-02T01:00:00.000Z"),
      sourceTraces: input.sourceTraces.map((trace) => ({
        ...trace,
        initialPermissionCheckedAt: new Date("2026-08-02T00:59:00.000Z"),
      })),
    });

    expect(replay.outcome).toBe("already_applied");
    expect(replay.receipt.delivery.id).toBe(first.receipt.delivery.id);
    expect(replay.receipt.delivery.createdAt).toEqual(first.receipt.delivery.createdAt);
    expect(replay.receipt.sources.map(({ id }) => id)).toEqual(
      first.receipt.sources.map(({ id }) => id),
    );
    expect(replay.receipt.events.map(({ id }) => id)).toEqual(
      first.receipt.events.map(({ id }) => id),
    );
    expect(replay.receipt.events).toHaveLength(1);
  });

  it("round-trips an exact grant binding and serializes send start against revoke", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const documentSourceId = `grant-source-${suffix}`;
    const grantorGroupId = `grant-owner-${suffix}`;
    const granteeGroupId = `grant-reader-${suffix}`;
    const snapshotId = `grant-snapshot-${suffix}`;
    const fragmentId = `grant-fragment-${suffix}`;
    const sourceUri = `https://tenant.feishu.cn/docx/${suffix}`;
    const at = new Date("2026-08-02T00:00:00.000Z");
    await pool!.query(
      `INSERT INTO document_sources (
         id, source_type, source_uri, origin_group_id, permission_state, sync_state,
         can_use_for_answering, can_use_for_knowledge_drafts, created_at, updated_at
       ) VALUES ($1, 'group_visible_document', $2, $3, 'readable', 'synced',
         TRUE, TRUE, $4, $4)`,
      [documentSourceId, sourceUri, grantorGroupId, at],
    );
    await pool!.query(
      `INSERT INTO document_snapshots (
         id, document_source_id, source_uri, fetch_status, body_text,
         content_hash, source_version, fetched_at, created_at
       ) VALUES ($1, $2, $3, 'succeeded', 'Granted body', $4, 'v1', $5, $5)`,
      [snapshotId, documentSourceId, sourceUri, "a".repeat(64), at],
    );
    await pool!.query(
      `INSERT INTO document_fragments (
         id, document_source_id, document_snapshot_id, source_uri, chunk_index,
         text, content_hash, created_at, embedding_profile_id
       ) VALUES ($1, $2, $3, $4, 0, 'Granted body', $5, $6, 'static-dev-6d')`,
      [fragmentId, documentSourceId, snapshotId, sourceUri, "b".repeat(64), at],
    );
    let createdGrantFactCount = 0;
    const grantRepository = createPostgresDocumentSourceGroupGrantRepository({
      dataSource: pool!,
      createId: () => `grant-${suffix}-${++createdGrantFactCount}`,
    });
    const granted = await grantRepository.grant({
      documentSourceId,
      grantorGroupId,
      granteeGroupId,
      expectedVersion: 0,
      operationKey: `grant-op-${suffix}`,
      actorRef: "test-operator",
      at,
    });
    const answerRepository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const input = prepareInput(`grant-race-${suffix}`, {
      chatId: granteeGroupId,
      sourceTraces: [sourceTrace({
        documentSourceId,
        documentSnapshotId: snapshotId,
        fragmentId,
        sourceType: "feishu_group_document",
        sourceUri,
        contentHash: "b".repeat(64),
        crossGroupGrantId: granted.grant.id,
        crossGroupGrantVersion: granted.grant.version,
        crossGroupGrantorGroupId: grantorGroupId,
        crossGroupGranteeGroupId: granteeGroupId,
      })],
    });
    const prepared = await answerRepository.prepare(input);
    expect(prepared.receipt.sources[0]).toMatchObject({
      crossGroupGrantId: granted.grant.id,
      crossGroupGrantVersion: 1,
      crossGroupGrantorGroupId: grantorGroupId,
      crossGroupGranteeGroupId: granteeGroupId,
    });

    const [send, revoke] = await Promise.allSettled([
      answerRepository.beginAnswerSend({
        deliveryId: prepared.receipt.delivery.id,
        expectedVersion: prepared.receipt.delivery.version,
        at: new Date("2026-08-02T00:01:00.000Z"),
      }),
      grantRepository.revoke({
        grantId: granted.grant.id,
        expectedVersion: granted.grant.version,
        operationKey: `revoke-op-${suffix}`,
        actorRef: "test-operator",
        at: new Date("2026-08-02T00:01:00.000Z"),
      }),
    ]);

    const safeSendWon = send.status === "fulfilled"
      && revoke.status === "rejected"
      && revoke.reason instanceof DocumentSourceGroupGrantConflictError;
    const safeRevokeWon = revoke.status === "fulfilled"
      && send.status === "rejected"
      && send.reason instanceof AnswerReplyGrantStaleError;
    expect(safeSendWon || safeRevokeWon).toBe(true);
  });

  it("persists the knowledge-conflict candidate as exact preparation identity", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const candidateId = `answer-candidate-${randomUUID()}`;
    const candidate = await insertKnowledgeConflictCandidateFixture(pool!, candidateId);
    const input = prepareInput(`candidate-${randomUUID()}`, {
      chatId: candidate.groupId,
      knowledgeConflictCandidateId: candidateId,
      sourceTraces: [sourceTrace({
        documentSourceId: candidate.sourceId,
        documentSnapshotId: candidate.snapshotId,
        fragmentId: candidate.fragmentId,
        sourceUri: candidate.sourceUri,
        contentHash: candidate.fragmentContentHash,
      })],
    });

    const first = await repository.prepare(input);
    expect(first.receipt.delivery.knowledgeConflictCandidateId).toBe(candidateId);
    await expect(pool!.query<{ knowledge_conflict_candidate_id: string }>(
      `SELECT knowledge_conflict_candidate_id
       FROM answer_reply_deliveries WHERE id = $1`,
      [first.receipt.delivery.id],
    )).resolves.toMatchObject({
      rows: [{ knowledge_conflict_candidate_id: candidateId }],
    });
    await expect(pool!.query<{
      delivery_id: string;
      candidate_id: string;
      candidate_version: string;
    }>(
      `SELECT delivery_id, candidate_id, candidate_version
       FROM answer_reply_knowledge_conflicts WHERE delivery_id = $1`,
      [first.receipt.delivery.id],
    )).resolves.toMatchObject({
      rows: [{ delivery_id: first.receipt.delivery.id, candidate_id: candidateId,
        candidate_version: "1" }],
    });

    await expect(repository.prepare({
      ...input,
      at: new Date(input.at.getTime() + 1_000),
    })).resolves.toMatchObject({
      outcome: "already_applied",
      receipt: { delivery: { knowledgeConflictCandidateId: candidateId } },
    });
    await expect(repository.prepare({
      ...input,
      knowledgeConflictCandidateId: `${candidateId}-different`,
    })).rejects.toBeInstanceOf(AnswerReplyPreparationConflictError);
    const { knowledgeConflictCandidateId: _removed, ...withoutCandidate } = input;
    await expect(repository.prepare(withoutCandidate))
      .rejects.toBeInstanceOf(AnswerReplyPreparationConflictError);

    await expect(repository.findByIncomingMessage({
      provider: "feishu",
      incomingMessageId: input.incomingMessageId,
    })).resolves.toMatchObject({
      delivery: { knowledgeConflictCandidateId: candidateId },
    });
    await expect(pool!.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM answer_reply_knowledge_conflicts WHERE delivery_id = $1",
      [first.receipt.delivery.id],
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("serializes a candidate-bound answer begin against dismissal", async () => {
    const candidateId = `answer-dismiss-race-${randomUUID()}`;
    const candidate = await insertKnowledgeConflictCandidateFixture(pool!, candidateId);
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const prepared = await repository.prepare(prepareInput(`answer-dismiss-race-${randomUUID()}`, {
      chatId: candidate.groupId,
      knowledgeConflictCandidateId: candidateId,
      sourceTraces: [sourceTrace({
        documentSourceId: candidate.sourceId,
        documentSnapshotId: candidate.snapshotId,
        fragmentId: candidate.fragmentId,
        sourceUri: candidate.sourceUri,
        contentHash: candidate.fragmentContentHash,
      })],
    }));
    const answerUpdated = deferred<void>();
    const releaseAnswer = deferred<void>();
    const beginRepository = createPostgresAnswerReplyRepository({
      dataSource: instrumentedAnswerDataSource(pool!, async (sql, execute) => {
        const result = await execute();
        if (sql.startsWith("UPDATE answer_reply_deliveries SET state = 'sending'")) {
          answerUpdated.resolve();
          await releaseAnswer.promise;
        }
        return result;
      }),
    });
    const dismissalPid = deferred<number>();
    const conflictRepository = createPostgresKnowledgeConflictRepository({
      dataSource: instrumentedKnowledgeDataSource(pool!, (pid) => dismissalPid.resolve(pid)),
    });

    const begin = beginRepository.beginAnswerSend({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 1,
      at: new Date("2026-08-02T00:01:00.000Z"),
    });
    await answerUpdated.promise;
    const dismissal = conflictRepository.dismissCandidate({
      candidateId,
      expectedVersion: 1,
      operationKey: `answer-dismiss-race-operation-${randomUUID()}`,
      actorType: "admin_role",
      actorRef: "knowledge-admin",
      reasonCode: "not_a_conflict",
      at: new Date("2026-08-02T00:01:00.000Z"),
    });
    try {
      await waitForPostgresLock(pool!, await dismissalPid.promise);
      releaseAnswer.resolve();
      await expect(begin).resolves.toMatchObject({ delivery: { state: "sending", version: 2 } });
      await expect(dismissal).rejects.toBeInstanceOf(KnowledgeConflictDeliveryConflictError);
    } finally {
      releaseAnswer.resolve();
      await Promise.allSettled([begin, dismissal]);
    }
    await repository.completeAnswerSend({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 2,
      at: new Date("2026-08-02T00:02:00.000Z"),
    });
  });

  it("serializes a candidate-bound answer begin against stale supersession", async () => {
    const candidateId = `answer-supersede-race-${randomUUID()}`;
    const candidate = await insertKnowledgeConflictCandidateFixture(pool!, candidateId);
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const prepared = await repository.prepare(prepareInput(`answer-supersede-race-${randomUUID()}`, {
      chatId: candidate.groupId,
      knowledgeConflictCandidateId: candidateId,
      sourceTraces: [sourceTrace({
        documentSourceId: candidate.sourceId,
        documentSnapshotId: candidate.snapshotId,
        fragmentId: candidate.fragmentId,
        sourceUri: candidate.sourceUri,
        contentHash: candidate.fragmentContentHash,
      })],
    }));
    const answerUpdated = deferred<void>();
    const releaseAnswer = deferred<void>();
    const beginRepository = createPostgresAnswerReplyRepository({
      dataSource: instrumentedAnswerDataSource(pool!, async (sql, execute) => {
        const result = await execute();
        if (sql.startsWith("UPDATE answer_reply_deliveries SET state = 'sending'")) {
          answerUpdated.resolve();
          await releaseAnswer.promise;
        }
        return result;
      }),
    });

    const begin = beginRepository.beginAnswerSend({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 1,
      at: new Date("2026-08-02T00:01:00.000Z"),
    });
    await answerUpdated.promise;
    const mutationClient = await pool!.connect();
    const mutationPid = (await mutationClient.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    )).rows[0]!.pid;
    const mutateChronology = mutationClient.query(
      "UPDATE conversation_messages SET sent_at = $2 WHERE id = $1",
      [candidate.messageId, new Date("2026-08-01T22:59:59.000Z")],
    ).finally(() => mutationClient.release());
    await waitForPostgresLock(pool!, mutationPid);
    const validationPid = deferred<number>();
    const conflictRepository = createPostgresKnowledgeConflictRepository({
      dataSource: instrumentedKnowledgeDataSource(pool!, (pid) => validationPid.resolve(pid)),
    });
    const validation = conflictRepository.validateCandidateCurrentState({
      candidateId,
      expectedVersion: 1,
      permissionAttestedAt: new Date("2026-08-02T00:01:00.000Z"),
      operationKey: `answer-supersede-race-operation-${randomUUID()}`,
      at: new Date("2026-08-02T00:01:00.000Z"),
    });
    try {
      await waitForPostgresLock(pool!, await validationPid.promise);
      releaseAnswer.resolve();
      await expect(begin).resolves.toMatchObject({ delivery: { state: "sending", version: 2 } });
      await mutateChronology;
      await expect(validation).rejects.toBeInstanceOf(KnowledgeConflictDeliveryConflictError);
    } finally {
      releaseAnswer.resolve();
      await Promise.allSettled([begin, mutateChronology, validation]);
    }
    await repository.completeAnswerSend({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 2,
      at: new Date("2026-08-02T00:02:00.000Z"),
    });
  });

  it("rejects changed rendered text or source facts as a semantic conflict", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const input = prepareInput("conflict");
    await repository.prepare(input);

    await expect(repository.prepare({ ...input, renderedText: "Changed answer body" }))
      .rejects.toBeInstanceOf(AnswerReplyPreparationConflictError);
    await expect(repository.prepare({
      ...input,
      sourceTraces: input.sourceTraces.map((trace) => ({ ...trace, citationRank: 2 })),
    })).rejects.toBeInstanceOf(AnswerReplyPreparationConflictError);
    await expect(repository.prepare({ ...input, renderedText: "Changed answer body" }))
      .rejects.toThrow("answer reply preparation conflict");
  });

  it("increments version and attempt count for each send start", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const prepared = await repository.prepare(prepareInput("send-start"));
    const first = await repository.beginAnswerSend({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 1,
      at: new Date("2026-08-02T00:01:00.000Z"),
    });
    const second = await repository.beginAnswerSend({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 2,
      at: new Date("2026-08-02T00:02:00.000Z"),
    });

    expect(first.delivery).toMatchObject({ state: "sending", attemptCount: 1, version: 2 });
    expect(second.delivery).toMatchObject({ state: "sending", attemptCount: 2, version: 3 });
    expect(second.events.map(({ sequence, eventType, attemptNumber }) => ({
      sequence,
      eventType,
      attemptNumber,
    }))).toEqual([
      { sequence: 1, eventType: "prepared", attemptNumber: undefined },
      { sequence: 2, eventType: "send_started", attemptNumber: 1 },
      { sequence: 3, eventType: "send_started", attemptNumber: 2 },
    ]);
    await expect(repository.beginAnswerSend({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 2,
      at: new Date("2026-08-02T00:03:00.000Z"),
    })).rejects.toBeInstanceOf(AnswerReplyVersionConflictError);
  });

  it("clears prepared text and retains its SHA-256 after sent", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const prepared = await repository.prepare(prepareInput("sent"));
    await repository.beginAnswerSend({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 1,
      at: new Date("2026-08-02T00:01:00.000Z"),
    });
    const sent = await repository.completeAnswerSend({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 2,
      replyMessageId: "reply-message-id",
      at: new Date("2026-08-02T00:02:00.000Z"),
    });

    expect(sent.delivery).toMatchObject({
      state: "sent",
      renderedReplyFingerprint: renderedFingerprint,
      replyMessageId: "reply-message-id",
      version: 3,
    });
    expect(sent.delivery.preparedReplyText).toBeUndefined();
    await expect(repository.completeAnswerSend({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 2,
      at: new Date("2026-08-02T00:03:00.000Z"),
    })).rejects.toBeInstanceOf(AnswerReplyVersionConflictError);
  });

  it("records permission_blocked before any send attempt", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const prepared = await repository.prepare(prepareInput("blocked"));
    const blocked = await repository.blockForPermission({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 1,
      documentSourceIds: ["source-a"],
      at: new Date("2026-08-02T00:01:00.000Z"),
    });

    expect(blocked.delivery).toMatchObject({
      state: "permission_blocked",
      attemptCount: 0,
      version: 2,
    });
    expect(blocked.delivery.preparedReplyText).toBeUndefined();
    expect(blocked.events.at(-1)).toMatchObject({
      sequence: 2,
      eventType: "permission_blocked",
      documentSourceIds: ["source-a"],
    });
  });

  it("rejects unknown permission document IDs without mutating the receipt", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const prepared = await repository.prepare(prepareInput("blocked-unknown"));

    await expect(repository.blockForPermission({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 1,
      documentSourceIds: ["Bearer credential-like-free-form-value"],
      at: new Date("2026-08-02T00:01:00.000Z"),
    })).rejects.toThrow("answer reply transition invalid");

    const after = await repository.findByIncomingMessage({
      provider: "feishu",
      incomingMessageId: prepared.receipt.delivery.incomingMessageId,
    });
    expect(after?.delivery).toMatchObject({ state: "prepared", version: 1 });
    expect(after?.delivery.preparedReplyText).toBe("Answer body");
    expect(after?.events.map(({ eventType }) => eventType)).toEqual(["prepared"]);
  });

  it("records accepted permission document IDs in immutable trace order", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const prepared = await repository.prepare(prepareInput("blocked-order", {
      sourceTraces: [sourceTrace(), sourceTrace({
        promptRank: 2,
        citationRank: 2,
        documentSourceId: "source-b",
        documentSnapshotId: "snapshot-b",
        fragmentId: "fragment-b",
      })],
    }));

    const blocked = await repository.blockForPermission({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 1,
      documentSourceIds: ["source-b", "source-a"],
      at: new Date("2026-08-02T00:01:00.000Z"),
    });

    expect(blocked.events.at(-1)?.documentSourceIds).toEqual(["source-a", "source-b"]);
  });

  it("records reconciliation_required after a send attempt began", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const prepared = await repository.prepare(prepareInput("reconciliation"));
    await repository.beginAnswerSend({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 1,
      at: new Date("2026-08-02T00:01:00.000Z"),
    });
    const blocked = await repository.blockForPermission({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 2,
      documentSourceIds: ["source-a"],
      at: new Date("2026-08-02T00:02:00.000Z"),
    });

    expect(blocked.delivery).toMatchObject({
      state: "reconciliation_required",
      attemptCount: 1,
      version: 3,
    });
    expect(blocked.delivery.preparedReplyText).toBeUndefined();
    expect(blocked.events.at(-1)?.eventType).toBe("reconciliation_required");
  });

  it("records a confirmed-not-sent terminal fact after an attempted delivery", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const prepared = await repository.prepare(prepareInput("not-sent-reconciled"));
    const sending = await repository.beginAnswerSend({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 1,
      at: new Date("2026-08-02T00:01:00.000Z"),
    });
    const reconciled = await repository.reconcileNotSent({
      deliveryId: sending.delivery.id,
      expectedVersion: 2,
      at: new Date("2026-08-02T00:02:00.000Z"),
    });

    expect(reconciled.delivery).toMatchObject({
      state: "not_sent_reconciled",
      attemptCount: 1,
      version: 3,
    });
    expect(reconciled.delivery.preparedReplyText).toBeUndefined();
    expect(reconciled.events.at(-1)).toMatchObject({
      sequence: 3,
      eventType: "not_sent_reconciled",
      documentSourceIds: ["source-a"],
    });

    const noticeStarted = await repository.beginSafeNoticeSend({
      deliveryId: reconciled.delivery.id,
      expectedVersion: 3,
      at: new Date("2026-08-02T00:03:00.000Z"),
    });
    expect(noticeStarted.delivery).toMatchObject({
      state: "not_sent_reconciled",
      safeNoticeAttemptCount: 1,
      version: 4,
    });
  });

  it("retries a safe notice without restoring blocked answer text", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const prepared = await repository.prepare(prepareInput("safe-notice"));
    const blocked = await repository.blockForPermission({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 1,
      documentSourceIds: ["source-a"],
      at: new Date("2026-08-02T00:01:00.000Z"),
    });
    const first = await repository.beginSafeNoticeSend({
      deliveryId: blocked.delivery.id,
      expectedVersion: 2,
      at: new Date("2026-08-02T00:02:00.000Z"),
    });
    const retry = await repository.beginSafeNoticeSend({
      deliveryId: blocked.delivery.id,
      expectedVersion: 3,
      at: new Date("2026-08-02T00:03:00.000Z"),
    });
    const sent = await repository.completeSafeNoticeSend({
      deliveryId: blocked.delivery.id,
      expectedVersion: 4,
      safeNoticeMessageId: "safe-notice-message-id",
      at: new Date("2026-08-02T00:04:00.000Z"),
    });

    expect(first.delivery).toMatchObject({ safeNoticeAttemptCount: 1, version: 3 });
    expect(retry.delivery).toMatchObject({ safeNoticeAttemptCount: 2, version: 4 });
    expect(sent.delivery).toMatchObject({
      state: "permission_blocked",
      safeNoticeAttemptCount: 2,
      safeNoticeMessageId: "safe-notice-message-id",
      version: 5,
    });
    expect(sent.delivery.preparedReplyText).toBeUndefined();
    expect(sent.events.slice(-3).map(({ eventType, attemptNumber }) => ({
      eventType,
      attemptNumber,
    }))).toEqual([
      { eventType: "safe_notice_send_started", attemptNumber: 1 },
      { eventType: "safe_notice_send_started", attemptNumber: 2 },
      { eventType: "safe_notice_sent", attemptNumber: undefined },
  ]);
  });

  it("prevents update, delete, and truncate of traces and events", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const prepared = await repository.prepare(prepareInput("append-only"));
    const sourceId = prepared.receipt.sources[0]!.id;
    const eventId = prepared.receipt.events[0]!.id;

    await expect(pool!.query(
      "UPDATE answer_reply_source_traces SET citation_rank = NULL WHERE id = $1",
      [sourceId],
    )).rejects.toThrow("knowledge draft history is append-only");
    await expect(pool!.query(
      "DELETE FROM answer_reply_source_traces WHERE id = $1",
      [sourceId],
    )).rejects.toThrow("knowledge draft history is append-only");
    await expect(pool!.query("TRUNCATE answer_reply_source_traces"))
      .rejects.toThrow("knowledge draft history is append-only");
    await expect(pool!.query(
      "UPDATE answer_reply_delivery_events SET source_count = 0 WHERE id = $1",
      [eventId],
    )).rejects.toThrow("knowledge draft history is append-only");
    await expect(pool!.query(
      "DELETE FROM answer_reply_delivery_events WHERE id = $1",
      [eventId],
    )).rejects.toThrow("knowledge draft history is append-only");
    await expect(pool!.query("TRUNCATE answer_reply_delivery_events"))
      .rejects.toThrow("knowledge draft history is append-only");
  });

  it.each([
    ["an oversized value hidden by a short value", ["x".repeat(1023), "y"], 2],
    ["a whitespace-only value", [" "], 1],
    ["a tab-only value", ["\t"], 1],
    ["duplicate values", ["source-a", "source-a"], 2],
    ["a multidimensional array", [["source-a"]], 1],
  ])("rejects event document source IDs containing %s", async (
    _label,
    documentSourceIds,
    sourceCount,
  ) => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const prepared = await repository.prepare(prepareInput(`event-array-${randomUUID()}`));

    await expect(pool!.query(
      `INSERT INTO answer_reply_delivery_events (
         id, delivery_id, sequence, event_type, attempt_number,
         source_count, document_source_ids, created_at
       ) VALUES ($1, $2, 2, 'sent', NULL, $3, $4, $5)`,
      [
        `invalid-event-${randomUUID()}`,
        prepared.receipt.delivery.id,
        sourceCount,
        documentSourceIds,
        new Date("2026-08-02T00:01:00.000Z"),
      ],
    )).rejects.toMatchObject({
      constraint: "answer_reply_delivery_events_document_source_ids_check",
    });
  });

  it("returns sources and events in deterministic rank and sequence order", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const prepared = await repository.prepare(prepareInput("ordering", {
      sourceTraces: [sourceTrace(), sourceTrace({
        promptRank: 2,
        citationRank: 2,
        documentSourceId: "source-b",
        documentSnapshotId: "snapshot-b",
        fragmentId: "fragment-b",
      })],
    }));
    await repository.beginAnswerSend({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 1,
      at: new Date("2026-08-02T00:01:00.000Z"),
    });
    await repository.beginAnswerSend({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 2,
      at: new Date("2026-08-02T00:02:00.000Z"),
    });
    const loaded = await repository.findByIncomingMessage({
      provider: "feishu",
      incomingMessageId: prepared.receipt.delivery.incomingMessageId,
    });

    expect(loaded?.sources.map(({ promptRank }) => promptRank)).toEqual([1, 2]);
    expect(loaded?.events.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
  });

  it("reads delivery, sources, and events from one repeatable snapshot", async () => {
    const transitionRepository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const prepared = await transitionRepository.prepare(prepareInput("coherent-snapshot"));
    const barrier = receiptReadBarrier(pool!);
    const readRepository = createPostgresAnswerReplyRepository({
      dataSource: barrier.dataSource,
    });

    const receiptPromise = readRepository.findByIncomingMessage({
      provider: "feishu",
      incomingMessageId: prepared.receipt.delivery.incomingMessageId,
    });
    await barrier.deliveryRead;
    try {
      await transitionRepository.beginAnswerSend({
        deliveryId: prepared.receipt.delivery.id,
        expectedVersion: 1,
        at: new Date("2026-08-02T00:01:00.000Z"),
      });
    } finally {
      barrier.resume();
    }

    const receipt = await receiptPromise;
    expect(receipt?.delivery.version).toBe(1);
    expect(receipt?.delivery.state).toBe("prepared");
    expect(receipt?.events.map(({ sequence }) => sequence)).toEqual([1]);
  });

  it("rejects a persisted credential-bearing source URI", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const prepared = await repository.prepare(prepareInput("persisted-credential-uri"));
    await pool!.query(
      `INSERT INTO answer_reply_source_traces (
         id, delivery_id, prompt_rank, citation_rank, document_source_id,
         document_snapshot_id, fragment_id, chunk_index, source_type,
         source_uri, source_title, content_hash, embedding_profile_id,
         initial_permission_checked_at
       ) VALUES (
         $1, $2, 2, NULL, $3, $4, $5, 1, 'feishu_wiki',
         $6, NULL, $7, $8, $9
       )`,
      [
        `corrupt-source-${randomUUID()}`,
        prepared.receipt.delivery.id,
        "corrupt-source-id",
        "corrupt-snapshot-id",
        "corrupt-fragment-id",
        "https://user:secret@tenant.feishu.cn/wiki/corrupt-document",
        "b".repeat(64),
        "embedding-profile-a",
        new Date("2026-08-02T00:00:00.000Z"),
      ],
    );

    await expect(repository.findByIncomingMessage({
      provider: "feishu",
      incomingMessageId: prepared.receipt.delivery.incomingMessageId,
    })).rejects.toThrow("answer reply persistence failed");
  });

  it("rejects a persisted delivery with a contradictory terminal timestamp", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const prepared = await repository.prepare(prepareInput("persisted-terminal-timestamp"));
    await pool!.query(
      "UPDATE answer_reply_deliveries SET sent_at = $2 WHERE id = $1",
      [prepared.receipt.delivery.id, new Date("2026-08-02T00:01:00.000Z")],
    );

    await expect(repository.findByIncomingMessage({
      provider: "feishu",
      incomingMessageId: prepared.receipt.delivery.incomingMessageId,
    })).rejects.toThrow("answer reply persistence failed");
  });

  it("rejects exact replay when the persisted rendered fingerprint is corrupt", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const input = prepareInput("persisted-rendered-fingerprint");
    const prepared = await repository.prepare(input);
    await pool!.query(
      "UPDATE answer_reply_deliveries SET rendered_reply_fingerprint = $2 WHERE id = $1",
      [prepared.receipt.delivery.id, "d".repeat(64)],
    );

    await expect(repository.prepare(input)).rejects.toMatchObject({
      name: "AnswerReplyPersistenceError",
      message: "answer reply persistence failed",
    });
  });

  it("rejects exact replay when the persisted semantic fingerprint is corrupt", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const input = prepareInput("persisted-semantic-fingerprint");
    const prepared = await repository.prepare(input);
    await pool!.query(
      "UPDATE answer_reply_deliveries SET semantic_fingerprint = $2 WHERE id = $1",
      [prepared.receipt.delivery.id, "d".repeat(64)],
    );

    await expect(repository.prepare(input)).rejects.toMatchObject({
      name: "AnswerReplyPersistenceError",
      message: "answer reply persistence failed",
    });
  });

  it("validates semantic fingerprints after sent text has been cleared", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const prepared = await repository.prepare(prepareInput("sent-semantic-fingerprint"));
    await repository.beginAnswerSend({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 1,
      at: new Date("2026-08-02T00:01:00.000Z"),
    });
    const sent = await repository.completeAnswerSend({
      deliveryId: prepared.receipt.delivery.id,
      expectedVersion: 2,
      at: new Date("2026-08-02T00:02:00.000Z"),
    });
    await pool!.query(
      "UPDATE answer_reply_deliveries SET semantic_fingerprint = $2 WHERE id = $1",
      [sent.delivery.id, "d".repeat(64)],
    );

    await expect(repository.findByIncomingMessage({
      provider: "feishu",
      incomingMessageId: sent.delivery.incomingMessageId,
    })).rejects.toMatchObject({
      name: "AnswerReplyPersistenceError",
      message: "answer reply persistence failed",
    });
    await expect(pool!.query(
      "SELECT prepared_reply_text FROM answer_reply_deliveries WHERE id = $1",
      [sent.delivery.id],
    )).resolves.toMatchObject({ rows: [{ prepared_reply_text: null }] });
  });

  const assembledCorruptionCases: Array<[
    string,
    (fixture: RawReceiptFixture) => void,
  ]> = [
    ["a nondeterministic source trace ID", (fixture) => {
      fixture.sources[0]!.id = "answer-reply-source-not-deterministic";
    }],
    ["a nondeterministic event ID", (fixture) => {
      fixture.events[0]!.id = "answer-reply-event-not-deterministic";
    }],
    ["a source prompt-rank gap", (fixture) => {
      fixture.sources[0]!.prompt_rank = 2;
      fixture.sources[0]!.id = testSourceTraceId(fixture.delivery.id as string, 2);
    }],
    ["an event sequence gap", (fixture) => {
      makeRawFixtureSending(fixture, 2);
      fixture.events.push(eventRow({
        id: testEventId(fixture.delivery.id as string, 3),
        delivery_id: fixture.delivery.id,
        sequence: 3,
        event_type: "send_started",
        attempt_number: 1,
        created_at: new Date("2026-08-02T00:01:00.000Z"),
      }));
    }],
    ["an event source-count mismatch", (fixture) => {
      fixture.events[0]!.source_count = 2;
    }],
    ["an unknown event document source ID", (fixture) => {
      fixture.events[0]!.document_source_ids = ["source-unknown"];
    }],
    ["event document source IDs outside trace order", (fixture) => {
      fixture.sources.push(sourceTraceRow({
        id: testSourceTraceId(fixture.delivery.id as string, 2),
        delivery_id: fixture.delivery.id,
        prompt_rank: 2,
        document_source_id: "source-b",
      }));
      fixture.events[0]!.source_count = 2;
      fixture.events[0]!.document_source_ids = ["source-b", "source-a"];
    }],
    ["a delivery version without its event", (fixture) => {
      fixture.delivery.version = 2;
    }],
  ];

  it.each(assembledCorruptionCases)("rejects persisted assembled corruption with %s", async (
    _label,
    corrupt,
  ) => {
    const fixture = rawReceiptFixture(`assembled-${randomUUID()}`);
    corrupt(fixture);
    await insertRawReceipt(pool!, fixture);
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });

    await expect(repository.findByIncomingMessage({
      provider: "feishu",
      incomingMessageId: fixture.incomingMessageId,
    })).rejects.toThrow("answer reply persistence failed");
  });

  it("counts unresolved answers, unsent safe notices, and reconciliation cases", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool! });
    const baseline = await repository.getStatus();

    await repository.prepare(prepareInput("status-prepared"));
    const sending = await repository.prepare(prepareInput("status-sending"));
    await repository.beginAnswerSend({
      deliveryId: sending.receipt.delivery.id,
      expectedVersion: 1,
      at: new Date("2026-08-02T00:01:00.000Z"),
    });
    const blocked = await repository.prepare(prepareInput("status-blocked"));
    await repository.blockForPermission({
      deliveryId: blocked.receipt.delivery.id,
      expectedVersion: 1,
      documentSourceIds: ["source-a"],
      at: new Date("2026-08-02T00:01:00.000Z"),
    });
    const reconciliation = await repository.prepare(prepareInput("status-reconciliation"));
    await repository.beginAnswerSend({
      deliveryId: reconciliation.receipt.delivery.id,
      expectedVersion: 1,
      at: new Date("2026-08-02T00:01:00.000Z"),
    });
    await repository.blockForPermission({
      deliveryId: reconciliation.receipt.delivery.id,
      expectedVersion: 2,
      documentSourceIds: ["source-a"],
      at: new Date("2026-08-02T00:02:00.000Z"),
    });

    await expect(repository.getStatus()).resolves.toEqual({
      unresolvedCount: baseline.unresolvedCount + 2,
      pendingSafeNoticeCount: baseline.pendingSafeNoticeCount + 2,
      reconciliationRequiredCount: baseline.reconciliationRequiredCount + 1,
    });
  });
});

function candidateAwareBeginDataSource(order: string[]): {
  dataSource: PostgresAnswerReplyDataSource;
  deliveryId: string;
} {
  const candidateId = "candidate-boundary";
  const incomingMessageId = "incoming-candidate-boundary";
  const deliveryId = createAnswerReplyDeliveryId("feishu", incomingMessageId);
  const boundaryAt = new Date("2026-08-02T00:00:00.000Z");
  let currentDelivery: Record<string, unknown> = deliveryRow({
    id: deliveryId,
    incoming_message_id: incomingMessageId,
    chat_id: "chat-a",
    reply_uuid: createAnswerReplyUuid(incomingMessageId),
    safe_notice_uuid: createAnswerReplySafeNoticeUuid(incomingMessageId),
    knowledge_conflict_candidate_id: candidateId,
  });
  const sources = [sourceTraceRow({
    id: testSourceTraceId(deliveryId, 1),
    delivery_id: deliveryId,
  })];
  currentDelivery.semantic_fingerprint = testSemanticFingerprintForRows(currentDelivery, sources);
  const events: Array<Record<string, unknown>> = [eventRow({
    id: testEventId(deliveryId, 1),
    delivery_id: deliveryId,
  })];
  let candidateLocked = false;

  const query = async (sql: string, values?: unknown[]) => {
    const normalized = sql.replaceAll(/\s+/gu, " ").trim();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)
      || normalized.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (normalized.includes("FROM answer_reply_knowledge_conflicts")) {
      return { rows: [{
        delivery_id: deliveryId,
        candidate_id: candidateId,
        candidate_version: 1,
      }] };
    }
    if (normalized.includes("FROM group_memories") && normalized.includes("FOR UPDATE")) {
      return { rows: [{ id: "memory-boundary" }] };
    }
    if (normalized.includes("FROM knowledge_conflict_candidates")
      && normalized.includes("FOR UPDATE")) {
      order.push("candidate");
      candidateLocked = true;
      return { rows: [answerCandidateRow()] };
    }
    if (normalized.includes("FROM knowledge_conflict_candidates")) {
      return { rows: [answerCandidateRow()] };
    }
    if (normalized.includes("FROM knowledge_conflict_evidence")) {
      return { rows: answerCandidateEvidenceRows() };
    }
    if (normalized.includes("FROM conversation_messages")) {
      return { rows: [{ id: "message-boundary", sent_at: boundaryAt }] };
    }
    if (normalized.includes("FROM document_sources")) {
      return { rows: [{
        id: "source-a",
        authorized_space_id: "space-boundary",
        source_type: "authorized_wiki_document",
        permission_state: "readable",
        sync_state: "synced",
        can_use_for_knowledge_drafts: true,
        updated_at: boundaryAt,
        evidence_timestamp_current: true,
        candidate_timestamp_current: true,
      }] };
    }
    if (normalized.includes("FROM knowledge_publication_target_policies")) {
      return { rows: [{ id: "policy-boundary" }] };
    }
    if (normalized.includes("FROM document_snapshots")) {
      return { rows: [{
        id: "snapshot-a",
        document_source_id: "source-a",
        fetch_status: "succeeded",
        content_hash: "a".repeat(64),
        source_version: "revision-boundary",
        fetched_at: new Date("2026-08-01T23:00:00.000Z"),
      }] };
    }
    if (normalized.includes("FROM document_fragments")) {
      return { rows: [{
        id: "fragment-a",
        document_source_id: "source-a",
        document_snapshot_id: "snapshot-a",
        content_hash: "c".repeat(64),
      }] };
    }
    if (normalized.includes("FROM answer_reply_deliveries")
      && normalized.includes("FOR UPDATE")) {
      if (!candidateLocked) throw new Error("delivery locked before candidate");
      order.push("delivery");
      expect(values).toEqual([deliveryId]);
      return { rows: [currentDelivery] };
    }
    if (normalized.startsWith("UPDATE answer_reply_deliveries")) {
      currentDelivery = {
        ...currentDelivery,
        state: "sending",
        attempt_count: 1,
        version: 2,
        updated_at: new Date("2026-08-02T00:01:00.000Z"),
        last_send_started_at: new Date("2026-08-02T00:01:00.000Z"),
      };
      return { rows: [{ id: deliveryId }] };
    }
    if (normalized.startsWith("INSERT INTO answer_reply_delivery_events")) {
      events.push(eventRow({
        id: testEventId(deliveryId, 2),
        delivery_id: deliveryId,
        sequence: 2,
        event_type: "send_started",
        attempt_number: 1,
        created_at: new Date("2026-08-02T00:01:00.000Z"),
      }));
      return { rows: [] };
    }
    if (normalized.includes("FROM answer_reply_deliveries")) {
      return { rows: [currentDelivery] };
    }
    if (normalized.includes("FROM answer_reply_source_traces")) return { rows: sources };
    if (normalized.includes("FROM answer_reply_delivery_events")) return { rows: events };
    return { rows: [] };
  };
  return {
    deliveryId,
    dataSource: {
      query,
      async connect() {
        return { query, release() {} };
      },
    } as PostgresAnswerReplyDataSource,
  };
}

function answerCandidateRow(): Record<string, unknown> {
  const boundaryAt = new Date("2026-08-02T00:00:00.000Z");
  return {
    id: "candidate-boundary",
    idempotency_key: "candidate-boundary-operation",
    group_id: "chat-a",
    group_memory_id: "memory-boundary",
    memory_updated_at: boundaryAt,
    source_message_id: "message-boundary",
    target_document_source_id: "source-a",
    target_source_updated_at: boundaryAt,
    target_source_version: "revision-boundary",
    target_snapshot_id: "snapshot-a",
    target_content_hash: "a".repeat(64),
    detector_contract_version: "v1",
    status: "pending_review",
    subject: "Boundary subject",
    knowledge_base_statement: "Old statement",
    group_conclusion_statement: "New statement",
    difference: "Material difference",
    suggested_update: "Use new statement",
    target_document_ref: "D1",
    confidence: "high",
    version: 1,
    created_at: boundaryAt,
    updated_at: boundaryAt,
  };
}

function answerCandidateEvidenceRows(): Array<Record<string, unknown>> {
  const boundaryAt = new Date("2026-08-02T00:00:00.000Z");
  return [
    { evidence_type: "conversation_message", reference_id: "C1", group_id: "chat-a",
      conversation_message_id: "message-boundary" },
    { evidence_type: "group_memory", reference_id: "M1", group_id: "chat-a",
      group_memory_id: "memory-boundary", source_updated_at: boundaryAt },
    { evidence_type: "document_source", reference_id: "D1", document_source_id: "source-a",
      source_updated_at: boundaryAt },
    { evidence_type: "document_snapshot", reference_id: "D1", document_source_id: "source-a",
      document_snapshot_id: "snapshot-a", snapshot_content_hash: "a".repeat(64),
      content_hash: "a".repeat(64) },
    { evidence_type: "document_fragment", reference_id: "D1", document_source_id: "source-a",
      document_snapshot_id: "snapshot-a", document_fragment_id: "fragment-a",
      snapshot_content_hash: "a".repeat(64), content_hash: "c".repeat(64) },
  ].map((row, index) => ({
    id: index + 1,
    candidate_id: "candidate-boundary",
    group_id: null,
    conversation_message_id: null,
    group_memory_id: null,
    source_updated_at: null,
    document_source_id: null,
    document_snapshot_id: null,
    document_fragment_id: null,
    snapshot_content_hash: null,
    content_hash: null,
    created_at: boundaryAt,
    ...row,
  }));
}

function prepareInput(
  suffix: string,
  overrides: Partial<PrepareAnswerReplyInput> = {},
): PrepareAnswerReplyInput {
  const incomingMessageId = `incoming-${suffix}`;
  return {
    provider: "feishu",
    incomingMessageId,
    chatId: "chat-a",
    replyUuid: createAnswerReplyUuid(incomingMessageId),
    safeNoticeUuid: createAnswerReplySafeNoticeUuid(incomingMessageId),
    renderedText: "Answer body",
    sourceTraces: [sourceTrace()],
    at: new Date("2026-08-02T00:00:00.000Z"),
    ...overrides,
  };
}

function sourceTrace(
  overrides: Partial<AnswerReplySourceTraceInput> = {},
): AnswerReplySourceTraceInput {
  return {
    promptRank: 1,
    citationRank: 1,
    documentSourceId: "source-a",
    documentSnapshotId: "snapshot-a",
    fragmentId: "fragment-a",
    chunkIndex: 0,
    sourceType: "feishu_wiki",
    sourceUri: "https://tenant.feishu.cn/wiki/document-a",
    sourceTitle: "Document A",
    contentHash: "a".repeat(64),
    embeddingProfileId: "embedding-profile-a",
    initialPermissionCheckedAt: new Date("2026-08-01T23:59:00.000Z"),
    ...overrides,
  };
}

function repositoryForRows(overrides: {
  delivery?: Record<string, unknown>;
  sources?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
} = {}) {
  const query = async (sql: string) => {
    if (/from answer_reply_deliveries/iu.test(sql)) {
      return { rows: [overrides.delivery ?? deliveryRow()] };
    }
    if (/from answer_reply_source_traces/iu.test(sql)) {
      return { rows: overrides.sources ?? [sourceTraceRow()] };
    }
    if (/from answer_reply_delivery_events/iu.test(sql)) {
      return { rows: overrides.events ?? [eventRow()] };
    }
    return { rows: [] };
  };
  const dataSource = {
    query,
    async connect() {
      return { query, release() {} };
    },
  } as unknown as PostgresAnswerReplyDataSource;
  return createPostgresAnswerReplyRepository({ dataSource });
}

function findTestReceipt(
  repository: ReturnType<typeof createPostgresAnswerReplyRepository>,
) {
  return repository.findByIncomingMessage({
    provider: "feishu",
    incomingMessageId: "incoming-row-test",
  });
}

function deliveryRow(overrides: Record<string, unknown> = {}) {
  const at = new Date("2026-08-02T00:00:00.000Z");
  const incomingMessageId = "incoming-row-test";
  const row = {
    id: createAnswerReplyDeliveryId("feishu", incomingMessageId),
    provider: "feishu",
    incoming_message_id: incomingMessageId,
    chat_id: "chat-a",
    reply_uuid: createAnswerReplyUuid(incomingMessageId),
    safe_notice_uuid: createAnswerReplySafeNoticeUuid(incomingMessageId),
    state: "prepared",
    prepared_reply_text: "Answer body",
    rendered_reply_fingerprint: renderedFingerprint,
    semantic_fingerprint: "",
    knowledge_conflict_candidate_id: null,
    reply_message_id: null,
    safe_notice_message_id: null,
    attempt_count: 0,
    safe_notice_attempt_count: 0,
    version: "1",
    created_at: at,
    updated_at: at,
    last_send_started_at: null,
    sent_at: null,
    permission_blocked_at: null,
    reconciliation_required_at: null,
    safe_notice_sent_at: null,
    ...overrides,
  };
  if (Object.hasOwn(overrides, "semantic_fingerprint")) {
    return row;
  }
  return {
    ...row,
    semantic_fingerprint: testSemanticFingerprintForRows(row, [sourceTraceRow({
      delivery_id: row.id,
    })]),
  };
}

function sourceTraceRow(overrides: Record<string, unknown> = {}) {
  const deliveryId = typeof overrides.delivery_id === "string"
    ? overrides.delivery_id
    : createAnswerReplyDeliveryId("feishu", "incoming-row-test");
  const promptRank = typeof overrides.prompt_rank === "number"
    ? overrides.prompt_rank
    : 1;
  return {
    id: testSourceTraceId(deliveryId, promptRank),
    delivery_id: deliveryId,
    prompt_rank: 1,
    citation_rank: 1,
    document_source_id: "source-a",
    document_snapshot_id: "snapshot-a",
    fragment_id: "fragment-a",
    chunk_index: 0,
    source_type: "feishu_wiki",
    source_uri: "https://tenant.feishu.cn/wiki/document-a",
    source_title: "Document A",
    content_hash: "c".repeat(64),
    embedding_profile_id: "embedding-profile-a",
    initial_permission_checked_at: new Date("2026-08-02T00:00:00.000Z"),
    cross_group_grant_id: null,
    cross_group_grant_version: null,
    cross_group_grantor_group_id: null,
    cross_group_grantee_group_id: null,
    ...overrides,
  };
}

function eventRow(overrides: Record<string, unknown> = {}) {
  const deliveryId = typeof overrides.delivery_id === "string"
    ? overrides.delivery_id
    : createAnswerReplyDeliveryId("feishu", "incoming-row-test");
  const sequence = typeof overrides.sequence === "number"
    ? overrides.sequence
    : 1;
  return {
    id: testEventId(deliveryId, sequence),
    delivery_id: deliveryId,
    sequence: "1",
    event_type: "prepared",
    attempt_number: null,
    source_count: 1,
    document_source_ids: ["source-a"],
    created_at: new Date("2026-08-02T00:00:00.000Z"),
    ...overrides,
  };
}

function sendingDeliveryRow(overrides: Record<string, unknown> = {}) {
  return deliveryRow({
    state: "sending",
    attempt_count: 1,
    version: 2,
    updated_at: new Date("2026-08-02T00:01:00.000Z"),
    last_send_started_at: new Date("2026-08-02T00:01:00.000Z"),
    ...overrides,
  });
}

type RawReceiptFixture = {
  incomingMessageId: string;
  delivery: Record<string, unknown>;
  sources: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
};

function rawReceiptFixture(suffix: string): RawReceiptFixture {
  const incomingMessageId = `incoming-${suffix}`;
  const deliveryId = createAnswerReplyDeliveryId("feishu", incomingMessageId);
  return {
    incomingMessageId,
    delivery: deliveryRow({
      id: deliveryId,
      incoming_message_id: incomingMessageId,
      reply_uuid: createAnswerReplyUuid(incomingMessageId),
      safe_notice_uuid: createAnswerReplySafeNoticeUuid(incomingMessageId),
    }),
    sources: [sourceTraceRow({
      id: testSourceTraceId(deliveryId, 1),
      delivery_id: deliveryId,
    })],
    events: [eventRow({
      id: testEventId(deliveryId, 1),
      delivery_id: deliveryId,
    })],
  };
}

function makeRawFixtureSending(fixture: RawReceiptFixture, version: number): void {
  fixture.delivery.state = "sending";
  fixture.delivery.attempt_count = 1;
  fixture.delivery.version = version;
  fixture.delivery.updated_at = new Date("2026-08-02T00:01:00.000Z");
  fixture.delivery.last_send_started_at = new Date("2026-08-02T00:01:00.000Z");
}

async function insertRawReceipt(pool: pg.Pool, fixture: RawReceiptFixture): Promise<void> {
  const delivery = fixture.delivery;
  await pool.query(
    `INSERT INTO answer_reply_deliveries (
       id, provider, incoming_message_id, chat_id, reply_uuid,
       safe_notice_uuid, state, prepared_reply_text,
       rendered_reply_fingerprint, semantic_fingerprint,
       knowledge_conflict_candidate_id,
       reply_message_id, safe_notice_message_id, attempt_count,
       safe_notice_attempt_count, version, created_at, updated_at,
       last_send_started_at, sent_at, permission_blocked_at,
       reconciliation_required_at, safe_notice_sent_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
     )`,
    [
      delivery.id,
      delivery.provider,
      delivery.incoming_message_id,
      delivery.chat_id,
      delivery.reply_uuid,
      delivery.safe_notice_uuid,
      delivery.state,
      delivery.prepared_reply_text,
      delivery.rendered_reply_fingerprint,
      delivery.semantic_fingerprint,
      delivery.knowledge_conflict_candidate_id,
      delivery.reply_message_id,
      delivery.safe_notice_message_id,
      delivery.attempt_count,
      delivery.safe_notice_attempt_count,
      delivery.version,
      delivery.created_at,
      delivery.updated_at,
      delivery.last_send_started_at,
      delivery.sent_at,
      delivery.permission_blocked_at,
      delivery.reconciliation_required_at,
      delivery.safe_notice_sent_at,
    ],
  );
  for (const source of fixture.sources) {
    await pool.query(
      `INSERT INTO answer_reply_source_traces (
         id, delivery_id, prompt_rank, citation_rank, document_source_id,
         document_snapshot_id, fragment_id, chunk_index, source_type,
         source_uri, source_title, content_hash, embedding_profile_id,
         initial_permission_checked_at, cross_group_grant_id,
         cross_group_grant_version, cross_group_grantor_group_id,
         cross_group_grantee_group_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18
       )`,
      [
        source.id,
        source.delivery_id,
        source.prompt_rank,
        source.citation_rank,
        source.document_source_id,
        source.document_snapshot_id,
        source.fragment_id,
        source.chunk_index,
        source.source_type,
        source.source_uri,
        source.source_title,
        source.content_hash,
        source.embedding_profile_id,
        source.initial_permission_checked_at,
        source.cross_group_grant_id ?? null,
        source.cross_group_grant_version ?? null,
        source.cross_group_grantor_group_id ?? null,
        source.cross_group_grantee_group_id ?? null,
      ],
    );
  }
  for (const event of fixture.events) {
    await pool.query(
      `INSERT INTO answer_reply_delivery_events (
         id, delivery_id, sequence, event_type, attempt_number,
         source_count, document_source_ids, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.id,
        event.delivery_id,
        event.sequence,
        event.event_type,
        event.attempt_number,
        event.source_count,
        event.document_source_ids,
        event.created_at,
      ],
    );
  }
}

function testSourceTraceId(deliveryId: string, promptRank: number): string {
  return `answer-reply-source-${testSha256(JSON.stringify([deliveryId, promptRank]))}`;
}

function testEventId(deliveryId: string, sequence: number): string {
  return `answer-reply-event-${testSha256(JSON.stringify([deliveryId, sequence]))}`;
}

function testSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function testSemanticFingerprintForRows(
  delivery: Record<string, unknown>,
  sources: Array<Record<string, unknown>>,
): string {
  return testFingerprint({
    provider: delivery.provider,
    incomingMessageId: delivery.incoming_message_id,
    chatId: delivery.chat_id,
    renderedReplyFingerprint: delivery.rendered_reply_fingerprint,
    knowledgeConflictCandidateId: delivery.knowledge_conflict_candidate_id ?? undefined,
    sourceTraces: sources.map((source) => ({
      promptRank: source.prompt_rank,
      citationRank: source.citation_rank ?? undefined,
      documentSourceId: source.document_source_id,
      documentSnapshotId: source.document_snapshot_id,
      fragmentId: source.fragment_id,
      chunkIndex: source.chunk_index,
      sourceType: source.source_type,
      sourceUri: source.source_uri,
      sourceTitle: source.source_title ?? undefined,
      contentHash: source.content_hash,
      embeddingProfileId: source.embedding_profile_id,
      crossGroupGrantId: source.cross_group_grant_id ?? undefined,
      crossGroupGrantVersion: source.cross_group_grant_version ?? undefined,
      crossGroupGrantorGroupId: source.cross_group_grantor_group_id ?? undefined,
      crossGroupGranteeGroupId: source.cross_group_grantee_group_id ?? undefined,
    })),
  });
}

async function insertKnowledgeConflictCandidateFixture(
  pool: pg.Pool,
  candidateId: string,
): Promise<{
  groupId: string;
  messageId: string;
  memoryId: string;
  sourceId: string;
  snapshotId: string;
  fragmentId: string;
  sourceUri: string;
  fragmentContentHash: string;
}> {
  const groupId = `${candidateId}-group`;
  const messageId = `${candidateId}-message`;
  const memoryId = `${candidateId}-memory`;
  const sourceId = `${candidateId}-source`;
  const snapshotId = `${candidateId}-snapshot`;
  const fragmentId = `${candidateId}-fragment`;
  const contentHash = "e".repeat(64);
  const fragmentContentHash = "f".repeat(64);
  const sourceUri = `https://tenant.feishu.cn/wiki/${candidateId}`;
  const sourceUpdatedAt = new Date("2026-08-02T00:00:00.000Z");
  const snapshotFetchedAt = new Date("2026-08-01T23:00:00.000Z");
  const messageSentAt = new Date("2026-08-02T00:00:00.000Z");
  await pool.query(
    `
    INSERT INTO conversation_messages (
      id, provider, provider_message_id, chat_id, message_type,
      sent_at, raw_event_idempotency_key, created_at
    ) VALUES ($1, 'feishu', $2, $3, 'text', $4, $5, $4)
    `,
    [messageId, `${candidateId}-provider-message`, groupId, messageSentAt,
      `${candidateId}-raw-event`],
  );
  await pool.query(
    `
    INSERT INTO group_memories (
      id, group_id, memory_scope, category, content, importance, confidence,
      status, idempotency_key, origin, created_by, request_fingerprint
    ) VALUES (
      $1, $2, 'group', 'decision', 'Current conclusion', 5, 0.95,
      'active', $3, 'system', 'iris', repeat('f', 64)
    )
    `,
    [memoryId, groupId, `${candidateId}-memory-key`],
  );
  await pool.query(
    `INSERT INTO group_memory_message_evidence (memory_id, conversation_message_id)
     VALUES ($1, $2)`,
    [memoryId, messageId],
  );
  await pool.query(
    `
    INSERT INTO document_sources (
      id, source_type, source_uri, authorized_space_id, permission_state, sync_state,
      can_use_for_answering, can_use_for_knowledge_drafts, created_at, updated_at
    ) VALUES (
      $1, 'authorized_wiki_document', $2, $3, 'readable', 'synced',
      TRUE, TRUE, $4, $4
    )
    `,
    [sourceId, sourceUri, `${candidateId}-space`, sourceUpdatedAt],
  );
  await pool.query(
    `INSERT INTO knowledge_publication_target_policies (
       id, space_id, display_name, allowed_group_ids, allowed_risk_levels,
       enabled, operation_key, operation_fingerprint, created_by, updated_by,
       created_at, updated_at
     ) VALUES ($1, $2, 'Answer candidate policy', ARRAY[$3]::text[],
       ARRAY['medium']::text[], TRUE, $4, $5, 'tester', 'tester', $6, $6)`,
    [`${candidateId}-policy`, `${candidateId}-space`, groupId,
      `${candidateId}-policy-operation`, "d".repeat(64), sourceUpdatedAt],
  );
  await pool.query(
    `
    INSERT INTO document_snapshots (
      id, document_source_id, source_uri, fetch_status, body_text,
      content_hash, source_version, fetched_at, created_at
    ) VALUES ($1, $2, $3, 'succeeded', 'Prior statement', $4, $5, $6, $6)
    `,
    [snapshotId, sourceId, sourceUri, contentHash, `${candidateId}-revision`, snapshotFetchedAt],
  );
  await pool.query(
    `INSERT INTO document_fragments (
       id, document_source_id, document_snapshot_id, source_uri, chunk_index,
       text, content_hash, created_at, embedding_profile_id
     ) VALUES ($1, $2, $3, $4, 0, 'Prior statement', $5, $6, 'static-dev-6d')`,
    [fragmentId, sourceId, snapshotId, sourceUri, fragmentContentHash, snapshotFetchedAt],
  );
  await pool.query(
    `
    INSERT INTO knowledge_conflict_candidates (
      id, idempotency_key, group_id, group_memory_id, memory_updated_at,
      source_message_id, target_document_source_id, target_source_updated_at,
      target_source_version, target_snapshot_id,
      target_content_hash, detector_contract_version, status, subject,
      knowledge_base_statement, group_conclusion_statement, difference,
      suggested_update, target_document_ref, confidence
    ) VALUES (
      $1, $2, $3, $4, (SELECT updated_at FROM group_memories WHERE id = $4),
      $5, $6, (SELECT updated_at FROM document_sources WHERE id = $6),
      $7, $8, $9, 'v1', 'pending_review', 'Subject', 'Prior statement',
      'Current conclusion', 'Difference', 'Suggested update', 'D1', 'high'
    )
    `,
    [
      candidateId,
      `${candidateId}-key`,
      groupId,
      memoryId,
      messageId,
      sourceId,
      `${candidateId}-revision`,
      snapshotId,
      contentHash,
    ],
  );
  await pool.query(
    `INSERT INTO knowledge_conflict_evidence (
       candidate_id, evidence_type, reference_id, group_id, conversation_message_id,
       group_memory_id, source_updated_at, document_source_id, document_snapshot_id,
       document_fragment_id, snapshot_content_hash, content_hash, created_at
     ) VALUES
       ($1, 'conversation_message', 'C1', $2, $3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, $4),
       ($1, 'group_memory', 'M1', $2, NULL, $5,
         (SELECT updated_at FROM group_memories WHERE id = $5), NULL, NULL, NULL, NULL, NULL, $4),
       ($1, 'document_source', 'D1', NULL, NULL, NULL, $6, $7, NULL, NULL, NULL, NULL, $4),
       ($1, 'document_snapshot', 'D1', NULL, NULL, NULL, NULL, $7, $8, NULL, $9, $9, $4),
       ($1, 'document_fragment', 'D1', NULL, NULL, NULL, NULL, $7, $8, $10, $9, $11, $4)`,
    [candidateId, groupId, messageId, sourceUpdatedAt, memoryId, sourceUpdatedAt,
      sourceId, snapshotId, contentHash, fragmentId, fragmentContentHash],
  );
  return { groupId, messageId, memoryId, sourceId, snapshotId, fragmentId, sourceUri,
    fragmentContentHash };
}

function testFingerprint(value: unknown): string {
  return testSha256(JSON.stringify(testCanonicalizeFingerprintValue(value)));
}

function testCanonicalizeFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(testCanonicalizeFingerprintValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, testCanonicalizeFingerprintValue(item)]),
    );
  }
  return value;
}

function receiptReadBarrier(pool: pg.Pool): {
  dataSource: PostgresAnswerReplyDataSource;
  deliveryRead: Promise<void>;
  resume(): void;
} {
  let markDeliveryRead: (() => void) | undefined;
  let resumeRead: (() => void) | undefined;
  let intercepted = false;
  const deliveryRead = new Promise<void>((resolve) => {
    markDeliveryRead = resolve;
  });
  const resumePromise = new Promise<void>((resolve) => {
    resumeRead = resolve;
  });
  const queryWithBarrier = async (
    sql: string,
    execute: () => Promise<{ rows: Array<Record<string, unknown>> }>,
  ) => {
    const result = await execute();
    if (
      !intercepted
      && /from answer_reply_deliveries/iu.test(sql)
      && /where provider = \$1 and incoming_message_id = \$2/iu.test(sql)
      && !/for update/iu.test(sql)
    ) {
      intercepted = true;
      markDeliveryRead?.();
      await resumePromise;
    }
    return result;
  };
  const dataSource = {
    query(sql: string, values?: unknown[]) {
      return queryWithBarrier(sql, () => pool.query(sql, values));
    },
    async connect() {
      const client = await pool.connect();
      return {
        query(sql: string, values?: unknown[]) {
          return queryWithBarrier(sql, () => client.query(sql, values));
        },
        release() {
          client.release();
        },
      };
    },
  } as unknown as PostgresAnswerReplyDataSource;
  return {
    dataSource,
    deliveryRead,
    resume() {
      resumeRead?.();
    },
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value?: T) {
      resolvePromise?.(value as T);
    },
  };
}

function instrumentedAnswerDataSource(
  pool: pg.Pool,
  intercept: (
    normalizedSql: string,
    execute: () => Promise<{ rows: Array<Record<string, unknown>> }>,
  ) => Promise<{ rows: Array<Record<string, unknown>> }>,
): PostgresAnswerReplyDataSource {
  return {
    query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      values?: unknown[],
    ) {
      return pool.query<T>(sql, values);
    },
    async connect() {
      const client = await pool.connect();
      return {
        async query<T extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          values?: unknown[],
        ) {
          const normalizedSql = sql.replace(/\s+/gu, " ").trim();
          return await intercept(
            normalizedSql,
            () => client.query(sql, values),
          ) as { rows: T[] };
        },
        release() {
          client.release();
        },
      };
    },
  };
}

function instrumentedKnowledgeDataSource(
  pool: pg.Pool,
  onConnect: (pid: number) => void,
): PostgresKnowledgeConflictDataSource {
  return {
    query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      values?: unknown[],
    ) {
      return pool.query<T>(sql, values);
    },
    async connect() {
      const client = await pool.connect();
      const pid = (await client.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      )).rows[0]!.pid;
      onConnect(pid);
      return {
        query<T extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          values?: unknown[],
        ) {
          return client.query<T>(sql, values);
        },
        release() {
          client.release();
        },
      };
    },
  };
}

async function waitForPostgresLock(pool: pg.Pool, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const activity = await pool.query<{ wait_event_type: string | null }>(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (activity.rows[0]?.wait_event_type === "Lock") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PostgreSQL backend ${pid} did not wait on a lock`);
}
