import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";
import { createPostgresMemoryExtractionRepository } from "../src/memory-extraction/postgres-memory-extraction-repository.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;

runIfDatabase("PostgresMemoryExtractionRepository with Postgres", () => {
  let pool: pg.Pool | undefined;
  const suffix = randomUUID();
  const groupA = `extraction-group-a-${suffix}`;
  const groupB = `extraction-group-b-${suffix}`;
  const groupIds = [groupA, groupB];
  const contextIds = Array.from(
    { length: 12 },
    (_, index) => `feishu:extraction-context-${index.toString().padStart(2, "0")}-${suffix}`,
  );
  const evidenceIds = Array.from(
    { length: 42 },
    (_, index) => `feishu:extraction-evidence-${index.toString().padStart(2, "0")}-${suffix}`,
  );
  const otherGroupMessageId = `feishu:extraction-other-${suffix}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally {
      client.release();
    }

    for (const [index, id] of [...contextIds, ...evidenceIds].entries()) {
      const isContext = index < contextIds.length;
      const sequence = index + 1;
      await pool.query(
        `
        INSERT INTO conversation_messages (
          id, provider, provider_message_id, chat_id, sender_id,
          message_type, text, sent_at, raw_event_idempotency_key, created_at
        )
        VALUES ($1, 'feishu', $2, $3, $4, 'text', $5, $6, $7, $8)
        `,
        [
          id,
          `provider-${id}`,
          groupA,
          sequence % 2 === 0 ? "alice" : "bob",
          `${isContext ? "Context" : "Evidence"} ${sequence}`,
          new Date(Date.UTC(2026, 6, 14, 0, sequence)),
          `event-${id}`,
          new Date(Date.UTC(2026, 6, 14, 0, sequence)),
        ],
      );
    }

    await pool.query(
      `
      INSERT INTO conversation_messages (
        id, provider, provider_message_id, chat_id, sender_id,
        message_type, text, sent_at, raw_event_idempotency_key, created_at
      )
      VALUES ($1, 'feishu', $2, $3, 'carol', 'text', 'Other group', $4, $5, $4)
      `,
      [
        otherGroupMessageId,
        `provider-${otherGroupMessageId}`,
        groupB,
        new Date("2026-07-14T00:30:00.000Z"),
        `event-${otherGroupMessageId}`,
      ],
    );

    for (let index = 0; index < 10; index += 1) {
      await pool.query(
        `
        INSERT INTO group_memories (
          id, group_id, memory_scope, category, content, importance, confidence,
          status, idempotency_key, origin, created_by, request_fingerprint, updated_at
        )
        VALUES ($1, $2, 'group', 'decision', $3, $4, 0.9,
          'active', $5, 'operator', 'test', $6, $7)
        `,
        [
          `extraction-memory-${index.toString().padStart(2, "0")}-${suffix}`,
          groupA,
          `Memory ${index}`,
          (index % 5) + 1,
          `extraction-memory-key-${index}-${suffix}`,
          "0".repeat(64),
          new Date(Date.UTC(2026, 6, 14, 2, index)),
        ],
      );
    }
  });

  afterAll(async () => {
    if (pool === undefined) {
      return;
    }
    try {
      await pool.query(
        "DELETE FROM group_memory_extraction_requests WHERE group_id = ANY($1::text[])",
        [groupIds],
      );
      await pool.query(
        "DELETE FROM group_memory_extraction_runs WHERE group_id = ANY($1::text[])",
        [groupIds],
      );
      await pool.query("DELETE FROM group_memories WHERE group_id = ANY($1::text[])", [
        groupIds,
      ]);
      await pool.query("DELETE FROM conversation_messages WHERE chat_id = ANY($1::text[])", [
        groupIds,
      ]);
    } finally {
      await pool.end();
    }
  });

  it("registers one durable request for a repeated provider message", async () => {
    const repository = createRepository(pool);
    const input = {
      groupId: groupA,
      conversationMessageId: evidenceIds[1]!,
      providerMessageId: `provider-${evidenceIds[1]}`,
    };

    const first = await repository.registerRequest(input);
    const replay = await repository.registerRequest(input);

    expect(first).toMatchObject({
      created: true,
      request: {
        groupId: groupA,
        conversationMessageId: evidenceIds[1],
        providerMessageId: input.providerMessageId,
        status: "pending",
      },
    });
    expect(replay).toMatchObject({ created: false, request: { id: first.request.id } });
    await expect(
      pool!.query(
        "SELECT count(*)::int AS count FROM group_memory_extraction_requests WHERE provider_message_id = $1",
        [input.providerMessageId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("fails closed when registration metadata disagrees with the message fact", async () => {
    const repository = createRepository(pool);

    await expect(
      repository.registerRequest({
        groupId: groupB,
        conversationMessageId: evidenceIds[2]!,
        providerMessageId: `provider-${evidenceIds[2]}`,
      }),
    ).rejects.toThrow("conversation message does not match extraction request");
  });

  it("claims a bounded cursor-ordered run without crossing groups", async () => {
    const repository = createRepository(pool);
    const registrationOrder = [...evidenceIds].reverse();
    let seedRequestId = "";
    for (const messageId of registrationOrder) {
      const registered = await repository.registerRequest({
        groupId: groupA,
        conversationMessageId: messageId,
        providerMessageId: `provider-${messageId}`,
      });
      if (messageId === evidenceIds[41]) {
        seedRequestId = registered.request.id;
      }
    }
    const other = await repository.registerRequest({
      groupId: groupB,
      conversationMessageId: otherGroupMessageId,
      providerMessageId: `provider-${otherGroupMessageId}`,
    });

    const run = await repository.claimRun({
      seedRequestId,
      maxEvidenceMessages: 400,
      contextMessageLimit: 100,
      activeMemoryLimit: 80,
    });

    expect(run).toBeDefined();
    expect(run!.groupId).toBe(groupA);
    expect(run!.inputFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(run!.evidenceMessages.map((message) => message.id)).toEqual(
      evidenceIds.slice(0, 40),
    );
    expect(run!.evidenceMessages.every((message) => message.evidenceEligible)).toBe(true);
    expect(run!.contextMessages.map((message) => message.id)).toEqual(contextIds.slice(2));
    expect(run!.contextMessages.every((message) => !message.evidenceEligible)).toBe(true);
    expect(run!.existingMemories).toHaveLength(8);
    expect(new Set([
      ...run!.evidenceMessages.map((message) => message.id),
      ...run!.contextMessages.map((message) => message.id),
    ]).size).toBe(50);
    expect(run!.evidenceMessages.some((message) => message.groupId !== groupA)).toBe(false);
    expect(run!.contextMessages.some((message) => message.groupId !== groupA)).toBe(false);

    const otherRun = await repository.claimRun({
      seedRequestId: other.request.id,
      maxEvidenceMessages: 40,
      contextMessageLimit: 10,
      activeMemoryLimit: 8,
    });
    expect(otherRun).toMatchObject({
      groupId: groupB,
      evidenceMessages: [{ id: otherGroupMessageId }],
    });
  });

  it("reloads unchanged facts and rejects a changed fingerprint as stale", async () => {
    const repository = createRepository(pool);
    const pending = await repository.claimRun({
      seedRequestId: (
        await repository.registerRequest({
          groupId: groupA,
          conversationMessageId: evidenceIds[40]!,
          providerMessageId: `provider-${evidenceIds[40]}`,
        })
      ).request.id,
      maxEvidenceMessages: 1,
      contextMessageLimit: 0,
      activeMemoryLimit: 0,
    });

    expect(pending).toBeDefined();
    await expect(repository.loadRunInput(pending!.id)).resolves.toMatchObject({
      status: "ready",
      run: { inputFingerprint: pending!.inputFingerprint },
    });

    await pool!.query("UPDATE conversation_messages SET text = text || ' changed' WHERE id = $1", [
      pending!.evidenceMessages[0]!.id,
    ]);

    await expect(repository.loadRunInput(pending!.id)).resolves.toEqual({
      status: "stale",
      groupId: groupA,
      requestIds: pending!.requestIds,
    });
  });

  it("skips and fails runs with bounded status counts", async () => {
    const repository = createRepository(pool);
    const remainingRequest = await repository.registerRequest({
      groupId: groupA,
      conversationMessageId: evidenceIds[41]!,
      providerMessageId: `provider-${evidenceIds[41]}`,
    });
    await repository.skipRequest({ requestId: remainingRequest.request.id, reason: "policy_denied" });

    const processingResult = await pool!.query<{ id: string }>(
      `SELECT id FROM group_memory_extraction_runs WHERE group_id = $1 AND status = 'processing' ORDER BY created_at ASC LIMIT 1`,
      [groupA],
    );
    const processingRunId = processingResult.rows[0]!.id;
    await repository.failRun({ runId: processingRunId, classification: "provider_timeout" });

    const otherProcessingResult = await pool!.query<{ id: string }>(
      `SELECT id FROM group_memory_extraction_runs WHERE group_id = $1 AND status = 'processing' ORDER BY created_at ASC LIMIT 1`,
      [groupB],
    );
    const completedRunId = otherProcessingResult.rows[0]!.id;
    await repository.skipRun({ runId: completedRunId, reason: "runtime_disabled_before_apply" });

    await expect(repository.loadRunInput(completedRunId)).resolves.toEqual({
      status: "completed",
    });
    await expect(repository.getStatusCounts()).resolves.toMatchObject({
      skipped: expect.any(Number),
      failedRuns: expect.any(Number),
    });
    const counts = await repository.getStatusCounts();
    expect(counts.skipped).toBeGreaterThanOrEqual(2);
    expect(counts.failedRuns).toBeGreaterThanOrEqual(1);
  });
});

function createRepository(pool: pg.Pool | undefined) {
  if (pool === undefined) {
    throw new Error("Expected Postgres pool to be initialized");
  }
  return createPostgresMemoryExtractionRepository({ dataSource: pool });
}
