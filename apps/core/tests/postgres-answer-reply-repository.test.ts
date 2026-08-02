import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AnswerReplySourceTraceInput } from "../src/answer-replies/answer-source-citation-renderer.js";
import {
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
  return {
    id: createAnswerReplyDeliveryId("feishu", incomingMessageId),
    provider: "feishu",
    incoming_message_id: incomingMessageId,
    chat_id: "chat-a",
    reply_uuid: createAnswerReplyUuid(incomingMessageId),
    safe_notice_uuid: createAnswerReplySafeNoticeUuid(incomingMessageId),
    state: "prepared",
    prepared_reply_text: "Answer body",
    rendered_reply_fingerprint: "a".repeat(64),
    semantic_fingerprint: "b".repeat(64),
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
       reply_message_id, safe_notice_message_id, attempt_count,
       safe_notice_attempt_count, version, created_at, updated_at,
       last_send_started_at, sent_at, permission_blocked_at,
       reconciliation_required_at, safe_notice_sent_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
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
         initial_permission_checked_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
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
