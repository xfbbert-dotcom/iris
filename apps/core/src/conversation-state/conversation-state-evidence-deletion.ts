import { createHash, randomUUID } from "node:crypto";

import { lockGroupMemoryWriteScope } from "../memory/postgres-group-memory-writer.js";
import { lockConversationMessageIngestScope } from "../conversation/conversation-message-replay-guard.js";
import {
  lockConversationStateWriteScope,
  type PostgresConversationStateDataSource,
  type TransactionClient,
} from "./postgres-conversation-state-repository.js";

const MAX_IDENTIFIER_CHARS = 512;
const REDACTED_CONTENT = "[evidence deleted]";

export type ConversationMessageEvidenceDeletionResult =
  | { status: "not_found" }
  | {
      status: "deleted" | "already_deleted";
      affectedThreadCount: number;
      affectedActionCount: number;
      deletedMemoryCount: number;
    };

type VersionRow = { id: unknown; version: unknown };
type IdRow = { id: unknown };
type MessageIdentityRow = {
  id: unknown;
  provider: unknown;
  provider_message_id: unknown;
};
type RunIdRow = { run_id: unknown };

export async function deleteConversationMessageEvidence(input: {
  dataSource: PostgresConversationStateDataSource;
  groupId: string;
  messageId: string;
  operatorHint: string;
}): Promise<ConversationMessageEvidenceDeletionResult> {
  const groupId = requireIdentifier("groupId", input.groupId);
  const messageId = requireIdentifier("messageId", input.messageId);
  requireIdentifier("operatorHint", input.operatorHint);

  return withTransaction(input.dataSource, async (client) => {
    await lockConversationMessageIngestScope({ queryable: client, conversationMessageId: messageId });
    const tombstone = await client.query(
      `
      SELECT 1
      FROM conversation_message_deletion_tombstones
      WHERE conversation_message_id = $1 AND chat_id = $2
      `,
      [messageId, groupId],
    );
    if (tombstone.rows.length > 0) {
      return {
        status: "already_deleted",
        affectedThreadCount: 0,
        affectedActionCount: 0,
        deletedMemoryCount: 0,
      };
    }
    await lockGroupMemoryWriteScope({ queryable: client as never, groupId });
    await lockConversationStateWriteScope({ queryable: client, groupId });
    const message = await client.query<MessageIdentityRow>(
      `
      SELECT id, provider, provider_message_id
      FROM conversation_messages
      WHERE id = $1 AND chat_id = $2
      FOR UPDATE
      `,
      [messageId, groupId],
    );
    if (message.rows.length === 0) {
      return { status: "not_found" };
    }
    if (message.rows.length !== 1) {
      throw new Error("conversation message lookup returned multiple rows");
    }
    const provider = requireIdentifier("message provider", message.rows[0]!.provider);
    const providerMessageId = requireIdentifier(
      "provider message id",
      message.rows[0]!.provider_message_id,
    );
    const insertedTombstone = await client.query(
      `
      INSERT INTO conversation_message_deletion_tombstones (
        provider, provider_message_id, conversation_message_id, chat_id
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
      RETURNING conversation_message_id
      `,
      [provider, providerMessageId, messageId, groupId],
    );
    if (insertedTombstone.rows.length !== 1) {
      throw new Error("conversation message deletion tombstone conflict");
    }

    const threadResult = await client.query<VersionRow>(
      `
      SELECT thread.id, thread.version
      FROM discussion_threads thread
      WHERE thread.group_id = $1
        AND (
          EXISTS (
            SELECT 1 FROM discussion_thread_evidence evidence
            WHERE evidence.thread_id = thread.id
              AND evidence.group_id = thread.group_id
              AND evidence.conversation_message_id = $2
          )
          OR EXISTS (
            SELECT 1
            FROM discussion_thread_events event
            JOIN discussion_thread_event_evidence evidence
              ON evidence.event_id = event.id
             AND evidence.group_id = event.group_id
            WHERE event.thread_id = thread.id
              AND event.group_id = thread.group_id
              AND evidence.conversation_message_id = $2
          )
        )
      ORDER BY thread.id ASC
      FOR UPDATE
      `,
      [groupId, messageId],
    );
    const threads = threadResult.rows.map(mapVersionRow);
    const threadIds = threads.map((thread) => thread.id);

    const actionResult = await client.query<VersionRow>(
      `
      SELECT action.id, action.version
      FROM action_items action
      WHERE action.group_id = $1
        AND (
          action.thread_id = ANY($3::text[])
          OR EXISTS (
            SELECT 1
            FROM action_item_events event
            JOIN action_item_event_evidence evidence
              ON evidence.event_id = event.id
             AND evidence.group_id = event.group_id
            WHERE event.action_item_id = action.id
              AND event.group_id = action.group_id
              AND evidence.conversation_message_id = $2
          )
        )
      ORDER BY action.id ASC
      FOR UPDATE
      `,
      [groupId, messageId, threadIds],
    );
    const actions = actionResult.rows.map(mapVersionRow);
    const actionIds = actions.map((action) => action.id);

    const memoryResult = await client.query<IdRow>(
      `
      SELECT memory.id
      FROM group_memories memory
      WHERE EXISTS (
          SELECT 1
          FROM group_memory_message_evidence evidence
          WHERE evidence.memory_id = memory.id
            AND evidence.conversation_message_id = $2
        )
        OR (
          memory.group_id = $1
          AND EXISTS (
            SELECT 1
            FROM conversation_state_memory_projections projection
            WHERE projection.memory_id = memory.id
              AND projection.group_id = memory.group_id
              AND (
                (projection.entity_type = 'thread' AND projection.entity_id = ANY($3::text[]))
                OR (projection.entity_type = 'action' AND projection.entity_id = ANY($4::text[]))
              )
          )
        )
      ORDER BY memory.id ASC
      FOR UPDATE
      `,
      [groupId, messageId, threadIds, actionIds],
    );
    const memoryIds = memoryResult.rows.map((row) => requireIdentifier("memory id", row.id));

    const impactedRuns = await client.query<RunIdRow>(
      `
      SELECT run_id
      FROM (
        SELECT request.run_id
        FROM group_memory_extraction_requests request
        WHERE request.conversation_message_id = $1
        UNION
        SELECT evidence.run_id
        FROM group_memory_extraction_run_evidence evidence
        WHERE evidence.conversation_message_id = $1
        UNION
        SELECT context.run_id
        FROM group_memory_extraction_run_context context
        WHERE context.conversation_message_id = $1
        UNION
        SELECT mention.run_id
        FROM group_memory_extraction_run_mentions mention
        WHERE mention.conversation_message_id = $1
        UNION
        SELECT conflict.run_id
        FROM group_memory_extraction_conflict_evidence conflict
        WHERE conflict.conversation_message_id = $1
      ) impacted
      WHERE run_id IS NOT NULL
      ORDER BY run_id ASC
      `,
      [messageId],
    );
    const runIds = impactedRuns.rows.map((row) => requireIdentifier("run id", row.run_id));

    for (const thread of threads) {
      const nextVersion = thread.version + 1;
      await client.query(
        `
        UPDATE discussion_threads
        SET retrieval_state = 'invalidated', title = $3, summary = $3,
            version = $4, updated_at = NOW()
        WHERE id = $1 AND group_id = $2 AND version = $5
        `,
        [thread.id, groupId, REDACTED_CONTENT, nextVersion, thread.version],
      );
      await client.query(
        `
        INSERT INTO discussion_thread_events (
          id, thread_id, group_id, event_type, from_version, to_version,
          operation_key, created_at
        ) VALUES ($1, $2, $3, 'evidence_deleted', $4, $5, $6, NOW())
        `,
        [randomUUID(), thread.id, groupId, thread.version, nextVersion,
          deletionOperationKey("thread", groupId, messageId, thread.id)],
      );
      await invalidateProjection(client, "thread", thread.id, groupId, nextVersion);
    }

    for (const action of actions) {
      const nextVersion = action.version + 1;
      await client.query(
        `
        UPDATE action_items
        SET retrieval_state = 'invalidated', description = $3,
            owner_ref_type = 'text_label', owner_ref = $3, due_at = NULL,
            version = $4, updated_at = NOW()
        WHERE id = $1 AND group_id = $2 AND version = $5
        `,
        [action.id, groupId, REDACTED_CONTENT, nextVersion, action.version],
      );
      await client.query(
        `
        INSERT INTO action_item_events (
          id, action_item_id, group_id, event_type, from_version, to_version,
          operation_key, created_at
        ) VALUES ($1, $2, $3, 'evidence_deleted', $4, $5, $6, NOW())
        `,
        [randomUUID(), action.id, groupId, action.version, nextVersion,
          deletionOperationKey("action", groupId, messageId, action.id)],
      );
      await invalidateProjection(client, "action", action.id, groupId, nextVersion);
    }

    if (memoryIds.length > 0) {
      await client.query("DELETE FROM group_memories WHERE id = ANY($1::text[])", [memoryIds]);
    }

    if (runIds.length > 0) {
      await client.query(
        `
        UPDATE group_memory_extraction_requests
        SET status = 'skipped', skip_reason = 'evidence_deleted', updated_at = NOW()
        WHERE run_id = ANY($1::text[])
        `,
        [runIds],
      );
      await client.query(
        `
        UPDATE group_memory_extraction_runs
        SET status = 'completed', failure_classification = 'evidence_deleted',
            completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
        WHERE id = ANY($1::text[])
        `,
        [runIds],
      );
    }
    await client.query(
      `
      UPDATE group_memory_extraction_requests
      SET status = 'skipped', skip_reason = 'evidence_deleted',
          conversation_message_id = NULL, updated_at = NOW()
      WHERE conversation_message_id = $1
      `,
      [messageId],
    );
    await client.query(
      `
      DELETE FROM group_memory_extraction_conflict_candidates candidate
      USING group_memory_extraction_conflict_evidence evidence
      WHERE evidence.run_id = candidate.run_id
        AND evidence.conflict_ordinal = candidate.ordinal
        AND evidence.conversation_message_id = $1
      `,
      [messageId],
    );
    for (const table of [
      "group_memory_extraction_run_mentions",
      "group_memory_extraction_run_context",
      "group_memory_extraction_run_evidence",
      "discussion_thread_event_evidence",
      "action_item_event_evidence",
      "discussion_thread_evidence",
      "group_memory_message_evidence",
    ]) {
      await client.query(
        `DELETE FROM ${table} WHERE conversation_message_id = $1`,
        [messageId],
      );
    }
    const deleted = await client.query<IdRow>(
      "DELETE FROM conversation_messages WHERE id = $1 AND chat_id = $2 RETURNING id",
      [messageId, groupId],
    );
    if (deleted.rows.length !== 1) {
      throw new Error("conversation message deletion did not remove exactly one row");
    }

    return {
      status: "deleted",
      affectedThreadCount: threads.length,
      affectedActionCount: actions.length,
      deletedMemoryCount: memoryIds.length,
    };
  });
}

async function invalidateProjection(
  client: TransactionClient,
  entityType: "thread" | "action",
  entityId: string,
  groupId: string,
  entityVersion: number,
): Promise<void> {
  await client.query(
    `
    UPDATE conversation_state_memory_projections
    SET projected_version = $4, memory_id = NULL, updated_at = NOW()
    WHERE entity_type = $1 AND entity_id = $2 AND group_id = $3
    `,
    [entityType, entityId, groupId, entityVersion],
  );
  await client.query(
    `
    INSERT INTO conversation_state_projection_repairs (
      id, entity_type, entity_id, group_id, entity_version, status,
      attempt_count, next_attempt_at
    ) VALUES ($1, $2, $3, $4, $5, 'pending', 0, NOW())
    ON CONFLICT (entity_type, entity_id, entity_version) DO NOTHING
    `,
    [randomUUID(), entityType, entityId, groupId, entityVersion],
  );
}

function deletionOperationKey(
  entityType: "thread" | "action",
  groupId: string,
  messageId: string,
  entityId: string,
): string {
  const digest = createHash("sha256")
    .update(`${groupId}\u0000${messageId}\u0000${entityType}\u0000${entityId}`, "utf8")
    .digest("hex");
  return `evidence-delete:${entityType}:${digest}`;
}

function mapVersionRow(row: VersionRow): { id: string; version: number } {
  const version = typeof row.version === "number" ? row.version : Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("entity version is invalid");
  }
  return { id: requireIdentifier("entity id", row.id), version };
}

function requireIdentifier(label: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > MAX_IDENTIFIER_CHARS) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

async function withTransaction<T>(
  dataSource: PostgresConversationStateDataSource,
  operation: (client: TransactionClient) => Promise<T>,
): Promise<T> {
  const client = await dataSource.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original transaction error.
    }
    throw error;
  } finally {
    client.release();
  }
}
