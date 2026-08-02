import { randomUUID } from "node:crypto";

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
import { createPostgresAnswerReplyRepository } from "../src/answer-replies/postgres-answer-reply-repository.js";
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
