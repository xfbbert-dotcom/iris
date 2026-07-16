import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresConversationStateInspectionStore } from "../src/conversation-state/conversation-state-api.js";
import { createConversationStateContextProvider } from "../src/conversation-state/conversation-state-context-provider.js";
import { createConversationStateProjector } from "../src/conversation-state/conversation-state-projector.js";
import { createPostgresConversationStateRepository } from "../src/conversation-state/postgres-conversation-state-repository.js";
import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";
import { createGroupMemoryService } from "../src/memory/group-memory-service.js";
import { createPostgresGroupMemoryRepository } from "../src/memory/postgres-group-memory-repository.js";
import { createPostgresMemoryExtractionRepository } from "../src/memory-extraction/postgres-memory-extraction-repository.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;

runIfDatabase("physical conversation evidence deletion with Postgres", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("physically removes evidence and prevents state, memory, replay, or repair resurrection", async () => {
    const suffix = randomUUID();
    const groupId = `privacy-group-${suffix}`;
    const messageId = `feishu:privacy-message-${suffix}`;
    const providerMessageId = `privacy-message-${suffix}`;
    const threadId = `privacy-thread-${suffix}`;
    const actionId = `privacy-action-${suffix}`;
    const secret = `sensitive phrase ${suffix}`;
    const timestamp = new Date("2026-07-17T00:00:00.000Z");
    const stateRepository = createPostgresConversationStateRepository({ dataSource: pool });
    const memoryRepository = createPostgresGroupMemoryRepository({ dataSource: pool });
    const memoryService = createGroupMemoryService({ repository: memoryRepository });
    const projector = createConversationStateProjector({
      repository: stateRepository,
      memories: memoryService,
    });
    const extractionRepository = createPostgresMemoryExtractionRepository({ dataSource: pool });
    const inspectionStore = createPostgresConversationStateInspectionStore({ dataSource: pool });
    const contextProvider = createConversationStateContextProvider({ dataSource: pool });

    await pool.query(
      `
      INSERT INTO conversation_messages (
        id, provider, provider_message_id, chat_id, sender_id, sender_open_id,
        message_type, text, sent_at, raw_event_idempotency_key, created_at
      ) VALUES ($1, 'feishu', $2, $3, 'ou_privacy', 'ou_privacy',
        'text', $4, $5, $6, $5)
      `,
      [messageId, providerMessageId, groupId, secret, timestamp, `event-${suffix}`],
    );
    const threadOperation = {
      kind: "create" as const,
      operationKey: `privacy-thread-create-${suffix}`,
      thread: {
        id: threadId,
        groupId,
        title: secret,
        summary: secret,
        status: "open" as const,
        confidence: 0.95,
        version: 1,
        firstEvidenceAt: timestamp,
        lastActivityAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      threadEvent: {
        id: `privacy-thread-event-${suffix}`,
        threadId,
        groupId,
        eventType: "created" as const,
        toVersion: 1,
        operationKey: `privacy-thread-create-${suffix}`,
        createdAt: timestamp,
      },
      evidenceMessageIds: [messageId],
    };
    const actionOperation = {
      kind: "create" as const,
      operationKey: `privacy-action-create-${suffix}`,
      action: {
        id: actionId,
        groupId,
        threadId,
        description: secret,
        ownerRefType: "feishu_user" as const,
        ownerRef: "ou_privacy",
        status: "open" as const,
        confidence: 0.95,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      actionEvent: {
        id: `privacy-action-event-${suffix}`,
        actionItemId: actionId,
        groupId,
        eventType: "created" as const,
        toVersion: 1,
        operationKey: `privacy-action-create-${suffix}`,
        createdAt: timestamp,
      },
      evidenceMessageIds: [messageId],
    };
    await stateRepository.applyOperations({
      groupId,
      operations: [threadOperation, actionOperation],
    });
    await projector.processBatch({ limit: 100, now: new Date(Date.now() + 60_000) });
    const projectedBefore = await memoryRepository.listActiveByGroup({ groupId, limit: 8 });
    expect(projectedBefore).toHaveLength(2);

    const registered = await extractionRepository.registerRequest({
      groupId,
      conversationMessageId: messageId,
      providerMessageId,
    });
    const claimed = await extractionRepository.claimRun({
      requestIds: [registered.request.id],
      maxEvidenceMessages: 1,
      contextMessageLimit: 0,
      activeMemoryLimit: 8,
      enabledOperationFamilies: ["memory", "thread", "action"],
    });
    expect(claimed).toBeDefined();

    const deletion = await (inspectionStore as any).deleteMessageEvidence({
      groupId,
      messageId,
      operatorHint: "privacy-reviewer",
    });

    expect(deletion).toEqual({
      status: "deleted",
      affectedThreadCount: 1,
      affectedActionCount: 1,
      deletedMemoryCount: 2,
    });
    await expect(pool.query("SELECT id FROM conversation_messages WHERE id = $1", [messageId]))
      .resolves.toMatchObject({ rows: [] });
    await expect(pool.query(
      "SELECT retrieval_state, title, summary, version FROM discussion_threads WHERE id = $1",
      [threadId],
    )).resolves.toMatchObject({
      rows: [{
        retrieval_state: "invalidated",
        title: "[evidence deleted]",
        summary: "[evidence deleted]",
        version: "2",
      }],
    });
    await expect(pool.query(
      "SELECT retrieval_state, description, owner_ref, version FROM action_items WHERE id = $1",
      [actionId],
    )).resolves.toMatchObject({
      rows: [{
        retrieval_state: "invalidated",
        description: "[evidence deleted]",
        owner_ref: "[evidence deleted]",
        version: "2",
      }],
    });
    await expect(stateRepository.listRelevantThreads({ groupId, limit: 8 })).resolves.toEqual([]);
    await expect(stateRepository.listRelevantActions({ groupId, limit: 8 })).resolves.toEqual([]);
    await expect(contextProvider.loadRelevant({ groupId, queryText: secret, limit: 6 }))
      .resolves.toEqual({ threads: [], actions: [] });
    await expect(inspectionStore.listThreads({ groupId, limit: 8 })).resolves.toEqual([]);
    await expect(inspectionStore.listActions({ groupId, limit: 8 })).resolves.toEqual([]);
    await expect(memoryRepository.listActiveByGroup({ groupId, limit: 8 })).resolves.toEqual([]);
    for (const memory of projectedBefore) {
      await expect(memoryRepository.getById(memory.id)).resolves.toBeUndefined();
    }
    await expect(extractionRepository.loadRunInput(claimed!.id)).resolves.toEqual({
      status: "completed",
    });

    await projector.processBatch({ limit: 100, now: new Date(Date.now() + 120_000) });
    await expect(memoryRepository.listActiveByGroup({ groupId, limit: 8 })).resolves.toEqual([]);
    await expect(stateRepository.applyOperations({
      groupId,
      operations: [threadOperation, actionOperation],
    })).resolves.toEqual({ status: "already_applied", threadIds: [], actionItemIds: [] });
    await expect((inspectionStore as any).deleteMessageEvidence({
      groupId,
      messageId,
      operatorHint: "privacy-reviewer",
    })).resolves.toEqual({
      status: "already_deleted",
      affectedThreadCount: 0,
      affectedActionCount: 0,
      deletedMemoryCount: 0,
    });

    const tombstone = await pool.query<Record<string, unknown>>(
      `
      SELECT provider, provider_message_id, conversation_message_id, chat_id,
        to_jsonb(tombstone)::text AS persisted_json
      FROM conversation_message_deletion_tombstones tombstone
      WHERE provider = 'feishu' AND provider_message_id = $1
      `,
      [providerMessageId],
    );
    expect(tombstone.rows).toMatchObject([{
      provider: "feishu",
      provider_message_id: providerMessageId,
      conversation_message_id: messageId,
      chat_id: groupId,
    }]);
    expect(tombstone.rows[0]?.persisted_json).not.toContain(secret);
    expect(tombstone.rows[0]?.persisted_json).not.toContain("privacy-reviewer");

    await expect(inspectionStore.listThreadEvents({ threadId, limit: 10 })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "evidence_deleted", evidenceMessageIds: [] }),
      ]),
    );
    await expect(inspectionStore.listActionEvents({ actionItemId: actionId, limit: 10 }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: "evidence_deleted", evidenceMessageIds: [] }),
      ]));
    const leakedContent = await pool.query<{ count: number }>(
      `
      SELECT COUNT(*)::int AS count
      FROM group_memories
      WHERE group_id = $1 AND strpos(content, $2) > 0
      `,
      [groupId, secret],
    );
    expect(leakedContent.rows).toEqual([{ count: 0 }]);
  });
});
