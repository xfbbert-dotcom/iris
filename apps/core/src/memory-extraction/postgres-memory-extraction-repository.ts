import { createHash, randomUUID } from "node:crypto";

import {
  MEMORY_CANDIDATE_CATEGORIES,
  type MemoryExtractionDiagnostics,
  type ValidatedActionOperation,
  type ValidatedMemoryCandidate,
  type ValidatedMemoryConflictCandidate,
  type ValidatedThreadOperation,
} from "./ai-worker-memory-extraction-client.js";
import type {
  ClaimedMemoryExtractionRun,
  ExtractionExistingAction,
  ExtractionExistingMemory,
  ExtractionExistingThread,
  ExtractionMessage,
  ExtractionMessageMention,
  ConversationStateDiagnostics,
  MemoryExtractionRepository,
  MemoryExtractionRequest,
  MemoryExtractionRequestRoute,
  MemoryExtractionRequestStatus,
} from "./memory-extraction-repository.js";
import {
  MemoryExtractionCompletionConflictError,
  MemoryExtractionStaleRunError,
} from "./memory-extraction-repository.js";
import {
  insertGroupMemoryWithEvidence,
  lockGroupMemoryWriteScope,
} from "../memory/postgres-group-memory-writer.js";
import {
  applyConversationStateOperationsInTransaction,
  lockConversationStateWriteScope,
} from "../conversation-state/postgres-conversation-state-repository.js";
import type { ConversationStateOperation } from "../conversation-state/conversation-state-repository.js";

export type Queryable = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export type TransactionClient = Queryable & { release(): void };

export type PostgresMemoryExtractionDataSource = Queryable & {
  connect(): Promise<TransactionClient>;
};

type RequestRow = {
  id: unknown;
  group_id: unknown;
  conversation_message_id: unknown;
  provider_message_id: unknown;
  status: unknown;
  run_id: unknown;
  skip_reason: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type ExistingRequestRow = RequestRow & {
  message_group_id: unknown;
  message_provider_id: unknown;
  message_text: unknown;
};

type RequestRouteRow = {
  id: unknown;
  group_id: unknown;
  status: unknown;
  run_id: unknown;
};

type ClaimMessageRow = MessageRow & {
  request_id: unknown;
  request_group_id: unknown;
  request_provider_message_id: unknown;
  request_status: unknown;
  request_run_id: unknown;
};

type MessageRow = {
  request_id?: unknown;
  stored_message_id?: unknown;
  stored_content_hash?: unknown;
  id: unknown;
  chat_id: unknown;
  sender_id: unknown;
  sender_open_id?: unknown;
  sender_union_id?: unknown;
  sender_user_id?: unknown;
  text: unknown;
  sent_at: unknown;
  created_at: unknown;
};

type MemoryRow = {
  stored_memory_id?: unknown;
  stored_updated_at?: unknown;
  id: unknown;
  group_id?: unknown;
  category: unknown;
  content: unknown;
  status?: unknown;
  updated_at: unknown;
};

type RunRow = {
  id: unknown;
  group_id: unknown;
  input_fingerprint: unknown;
  status: unknown;
  failure_classification?: unknown;
  enabled_operation_families?: unknown;
};

type CompletionEvidenceRow = {
  request_id: unknown;
  conversation_message_id: unknown;
  ordinal: unknown;
  request_status: unknown;
  request_run_id: unknown;
  request_group_id: unknown;
  message_group_id: unknown;
};

type CompletionMemoryIdRow = {
  id: unknown;
  idempotency_key: unknown;
};

type RequestRunReferenceRow = {
  run_id: unknown;
  status: unknown;
};

type LockedRunRequestRow = {
  id: unknown;
  status: unknown;
  run_id: unknown;
};

type StatusCountsRow = {
  pending: unknown;
  processing: unknown;
  completed: unknown;
  skipped: unknown;
  failed_runs: unknown;
  diagnostic_run_count: unknown;
  valid_diagnostic_run_count: unknown;
  accepted_candidates: unknown;
  rejected_candidates: unknown;
  duplicate_candidates: unknown;
  conflict_candidates: unknown;
  accepted_thread_operations: unknown;
  rejected_thread_operations: unknown;
  accepted_action_operations: unknown;
  rejected_action_operations: unknown;
};

type ActiveMemoryContentRow = {
  id: unknown;
  content: unknown;
};
type MentionRow = { conversation_message_id: unknown; mention_key: unknown; mentioned_open_id: unknown };
type ThreadSnapshotRow = Record<string, unknown> & {
  stored_thread_version?: unknown;
  stored_thread_updated_at?: unknown;
  stored_thread_evidence_count?: unknown;
};
type ActionSnapshotRow = Record<string, unknown> & { stored_action_version?: unknown; stored_action_updated_at?: unknown };

const MAX_IDENTIFIER_CHARS = 512;
const MAX_ROUTE_REQUESTS = 100;
const MAX_CLASSIFICATION_CHARS = 128;
const MAX_EVIDENCE_MESSAGES = 40;
const MAX_CONTEXT_MESSAGES = 10;
const MAX_ACTIVE_MEMORIES = 8;
const MAX_ACCEPTED_CANDIDATES = 8;
const MAX_CONVERSATION_STATE_OPERATIONS = 8;
const MAX_CONVERSATION_STATE_REJECTIONS = 16;
const MAX_CONVERSATION_STATE_SNAPSHOTS = 12;
const MAX_AUTHORITATIVE_ACTIVE_MEMORIES = 10_000;
const MAX_CANDIDATE_EVIDENCE_IDS = 40;
const EXTRACTION_MEMORY_CREATED_BY = "memory-extraction-worker";
const READABLE_MESSAGE_TEXT_SQL = "cm.text ~ '[^[:space:]]'";
const COMPLETION_REJECTION_CODES = new Set([
  "candidate_count",
  "invalid_run",
  "invalid_shape",
  "invalid_category",
  "invalid_content",
  "invalid_importance",
  "invalid_confidence",
  "invalid_relation",
  "invalid_evidence",
  "invalid_relation_reference",
  "low_confidence",
  "duplicate_relation",
  "conflict_relation",
  "exact_duplicate",
]);
const SORTED_COMPLETION_REJECTION_CODES = [...COMPLETION_REJECTION_CODES].sort(compareStrings);

export function createPostgresMemoryExtractionRepository({
  dataSource,
}: {
  dataSource: PostgresMemoryExtractionDataSource;
}): MemoryExtractionRepository {
  return {
    async registerRequest(rawInput) {
      const input = {
        groupId: requireBoundedString("groupId", rawInput.groupId, MAX_IDENTIFIER_CHARS),
        conversationMessageId: requireBoundedString(
          "conversationMessageId",
          rawInput.conversationMessageId,
          MAX_IDENTIFIER_CHARS,
        ),
        providerMessageId: requireBoundedString(
          "providerMessageId",
          rawInput.providerMessageId,
          MAX_IDENTIFIER_CHARS,
        ),
      };
      const id = randomUUID();
      const inserted = await dataSource.query<RequestRow>(
        `
        INSERT INTO group_memory_extraction_requests (
          id, group_id, conversation_message_id, provider_message_id, status
        )
        SELECT $1, cm.chat_id, cm.id, cm.provider_message_id, 'pending'
        FROM conversation_messages cm
        WHERE cm.id = $2
          AND cm.chat_id = $3
          AND cm.provider_message_id = $4
          AND ${READABLE_MESSAGE_TEXT_SQL}
        ON CONFLICT DO NOTHING
        RETURNING *
        `,
        [id, input.conversationMessageId, input.groupId, input.providerMessageId],
      );
      const [insertedRow] = inserted.rows;
      if (insertedRow !== undefined) {
        return { request: mapRequest(insertedRow), created: true };
      }

      const existing = await dataSource.query<ExistingRequestRow>(
        `
        SELECT
          r.*,
          cm.chat_id AS message_group_id,
          cm.provider_message_id AS message_provider_id,
          cm.text AS message_text
        FROM group_memory_extraction_requests r
        JOIN conversation_messages cm ON cm.id = r.conversation_message_id
        WHERE r.conversation_message_id = $1 OR r.provider_message_id = $2
        ORDER BY r.conversation_message_id = $1 DESC
        LIMIT 1
        `,
        [input.conversationMessageId, input.providerMessageId],
      );
      const [existingRow] = existing.rows;
      if (existingRow === undefined) {
        throw new Error("conversation message does not match extraction request");
      }
      if (!isReadableText(existingRow.message_text)) {
        throw new Error("conversation message is not readable for extraction");
      }
      const request = mapRequest(existingRow);
      const messageGroupId = requireString(
        "conversation message group id",
        existingRow.message_group_id,
      );
      const messageProviderId = requireString(
        "conversation message provider id",
        existingRow.message_provider_id,
      );
      if (
        request.groupId !== input.groupId ||
        request.conversationMessageId !== input.conversationMessageId ||
        request.providerMessageId !== input.providerMessageId ||
        messageGroupId !== input.groupId ||
        messageGroupId !== request.groupId ||
        messageProviderId !== input.providerMessageId ||
        messageProviderId !== request.providerMessageId
      ) {
        throw new Error("conversation message does not match extraction request");
      }
      return { request, created: false };
    },

    async getRequestRoutes(rawInput) {
      const requestIds = normalizeIdentifierSet(
        "requestIds",
        rawInput.requestIds,
        MAX_ROUTE_REQUESTS,
      );
      if (requestIds.length === 0) {
        return [];
      }
      const result = await dataSource.query<RequestRouteRow>(
        `
        SELECT r.id, r.group_id, r.status, r.run_id
        FROM group_memory_extraction_requests r
        WHERE r.id = ANY($1::text[])
        ORDER BY r.id ASC
        `,
        [requestIds],
      );
      return result.rows.map(mapRequestRoute);
    },

    async claimRun(rawInput) {
      const requestedIds = normalizeIdentifierSet(
        "requestIds",
        rawInput.requestIds,
        MAX_EVIDENCE_MESSAGES,
      );
      const maxEvidenceMessages = boundedLimit(
        "maxEvidenceMessages",
        rawInput.maxEvidenceMessages,
        MAX_EVIDENCE_MESSAGES,
      );
      const contextMessageLimit = boundedLimit(
        "contextMessageLimit",
        rawInput.contextMessageLimit,
        MAX_CONTEXT_MESSAGES,
      );
      const activeMemoryLimit = boundedLimit(
        "activeMemoryLimit",
        rawInput.activeMemoryLimit,
        MAX_ACTIVE_MEMORIES,
      );
      const enabledOperationFamilies = normalizeOperationFamilies(
        rawInput.enabledOperationFamilies,
      );
      if (
        requestedIds.length === 0 ||
        maxEvidenceMessages === 0 ||
        requestedIds.length > maxEvidenceMessages
      ) {
        return undefined;
      }

      let staleRunDetected = false;
      const claimedRun = await withTransaction(dataSource, async (client) => {
        const referenceResult = await client.query<RequestRouteRow>(
          `
          SELECT r.id, r.group_id, r.status, r.run_id
          FROM group_memory_extraction_requests r
          WHERE r.id = ANY($1::text[])
          ORDER BY r.id ASC
          `,
          [requestedIds],
        );
        const reference = validateClaimReferences(referenceResult.rows, requestedIds);
        if (reference === undefined || reference.status === "completed" || reference.status === "skipped") {
          return undefined;
        }

        if (reference.status === "processing") {
          if (reference.runId === undefined) {
            throw new Error("processing extraction requests have no run");
          }
          const storedFamiliesResult = await client.query<RunRow>(
            `
            SELECT enabled_operation_families
            FROM group_memory_extraction_runs
            WHERE id = $1
            FOR UPDATE
            `,
            [reference.runId],
          );
          if (storedFamiliesResult.rows.length !== 1) {
            return undefined;
          }
          const storedFamilies = readPersistedOperationFamilies(
            storedFamiliesResult.rows[0]!.enabled_operation_families,
          );
          if (!sameStrings(storedFamilies, enabledOperationFamilies)) {
            await client.query(
              `
              UPDATE group_memory_extraction_requests
              SET status = 'skipped', skip_reason = 'runtime_disabled_before_apply', updated_at = NOW()
              WHERE run_id = $1 AND status = 'processing'
              `,
              [reference.runId],
            );
            await client.query(
              `
              UPDATE group_memory_extraction_runs
              SET status = 'completed', failure_classification = 'runtime_disabled_before_apply',
                  completed_at = NOW(), updated_at = NOW()
              WHERE id = $1 AND status <> 'completed'
              `,
              [reference.runId],
            );
            return undefined;
          }
          const loaded = await loadStoredRun(client, reference.runId);
          const lockedRows = await loadClaimRows(client, requestedIds);
          const locked = validateClaimRows(lockedRows, requestedIds, "processing");
          if (
            locked === undefined ||
            locked.groupId !== reference.groupId ||
            locked.runId !== reference.runId
          ) {
            return undefined;
          }
          if (loaded.status === "ready") {
            if (!identifierSetContainsAll(loaded.run.requestIds, requestedIds)) {
              throw new Error("memory extraction run request scope conflicts with claimed jobs");
            }
            await client.query(
              `
              UPDATE group_memory_extraction_runs
              SET status = 'processing', completed_at = NULL, updated_at = NOW()
              WHERE id = $1 AND status = 'failed'
              `,
              [reference.runId],
            );
            return loaded.run;
          }
          if (loaded.status === "stale") {
            await markRunStale(client, reference.runId);
            staleRunDetected = true;
          }
          return undefined;
        }

        const lockedRows = await loadClaimRows(client, requestedIds);
        const locked = validateClaimRows(lockedRows, requestedIds, "pending");
        if (locked === undefined || locked.groupId !== reference.groupId) {
          return undefined;
        }
        const unreadableRequestIds = lockedRows
          .filter((row) => !isReadableText(row.text))
          .map((row) => requireExactIdentifier(row.request_id));
        if (unreadableRequestIds.length > 0) {
          await client.query(
            `
            UPDATE group_memory_extraction_requests
            SET status = 'skipped', skip_reason = 'unreadable_message', updated_at = NOW()
            WHERE id = ANY($1::text[]) AND status = 'pending'
            `,
            [unreadableRequestIds],
          );
          return undefined;
        }
        const evidenceRows = [...lockedRows].sort(compareClaimMessageRows);
        let evidenceMessages = evidenceRows.map((row) => mapMessage(row, true));
        const requestIds = evidenceRows.map((row) =>
          requireString("request id", row.request_id),
        );
        const firstEvidence = evidenceMessages[0]!;

        const contextResult = await client.query<MessageRow>(
          `
          SELECT cm.id, cm.chat_id, cm.sender_id, cm.sender_open_id,
                 cm.sender_union_id, cm.sender_user_id, cm.text, cm.sent_at, cm.created_at
          FROM conversation_messages cm
          WHERE cm.chat_id = $1
            AND ${READABLE_MESSAGE_TEXT_SQL}
            AND (cm.created_at, cm.id) < ($2, $3)
            AND NOT (cm.id = ANY($4::text[]))
          ORDER BY cm.created_at DESC, cm.id DESC
          LIMIT $5
          `,
          [
            locked.groupId,
            firstEvidence.createdAt,
            firstEvidence.id,
            evidenceMessages.map((message) => message.id),
            contextMessageLimit,
          ],
        );
        let contextMessages = contextResult.rows
          .map((row) => mapMessage(row, false))
          .reverse();
        const mentions = enabledOperationFamilies.includes("action")
          ? await loadRunMentions(client, [...evidenceMessages, ...contextMessages])
          : [];
        evidenceMessages = attachMentions(evidenceMessages, mentions);
        contextMessages = attachMentions(contextMessages, mentions);

        const memoryResult = await client.query<MemoryRow>(
          `
          SELECT id, group_id, category, content, status, updated_at
          FROM group_memories
          WHERE group_id = $1 AND status = 'active'
          ORDER BY importance DESC, updated_at DESC, id ASC
          LIMIT $2
          `,
          [locked.groupId, activeMemoryLimit],
        );
        const existingMemories = memoryResult.rows.map(mapMemory);
        const { existingThreads, existingActions } = await selectCurrentConversationState(
          client,
          locked.groupId,
          enabledOperationFamilies,
        );
        const inputFingerprint = fingerprintInput({
          groupId: locked.groupId,
          evidenceMessages,
          contextMessages,
          existingMemories,
          mentions,
          existingThreads,
          existingActions,
          enabledOperationFamilies,
        });
        const runId = randomUUID();
        const runResult = await client.query<RunRow>(
          `
          INSERT INTO group_memory_extraction_runs (
            id, group_id, input_fingerprint, status, enabled_operation_families
          )
          VALUES ($1, $2, $3, 'processing', $4::text[])
          RETURNING id, group_id, input_fingerprint, status
          `,
          [runId, locked.groupId, inputFingerprint, enabledOperationFamilies],
        );
        if (runResult.rows.length !== 1) {
          throw new Error("memory extraction run insert returned no rows");
        }

        for (const [ordinal, row] of evidenceRows.entries()) {
          const message = evidenceMessages[ordinal]!;
          await client.query(
            `
            INSERT INTO group_memory_extraction_run_evidence (
              run_id, request_id, conversation_message_id, ordinal, content_hash
            )
            VALUES ($1, $2, $3, $4, $5)
            `,
            [runId, requestIds[ordinal], message.id, ordinal, fingerprintMessage(message)],
          );
        }
        for (const [ordinal, message] of contextMessages.entries()) {
          await client.query(
            `
            INSERT INTO group_memory_extraction_run_context (
              run_id, conversation_message_id, ordinal, content_hash
            )
            VALUES ($1, $2, $3, $4)
            `,
            [runId, message.id, ordinal, fingerprintMessage(message)],
          );
        }
        for (const [ordinal, memory] of existingMemories.entries()) {
          await client.query(
            `
            INSERT INTO group_memory_extraction_run_memories (
              run_id, memory_id, ordinal, memory_updated_at
            )
            VALUES ($1, $2, $3, $4)
            `,
            [runId, memory.id, ordinal, memory.updatedAt],
          );
        }
        for (const mention of mentions) {
          await client.query(
            `
            INSERT INTO group_memory_extraction_run_mentions (
              run_id, conversation_message_id, mention_key, mentioned_open_id
            ) VALUES ($1, $2, $3, $4)
            `,
            [runId, mention.conversationMessageId, mention.key, mention.openId],
          );
        }
        for (const [ordinal, thread] of existingThreads.entries()) {
          await client.query(
            `
            INSERT INTO group_memory_extraction_run_threads (
              run_id, thread_id, ordinal, thread_version, thread_updated_at,
              thread_evidence_count
            ) VALUES ($1, $2, $3, $4, $5, $6)
            `,
            [runId, thread.id, ordinal, thread.version, thread.updatedAt, thread.evidenceCount],
          );
        }
        for (const [ordinal, action] of existingActions.entries()) {
          await client.query(
            `
            INSERT INTO group_memory_extraction_run_actions (
              run_id, action_item_id, ordinal, action_version, action_updated_at
            ) VALUES ($1, $2, $3, $4, $5)
            `,
            [runId, action.id, ordinal, action.version, action.updatedAt],
          );
        }
        const requestUpdate = await client.query<{ id: unknown }>(
          `
          UPDATE group_memory_extraction_requests
          SET status = 'processing', run_id = $1, skip_reason = NULL, updated_at = NOW()
          WHERE id = ANY($2::text[]) AND status = 'pending'
          RETURNING id
          `,
          [runId, requestIds],
        );
        assertExactIds(requestUpdate.rows.map((row) => row.id), requestIds);

        return {
          id: runId,
          groupId: locked.groupId,
          inputFingerprint,
          requestIds,
          evidenceMessages,
          contextMessages,
          existingMemories,
          mentions,
          existingThreads,
          existingActions,
          enabledOperationFamilies,
        };
      });
      if (staleRunDetected) {
        throw new MemoryExtractionStaleRunError();
      }
      return claimedRun;
    },

    async loadRunInput(runIdValue) {
      const runId = requireBoundedString("runId", runIdValue, MAX_IDENTIFIER_CHARS);
      return withTransaction(dataSource, async (client) => {
        const groupId = await lockRunFreshnessScopes(client, runId);
        if (groupId === undefined) return { status: "not_found" as const };
        const loaded = await loadStoredRun(client, runId, { lockInputs: true });
        if (loaded.status === "ready" && loaded.run.groupId !== groupId) {
          throw new Error("memory extraction run group changed while locking freshness scope");
        }
        if (loaded.status !== "stale") {
          return loaded;
        }
        await markRunStale(client, runId);
        return loaded;
      });
    },

    async skipRequest(rawInput) {
      const requestId = requireBoundedString(
        "requestId",
        rawInput.requestId,
        MAX_IDENTIFIER_CHARS,
      );
      const reason = requireBoundedString("reason", rawInput.reason, MAX_CLASSIFICATION_CHARS);
      await withTransaction(dataSource, async (client) => {
        const referenceResult = await client.query<RequestRunReferenceRow>(
          `
          SELECT run_id, status
          FROM group_memory_extraction_requests
          WHERE id = $1
          `,
          [requestId],
        );
        if (referenceResult.rows.length === 0) {
          return;
        }
        if (referenceResult.rows.length !== 1) {
          throw new Error("memory extraction request query returned multiple rows");
        }
        const reference = referenceResult.rows[0]!;
        const runId = reference.run_id === null || reference.run_id === undefined
          ? undefined
          : requireBoundedString(
              "request run id",
              requireString("request run id", reference.run_id),
              MAX_IDENTIFIER_CHARS,
            );
        if (runId === undefined) {
          await client.query(
            `
            UPDATE group_memory_extraction_requests
            SET status = 'skipped', skip_reason = $2, updated_at = NOW()
            WHERE id = $1 AND status = 'pending'
            `,
            [requestId, reason],
          );
          return;
        }

        const runResult = await client.query<RunRow>(
          `
          SELECT id, group_id, input_fingerprint, status, failure_classification
          FROM group_memory_extraction_runs
          WHERE id = $1
          FOR UPDATE
          `,
          [runId],
        );
        if (runResult.rows.length !== 1) {
          throw new Error("memory extraction run is missing for request");
        }
        const lockedRequests = await client.query<LockedRunRequestRow>(
          `
          SELECT id, status, run_id
          FROM group_memory_extraction_requests
          WHERE run_id = $1
          ORDER BY id ASC
          FOR UPDATE
          `,
          [runId],
        );
        const requestIds = lockedRequests.rows.map((row) => {
          const lockedRunId = requireBoundedString(
            "request run id",
            requireString("request run id", row.run_id),
            MAX_IDENTIFIER_CHARS,
          );
          requireRequestStatus(row.status);
          if (lockedRunId !== runId) {
            throw new Error("memory extraction request no longer belongs to run");
          }
          return requireBoundedString(
            "request id",
            requireString("request id", row.id),
            MAX_IDENTIFIER_CHARS,
          );
        });
        if (!requestIds.includes(requestId)) {
          throw new Error("memory extraction request no longer belongs to run");
        }
        if (requireRunStatus(runResult.rows[0]!.status) === "completed") {
          return;
        }

        await client.query(
          `
          UPDATE group_memory_extraction_requests
          SET status = 'skipped', skip_reason = $2, updated_at = NOW()
          WHERE run_id = $1 AND status = 'processing'
          `,
          [runId, reason],
        );
        await client.query(
          `
          UPDATE group_memory_extraction_runs
          SET status = 'completed', failure_classification = $2,
              completed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status <> 'completed'
          `,
          [runId, reason],
        );
      });
    },

    async skipRun(rawInput) {
      const runId = requireBoundedString("runId", rawInput.runId, MAX_IDENTIFIER_CHARS);
      const reason = requireBoundedString("reason", rawInput.reason, MAX_CLASSIFICATION_CHARS);
      await withTransaction(dataSource, async (client) => {
        await client.query(
          `
          SELECT id
          FROM group_memory_extraction_runs
          WHERE id = $1
          FOR UPDATE
          `,
          [runId],
        );
        await client.query(
          `
          UPDATE group_memory_extraction_requests
          SET status = 'skipped', skip_reason = $2, updated_at = NOW()
          WHERE run_id = $1 AND status = 'processing'
          `,
          [runId, reason],
        );
        await client.query(
          `
          UPDATE group_memory_extraction_runs
          SET status = 'completed', failure_classification = $2,
              completed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status <> 'completed'
          `,
          [runId, reason],
        );
      });
    },

    async failRun(rawInput) {
      const runId = requireBoundedString("runId", rawInput.runId, MAX_IDENTIFIER_CHARS);
      const classification = requireBoundedString(
        "classification",
        rawInput.classification,
        MAX_CLASSIFICATION_CHARS,
      );
      await dataSource.query(
        `
        UPDATE group_memory_extraction_runs
        SET status = 'failed', failure_classification = $2,
            failure_count = failure_count + 1,
            completed_at = NULL, updated_at = NOW()
        WHERE id = $1 AND status <> 'completed'
        `,
        [runId, classification],
      );
    },

    async completeRun(rawInput) {
      const input = normalizeCompletionInput(rawInput);
      const replayDigest = createCompletionReplayDigest(input);
      const allIdempotencyKeys = Array.from(
        { length: MAX_ACCEPTED_CANDIDATES },
        (_, index) => completionIdempotencyKey(input.runId, index),
      );

      let staleRunDetected = false;
      const completion = await withTransaction(dataSource, async (client) => {
        const lockedGroupId = await lockRunFreshnessScopes(client, input.runId);
        if (lockedGroupId === undefined) {
          throw new MemoryExtractionCompletionConflictError();
        }
        const runResult = await client.query<RunRow>(
          `
          SELECT id, group_id, input_fingerprint, status, failure_classification
          FROM group_memory_extraction_runs
          WHERE id = $1
          FOR UPDATE
          `,
          [input.runId],
        );
        if (runResult.rows.length !== 1) {
          throw new MemoryExtractionCompletionConflictError();
        }
        const runRow = runResult.rows[0]!;
        const groupId = requireBoundedString(
          "run group id",
          requireString("run group id", runRow.group_id),
          MAX_IDENTIFIER_CHARS,
        );
        const persistedFingerprint = requireFingerprint(runRow.input_fingerprint);
        const runStatus = requireRunStatus(runRow.status);
        if (groupId !== lockedGroupId || persistedFingerprint !== input.inputFingerprint) {
          throw new MemoryExtractionCompletionConflictError();
        }

        const evidenceResult = await client.query<CompletionEvidenceRow>(
          `
          SELECT
            e.request_id,
            e.conversation_message_id,
            e.ordinal,
            r.status AS request_status,
            r.run_id AS request_run_id,
            r.group_id AS request_group_id,
            cm.chat_id AS message_group_id
          FROM group_memory_extraction_run_evidence e
          JOIN group_memory_extraction_requests r
            ON r.id = e.request_id
          JOIN conversation_messages cm
            ON cm.id = e.conversation_message_id
          WHERE e.run_id = $1
          ORDER BY e.ordinal ASC, r.id ASC
          FOR UPDATE OF r
          `,
          [input.runId],
        );
        const claimed = validateClaimedCompletionRows({
          rows: evidenceResult.rows,
          runId: input.runId,
          groupId,
          expectedStatus: runStatus === "completed" ? "completed" : "processing",
        });
        validateCompletionEvidence(
          [...input.acceptedCandidates, ...input.conflictCandidates],
          claimed.evidenceMessageIds,
        );

        if (runStatus === "completed") {
          const completionMarker = parseCompletionMarker(runRow.failure_classification);
          if (
            completionMarker === undefined ||
            completionMarker.replayDigest !== replayDigest
          ) {
            throw new MemoryExtractionCompletionConflictError();
          }
          const memoryIds = await loadCompletedMemoryIds({
            queryable: client,
            groupId,
            expectedIdempotencyKeys: allIdempotencyKeys.slice(
              0,
              completionMarker.acceptedCount,
            ),
            allIdempotencyKeys,
          });
          const conversationStateIds = await loadCompletedConversationStateIds({
            queryable: client,
            groupId,
            operationKeys: [...input.threadOperations, ...input.actionOperations].map((operation) => operation.operationKey),
          });
          return {
            status: "already_completed" as const,
            memoryIds,
            ...(input.threadOperations.length + input.actionOperations.length === 0 ? {} : conversationStateIds),
          };
        }
        if (runStatus !== "processing") {
          throw new MemoryExtractionCompletionConflictError();
        }

        const current = await loadStoredRun(client, input.runId, { lockInputs: true });
        if (current.status === "stale") {
          await markRunStale(client, input.runId);
          staleRunDetected = true;
          return undefined;
        }
        if (
          current.status !== "ready" ||
          current.run.groupId !== groupId ||
          current.run.inputFingerprint !== input.inputFingerprint ||
          !sameIdentifierSet(current.run.requestIds, claimed.requestIds)
        ) {
          throw new MemoryExtractionCompletionConflictError();
        }
        validateCompletionConflictTargets(
          input.conflictCandidates,
          current.run.existingMemories,
        );
        validateOperationEvidence(
          [...input.threadOperations, ...input.actionOperations],
          claimed.evidenceMessageIds,
        );

        const admitted = await admitCandidatesAgainstActiveMemories({
          queryable: client,
          groupId,
          acceptedCandidates: input.acceptedCandidates,
          diagnostics: input.diagnostics,
        });
        const completionMarker = createCompletionMarker({
          diagnostics: admitted.diagnostics,
          replayDigest,
        });
        const memoryIds: string[] = [];
        for (const [index, candidate] of admitted.acceptedCandidates.entries()) {
          const memory = await insertGroupMemoryWithEvidence({
            queryable: client,
            memory: {
              id: randomUUID(),
              groupId,
              scope: "group",
              category: candidate.category,
              content: candidate.content,
              importance: candidate.importance,
              confidence: candidate.confidence,
              idempotencyKey: completionIdempotencyKey(input.runId, index),
              origin: "extractor",
              createdBy: EXTRACTION_MEMORY_CREATED_BY,
              evidenceMessageIds: candidate.evidenceMessageIds,
            },
          });
          memoryIds.push(memory.id);
        }
        await insertConflictCandidates({
          queryable: client,
          runId: input.runId,
          conflictCandidates: input.conflictCandidates,
        });
        const conversationState = await applyConversationStateOperationsInTransaction(
          client as never,
          {
            groupId,
            operations: toConversationStateOperations({
              run: current.run,
              threadOperations: input.threadOperations,
              actionOperations: input.actionOperations,
            }),
          },
        );

        const requestUpdate = await client.query<{ id: unknown }>(
          `
          UPDATE group_memory_extraction_requests
          SET status = 'completed', skip_reason = NULL, updated_at = NOW()
          WHERE run_id = $1
            AND id = ANY($2::text[])
            AND status = 'processing'
          RETURNING id
          `,
          [input.runId, claimed.requestIds],
        );
        assertExactIds(requestUpdate.rows.map((row) => row.id), claimed.requestIds);

        const runUpdate = await client.query<{ id: unknown }>(
          `
          UPDATE group_memory_extraction_runs
          SET status = 'completed', failure_classification = $3,
              thread_operation_count = $4, action_operation_count = $5,
              thread_operation_rejected_count = $6,
              action_operation_rejected_count = $7,
              conversation_state_rejected_count = $8,
              conversation_state_rejection_codes = $9::text[],
              completed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND input_fingerprint = $2 AND status = 'processing'
          RETURNING id
          `,
          [
            input.runId, input.inputFingerprint, completionMarker,
            input.threadOperations.length, input.actionOperations.length,
            input.conversationStateDiagnostics.threadRejectedCount,
            input.conversationStateDiagnostics.actionRejectedCount,
            input.conversationStateDiagnostics.rejectedCount,
            input.conversationStateDiagnostics.rejectionCodes,
          ],
        );
        assertExactIds(runUpdate.rows.map((row) => row.id), [input.runId]);

        return {
          status: "completed" as const,
          memoryIds,
          ...(input.threadOperations.length + input.actionOperations.length === 0 ? {} : {
            threadIds: conversationState.threadIds,
            actionItemIds: conversationState.actionItemIds,
          }),
        };
      });
      if (staleRunDetected) {
        throw new MemoryExtractionStaleRunError();
      }
      if (completion === undefined) {
        throw new MemoryExtractionCompletionConflictError();
      }
      return completion;
    },

    async getStatusCounts() {
      const result = await dataSource.query<StatusCountsRow>(`
        WITH request_counts AS (
          SELECT
            COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
            COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
            COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped
          FROM group_memory_extraction_requests
        ),
        diagnostic_rows AS (
          SELECT
            regexp_match(
              r.failure_classification,
              '^v3:p([0-8]):a([0-8]):r([0-8]):d([0-8]):c([0-8]):x([^:]*):h[A-Za-z0-9_-]{43}$'
            ) AS marker,
            r.thread_operation_count,
            r.thread_operation_rejected_count,
            r.action_operation_count,
            r.action_operation_rejected_count
          FROM group_memory_extraction_runs r
          WHERE r.status = 'completed'
            AND EXISTS (
              SELECT 1
              FROM group_memory_extraction_requests request
              WHERE request.run_id = r.id AND request.status = 'completed'
            )
        ),
        parsed_diagnostics AS (
          SELECT
            marker,
            thread_operation_count,
            thread_operation_rejected_count,
            action_operation_count,
            action_operation_rejected_count,
            CASE
              WHEN marker IS NULL THEN FALSE
              ELSE marker[2]::int + marker[3]::int = marker[1]::int
                AND marker[4]::int + marker[5]::int <= marker[3]::int
                AND cardinality(string_to_array(marker[6], ',')) <= 2
                AND string_to_array(marker[6], ',') <@ $1::text[]
                AND (
                  cardinality(string_to_array(marker[6], ',')) < 2
                  OR array_position($1::text[], (string_to_array(marker[6], ','))[1])
                    < array_position($1::text[], (string_to_array(marker[6], ','))[2])
                )
            END AS valid
          FROM diagnostic_rows
        ),
        run_counts AS (
          SELECT
            (SELECT COALESCE(SUM(failure_count), 0)
             FROM group_memory_extraction_runs) AS failed_runs,
            COUNT(*)::int AS diagnostic_run_count,
            COUNT(*) FILTER (WHERE valid)::int AS valid_diagnostic_run_count,
            COALESCE(SUM(CASE WHEN valid THEN marker[2]::int ELSE 0 END), 0)::int
              AS accepted_candidates,
            COALESCE(SUM(CASE WHEN valid THEN marker[3]::int ELSE 0 END), 0)::int
              AS rejected_candidates,
            COALESCE(SUM(CASE WHEN valid THEN marker[4]::int ELSE 0 END), 0)::int
              AS duplicate_candidates,
            COALESCE(SUM(CASE WHEN valid THEN marker[5]::int ELSE 0 END), 0)::int
              AS conflict_candidates,
            COALESCE(SUM(thread_operation_count) FILTER (WHERE valid), 0)::int
              AS accepted_thread_operations,
            COALESCE(SUM(thread_operation_rejected_count) FILTER (WHERE valid), 0)::int
              AS rejected_thread_operations,
            COALESCE(SUM(action_operation_count) FILTER (WHERE valid), 0)::int
              AS accepted_action_operations,
            COALESCE(SUM(action_operation_rejected_count) FILTER (WHERE valid), 0)::int
              AS rejected_action_operations
          FROM parsed_diagnostics
        )
        SELECT
          request_counts.pending,
          request_counts.processing,
          request_counts.completed,
          request_counts.skipped,
          run_counts.failed_runs,
          run_counts.diagnostic_run_count,
          run_counts.valid_diagnostic_run_count,
          run_counts.accepted_candidates,
          run_counts.rejected_candidates,
          run_counts.duplicate_candidates,
          run_counts.conflict_candidates,
          run_counts.accepted_thread_operations,
          run_counts.rejected_thread_operations,
          run_counts.accepted_action_operations,
          run_counts.rejected_action_operations
        FROM request_counts CROSS JOIN run_counts
      `, [SORTED_COMPLETION_REJECTION_CODES]);
      const [row] = result.rows;
      if (row === undefined) {
        throw new Error("memory extraction status count returned no rows");
      }
      const diagnosticRunCount = requireNumber(
        "diagnostic run count",
        row.diagnostic_run_count,
      );
      const validDiagnosticRunCount = requireNumber(
        "valid diagnostic run count",
        row.valid_diagnostic_run_count,
      );
      if (diagnosticRunCount !== validDiagnosticRunCount) {
        throw new Error("memory extraction diagnostics aggregate is invalid");
      }
      return {
        pending: requireNumber("pending count", row.pending),
        processing: requireNumber("processing count", row.processing),
        completed: requireNumber("completed count", row.completed),
        skipped: requireNumber("skipped count", row.skipped),
        failedRuns: requireNumber("failed run count", row.failed_runs),
        acceptedCandidates: requireNumber(
          "accepted candidate count",
          row.accepted_candidates,
        ),
        rejectedCandidates: requireNumber(
          "rejected candidate count",
          row.rejected_candidates,
        ),
        duplicateCandidates: requireNumber(
          "duplicate candidate count",
          row.duplicate_candidates,
        ),
        conflictCandidates: requireNumber(
          "conflict candidate count",
          row.conflict_candidates,
        ),
        acceptedThreadOperations: requireNumber(
          "accepted thread operation count",
          row.accepted_thread_operations,
        ),
        rejectedThreadOperations: requireNumber(
          "rejected thread operation count",
          row.rejected_thread_operations,
        ),
        acceptedActionOperations: requireNumber(
          "accepted action operation count",
          row.accepted_action_operations,
        ),
        rejectedActionOperations: requireNumber(
          "rejected action operation count",
          row.rejected_action_operations,
        ),
      };
    },
  };
}

function normalizeCompletionInput(input: {
  runId: string;
  inputFingerprint: string;
  acceptedCandidates: ValidatedMemoryCandidate[];
  conflictCandidates: ValidatedMemoryConflictCandidate[];
  diagnostics: MemoryExtractionDiagnostics;
  threadOperations?: ValidatedThreadOperation[];
  actionOperations?: ValidatedActionOperation[];
  conversationStateDiagnostics?: ConversationStateDiagnostics;
}): {
  runId: string;
  inputFingerprint: string;
  acceptedCandidates: ValidatedMemoryCandidate[];
  conflictCandidates: ValidatedMemoryConflictCandidate[];
  diagnostics: MemoryExtractionDiagnostics;
  threadOperations: ValidatedThreadOperation[];
  actionOperations: ValidatedActionOperation[];
  conversationStateDiagnostics: ConversationStateDiagnostics;
} {
  try {
    const runId = requireBoundedString("runId", input.runId, MAX_IDENTIFIER_CHARS);
    const inputFingerprint = requireFingerprint(input.inputFingerprint);
    if (
      !Array.isArray(input.acceptedCandidates) ||
      !Array.isArray(input.conflictCandidates) ||
      input.acceptedCandidates.length + input.conflictCandidates.length > MAX_ACCEPTED_CANDIDATES
    ) {
      throw new Error("invalid candidates");
    }
    const acceptedCandidates = input.acceptedCandidates.map(normalizeCompletionCandidate);
    acceptedCandidates.sort(compareCompletionCandidates);
    const comparisonKeys = acceptedCandidates.map((candidate) =>
      candidate.content.normalize("NFC").toLowerCase().normalize("NFC"),
    );
    if (new Set(comparisonKeys).size !== comparisonKeys.length) {
      throw new Error("duplicate candidates");
    }
    const conflictCandidates = input.conflictCandidates.map(
      normalizeCompletionConflictCandidate,
    );
    conflictCandidates.sort(compareCompletionConflictCandidates);
    const diagnostics = normalizeCompletionDiagnostics(
      input.diagnostics,
      acceptedCandidates.length,
      conflictCandidates.length,
    );
    const threadOperations = normalizeConversationOperations(input.threadOperations ?? []);
    const actionOperations = normalizeConversationOperations(input.actionOperations ?? []);
    const conversationStateDiagnostics = normalizeConversationStateDiagnostics(
      input.conversationStateDiagnostics ?? emptyConversationStateDiagnostics(),
      threadOperations.length,
      actionOperations.length,
    );
    return {
      runId,
      inputFingerprint,
      acceptedCandidates,
      conflictCandidates,
      diagnostics,
      threadOperations: threadOperations as ValidatedThreadOperation[],
      actionOperations: actionOperations as ValidatedActionOperation[],
      conversationStateDiagnostics,
    };
  } catch (error) {
    if (error instanceof MemoryExtractionCompletionConflictError) {
      throw error;
    }
    throw new MemoryExtractionCompletionConflictError();
  }
}

function normalizeConversationOperations<T extends { operationKey: string }>(value: T[]): T[] {
  if (!Array.isArray(value) || value.length > MAX_CONVERSATION_STATE_OPERATIONS) throw new Error("invalid conversation operations");
  const normalized = value.map((operation) => {
    if (typeof operation !== "object" || operation === null) throw new Error("invalid conversation operation");
    return { ...operation, operationKey: requireBoundedString("operation key", operation.operationKey, MAX_IDENTIFIER_CHARS) } as T;
  }).sort((left, right) => compareStrings(left.operationKey, right.operationKey));
  if (new Set(normalized.map((operation) => operation.operationKey)).size !== normalized.length) throw new Error("duplicate conversation operation key");
  return normalized;
}

function normalizeConversationStateDiagnostics(
  value: ConversationStateDiagnostics,
  acceptedThreadCount: number,
  acceptedActionCount: number,
): ConversationStateDiagnostics {
  if (typeof value !== "object" || value === null) throw new Error("invalid conversation diagnostics");
  const proposedCount = boundedConversationStateCount(value.proposedCount);
  const normalizedAcceptedCount = boundedConversationStateCount(value.acceptedCount);
  const rejectedCount = boundedConversationStateCount(value.rejectedCount);
  const threadProposedCount = boundedConversationStateFamilyCount(value.threadProposedCount);
  const threadAcceptedCount = boundedConversationStateFamilyCount(value.threadAcceptedCount);
  const threadRejectedCount = boundedConversationStateFamilyCount(value.threadRejectedCount);
  const actionProposedCount = boundedConversationStateFamilyCount(value.actionProposedCount);
  const actionAcceptedCount = boundedConversationStateFamilyCount(value.actionAcceptedCount);
  const actionRejectedCount = boundedConversationStateFamilyCount(value.actionRejectedCount);
  if (
    normalizedAcceptedCount !== acceptedThreadCount + acceptedActionCount ||
    normalizedAcceptedCount + rejectedCount !== proposedCount ||
    threadAcceptedCount !== acceptedThreadCount ||
    threadAcceptedCount + threadRejectedCount !== threadProposedCount ||
    actionAcceptedCount !== acceptedActionCount ||
    actionAcceptedCount + actionRejectedCount !== actionProposedCount ||
    threadProposedCount + actionProposedCount !== proposedCount ||
    threadAcceptedCount + actionAcceptedCount !== normalizedAcceptedCount ||
    threadRejectedCount + actionRejectedCount !== rejectedCount
  ) throw new Error("invalid conversation diagnostics");
  if (!Array.isArray(value.rejectionCodes) || value.rejectionCodes.length > MAX_CONVERSATION_STATE_REJECTIONS) throw new Error("invalid conversation diagnostics");
  const rejectionCodes = value.rejectionCodes.map((code) => {
    if (typeof code !== "string" || !/^[a-z_]{1,128}$/u.test(code)) throw new Error("invalid conversation diagnostics");
    return code;
  }).sort(compareStrings);
  if (new Set(rejectionCodes).size !== rejectionCodes.length) throw new Error("invalid conversation diagnostics");
  return {
    proposedCount,
    acceptedCount: normalizedAcceptedCount,
    rejectedCount,
    threadProposedCount,
    threadAcceptedCount,
    threadRejectedCount,
    actionProposedCount,
    actionAcceptedCount,
    actionRejectedCount,
    rejectionCodes,
  };
}

function emptyConversationStateDiagnostics(): ConversationStateDiagnostics {
  return {
    proposedCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    threadProposedCount: 0,
    threadAcceptedCount: 0,
    threadRejectedCount: 0,
    actionProposedCount: 0,
    actionAcceptedCount: 0,
    actionRejectedCount: 0,
    rejectionCodes: [],
  };
}

function boundedConversationStateCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_CONVERSATION_STATE_REJECTIONS) throw new Error("invalid conversation diagnostics");
  return value as number;
}

function boundedConversationStateFamilyCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_CONVERSATION_STATE_OPERATIONS) throw new Error("invalid conversation diagnostics");
  return value as number;
}

function validateOperationEvidence(
  operations: Array<{ evidenceMessageIds: string[] }>,
  availableEvidenceIds: Set<string>,
): void {
  for (const operation of operations) {
    if (!Array.isArray(operation.evidenceMessageIds) || operation.evidenceMessageIds.length === 0 ||
      operation.evidenceMessageIds.some((id) => !availableEvidenceIds.has(id))) {
      throw new MemoryExtractionCompletionConflictError();
    }
  }
}

async function loadCompletedConversationStateIds(input: {
  queryable: Queryable;
  groupId: string;
  operationKeys: string[];
}): Promise<{ threadIds: string[]; actionItemIds: string[] }> {
  if (input.operationKeys.length === 0) return { threadIds: [], actionItemIds: [] };
  const result = await input.queryable.query<{ entity_type: unknown; entity_id: unknown }>(
    `
    SELECT entity_type, entity_id
    FROM conversation_state_operation_claims
    WHERE group_id = $1 AND operation_key = ANY($2::text[])
    ORDER BY operation_key ASC
    `,
    [input.groupId, input.operationKeys],
  );
  if (result.rows.length !== input.operationKeys.length) throw new MemoryExtractionCompletionConflictError();
  const threadIds: string[] = [];
  const actionItemIds: string[] = [];
  for (const row of result.rows) {
    const id = requireExactIdentifier(row.entity_id);
    if (row.entity_type === "thread") threadIds.push(id);
    else if (row.entity_type === "action") actionItemIds.push(id);
    else throw new MemoryExtractionCompletionConflictError();
  }
  return { threadIds, actionItemIds };
}

function toConversationStateOperations(input: {
  run: ClaimedMemoryExtractionRun;
  threadOperations: ValidatedThreadOperation[];
  actionOperations: ValidatedActionOperation[];
}): ConversationStateOperation[] {
  const now = new Date();
  const threads = new Map(input.run.existingThreads.map((thread) => [thread.id, thread]));
  const actions = new Map(input.run.existingActions.map((action) => [action.id, action]));
  const operations: ConversationStateOperation[] = [];
  for (const operation of input.threadOperations) {
    if (operation.operation === "create") {
      const id = randomUUID();
      const thread = { id, groupId: input.run.groupId, title: operation.title, summary: operation.summary,
        status: operation.initialStatus, confidence: operation.confidence, version: 1, evidenceCount: 0, firstEvidenceAt: now,
        lastActivityAt: now, createdAt: now, updatedAt: now };
      operations.push({ kind: "create", operationKey: operation.operationKey, thread,
        threadEvent: { id: randomUUID(), threadId: id, groupId: input.run.groupId, eventType: "created", toVersion: 1, operationKey: operation.operationKey, createdAt: now },
        evidenceMessageIds: operation.evidenceMessageIds });
      threads.set(id, thread);
      continue;
    }
    const current = threads.get(operation.operation === "merge" ? operation.sourceThreadId : operation.threadId);
    if (current === undefined || current.version !== operation.expectedVersion) throw new MemoryExtractionCompletionConflictError();
    let thread: ExtractionExistingThread;
    let eventType: "evidence_attached" | "promoted" | "merged" | "resolved" | "reopened" | "summary_updated" | "corrected";
    if (operation.operation === "attach_evidence") { thread = { ...current, version: current.version + 1, lastActivityAt: now, updatedAt: now }; eventType = "evidence_attached"; }
    else if (operation.operation === "promote") { thread = { ...current, status: "open", summary: operation.summary, version: current.version + 1, lastActivityAt: now, updatedAt: now }; eventType = "promoted"; }
    else if (operation.operation === "merge") { thread = mapMergedThreadForCompletion(current, operation.targetThreadId, now); eventType = "merged"; }
    else if (operation.operation === "resolve") { thread = { ...current, status: "resolved", resolvedAt: now, version: current.version + 1, lastActivityAt: now, updatedAt: now }; eventType = "resolved"; }
    else if (operation.operation === "reopen") { const { resolvedAt: _resolvedAt, ...reopened } = current; thread = { ...reopened, status: "open", version: current.version + 1, lastActivityAt: now, updatedAt: now }; eventType = "reopened"; }
    else if (operation.operation === "update_summary") { thread = { ...current, summary: operation.summary, version: current.version + 1, lastActivityAt: now, updatedAt: now }; eventType = "summary_updated"; }
    else { thread = { ...current, ...(operation.title === undefined ? {} : { title: operation.title }), ...(operation.summary === undefined ? {} : { summary: operation.summary }), version: current.version + 1, lastActivityAt: now, updatedAt: now }; eventType = "corrected"; }
    operations.push({ kind: "mutation", operationKey: operation.operationKey, expectedVersion: current.version, thread,
      threadEvent: { id: randomUUID(), threadId: thread.id, groupId: input.run.groupId, eventType, fromVersion: current.version, toVersion: thread.version, operationKey: operation.operationKey, createdAt: now }, evidenceMessageIds: operation.evidenceMessageIds });
    threads.set(thread.id, thread);
  }
  for (const operation of input.actionOperations) {
    if (operation.operation === "create") {
      const id = randomUUID();
      const dueAt = operation.dueAt === undefined ? undefined : requireDate("action due at", operation.dueAt);
      const action = { id, groupId: input.run.groupId, ...(operation.threadId == null ? {} : { threadId: operation.threadId }), description: operation.description,
        ownerRefType: operation.ownerRefType!, ownerRef: operation.ownerRef!, ...(dueAt === undefined ? {} : { dueAt }), status: "open" as const, confidence: operation.confidence, version: 1, createdAt: now, updatedAt: now };
      operations.push({ kind: "create", operationKey: operation.operationKey, action,
        actionEvent: { id: randomUUID(), actionItemId: id, groupId: input.run.groupId, eventType: "created", toVersion: 1, operationKey: operation.operationKey, createdAt: now }, evidenceMessageIds: operation.evidenceMessageIds });
      actions.set(id, action);
      continue;
    }
    const current = actions.get(operation.actionId);
    if (current === undefined || current.version !== operation.expectedVersion) throw new MemoryExtractionCompletionConflictError();
    let action: ExtractionExistingAction;
    let eventType: "completed" | "cancelled" | "reopened" | "owner_resolved" | "corrected";
    if (operation.operation === "complete") { action = { ...current, status: "completed", completedAt: now, version: current.version + 1, updatedAt: now }; eventType = "completed"; }
    else if (operation.operation === "cancel") { action = { ...current, status: "cancelled", cancelledAt: now, version: current.version + 1, updatedAt: now }; eventType = "cancelled"; }
    else if (operation.operation === "reopen") { const { completedAt: _completedAt, cancelledAt: _cancelledAt, ...reopened } = current; action = { ...reopened, status: "open", version: current.version + 1, updatedAt: now }; eventType = "reopened"; }
    else if (operation.operation === "resolve_owner") { action = { ...current, ownerRefType: operation.ownerRefType!, ownerRef: operation.ownerRef!, version: current.version + 1, updatedAt: now }; eventType = "owner_resolved"; }
    else { const { threadId: _threadId, ...unlinked } = current; action = { ...unlinked, ...(operation.description === undefined ? {} : { description: operation.description }), ...(operation.ownerRefType === undefined ? {} : { ownerRefType: operation.ownerRefType, ownerRef: operation.ownerRef! }), ...(Object.hasOwn(operation, "threadId") ? (operation.threadId == null ? {} : { threadId: operation.threadId }) : { ...(current.threadId === undefined ? {} : { threadId: current.threadId }) }), version: current.version + 1, updatedAt: now }; eventType = "corrected"; }
    operations.push({ kind: "mutation", operationKey: operation.operationKey, expectedVersion: current.version, action,
      actionEvent: { id: randomUUID(), actionItemId: action.id, groupId: input.run.groupId, eventType, fromVersion: current.version, toVersion: action.version, operationKey: operation.operationKey, createdAt: now }, evidenceMessageIds: operation.evidenceMessageIds });
    actions.set(action.id, action);
  }
  return operations;
}

export function mapMergedThreadForCompletion(
  current: ExtractionExistingThread,
  targetThreadId: string,
  now: Date,
): ExtractionExistingThread {
  const { resolvedAt: _resolvedAt, ...mergeable } = current;
  return {
    ...mergeable,
    status: "merged",
    mergedIntoThreadId: targetThreadId,
    version: current.version + 1,
    lastActivityAt: now,
    updatedAt: now,
  };
}

function normalizeCompletionConflictCandidate(
  candidate: ValidatedMemoryConflictCandidate,
): ValidatedMemoryConflictCandidate {
  const normalized = normalizeCompletionCandidate(candidate);
  return {
    ...normalized,
    existingMemoryId: requireExactIdentifier(candidate.existingMemoryId),
  };
}

function normalizeCompletionCandidate(
  candidate: ValidatedMemoryCandidate,
): ValidatedMemoryCandidate {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !MEMORY_CANDIDATE_CATEGORIES.includes(candidate.category as never)
  ) {
    throw new Error("invalid candidate");
  }
  const content = normalizeCandidateContent(candidate.content);
  if (!Number.isSafeInteger(candidate.importance) || candidate.importance < 1 || candidate.importance > 5) {
    throw new Error("invalid candidate");
  }
  if (
    typeof candidate.confidence !== "number" ||
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  ) {
    throw new Error("invalid candidate");
  }
  if (
    !Array.isArray(candidate.evidenceMessageIds) ||
    candidate.evidenceMessageIds.length === 0 ||
    candidate.evidenceMessageIds.length > MAX_CANDIDATE_EVIDENCE_IDS
  ) {
    throw new Error("invalid candidate");
  }
  const evidenceMessageIds = [...new Set(candidate.evidenceMessageIds.map((id) =>
    requireExactIdentifier(id),
  ))].sort(compareStrings);
  return {
    category: candidate.category,
    content,
    importance: candidate.importance,
    confidence: candidate.confidence,
    evidenceMessageIds,
  };
}

function normalizeCandidateContent(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.includes("\u0000") ||
    hasLoneSurrogate(value) ||
    /[\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value)
  ) {
    throw new Error("invalid candidate");
  }
  const content = value.trim();
  if (content.length === 0 || content.length > 4000) {
    throw new Error("invalid candidate");
  }
  return content;
}

function normalizeCompletionDiagnostics(
  diagnostics: MemoryExtractionDiagnostics,
  acceptedCount: number,
  conflictCandidateCount: number,
): MemoryExtractionDiagnostics {
  if (typeof diagnostics !== "object" || diagnostics === null) {
    throw new Error("invalid diagnostics");
  }
  const proposedCount = boundedDiagnosticCount(diagnostics.proposedCount);
  const normalizedAcceptedCount = boundedDiagnosticCount(diagnostics.acceptedCount);
  const rejectedCount = boundedDiagnosticCount(diagnostics.rejectedCount);
  const duplicateCount = boundedDiagnosticCount(diagnostics.duplicateCount);
  const conflictCount = boundedDiagnosticCount(diagnostics.conflictCount);
  if (
    normalizedAcceptedCount !== acceptedCount ||
    conflictCount !== conflictCandidateCount ||
    normalizedAcceptedCount + rejectedCount !== proposedCount ||
    duplicateCount + conflictCount > rejectedCount
  ) {
    throw new Error("invalid diagnostics");
  }
  if (
    !Array.isArray(diagnostics.rejectionCodes) ||
    diagnostics.rejectionCodes.length > MAX_ACCEPTED_CANDIDATES ||
    diagnostics.rejectionCodes.some((code) => !COMPLETION_REJECTION_CODES.has(code))
  ) {
    throw new Error("invalid diagnostics");
  }
  const rejectionCodes = [...new Set(diagnostics.rejectionCodes)].sort(compareStrings);
  if (rejectionCodes.length !== diagnostics.rejectionCodes.length) {
    throw new Error("invalid diagnostics");
  }
  return {
    proposedCount,
    acceptedCount: normalizedAcceptedCount,
    rejectedCount,
    duplicateCount,
    conflictCount,
    rejectionCodes,
  };
}

function boundedDiagnosticCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 8) {
    throw new Error("invalid diagnostics");
  }
  return value as number;
}

function createCompletionReplayDigest(input: {
  acceptedCandidates: ValidatedMemoryCandidate[];
  conflictCandidates: ValidatedMemoryConflictCandidate[];
  diagnostics: MemoryExtractionDiagnostics;
  threadOperations: ValidatedThreadOperation[];
  actionOperations: ValidatedActionOperation[];
  conversationStateDiagnostics: ConversationStateDiagnostics;
}): string {
  const conversationState = input.threadOperations.length + input.actionOperations.length +
    input.conversationStateDiagnostics.proposedCount === 0
    ? {}
    : {
        threadOperations: input.threadOperations,
        actionOperations: input.actionOperations,
        conversationStateDiagnostics: input.conversationStateDiagnostics,
      };
  const replayPayload = input.conflictCandidates.length === 0
    ? {
        acceptedCandidates: input.acceptedCandidates,
        diagnostics: input.diagnostics,
        ...conversationState,
      }
    : {
        acceptedCandidates: input.acceptedCandidates,
        conflictCandidates: input.conflictCandidates,
        diagnostics: input.diagnostics,
        ...conversationState,
      };
  return createHash("sha256")
    .update(JSON.stringify(replayPayload), "utf8")
    .digest("base64url");
}

function createCompletionMarker(input: {
  diagnostics: MemoryExtractionDiagnostics;
  replayDigest: string;
}): string {
  const persistedRejectionCodes = input.diagnostics.rejectionCodes.slice(0, 2).join(",");
  return [
    "v3",
    `p${input.diagnostics.proposedCount}`,
    `a${input.diagnostics.acceptedCount}`,
    `r${input.diagnostics.rejectedCount}`,
    `d${input.diagnostics.duplicateCount}`,
    `c${input.diagnostics.conflictCount}`,
    `x${persistedRejectionCodes}`,
    `h${input.replayDigest}`,
  ].join(":");
}

function parseCompletionMarker(value: unknown): {
  acceptedCount: number;
  replayDigest: string;
} | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^v3:p([0-8]):a([0-8]):r([0-8]):d([0-8]):c([0-8]):x([^:]*):h([A-Za-z0-9_-]{43})$/u.exec(value);
  if (match === null) {
    return undefined;
  }
  const proposedCount = Number(match[1]);
  const acceptedCount = Number(match[2]);
  const rejectedCount = Number(match[3]);
  const duplicateCount = Number(match[4]);
  const conflictCount = Number(match[5]);
  const rejectionCodes = match[6]!.length === 0 ? [] : match[6]!.split(",");
  if (
    acceptedCount + rejectedCount !== proposedCount ||
    duplicateCount + conflictCount > rejectedCount ||
    rejectionCodes.length > 2 ||
    new Set(rejectionCodes).size !== rejectionCodes.length ||
    rejectionCodes.some((code) => !COMPLETION_REJECTION_CODES.has(code)) ||
    [...rejectionCodes].sort(compareStrings).some((code, index) => code !== rejectionCodes[index])
  ) {
    return undefined;
  }
  return { acceptedCount, replayDigest: match[7]! };
}

async function admitCandidatesAgainstActiveMemories(input: {
  queryable: Queryable;
  groupId: string;
  acceptedCandidates: ValidatedMemoryCandidate[];
  diagnostics: MemoryExtractionDiagnostics;
}): Promise<{
  acceptedCandidates: ValidatedMemoryCandidate[];
  diagnostics: MemoryExtractionDiagnostics;
}> {
  const result = await input.queryable.query<ActiveMemoryContentRow>(
    `
    SELECT gm.id, gm.content
    FROM group_memories gm
    WHERE gm.group_id = $1 AND gm.status = 'active'
    ORDER BY gm.id ASC
    LIMIT $2
    `,
    [input.groupId, MAX_AUTHORITATIVE_ACTIVE_MEMORIES + 1],
  );
  if (result.rows.length > MAX_AUTHORITATIVE_ACTIVE_MEMORIES) {
    throw new MemoryExtractionCompletionConflictError();
  }
  const activeContent = new Set(result.rows.map((row) => {
    requireExactIdentifier(row.id);
    return authoritativeContentComparisonKey(row.content);
  }));
  const acceptedCandidates: ValidatedMemoryCandidate[] = [];
  let duplicateCount = 0;
  for (const candidate of input.acceptedCandidates) {
    const comparisonKey = authoritativeContentComparisonKey(candidate.content);
    if (activeContent.has(comparisonKey)) {
      duplicateCount += 1;
      continue;
    }
    activeContent.add(comparisonKey);
    acceptedCandidates.push({
      ...candidate,
      evidenceMessageIds: [...candidate.evidenceMessageIds],
    });
  }
  if (duplicateCount === 0) {
    return {
      acceptedCandidates,
      diagnostics: {
        ...input.diagnostics,
        rejectionCodes: [...input.diagnostics.rejectionCodes],
      },
    };
  }
  return {
    acceptedCandidates,
    diagnostics: {
      proposedCount: input.diagnostics.proposedCount,
      acceptedCount: input.diagnostics.acceptedCount - duplicateCount,
      rejectedCount: input.diagnostics.rejectedCount + duplicateCount,
      duplicateCount: input.diagnostics.duplicateCount + duplicateCount,
      conflictCount: input.diagnostics.conflictCount,
      rejectionCodes: [...new Set([
        ...input.diagnostics.rejectionCodes,
        "exact_duplicate",
      ])].sort(compareStrings),
    },
  };
}

function authoritativeContentComparisonKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.includes("\u0000") ||
    hasLoneSurrogate(value)
  ) {
    throw new MemoryExtractionCompletionConflictError();
  }
  const content = value.trim();
  if (content.length === 0 || content.length > 4000) {
    throw new MemoryExtractionCompletionConflictError();
  }
  return content.normalize("NFC").toLowerCase().normalize("NFC");
}

function completionIdempotencyKey(runId: string, canonicalCandidateIndex: number): string {
  return sha256(runId + String(canonicalCandidateIndex));
}

function validateClaimedCompletionRows(input: {
  rows: CompletionEvidenceRow[];
  runId: string;
  groupId: string;
  expectedStatus: "processing" | "completed";
}): { requestIds: string[]; evidenceMessageIds: Set<string> } {
  if (input.rows.length === 0 || input.rows.length > MAX_EVIDENCE_MESSAGES) {
    throw new MemoryExtractionCompletionConflictError();
  }
  const requestIds: string[] = [];
  const evidenceMessageIds = new Set<string>();
  for (const [expectedOrdinal, row] of input.rows.entries()) {
    const requestId = requireExactIdentifier(row.request_id);
    const messageId = requireExactIdentifier(row.conversation_message_id);
    if (
      Number(row.ordinal) !== expectedOrdinal ||
      row.request_status !== input.expectedStatus ||
      row.request_run_id !== input.runId ||
      row.request_group_id !== input.groupId ||
      row.message_group_id !== input.groupId ||
      requestIds.includes(requestId) ||
      evidenceMessageIds.has(messageId)
    ) {
      throw new MemoryExtractionCompletionConflictError();
    }
    requestIds.push(requestId);
    evidenceMessageIds.add(messageId);
  }
  return { requestIds, evidenceMessageIds };
}

function validateCompletionEvidence(
  acceptedCandidates: ValidatedMemoryCandidate[],
  authoritativeEvidenceIds: ReadonlySet<string>,
): void {
  if (
    acceptedCandidates.some((candidate) =>
      candidate.evidenceMessageIds.some((id) => !authoritativeEvidenceIds.has(id)),
    )
  ) {
    throw new MemoryExtractionCompletionConflictError();
  }
}

function validateCompletionConflictTargets(
  conflictCandidates: ValidatedMemoryConflictCandidate[],
  existingMemories: ExtractionExistingMemory[],
): void {
  const existingMemoryIds = new Set(existingMemories.map((memory) => memory.id));
  if (
    conflictCandidates.some((candidate) =>
      !existingMemoryIds.has(candidate.existingMemoryId),
    )
  ) {
    throw new MemoryExtractionCompletionConflictError();
  }
}

async function insertConflictCandidates(input: {
  queryable: Queryable;
  runId: string;
  conflictCandidates: ValidatedMemoryConflictCandidate[];
}): Promise<void> {
  for (const [conflictOrdinal, candidate] of input.conflictCandidates.entries()) {
    await input.queryable.query(
      `
      INSERT INTO group_memory_extraction_conflict_candidates (
        run_id, ordinal, category, content, importance, confidence, target_memory_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        input.runId,
        conflictOrdinal,
        candidate.category,
        candidate.content,
        candidate.importance,
        candidate.confidence,
        candidate.existingMemoryId,
      ],
    );
    for (const [evidenceOrdinal, messageId] of candidate.evidenceMessageIds.entries()) {
      await input.queryable.query(
        `
        INSERT INTO group_memory_extraction_conflict_evidence (
          run_id, conflict_ordinal, conversation_message_id, ordinal
        )
        VALUES ($1, $2, $3, $4)
        `,
        [input.runId, conflictOrdinal, messageId, evidenceOrdinal],
      );
    }
  }
}

async function loadCompletedMemoryIds(input: {
  queryable: Queryable;
  groupId: string;
  expectedIdempotencyKeys: string[];
  allIdempotencyKeys: string[];
}): Promise<string[]> {
  const result = await input.queryable.query<CompletionMemoryIdRow>(
    `
    SELECT id, idempotency_key
    FROM group_memories
    WHERE group_id = $1 AND idempotency_key = ANY($2::text[])
    ORDER BY idempotency_key ASC
    `,
    [input.groupId, input.allIdempotencyKeys],
  );
  const memoryByKey = new Map<string, string>();
  for (const row of result.rows) {
    const key = requireFingerprint(row.idempotency_key);
    const id = requireExactIdentifier(row.id);
    if (memoryByKey.has(key)) {
      throw new MemoryExtractionCompletionConflictError();
    }
    memoryByKey.set(key, id);
  }
  if (
    memoryByKey.size !== input.expectedIdempotencyKeys.length ||
    input.expectedIdempotencyKeys.some((key) => !memoryByKey.has(key))
  ) {
    throw new MemoryExtractionCompletionConflictError();
  }
  return input.expectedIdempotencyKeys.map((key) => memoryByKey.get(key)!);
}

function assertExactIds(actualValues: unknown[], expectedValues: string[]): void {
  const actual = actualValues.map(requireExactIdentifier).sort(compareStrings);
  const expected = [...expectedValues].sort(compareStrings);
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new MemoryExtractionCompletionConflictError();
  }
}

function compareCompletionCandidates(
  left: ValidatedMemoryCandidate,
  right: ValidatedMemoryCandidate,
): number {
  const leftKey = left.content.normalize("NFC").toLowerCase().normalize("NFC");
  const rightKey = right.content.normalize("NFC").toLowerCase().normalize("NFC");
  return compareStrings(left.category, right.category) ||
    compareStrings(leftKey, rightKey) ||
    compareStrings(left.content, right.content) ||
    compareStrings(JSON.stringify(left.evidenceMessageIds), JSON.stringify(right.evidenceMessageIds)) ||
    left.importance - right.importance ||
    left.confidence - right.confidence;
}

function compareCompletionConflictCandidates(
  left: ValidatedMemoryConflictCandidate,
  right: ValidatedMemoryConflictCandidate,
): number {
  return compareCompletionCandidates(left, right) ||
    compareStrings(left.existingMemoryId, right.existingMemoryId);
}

function requireExactIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_CHARS ||
    value !== value.trim() ||
    hasLoneSurrogate(value) ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  ) {
    throw new MemoryExtractionCompletionConflictError();
  }
  return value;
}

function requireFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new MemoryExtractionCompletionConflictError();
  }
  return value;
}

function requireRunStatus(value: unknown): "processing" | "completed" | "failed" {
  if (value === "processing" || value === "completed" || value === "failed") {
    return value;
  }
  throw new MemoryExtractionCompletionConflictError();
}

function requireOptionalClassification(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CLASSIFICATION_CHARS) {
    throw new Error("memory extraction run classification is invalid");
  }
  return value;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function markRunStale(queryable: Queryable, runId: string): Promise<void> {
  await queryable.query(
    `
    UPDATE group_memory_extraction_runs
    SET status = 'failed', failure_classification = 'input_stale',
        failure_count = failure_count + 1,
        completed_at = NULL, updated_at = NOW()
    WHERE id = $1 AND status <> 'completed'
    `,
    [runId],
  );
  await queryable.query(
    `
    UPDATE group_memory_extraction_requests
    SET status = 'pending', run_id = NULL, skip_reason = NULL, updated_at = NOW()
    WHERE run_id = $1 AND status = 'processing'
    `,
    [runId],
  );
  await queryable.query(
    `
    SELECT t.id
    FROM discussion_threads t
    WHERE t.id IN (
      SELECT rt.thread_id FROM group_memory_extraction_run_threads rt WHERE rt.run_id = $1
    )
    ORDER BY t.id ASC
    FOR SHARE
    `,
    [runId],
  );
  await queryable.query(
    `
    SELECT a.id
    FROM action_items a
    WHERE a.id IN (
      SELECT ra.action_item_id FROM group_memory_extraction_run_actions ra WHERE ra.run_id = $1
    )
    ORDER BY a.id ASC
    FOR SHARE
    `,
    [runId],
  );
}

async function lockRunFreshnessScopes(
  client: TransactionClient,
  runId: string,
): Promise<string | undefined> {
  const result = await client.query<{ group_id: unknown }>(
    "SELECT group_id FROM group_memory_extraction_runs WHERE id = $1",
    [runId],
  );
  if (result.rows.length === 0) return undefined;
  if (result.rows.length !== 1) throw new Error("memory extraction run query returned multiple rows");
  const groupId = requireExactIdentifier(result.rows[0]!.group_id);
  await lockGroupMemoryWriteScope({ queryable: client, groupId });
  await lockConversationStateWriteScope({ queryable: client as never, groupId });
  return groupId;
}

async function lockStoredRunInputs(queryable: Queryable, runId: string): Promise<void> {
  await queryable.query(
    `
    SELECT cm.id
    FROM conversation_messages cm
    WHERE cm.id IN (
      SELECT e.conversation_message_id
      FROM group_memory_extraction_run_evidence e
      WHERE e.run_id = $1
      UNION
      SELECT c.conversation_message_id
      FROM group_memory_extraction_run_context c
      WHERE c.run_id = $1
    )
    ORDER BY cm.id ASC
    FOR SHARE
    `,
    [runId],
  );
  await queryable.query(
    `
    SELECT gm.id
    FROM group_memories gm
    WHERE gm.id IN (
      SELECT rm.memory_id
      FROM group_memory_extraction_run_memories rm
      WHERE rm.run_id = $1
    )
    ORDER BY gm.id ASC
    FOR SHARE
    `,
    [runId],
  );
}

async function loadStoredRun(
  queryable: Queryable,
  runId: string,
  options: { lockInputs?: boolean } = {},
): Promise<
  | { status: "ready"; run: ClaimedMemoryExtractionRun }
  | { status: "completed" }
  | { status: "stale"; groupId: string; requestIds: string[] }
  | { status: "not_found" }
> {
  const runResult = await queryable.query<RunRow>(
    `
    SELECT id, group_id, input_fingerprint, status, failure_classification,
           enabled_operation_families
    FROM group_memory_extraction_runs
    WHERE id = $1
    FOR UPDATE
    `,
    [runId],
  );
  const [runRow] = runResult.rows;
  if (runRow === undefined) {
    return { status: "not_found" };
  }
  const status = requireString("run status", runRow.status);
  if (status === "completed") {
    return { status: "completed" };
  }
  const groupId = requireString("run group id", runRow.group_id);
  const inputFingerprint = requireString("input fingerprint", runRow.input_fingerprint);
  const enabledOperationFamilies = readPersistedOperationFamilies(
    runRow.enabled_operation_families,
  );
  const previousFailureClassification = status === "failed" || status === "processing"
    ? requireOptionalClassification(runRow.failure_classification)
    : undefined;

  if (options.lockInputs === true) {
    await lockStoredRunInputs(queryable, runId);
  }

  const evidenceResult = await queryable.query<MessageRow>(
    `
    SELECT
      e.request_id,
      e.conversation_message_id AS stored_message_id,
      e.content_hash AS stored_content_hash,
      cm.id,
      cm.chat_id,
      cm.sender_id,
      cm.sender_open_id,
      cm.sender_union_id,
      cm.sender_user_id,
      cm.text,
      cm.sent_at,
      cm.created_at
    FROM group_memory_extraction_run_evidence e
    LEFT JOIN conversation_messages cm ON cm.id = e.conversation_message_id
    WHERE e.run_id = $1
    ORDER BY e.ordinal ASC
    `,
    [runId],
  );
  const requestIds = evidenceResult.rows.map((row) =>
    requireString("request id", row.request_id),
  );
  const contextResult = await queryable.query<MessageRow>(
    `
    SELECT
      c.conversation_message_id AS stored_message_id,
      c.content_hash AS stored_content_hash,
      cm.id,
      cm.chat_id,
      cm.sender_id,
      cm.sender_open_id,
      cm.sender_union_id,
      cm.sender_user_id,
      cm.text,
      cm.sent_at,
      cm.created_at
    FROM group_memory_extraction_run_context c
    LEFT JOIN conversation_messages cm ON cm.id = c.conversation_message_id
    WHERE c.run_id = $1
    ORDER BY c.ordinal ASC
    `,
    [runId],
  );
  const memoryResult = await queryable.query<MemoryRow>(
    `
    SELECT
      rm.memory_id AS stored_memory_id,
      rm.memory_updated_at AS stored_updated_at,
      gm.id,
      gm.group_id,
      gm.category,
      gm.content,
      gm.status,
      gm.updated_at
    FROM group_memory_extraction_run_memories rm
    LEFT JOIN group_memories gm ON gm.id = rm.memory_id
    WHERE rm.run_id = $1
    ORDER BY rm.ordinal ASC
    `,
    [runId],
  );
  const mentionResult = await queryable.query<MentionRow>(
    `
    SELECT conversation_message_id, mention_key, mentioned_open_id
    FROM group_memory_extraction_run_mentions
    WHERE run_id = $1
    ORDER BY conversation_message_id ASC, mention_key ASC
    `,
    [runId],
  );
  const threadResult = await queryable.query<ThreadSnapshotRow>(
    `
    SELECT rt.thread_version AS stored_thread_version,
           rt.thread_updated_at AS stored_thread_updated_at,
           rt.thread_evidence_count AS stored_thread_evidence_count,
           t.id, t.group_id, t.title, t.summary, t.status, t.confidence,
           t.merged_into_thread_id, t.version, t.first_evidence_at, t.last_activity_at,
           t.resolved_at, t.created_at, t.updated_at,
           (SELECT COUNT(*)::bigint FROM discussion_thread_evidence evidence
            WHERE evidence.thread_id = t.id AND evidence.group_id = t.group_id) AS evidence_count
    FROM group_memory_extraction_run_threads rt
    LEFT JOIN discussion_threads t ON t.id = rt.thread_id
    WHERE rt.run_id = $1
    ORDER BY rt.ordinal ASC
    `,
    [runId],
  );
  const actionResult = await queryable.query<ActionSnapshotRow>(
    `
    SELECT ra.action_version AS stored_action_version,
           ra.action_updated_at AS stored_action_updated_at,
           a.id, a.group_id, a.thread_id, a.description, a.owner_ref_type, a.owner_ref,
           a.due_at, a.status, a.confidence, a.version, a.completed_at, a.cancelled_at,
           a.created_at, a.updated_at
    FROM group_memory_extraction_run_actions ra
    LEFT JOIN action_items a ON a.id = ra.action_item_id
    WHERE ra.run_id = $1
    ORDER BY ra.ordinal ASC
    `,
    [runId],
  );

  if (
    evidenceResult.rows.length === 0 ||
    evidenceResult.rows.some((row) => !messageRowIsCurrent(row, groupId, true)) ||
    contextResult.rows.some((row) => !messageRowIsCurrent(row, groupId, false)) ||
    memoryResult.rows.some((row) => !memoryRowIsCurrent(row, groupId)) ||
    threadResult.rows.some((row) => !threadSnapshotRowIsCurrent(row, groupId)) ||
    actionResult.rows.some((row) => !actionSnapshotRowIsCurrent(row, groupId))
  ) {
    return { status: "stale", groupId, requestIds };
  }

  const mentions = mentionResult.rows.map(mapMention);
  const evidenceMessagesWithoutMentions = evidenceResult.rows.map((row) => mapMessage(row, true));
  const contextMessagesWithoutMentions = contextResult.rows.map((row) => mapMessage(row, false));
  const currentMentions = enabledOperationFamilies.includes("action")
    ? await loadRunMentions(
      queryable,
      [...evidenceMessagesWithoutMentions, ...contextMessagesWithoutMentions],
    )
    : [];
  if (!sameMentions(mentions, currentMentions)) {
    return { status: "stale", groupId, requestIds };
  }
  const evidenceMessages = attachMentions(evidenceMessagesWithoutMentions, mentions);
  const contextMessages = attachMentions(contextMessagesWithoutMentions, mentions);
  const existingMemories = memoryResult.rows.map(mapMemory);
  const existingThreads = threadResult.rows.map(mapThreadSnapshot);
  const existingActions = actionResult.rows.map(mapActionSnapshot);
  const currentConversationState = await selectCurrentConversationState(
    queryable,
    groupId,
    enabledOperationFamilies,
  );
  if (
    !sameThreadSnapshots(existingThreads, currentConversationState.existingThreads) ||
    !sameActionSnapshots(existingActions, currentConversationState.existingActions)
  ) {
    return { status: "stale", groupId, requestIds };
  }
  const currentFingerprint = fingerprintInput({
    groupId,
    evidenceMessages,
    contextMessages,
    existingMemories,
    mentions,
    existingThreads,
    existingActions,
    enabledOperationFamilies,
  });
  if (currentFingerprint !== inputFingerprint) {
    return { status: "stale", groupId, requestIds };
  }
  return {
    status: "ready",
    run: {
      id: requireString("run id", runRow.id),
      groupId,
      inputFingerprint,
      requestIds,
      evidenceMessages,
      contextMessages,
      existingMemories,
      mentions,
      existingThreads,
      existingActions,
      enabledOperationFamilies,
      ...(previousFailureClassification === undefined
        ? {}
        : { previousFailureClassification }),
    },
  };
}

async function loadClaimRows(
  queryable: Queryable,
  requestIds: string[],
): Promise<ClaimMessageRow[]> {
  const result = await queryable.query<ClaimMessageRow>(
    `
    SELECT
      r.id AS request_id,
      r.group_id AS request_group_id,
      r.provider_message_id AS request_provider_message_id,
      r.status AS request_status,
      r.run_id AS request_run_id,
      cm.id,
      cm.chat_id,
      cm.sender_id,
      cm.sender_open_id,
      cm.sender_union_id,
      cm.sender_user_id,
      cm.text,
      cm.sent_at,
      cm.created_at
    FROM group_memory_extraction_requests r
    JOIN conversation_messages cm
      ON cm.id = r.conversation_message_id
     AND cm.chat_id = r.group_id
     AND cm.provider_message_id = r.provider_message_id
    WHERE r.id = ANY($1::text[])
    ORDER BY r.id ASC
    FOR UPDATE OF r SKIP LOCKED
    `,
    [requestIds],
  );
  return result.rows;
}

function validateClaimReferences(
  rows: RequestRouteRow[],
  requestIds: string[],
): { groupId: string; status: MemoryExtractionRequestStatus; runId?: string } | undefined {
  if (rows.length !== requestIds.length) {
    return undefined;
  }
  const routes = rows.map(mapRequestRoute);
  if (!sameIdentifierSet(routes.map(({ requestId }) => requestId), requestIds)) {
    return undefined;
  }
  const groupId = routes[0]!.groupId;
  const status = routes[0]!.status;
  const runId = routes[0]!.runId;
  if (
    routes.some((route) =>
      route.groupId !== groupId || route.status !== status || route.runId !== runId,
    )
  ) {
    throw new Error("memory extraction request routes do not form one durable scope");
  }
  return { groupId, status, ...(runId === undefined ? {} : { runId }) };
}

function validateClaimRows(
  rows: ClaimMessageRow[],
  requestIds: string[],
  expectedStatus: "pending" | "processing",
): { groupId: string; runId?: string } | undefined {
  if (rows.length !== requestIds.length) {
    return undefined;
  }
  const actualIds = rows.map((row) => requireExactIdentifier(row.request_id));
  if (!sameIdentifierSet(actualIds, requestIds)) {
    return undefined;
  }
  const groupId = requireExactIdentifier(rows[0]!.request_group_id);
  const runIdValue = rows[0]!.request_run_id;
  const runId = runIdValue === null || runIdValue === undefined
    ? undefined
    : requireExactIdentifier(runIdValue);
  for (const row of rows) {
    if (
      row.request_status !== expectedStatus ||
      row.request_group_id !== groupId ||
      row.chat_id !== groupId ||
      row.request_provider_message_id === null ||
      row.request_provider_message_id === undefined ||
      row.request_run_id !== (runId ?? null)
    ) {
      return undefined;
    }
  }
  if (expectedStatus === "processing" && runId === undefined) {
    return undefined;
  }
  if (expectedStatus === "pending" && runId !== undefined) {
    return undefined;
  }
  return { groupId, ...(runId === undefined ? {} : { runId }) };
}

function compareClaimMessageRows(left: ClaimMessageRow, right: ClaimMessageRow): number {
  const created = requireDate("message created at", left.created_at).getTime() -
    requireDate("message created at", right.created_at).getTime();
  return created === 0
    ? compareStrings(requireExactIdentifier(left.id), requireExactIdentifier(right.id))
    : created;
}

function messageRowIsCurrent(row: MessageRow, groupId: string, evidenceEligible: boolean): boolean {
  if (
    typeof row.id !== "string" ||
    row.id !== row.stored_message_id ||
    row.chat_id !== groupId ||
    typeof row.text !== "string"
  ) {
    return false;
  }
  try {
    return fingerprintMessage(mapMessage(row, evidenceEligible)) === row.stored_content_hash;
  } catch {
    return false;
  }
}

function memoryRowIsCurrent(row: MemoryRow, groupId: string): boolean {
  if (
    typeof row.id !== "string" ||
    row.id !== row.stored_memory_id ||
    row.group_id !== groupId ||
    row.status !== "active"
  ) {
    return false;
  }
  try {
    return mapMemory(row).updatedAt.getTime() === requireDate(
      "stored memory updated at",
      row.stored_updated_at,
    ).getTime();
  } catch {
    return false;
  }
}

function fingerprintInput(input: {
  groupId: string;
  evidenceMessages: ExtractionMessage[];
  contextMessages: ExtractionMessage[];
  existingMemories: ExtractionExistingMemory[];
  mentions: ExtractionMessageMention[];
  existingThreads: ExtractionExistingThread[];
  existingActions: ExtractionExistingAction[];
  enabledOperationFamilies: Array<"memory" | "thread" | "action">;
}): string {
  return sha256(
    JSON.stringify({
      groupId: input.groupId,
      evidenceMessages: input.evidenceMessages.map((message) => ({
        id: message.id,
        contentHash: fingerprintMessage(message),
      })),
      contextMessages: input.contextMessages.map((message) => ({
        id: message.id,
        contentHash: fingerprintMessage(message),
      })),
      existingMemories: input.existingMemories.map((memory) => ({
        id: memory.id,
        updatedAt: memory.updatedAt.toISOString(),
      })),
      mentions: [...input.mentions].sort(compareMentions).map((mention) => ({
        conversationMessageId: mention.conversationMessageId,
        key: mention.key,
        openId: mention.openId,
      })),
      existingThreads: [...input.existingThreads].sort((left, right) => compareStrings(left.id, right.id)).map((thread) => ({
        id: thread.id,
        version: thread.version,
        updatedAt: thread.updatedAt.toISOString(),
        evidenceCount: thread.evidenceCount,
      })),
      existingActions: [...input.existingActions].sort((left, right) => compareStrings(left.id, right.id)).map((action) => ({
        id: action.id,
        version: action.version,
        updatedAt: action.updatedAt.toISOString(),
      })),
      enabledOperationFamilies: [...input.enabledOperationFamilies].sort(compareStrings),
    }),
  );
}

function fingerprintMessage(message: ExtractionMessage): string {
  return sha256(
    JSON.stringify({
      id: message.id,
      groupId: message.groupId,
      senderId: message.senderId ?? null,
      ...(message.senderOpenId === undefined ? {} : { senderOpenId: message.senderOpenId }),
      ...(message.senderUnionId === undefined ? {} : { senderUnionId: message.senderUnionId }),
      ...(message.senderUserId === undefined ? {} : { senderUserId: message.senderUserId }),
      text: message.text,
      sentAt: message.sentAt.toISOString(),
      createdAt: message.createdAt.toISOString(),
      evidenceEligible: message.evidenceEligible,
    }),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function mapRequest(row: RequestRow): MemoryExtractionRequest {
  const status = requireRequestStatus(row.status);
  return {
    id: requireString("request id", row.id),
    groupId: requireString("request group id", row.group_id),
    ...(row.conversation_message_id === null || row.conversation_message_id === undefined
      ? {}
      : {
          conversationMessageId: requireString(
            "request conversation message id",
            row.conversation_message_id,
          ),
        }),
    providerMessageId: requireString("request provider message id", row.provider_message_id),
    status,
    ...(row.run_id === null || row.run_id === undefined
      ? {}
      : { runId: requireString("request run id", row.run_id) }),
    ...(row.skip_reason === null || row.skip_reason === undefined
      ? {}
      : { skipReason: requireString("request skip reason", row.skip_reason) }),
    createdAt: requireDate("request created at", row.created_at),
    updatedAt: requireDate("request updated at", row.updated_at),
  };
}

function mapMessage(row: MessageRow, evidenceEligible: boolean): ExtractionMessage {
  return {
    id: requireString("message id", row.id),
    groupId: requireString("message group id", row.chat_id),
    ...(row.sender_id === null || row.sender_id === undefined
      ? {}
      : { senderId: requireString("message sender id", row.sender_id) }),
    ...(row.sender_open_id === null || row.sender_open_id === undefined
      ? {}
      : { senderOpenId: requireString("message sender open id", row.sender_open_id) }),
    ...(row.sender_union_id === null || row.sender_union_id === undefined
      ? {}
      : { senderUnionId: requireString("message sender union id", row.sender_union_id) }),
    ...(row.sender_user_id === null || row.sender_user_id === undefined
      ? {}
      : { senderUserId: requireString("message sender user id", row.sender_user_id) }),
    text: requireString("message text", row.text, true),
    sentAt: requireDate("message sent at", row.sent_at),
    createdAt: requireDate("message created at", row.created_at),
    evidenceEligible,
  };
}

function mapMemory(row: MemoryRow): ExtractionExistingMemory {
  return {
    id: requireString("memory id", row.id),
    category: requireString("memory category", row.category),
    content: requireString("memory content", row.content, true),
    updatedAt: requireDate("memory updated at", row.updated_at),
  };
}

function mapMention(row: MentionRow): ExtractionMessageMention {
  return {
    conversationMessageId: requireExactIdentifier(row.conversation_message_id),
    key: requireBoundedString("mention key", row.mention_key, MAX_IDENTIFIER_CHARS),
    openId: requireBoundedString("mentioned open id", row.mentioned_open_id, MAX_IDENTIFIER_CHARS),
  };
}

async function loadRunMentions(
  queryable: Queryable,
  messages: ExtractionMessage[],
): Promise<ExtractionMessageMention[]> {
  if (messages.length === 0) return [];
  const messageIds = messages.map((message) => message.id).sort(compareStrings);
  const result = await queryable.query<MentionRow>(
    `
    SELECT conversation_message_id, mention_key, mentioned_open_id
    FROM conversation_message_mentions
    WHERE conversation_message_id = ANY($1::text[])
    ORDER BY conversation_message_id ASC, mention_key ASC
    `,
    [messageIds],
  );
  const mentions = result.rows.map(mapMention);
  if (mentions.some((mention) => !messageIds.includes(mention.conversationMessageId))) {
    throw new Error("mention does not belong to extraction run message");
  }
  return mentions;
}

function attachMentions(
  messages: ExtractionMessage[],
  mentions: ExtractionMessageMention[],
): ExtractionMessage[] {
  const byMessage = new Map<string, Array<{ key: string; openId: string }>>();
  for (const mention of mentions) {
    const values = byMessage.get(mention.conversationMessageId) ?? [];
    values.push({ key: mention.key, openId: mention.openId });
    byMessage.set(mention.conversationMessageId, values);
  }
  return messages.map((message) => ({
    ...message,
    mentions: (byMessage.get(message.id) ?? []).sort((left, right) =>
      compareStrings(left.key, right.key) || compareStrings(left.openId, right.openId),
    ),
  }));
}

function compareMentions(left: ExtractionMessageMention, right: ExtractionMessageMention): number {
  return compareStrings(left.conversationMessageId, right.conversationMessageId) ||
    compareStrings(left.key, right.key) || compareStrings(left.openId, right.openId);
}

function sameMentions(
  left: ExtractionMessageMention[],
  right: ExtractionMessageMention[],
): boolean {
  const canonicalLeft = [...left].sort(compareMentions);
  const canonicalRight = [...right].sort(compareMentions);
  return canonicalLeft.length === canonicalRight.length && canonicalLeft.every((mention, index) => {
    const other = canonicalRight[index]!;
    return mention.conversationMessageId === other.conversationMessageId &&
      mention.key === other.key && mention.openId === other.openId;
  });
}

async function selectCurrentConversationState(
  queryable: Queryable,
  groupId: string,
  enabledOperationFamilies: ClaimedMemoryExtractionRun["enabledOperationFamilies"],
): Promise<{
  existingThreads: ExtractionExistingThread[];
  existingActions: ExtractionExistingAction[];
}> {
  const threadsResult = enabledOperationFamilies.includes("thread")
    ? await queryable.query<ThreadSnapshotRow>(
    `
    SELECT t.id, t.group_id, t.title, t.summary, t.status, t.confidence,
           t.merged_into_thread_id, t.version, t.first_evidence_at,
           t.last_activity_at, t.resolved_at, t.created_at, t.updated_at,
           COUNT(evidence.conversation_message_id)::bigint AS evidence_count
    FROM discussion_threads t
    LEFT JOIN discussion_thread_evidence evidence
      ON evidence.thread_id = t.id AND evidence.group_id = t.group_id
    WHERE t.group_id = $1
      AND t.status IN ('candidate', 'open', 'resolved')
      AND t.retrieval_state = 'visible'
    GROUP BY t.id
    ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
             t.last_activity_at DESC, t.id ASC
    LIMIT $2
    `,
    [groupId, MAX_CONVERSATION_STATE_SNAPSHOTS],
    )
    : { rows: [] };
  const actionsResult = enabledOperationFamilies.includes("action")
    ? await queryable.query<ActionSnapshotRow>(
    `
    SELECT id, group_id, thread_id, description, owner_ref_type, owner_ref, due_at,
           status, confidence, version, completed_at, cancelled_at, created_at, updated_at
    FROM action_items
    WHERE group_id = $1
      AND retrieval_state = 'visible'
      AND NOT EXISTS (
        SELECT 1
        FROM discussion_threads dependency
        WHERE dependency.id = action_items.thread_id
          AND dependency.group_id = action_items.group_id
          AND (
            dependency.status IN ('candidate', 'merged')
            OR dependency.retrieval_state <> 'visible'
          )
      )
    ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, updated_at DESC, id ASC
    LIMIT $2
    `,
    [groupId, MAX_CONVERSATION_STATE_SNAPSHOTS],
    )
    : { rows: [] };
  return {
    existingThreads: threadsResult.rows.map(mapThreadSnapshot),
    existingActions: actionsResult.rows.map(mapActionSnapshot),
  };
}

function sameThreadSnapshots(
  stored: ExtractionExistingThread[],
  current: ExtractionExistingThread[],
): boolean {
  return stored.length === current.length && stored.every((thread, index) => {
    const selected = current[index]!;
    return thread.id === selected.id && thread.version === selected.version &&
      thread.updatedAt.getTime() === selected.updatedAt.getTime() &&
      thread.evidenceCount === selected.evidenceCount;
  });
}

function sameActionSnapshots(
  stored: ExtractionExistingAction[],
  current: ExtractionExistingAction[],
): boolean {
  return stored.length === current.length && stored.every((action, index) => {
    const selected = current[index]!;
    return action.id === selected.id && action.version === selected.version &&
      action.updatedAt.getTime() === selected.updatedAt.getTime();
  });
}

function mapThreadSnapshot(row: ThreadSnapshotRow): ExtractionExistingThread {
  const status = requireThreadStatus(row.status);
  const mergedIntoThreadId = row.merged_into_thread_id === null || row.merged_into_thread_id === undefined
    ? undefined : requireExactIdentifier(row.merged_into_thread_id);
  const resolvedAt = row.resolved_at === null || row.resolved_at === undefined
    ? undefined : requireDate("thread resolved at", row.resolved_at);
  if ((status === "merged") !== (mergedIntoThreadId !== undefined) || (status === "resolved") !== (resolvedAt !== undefined)) {
    throw new Error("persisted discussion thread is invalid");
  }
  return {
    id: requireExactIdentifier(row.id), groupId: requireExactIdentifier(row.group_id),
    title: requireBoundedString("thread title", row.title, MAX_IDENTIFIER_CHARS),
    summary: requireBoundedString("thread summary", row.summary, 4000), status,
    confidence: requireConfidence(row.confidence), ...(mergedIntoThreadId === undefined ? {} : { mergedIntoThreadId }),
    version: requirePersistedVersion(row.version), evidenceCount: requireNumber("thread evidence count", row.evidence_count),
    firstEvidenceAt: requireDate("thread first evidence at", row.first_evidence_at),
    lastActivityAt: requireDate("thread last activity at", row.last_activity_at),
    ...(resolvedAt === undefined ? {} : { resolvedAt }), createdAt: requireDate("thread created at", row.created_at),
    updatedAt: requireDate("thread updated at", row.updated_at),
  };
}

function mapActionSnapshot(row: ActionSnapshotRow): ExtractionExistingAction {
  const status = requireActionStatus(row.status);
  const threadId = row.thread_id === null || row.thread_id === undefined ? undefined : requireExactIdentifier(row.thread_id);
  const dueAt = row.due_at === null || row.due_at === undefined ? undefined : requireDate("action due at", row.due_at);
  const completedAt = row.completed_at === null || row.completed_at === undefined ? undefined : requireDate("action completed at", row.completed_at);
  const cancelledAt = row.cancelled_at === null || row.cancelled_at === undefined ? undefined : requireDate("action cancelled at", row.cancelled_at);
  if ((status === "completed") !== (completedAt !== undefined) || (status === "cancelled") !== (cancelledAt !== undefined)) throw new Error("persisted action item is invalid");
  return {
    id: requireExactIdentifier(row.id), groupId: requireExactIdentifier(row.group_id), ...(threadId === undefined ? {} : { threadId }),
    description: requireBoundedString("action description", row.description, 4000),
    ownerRefType: requireOwnerRefType(row.owner_ref_type), ownerRef: requireExactIdentifier(row.owner_ref),
    ...(dueAt === undefined ? {} : { dueAt }), status, confidence: requireConfidence(row.confidence), version: requirePersistedVersion(row.version),
    ...(completedAt === undefined ? {} : { completedAt }), ...(cancelledAt === undefined ? {} : { cancelledAt }),
    createdAt: requireDate("action created at", row.created_at), updatedAt: requireDate("action updated at", row.updated_at),
  };
}

function threadSnapshotRowIsCurrent(row: ThreadSnapshotRow, groupId: string): boolean {
  try {
    const thread = mapThreadSnapshot(row);
    return thread.groupId === groupId && thread.version === requirePersistedVersion(row.stored_thread_version) &&
      thread.updatedAt.getTime() === requireDate("stored thread updated at", row.stored_thread_updated_at).getTime() &&
      thread.evidenceCount === requireNumber("stored thread evidence count", row.stored_thread_evidence_count);
  } catch { return false; }
}

function actionSnapshotRowIsCurrent(row: ActionSnapshotRow, groupId: string): boolean {
  try {
    const action = mapActionSnapshot(row);
    return action.groupId === groupId && action.version === requirePersistedVersion(row.stored_action_version) &&
      action.updatedAt.getTime() === requireDate("stored action updated at", row.stored_action_updated_at).getTime();
  } catch { return false; }
}

function mapRequestRoute(row: RequestRouteRow): MemoryExtractionRequestRoute {
  const status = requireRequestStatus(row.status);
  const runId = row.run_id === null || row.run_id === undefined
    ? undefined
    : requireBoundedString(
        "request run id",
        requireString("request run id", row.run_id),
        MAX_IDENTIFIER_CHARS,
      );
  if ((status === "processing" || status === "completed") && runId === undefined) {
    throw new Error("terminal extraction request has no run");
  }
  return {
    requestId: requireBoundedString(
      "request id",
      requireString("request id", row.id),
      MAX_IDENTIFIER_CHARS,
    ),
    groupId: requireBoundedString(
      "request group id",
      requireString("request group id", row.group_id),
      MAX_IDENTIFIER_CHARS,
    ),
    status,
    ...(runId === undefined ? {} : { runId }),
  };
}

function normalizeIdentifierSet(fieldName: string, value: unknown, maximum: number): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  if (value.length > maximum) {
    throw new Error(`${fieldName} must contain at most ${maximum} identifiers`);
  }
  const identifiers = value.map((identifier) =>
    requireBoundedString(fieldName, requireString(fieldName, identifier), MAX_IDENTIFIER_CHARS),
  );
  if (new Set(identifiers).size !== identifiers.length) {
    throw new Error(`${fieldName} must not contain duplicate identifiers`);
  }
  return identifiers.sort(compareStrings);
}

function normalizeOperationFamilies(
  value: unknown,
): ClaimedMemoryExtractionRun["enabledOperationFamilies"] {
  if (value === undefined) {
    return ["memory", "thread", "action"];
  }
  if (!Array.isArray(value)) {
    throw new Error("enabledOperationFamilies must be an array");
  }
  const families = value.map((family) => requireString("operation family", family));
  const canonical = ["memory", "thread", "action"].filter((family) =>
    families.includes(family)
  ) as ClaimedMemoryExtractionRun["enabledOperationFamilies"];
  if (
    canonical.length !== families.length ||
    !canonical.includes("memory") ||
    (canonical.includes("action") && !canonical.includes("thread"))
  ) {
    throw new Error("enabledOperationFamilies is invalid");
  }
  return canonical;
}

function readPersistedOperationFamilies(
  value: unknown,
): ClaimedMemoryExtractionRun["enabledOperationFamilies"] {
  return normalizeOperationFamilies(value);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameIdentifierSet(left: string[], right: string[]): boolean {
  const canonicalLeft = [...left].sort(compareStrings);
  const canonicalRight = [...right].sort(compareStrings);
  return canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((value, index) => value === canonicalRight[index]);
}

function identifierSetContainsAll(authoritative: string[], requested: string[]): boolean {
  const authoritativeIds = new Set(authoritative);
  return requested.every((identifier) => authoritativeIds.has(identifier));
}

function requireRequestStatus(value: unknown): MemoryExtractionRequestStatus {
  if (
    value === "pending" ||
    value === "processing" ||
    value === "completed" ||
    value === "skipped"
  ) {
    return value;
  }
  throw new Error("invalid memory extraction request status");
}

function isReadableText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requireBoundedString(fieldName: string, value: unknown, maxChars: number): string {
  const normalized = requireString(fieldName, value);
  if (normalized.length > maxChars) {
    throw new Error(`${fieldName} must be at most ${maxChars} characters`);
  }
  return normalized;
}

function requireString(fieldName: string, value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`${fieldName} must be a non-blank string`);
  }
  return value;
}

function requireDate(fieldName: string, value: unknown): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value as string);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }
  return date;
}

function requireNumber(fieldName: string, value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
  return number;
}

function requirePersistedVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("persisted version is invalid");
  return version;
}

function requireConfidence(value: unknown): number {
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("confidence is invalid");
  return confidence;
}

function requireThreadStatus(value: unknown): ExtractionExistingThread["status"] {
  if (value === "candidate" || value === "open" || value === "resolved" || value === "merged") return value;
  throw new Error("thread status is invalid");
}

function requireActionStatus(value: unknown): ExtractionExistingAction["status"] {
  if (value === "open" || value === "completed" || value === "cancelled") return value;
  throw new Error("action status is invalid");
}

function requireOwnerRefType(value: unknown): ExtractionExistingAction["ownerRefType"] {
  if (value === "feishu_user" || value === "text_label") return value;
  throw new Error("action owner type is invalid");
}

function boundedLimit(fieldName: string, value: number, maximum: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${fieldName} must be a finite safe-magnitude number`);
  }
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

async function withTransaction<T>(
  dataSource: PostgresMemoryExtractionDataSource,
  operation: (client: TransactionClient) => Promise<T>,
): Promise<T> {
  const client = await dataSource.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the operation failure.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
