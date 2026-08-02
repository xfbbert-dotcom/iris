import { createHash } from "node:crypto";

import { normalizeFeishuDocumentSourceUri } from "../documents/feishu-document-body-fetcher.js";
import type { AnswerReplySourceTraceInput } from "./answer-source-citation-renderer.js";
import {
  AnswerReplyPreparationConflictError,
  AnswerReplyVersionConflictError,
  createAnswerReplyDeliveryId,
  createAnswerReplySafeNoticeUuid,
  createAnswerReplyUuid,
  type AnswerReplyDelivery,
  type AnswerReplyDeliveryEvent,
  type AnswerReplyDeliveryEventType,
  type AnswerReplyDeliveryState,
  type AnswerReplyProvider,
  type AnswerReplyReceipt,
  type AnswerReplyRepository,
  type AnswerReplyRepositoryStatus,
  type AnswerReplySourceTrace,
  type PrepareAnswerReplyInput,
  type VersionedTransitionInput,
} from "./answer-reply-repository.js";

export type AnswerReplyQueryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export type AnswerReplyTransactionClient = AnswerReplyQueryable & { release(): void };

export type PostgresAnswerReplyDataSource = AnswerReplyQueryable & {
  connect(): Promise<AnswerReplyTransactionClient>;
};

const DELIVERY_COLUMNS = `
  id, provider, incoming_message_id, chat_id, reply_uuid, safe_notice_uuid,
  state, prepared_reply_text, rendered_reply_fingerprint, semantic_fingerprint,
  reply_message_id, safe_notice_message_id, attempt_count,
  safe_notice_attempt_count, version, created_at, updated_at,
  last_send_started_at, sent_at, permission_blocked_at,
  reconciliation_required_at, safe_notice_sent_at
`;
const MAX_REFERENCE_CHARS = 512;
const MAX_REPLY_CHARS = 8000;
const MAX_SOURCE_URI_CHARS = 2048;
const MAX_SOURCE_TRACES = 1000;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const DELIVERY_STATES: readonly AnswerReplyDeliveryState[] = [
  "prepared",
  "sending",
  "sent",
  "permission_blocked",
  "reconciliation_required",
];
const EVENT_TYPES: readonly AnswerReplyDeliveryEventType[] = [
  "prepared",
  "send_started",
  "sent",
  "permission_blocked",
  "reconciliation_required",
  "safe_notice_send_started",
  "safe_notice_sent",
];
const SOURCE_TYPES = ["feishu_wiki", "feishu_group_document", "manual_upload"] as const;

type DeliveryRow = {
  id: unknown;
  provider: unknown;
  incoming_message_id: unknown;
  chat_id: unknown;
  reply_uuid: unknown;
  safe_notice_uuid: unknown;
  state: unknown;
  prepared_reply_text: unknown;
  rendered_reply_fingerprint: unknown;
  semantic_fingerprint: unknown;
  reply_message_id: unknown;
  safe_notice_message_id: unknown;
  attempt_count: unknown;
  safe_notice_attempt_count: unknown;
  version: unknown;
  created_at: unknown;
  updated_at: unknown;
  last_send_started_at: unknown;
  sent_at: unknown;
  permission_blocked_at: unknown;
  reconciliation_required_at: unknown;
  safe_notice_sent_at: unknown;
};

type SourceTraceRow = {
  id: unknown;
  delivery_id: unknown;
  prompt_rank: unknown;
  citation_rank: unknown;
  document_source_id: unknown;
  document_snapshot_id: unknown;
  fragment_id: unknown;
  chunk_index: unknown;
  source_type: unknown;
  source_uri: unknown;
  source_title: unknown;
  content_hash: unknown;
  embedding_profile_id: unknown;
  initial_permission_checked_at: unknown;
};

type EventRow = {
  id: unknown;
  delivery_id: unknown;
  sequence: unknown;
  event_type: unknown;
  attempt_number: unknown;
  source_count: unknown;
  document_source_ids: unknown;
  created_at: unknown;
};

type NormalizedPrepareInput = {
  provider: AnswerReplyProvider;
  incomingMessageId: string;
  chatId: string;
  replyUuid: string;
  safeNoticeUuid: string;
  renderedText: string;
  sourceTraces: AnswerReplySourceTraceInput[];
  at: Date;
  deliveryId: string;
  renderedReplyFingerprint: string;
  semanticFingerprint: string;
};

class AnswerReplyPersistenceError extends Error {
  constructor() {
    super("answer reply persistence failed");
    this.name = "AnswerReplyPersistenceError";
  }
}

class AnswerReplyTransitionError extends Error {
  constructor() {
    super("answer reply transition invalid");
    this.name = "AnswerReplyTransitionError";
  }
}

class AnswerReplyNotFoundError extends Error {
  constructor() {
    super("answer reply delivery not found");
    this.name = "AnswerReplyNotFoundError";
  }
}

export function createPostgresAnswerReplyRepository(input: {
  dataSource: PostgresAnswerReplyDataSource;
}): AnswerReplyRepository {
  const { dataSource } = input;

  return {
    async findByIncomingMessage(findInput) {
      const provider = requireProvider(findInput.provider);
      const incomingMessageId = requireReference(
        "incomingMessageId",
        findInput.incomingMessageId,
      );
      return withReadOnlyRepeatableRead(dataSource, async (client) => {
        const result = await client.query<DeliveryRow>(
          `SELECT ${DELIVERY_COLUMNS}
           FROM answer_reply_deliveries
           WHERE provider = $1 AND incoming_message_id = $2`,
          [provider, incomingMessageId],
        );
        const row = result.rows[0];
        return row === undefined
          ? undefined
          : await loadReceipt(client, mapDelivery(row));
      });
    },

    async prepare(prepareInput) {
      const normalized = normalizePrepareInput(prepareInput);
      return withTransaction(dataSource, async (client) => {
        await acquireAdvisoryLock(
          client,
          `${normalized.provider}:${normalized.incomingMessageId}`,
        );
        const existingResult = await client.query<DeliveryRow>(
          `SELECT ${DELIVERY_COLUMNS}
           FROM answer_reply_deliveries
           WHERE provider = $1 AND incoming_message_id = $2
           FOR UPDATE`,
          [normalized.provider, normalized.incomingMessageId],
        );
        const existingRow = existingResult.rows[0];
        if (existingRow !== undefined) {
          const existing = mapDelivery(existingRow);
          if (existing.semanticFingerprint !== normalized.semanticFingerprint) {
            throw new AnswerReplyPreparationConflictError();
          }
          return {
            outcome: "already_applied" as const,
            receipt: await loadReceipt(client, existing),
          };
        }

        await client.query(
          `INSERT INTO answer_reply_deliveries (
             id, provider, incoming_message_id, chat_id, reply_uuid,
             safe_notice_uuid, state, prepared_reply_text,
             rendered_reply_fingerprint, semantic_fingerprint,
             reply_message_id, safe_notice_message_id, attempt_count,
             safe_notice_attempt_count, version, created_at, updated_at,
             last_send_started_at, sent_at, permission_blocked_at,
             reconciliation_required_at, safe_notice_sent_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'prepared', $7, $8, $9,
             NULL, NULL, 0, 0, 1, $10, $10, NULL, NULL, NULL, NULL, NULL
           )`,
          [
            normalized.deliveryId,
            normalized.provider,
            normalized.incomingMessageId,
            normalized.chatId,
            normalized.replyUuid,
            normalized.safeNoticeUuid,
            normalized.renderedText,
            normalized.renderedReplyFingerprint,
            normalized.semanticFingerprint,
            normalized.at,
          ],
        );

        for (const trace of normalized.sourceTraces) {
          await insertSourceTrace(client, normalized.deliveryId, trace);
        }
        await insertEvent(client, {
          deliveryId: normalized.deliveryId,
          sequence: 1,
          eventType: "prepared",
          sourceCount: normalized.sourceTraces.length,
          documentSourceIds: uniqueDocumentSourceIds(normalized.sourceTraces),
          at: normalized.at,
        });

        return {
          outcome: "applied" as const,
          receipt: await loadReceiptById(client, normalized.deliveryId),
        };
      });
    },

    async beginAnswerSend(transitionInput) {
      const normalized = normalizeTransitionInput(transitionInput);
      return withLockedDelivery(dataSource, normalized, async (client, delivery, sources) => {
        if (delivery.state !== "prepared" && delivery.state !== "sending") {
          throw new AnswerReplyTransitionError();
        }
        const nextVersion = delivery.version + 1;
        const attemptNumber = delivery.attemptCount + 1;
        await requireSingleRow(client.query<{ id: string }>(
          `UPDATE answer_reply_deliveries
           SET state = 'sending', attempt_count = attempt_count + 1,
               version = version + 1, updated_at = $3, last_send_started_at = $3
           WHERE id = $1 AND version = $2
             AND state IN ('prepared', 'sending')
           RETURNING id`,
          [delivery.id, delivery.version, normalized.at],
        ));
        await insertEvent(client, {
          deliveryId: delivery.id,
          sequence: nextVersion,
          eventType: "send_started",
          attemptNumber,
          sourceCount: sources.length,
          documentSourceIds: uniqueDocumentSourceIds(sources),
          at: normalized.at,
        });
        return loadReceiptById(client, delivery.id);
      });
    },

    async completeAnswerSend(transitionInput) {
      const normalized = normalizeTransitionInput(transitionInput);
      const replyMessageId = normalizeOptionalReference(
        "replyMessageId",
        transitionInput.replyMessageId,
      );
      return withLockedDelivery(dataSource, normalized, async (client, delivery, sources) => {
        if (delivery.state !== "sending" || delivery.attemptCount < 1) {
          throw new AnswerReplyTransitionError();
        }
        const nextVersion = delivery.version + 1;
        await requireSingleRow(client.query<{ id: string }>(
          `UPDATE answer_reply_deliveries
           SET state = 'sent', prepared_reply_text = NULL,
               reply_message_id = $3, version = version + 1,
               updated_at = $4, sent_at = $4
           WHERE id = $1 AND version = $2 AND state = 'sending'
           RETURNING id`,
          [delivery.id, delivery.version, replyMessageId ?? null, normalized.at],
        ));
        await insertEvent(client, {
          deliveryId: delivery.id,
          sequence: nextVersion,
          eventType: "sent",
          sourceCount: sources.length,
          documentSourceIds: uniqueDocumentSourceIds(sources),
          at: normalized.at,
        });
        return loadReceiptById(client, delivery.id);
      });
    },

    async blockForPermission(transitionInput) {
      const normalized = normalizeTransitionInput(transitionInput);
      const requestedDocumentSourceIds = requireDocumentSourceIds(
        transitionInput.documentSourceIds,
      );
      return withLockedDelivery(dataSource, normalized, async (client, delivery, sources) => {
        if (delivery.state !== "prepared" && delivery.state !== "sending") {
          throw new AnswerReplyTransitionError();
        }
        const blockedDocumentSourceIds = requireAuthoritativeDocumentSourceIds(
          requestedDocumentSourceIds,
          sources,
        );
        const nextVersion = delivery.version + 1;
        const state = delivery.attemptCount === 0
          ? "permission_blocked" as const
          : "reconciliation_required" as const;
        if (state === "permission_blocked") {
          await requireSingleRow(client.query<{ id: string }>(
            `UPDATE answer_reply_deliveries
             SET state = 'permission_blocked', prepared_reply_text = NULL,
                 version = version + 1, updated_at = $3,
                 permission_blocked_at = $3
             WHERE id = $1 AND version = $2
               AND state IN ('prepared', 'sending') AND attempt_count = 0
             RETURNING id`,
            [delivery.id, delivery.version, normalized.at],
          ));
        } else {
          await requireSingleRow(client.query<{ id: string }>(
            `UPDATE answer_reply_deliveries
             SET state = 'reconciliation_required', prepared_reply_text = NULL,
                 version = version + 1, updated_at = $3,
                 reconciliation_required_at = $3
             WHERE id = $1 AND version = $2
               AND state IN ('prepared', 'sending') AND attempt_count > 0
             RETURNING id`,
            [delivery.id, delivery.version, normalized.at],
          ));
        }
        await insertEvent(client, {
          deliveryId: delivery.id,
          sequence: nextVersion,
          eventType: state,
          sourceCount: sources.length,
          documentSourceIds: blockedDocumentSourceIds,
          at: normalized.at,
        });
        return loadReceiptById(client, delivery.id);
      });
    },

    async beginSafeNoticeSend(transitionInput) {
      const normalized = normalizeTransitionInput(transitionInput);
      return withLockedDelivery(dataSource, normalized, async (client, delivery, sources) => {
        requireSafeNoticePending(delivery);
        const nextVersion = delivery.version + 1;
        const attemptNumber = delivery.safeNoticeAttemptCount + 1;
        await requireSingleRow(client.query<{ id: string }>(
          `UPDATE answer_reply_deliveries
           SET safe_notice_attempt_count = safe_notice_attempt_count + 1,
               version = version + 1, updated_at = $3
           WHERE id = $1 AND version = $2
             AND state IN ('permission_blocked', 'reconciliation_required')
             AND safe_notice_sent_at IS NULL
           RETURNING id`,
          [delivery.id, delivery.version, normalized.at],
        ));
        await insertEvent(client, {
          deliveryId: delivery.id,
          sequence: nextVersion,
          eventType: "safe_notice_send_started",
          attemptNumber,
          sourceCount: sources.length,
          documentSourceIds: uniqueDocumentSourceIds(sources),
          at: normalized.at,
        });
        return loadReceiptById(client, delivery.id);
      });
    },

    async completeSafeNoticeSend(transitionInput) {
      const normalized = normalizeTransitionInput(transitionInput);
      const safeNoticeMessageId = normalizeOptionalReference(
        "safeNoticeMessageId",
        transitionInput.safeNoticeMessageId,
      );
      return withLockedDelivery(dataSource, normalized, async (client, delivery, sources) => {
        requireSafeNoticePending(delivery);
        if (delivery.safeNoticeAttemptCount < 1) {
          throw new AnswerReplyTransitionError();
        }
        const nextVersion = delivery.version + 1;
        await requireSingleRow(client.query<{ id: string }>(
          `UPDATE answer_reply_deliveries
           SET safe_notice_message_id = $3, safe_notice_sent_at = $4,
               version = version + 1, updated_at = $4
           WHERE id = $1 AND version = $2
             AND state IN ('permission_blocked', 'reconciliation_required')
             AND safe_notice_attempt_count > 0 AND safe_notice_sent_at IS NULL
           RETURNING id`,
          [delivery.id, delivery.version, safeNoticeMessageId ?? null, normalized.at],
        ));
        await insertEvent(client, {
          deliveryId: delivery.id,
          sequence: nextVersion,
          eventType: "safe_notice_sent",
          sourceCount: sources.length,
          documentSourceIds: uniqueDocumentSourceIds(sources),
          at: normalized.at,
        });
        return loadReceiptById(client, delivery.id);
      });
    },

    async getStatus(): Promise<AnswerReplyRepositoryStatus> {
      try {
        const result = await dataSource.query<{
          unresolved_count: unknown;
          pending_safe_notice_count: unknown;
          reconciliation_required_count: unknown;
        }>(
          `SELECT
             COUNT(*) FILTER (WHERE state IN ('prepared', 'sending')) AS unresolved_count,
             COUNT(*) FILTER (
               WHERE state IN ('permission_blocked', 'reconciliation_required')
                 AND safe_notice_sent_at IS NULL
             ) AS pending_safe_notice_count,
             COUNT(*) FILTER (
               WHERE state = 'reconciliation_required'
             ) AS reconciliation_required_count
           FROM answer_reply_deliveries`,
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw new Error("answer reply status row is invalid");
        }
        return {
          unresolvedCount: requireSafeInteger(row.unresolved_count),
          pendingSafeNoticeCount: requireSafeInteger(row.pending_safe_notice_count),
          reconciliationRequiredCount: requireSafeInteger(
            row.reconciliation_required_count,
          ),
        };
      } catch {
        throw new AnswerReplyPersistenceError();
      }
    },
  };
}

async function withLockedDelivery<T>(
  dataSource: PostgresAnswerReplyDataSource,
  input: VersionedTransitionInput,
  operation: (
    client: AnswerReplyTransactionClient,
    delivery: AnswerReplyDelivery,
    sources: AnswerReplySourceTrace[],
  ) => Promise<T>,
): Promise<T> {
  return withTransaction(dataSource, async (client) => {
    await acquireAdvisoryLock(client, input.deliveryId);
    const result = await client.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS}
       FROM answer_reply_deliveries
       WHERE id = $1
       FOR UPDATE`,
      [input.deliveryId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AnswerReplyNotFoundError();
    }
    const delivery = mapDelivery(row);
    if (delivery.version !== input.expectedVersion) {
      throw new AnswerReplyVersionConflictError();
    }
    const sources = await loadSources(client, delivery.id);
    return operation(client, delivery, sources);
  });
}

async function loadReceiptById(
  queryable: AnswerReplyQueryable,
  deliveryId: string,
): Promise<AnswerReplyReceipt> {
  const result = await queryable.query<DeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS}
     FROM answer_reply_deliveries
     WHERE id = $1`,
    [deliveryId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new AnswerReplyNotFoundError();
  }
  return loadReceipt(queryable, mapDelivery(row));
}

async function loadReceipt(
  queryable: AnswerReplyQueryable,
  delivery: AnswerReplyDelivery,
): Promise<AnswerReplyReceipt> {
  const [sources, events] = await Promise.all([
    loadSources(queryable, delivery.id),
    loadEvents(queryable, delivery.id),
  ]);
  return { delivery, sources, events };
}

async function loadSources(
  queryable: AnswerReplyQueryable,
  deliveryId: string,
): Promise<AnswerReplySourceTrace[]> {
  const result = await queryable.query<SourceTraceRow>(
    `SELECT
       id, delivery_id, prompt_rank, citation_rank, document_source_id,
       document_snapshot_id, fragment_id, chunk_index, source_type,
       source_uri, source_title, content_hash, embedding_profile_id,
       initial_permission_checked_at
     FROM answer_reply_source_traces
     WHERE delivery_id = $1
     ORDER BY prompt_rank ASC`,
    [deliveryId],
  );
  return result.rows.map(mapSourceTrace);
}

async function loadEvents(
  queryable: AnswerReplyQueryable,
  deliveryId: string,
): Promise<AnswerReplyDeliveryEvent[]> {
  const result = await queryable.query<EventRow>(
    `SELECT
       id, delivery_id, sequence, event_type, attempt_number,
       source_count, document_source_ids, created_at
     FROM answer_reply_delivery_events
     WHERE delivery_id = $1
     ORDER BY sequence ASC`,
    [deliveryId],
  );
  return result.rows.map(mapEvent);
}

async function insertSourceTrace(
  client: AnswerReplyTransactionClient,
  deliveryId: string,
  trace: AnswerReplySourceTraceInput,
): Promise<void> {
  await client.query(
    `INSERT INTO answer_reply_source_traces (
       id, delivery_id, prompt_rank, citation_rank, document_source_id,
       document_snapshot_id, fragment_id, chunk_index, source_type,
       source_uri, source_title, content_hash, embedding_profile_id,
       initial_permission_checked_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
     )`,
    [
      createSourceTraceId(deliveryId, trace.promptRank),
      deliveryId,
      trace.promptRank,
      trace.citationRank ?? null,
      trace.documentSourceId,
      trace.documentSnapshotId,
      trace.fragmentId,
      trace.chunkIndex,
      trace.sourceType,
      trace.sourceUri,
      trace.sourceTitle ?? null,
      trace.contentHash,
      trace.embeddingProfileId,
      trace.initialPermissionCheckedAt,
    ],
  );
}

async function insertEvent(
  client: AnswerReplyTransactionClient,
  input: {
    deliveryId: string;
    sequence: number;
    eventType: AnswerReplyDeliveryEventType;
    attemptNumber?: number;
    sourceCount: number;
    documentSourceIds: string[];
    at: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO answer_reply_delivery_events (
       id, delivery_id, sequence, event_type, attempt_number,
       source_count, document_source_ids, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      createEventId(input.deliveryId, input.sequence),
      input.deliveryId,
      input.sequence,
      input.eventType,
      input.attemptNumber ?? null,
      input.sourceCount,
      input.documentSourceIds,
      input.at,
    ],
  );
}

async function acquireAdvisoryLock(
  client: AnswerReplyTransactionClient,
  key: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [key],
  );
}

async function requireSingleRow(
  query: Promise<{ rows: Array<{ id: string }> }>,
): Promise<void> {
  const result = await query;
  if (result.rows.length !== 1) {
    throw new AnswerReplyTransitionError();
  }
}

async function withTransaction<T>(
  dataSource: PostgresAnswerReplyDataSource,
  operation: (client: AnswerReplyTransactionClient) => Promise<T>,
): Promise<T> {
  let client: AnswerReplyTransactionClient | undefined;
  try {
    client = await dataSource.connect();
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (client !== undefined) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    if (isContentFreeDomainError(error)) {
      throw error;
    }
    throw new AnswerReplyPersistenceError();
  } finally {
    if (client !== undefined) {
      try {
        client.release();
      } catch {
        // Connection release failures must not expose driver details or content.
      }
    }
  }
}

async function withReadOnlyRepeatableRead<T>(
  dataSource: PostgresAnswerReplyDataSource,
  operation: (client: AnswerReplyTransactionClient) => Promise<T>,
): Promise<T> {
  let client: AnswerReplyTransactionClient | undefined;
  try {
    client = await dataSource.connect();
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch {
    if (client !== undefined) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw new AnswerReplyPersistenceError();
  } finally {
    if (client !== undefined) {
      try {
        client.release();
      } catch {
        // Connection release failures must not expose driver details or content.
      }
    }
  }
}

function normalizePrepareInput(input: PrepareAnswerReplyInput): NormalizedPrepareInput {
  const provider = requireProvider(input.provider);
  const incomingMessageId = requireReference("incomingMessageId", input.incomingMessageId);
  const chatId = requireReference("chatId", input.chatId);
  const replyUuid = requireBoundedString("replyUuid", input.replyUuid, 50);
  const safeNoticeUuid = requireBoundedString("safeNoticeUuid", input.safeNoticeUuid, 50);
  if (replyUuid !== createAnswerReplyUuid(incomingMessageId)) {
    throw new Error("replyUuid is invalid");
  }
  if (safeNoticeUuid !== createAnswerReplySafeNoticeUuid(incomingMessageId)) {
    throw new Error("safeNoticeUuid is invalid");
  }
  const renderedText = requireExactString("renderedText", input.renderedText, MAX_REPLY_CHARS);
  const sourceTraces = normalizeSourceTraces(input.sourceTraces);
  const at = requireDate(input.at);
  const renderedReplyFingerprint = sha256(renderedText);
  const semanticFingerprint = fingerprint({
    provider,
    incomingMessageId,
    chatId,
    renderedReplyFingerprint,
    sourceTraces: sourceTraces.map((trace) => ({
      promptRank: trace.promptRank,
      citationRank: trace.citationRank,
      documentSourceId: trace.documentSourceId,
      documentSnapshotId: trace.documentSnapshotId,
      fragmentId: trace.fragmentId,
      chunkIndex: trace.chunkIndex,
      sourceType: trace.sourceType,
      sourceUri: trace.sourceUri,
      sourceTitle: trace.sourceTitle,
      contentHash: trace.contentHash,
      embeddingProfileId: trace.embeddingProfileId,
    })),
  });
  return {
    provider,
    incomingMessageId,
    chatId,
    replyUuid,
    safeNoticeUuid,
    renderedText,
    sourceTraces,
    at,
    deliveryId: createAnswerReplyDeliveryId(provider, incomingMessageId),
    renderedReplyFingerprint,
    semanticFingerprint,
  };
}

function normalizeSourceTraces(
  value: readonly AnswerReplySourceTraceInput[],
): AnswerReplySourceTraceInput[] {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_TRACES) {
    throw new Error("sourceTraces is invalid");
  }
  return value.map((trace, index) => {
    if (trace === null || typeof trace !== "object" || trace.promptRank !== index + 1) {
      throw new Error("sourceTrace promptRank is invalid");
    }
    const citationRank = trace.citationRank === undefined
      ? undefined
      : requireInteger("sourceTrace citationRank", trace.citationRank, 1, 3);
    const sourceType = trace.sourceType;
    if (!SOURCE_TYPES.includes(sourceType)) {
      throw new Error("sourceTrace sourceType is invalid");
    }
    return {
      promptRank: index + 1,
      ...(citationRank === undefined ? {} : { citationRank }),
      documentSourceId: requireReference("sourceTrace documentSourceId", trace.documentSourceId),
      documentSnapshotId: requireReference(
        "sourceTrace documentSnapshotId",
        trace.documentSnapshotId,
      ),
      fragmentId: requireReference("sourceTrace fragmentId", trace.fragmentId),
      chunkIndex: requireInteger("sourceTrace chunkIndex", trace.chunkIndex, 0),
      sourceType,
      sourceUri: requireSourceUri(trace.sourceUri),
      ...(trace.sourceTitle === undefined
        ? {}
        : {
            sourceTitle: requireBoundedString(
              "sourceTrace sourceTitle",
              trace.sourceTitle,
              MAX_REFERENCE_CHARS,
            ),
          }),
      contentHash: requireFingerprint("sourceTrace contentHash", trace.contentHash),
      embeddingProfileId: requireReference(
        "sourceTrace embeddingProfileId",
        trace.embeddingProfileId,
      ),
      initialPermissionCheckedAt: requireDate(trace.initialPermissionCheckedAt),
    };
  });
}

function normalizeTransitionInput(input: VersionedTransitionInput): VersionedTransitionInput {
  return {
    deliveryId: requireReference("deliveryId", input.deliveryId),
    expectedVersion: requireInteger("expectedVersion", input.expectedVersion, 1),
    at: requireDate(input.at),
  };
}

function requireDocumentSourceIds(value: string[]): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SOURCE_TRACES) {
    throw new Error("documentSourceIds is invalid");
  }
  const normalized = value.map((item) => requireReference("documentSourceId", item));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("documentSourceIds is invalid");
  }
  return normalized;
}

function requireAuthoritativeDocumentSourceIds(
  requested: readonly string[],
  sources: readonly AnswerReplySourceTrace[],
): string[] {
  const authoritative = uniqueDocumentSourceIds(sources);
  const authoritativeSet = new Set(authoritative);
  if (requested.some((documentSourceId) => !authoritativeSet.has(documentSourceId))) {
    throw new AnswerReplyTransitionError();
  }
  const requestedSet = new Set(requested);
  return authoritative.filter((documentSourceId) => requestedSet.has(documentSourceId));
}

function requireSafeNoticePending(delivery: AnswerReplyDelivery): void {
  if (
    (delivery.state !== "permission_blocked" && delivery.state !== "reconciliation_required")
    || delivery.safeNoticeSentAt !== undefined
  ) {
    throw new AnswerReplyTransitionError();
  }
}

function mapDelivery(row: DeliveryRow): AnswerReplyDelivery {
  const provider = requireDatabaseEnum(row.provider, ["feishu"] as const);
  const state = requireDatabaseEnum(row.state, DELIVERY_STATES);
  const incomingMessageId = requireDatabaseBoundedString(
    row.incoming_message_id,
    MAX_REFERENCE_CHARS,
  );
  const delivery: AnswerReplyDelivery = {
    id: requireDatabaseBoundedString(row.id, MAX_REFERENCE_CHARS),
    provider,
    incomingMessageId,
    chatId: requireDatabaseBoundedString(row.chat_id, MAX_REFERENCE_CHARS),
    replyUuid: requireDatabaseBoundedString(row.reply_uuid, 50),
    safeNoticeUuid: requireDatabaseBoundedString(row.safe_notice_uuid, 50),
    state,
    ...(row.prepared_reply_text === null
      ? {}
      : {
          preparedReplyText: requireDatabaseExactText(
            row.prepared_reply_text,
            MAX_REPLY_CHARS,
          ),
        }),
    renderedReplyFingerprint: requireDatabaseFingerprint(row.rendered_reply_fingerprint),
    semanticFingerprint: requireDatabaseFingerprint(row.semantic_fingerprint),
    ...(row.reply_message_id === null
      ? {}
      : {
          replyMessageId: requireDatabaseBoundedString(
            row.reply_message_id,
            MAX_REFERENCE_CHARS,
          ),
        }),
    ...(row.safe_notice_message_id === null
      ? {}
      : {
          safeNoticeMessageId: requireDatabaseBoundedString(
            row.safe_notice_message_id,
            MAX_REFERENCE_CHARS,
          ),
        }),
    attemptCount: requireDatabaseInteger(row.attempt_count, 0),
    safeNoticeAttemptCount: requireDatabaseInteger(row.safe_notice_attempt_count, 0),
    version: requireDatabaseInteger(row.version, 1),
    createdAt: requireDatabaseDate(row.created_at),
    updatedAt: requireDatabaseDate(row.updated_at),
    ...(row.last_send_started_at === null
      ? {}
      : { lastSendStartedAt: requireDatabaseDate(row.last_send_started_at) }),
    ...(row.sent_at === null ? {} : { sentAt: requireDatabaseDate(row.sent_at) }),
    ...(row.permission_blocked_at === null
      ? {}
      : { permissionBlockedAt: requireDatabaseDate(row.permission_blocked_at) }),
    ...(row.reconciliation_required_at === null
      ? {}
      : {
          reconciliationRequiredAt: requireDatabaseDate(
            row.reconciliation_required_at,
          ),
        }),
    ...(row.safe_notice_sent_at === null
      ? {}
      : { safeNoticeSentAt: requireDatabaseDate(row.safe_notice_sent_at) }),
  };
  requireDeliveryContract(delivery);
  if (
    delivery.id !== createAnswerReplyDeliveryId(provider, incomingMessageId)
    || delivery.replyUuid !== createAnswerReplyUuid(incomingMessageId)
    || delivery.safeNoticeUuid !== createAnswerReplySafeNoticeUuid(incomingMessageId)
  ) {
    throw new Error("answer reply database row is invalid");
  }
  return delivery;
}

function mapSourceTrace(row: SourceTraceRow): AnswerReplySourceTrace {
  const sourceType = requireDatabaseEnum(row.source_type, SOURCE_TYPES);
  return {
    id: requireDatabaseBoundedString(row.id, MAX_REFERENCE_CHARS),
    deliveryId: requireDatabaseBoundedString(row.delivery_id, MAX_REFERENCE_CHARS),
    promptRank: requireDatabaseInteger(row.prompt_rank, 1),
    ...(row.citation_rank === null
      ? {}
      : { citationRank: requireDatabaseInteger(row.citation_rank, 1, 3) }),
    documentSourceId: requireDatabaseBoundedString(
      row.document_source_id,
      MAX_REFERENCE_CHARS,
    ),
    documentSnapshotId: requireDatabaseBoundedString(
      row.document_snapshot_id,
      MAX_REFERENCE_CHARS,
    ),
    fragmentId: requireDatabaseBoundedString(row.fragment_id, MAX_REFERENCE_CHARS),
    chunkIndex: requireDatabaseInteger(row.chunk_index, 0),
    sourceType,
    sourceUri: requireDatabaseSourceUri(row.source_uri),
    ...(row.source_title === null
      ? {}
      : {
          sourceTitle: requireDatabaseBoundedString(
            row.source_title,
            MAX_REFERENCE_CHARS,
          ),
        }),
    contentHash: requireDatabaseFingerprint(row.content_hash),
    embeddingProfileId: requireDatabaseBoundedString(
      row.embedding_profile_id,
      MAX_REFERENCE_CHARS,
    ),
    initialPermissionCheckedAt: requireDatabaseDate(row.initial_permission_checked_at),
  };
}

function mapEvent(row: EventRow): AnswerReplyDeliveryEvent {
  const eventType = requireDatabaseEnum(row.event_type, EVENT_TYPES);
  const attemptNumber = row.attempt_number === null
    ? undefined
    : requireDatabaseInteger(row.attempt_number, 1);
  const sourceCount = requireDatabaseInteger(row.source_count, 0, MAX_SOURCE_TRACES);
  const documentSourceIds = requireDatabaseDocumentSourceIds(
    row.document_source_ids,
    sourceCount,
  );
  const attemptRequired = eventType === "send_started"
    || eventType === "safe_notice_send_started";
  if (attemptRequired !== (attemptNumber !== undefined)) {
    throw new Error("answer reply database row is invalid");
  }
  return {
    id: requireDatabaseBoundedString(row.id, MAX_REFERENCE_CHARS),
    deliveryId: requireDatabaseBoundedString(row.delivery_id, MAX_REFERENCE_CHARS),
    sequence: requireDatabaseInteger(row.sequence, 1),
    eventType,
    ...(row.attempt_number === null
      ? {}
      : { attemptNumber }),
    sourceCount,
    documentSourceIds,
    createdAt: requireDatabaseDate(row.created_at),
  };
}

function uniqueDocumentSourceIds(
  traces: readonly Pick<AnswerReplySourceTraceInput, "documentSourceId">[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const trace of traces) {
    if (!seen.has(trace.documentSourceId)) {
      seen.add(trace.documentSourceId);
      result.push(trace.documentSourceId);
    }
  }
  return result;
}

function createSourceTraceId(deliveryId: string, promptRank: number): string {
  return `answer-reply-source-${sha256(JSON.stringify([deliveryId, promptRank]))}`;
}

function createEventId(deliveryId: string, sequence: number): string {
  return `answer-reply-event-${sha256(JSON.stringify([deliveryId, sequence]))}`;
}

function fingerprint(value: unknown): string {
  return sha256(JSON.stringify(canonicalizeFingerprintValue(value)));
}

function canonicalizeFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeFingerprintValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizeFingerprintValue(item)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireProvider(value: unknown): AnswerReplyProvider {
  if (value !== "feishu") {
    throw new Error("provider is invalid");
  }
  return value;
}

function requireReference(name: string, value: unknown): string {
  return requireBoundedString(name, value, MAX_REFERENCE_CHARS);
}

function normalizeOptionalReference(name: string, value: unknown): string | undefined {
  return value === undefined ? undefined : requireReference(name, value);
}

function requireBoundedString(name: string, value: unknown, maxChars: number): string {
  if (typeof value !== "string") {
    throw new Error(`${name} is invalid`);
  }
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxChars) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function requireExactString(name: string, value: unknown, maxChars: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maxChars
    || value.trim().length < 1
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireFingerprint(name: string, value: unknown): string {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireSourceUri(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("sourceTrace sourceUri is invalid");
  }
  const normalized = normalizeFeishuDocumentSourceUri(value);
  if (normalized === undefined || normalized.length > MAX_SOURCE_URI_CHARS) {
    throw new Error("sourceTrace sourceUri is invalid");
  }
  return normalized;
}

function requireInteger(
  name: string,
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return Number(value);
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("date is invalid");
  }
  return new Date(value.getTime());
}

function requireDatabaseBoundedString(value: unknown, maxChars: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maxChars
    || value.trim() !== value
  ) {
    throw new Error("answer reply database row is invalid");
  }
  return value;
}

function requireDatabaseExactText(value: unknown, maxChars: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maxChars
    || value.trim().length < 1
  ) {
    throw new Error("answer reply database row is invalid");
  }
  return value;
}

function requireDatabaseFingerprint(value: unknown): string {
  const result = requireDatabaseBoundedString(value, 64);
  if (!FINGERPRINT_PATTERN.test(result)) {
    throw new Error("answer reply database row is invalid");
  }
  return result;
}

function requireDatabaseDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("answer reply database row is invalid");
  }
  return new Date(value.getTime());
}

function requireSafeInteger(value: unknown): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("answer reply database row is invalid");
  }
  return result;
}

function requireDatabaseInteger(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error("answer reply database row is invalid");
  }
  return result;
}

function requireDatabaseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error("answer reply database row is invalid");
  }
  return value as T;
}

function requireDatabaseSourceUri(value: unknown): string {
  const sourceUri = requireDatabaseBoundedString(value, MAX_SOURCE_URI_CHARS);
  const normalized = normalizeFeishuDocumentSourceUri(sourceUri);
  if (normalized === undefined || normalized !== sourceUri) {
    throw new Error("answer reply database row is invalid");
  }
  return sourceUri;
}

function requireDatabaseDocumentSourceIds(
  value: unknown,
  sourceCount: number,
): string[] {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_TRACES || value.length > sourceCount) {
    throw new Error("answer reply database row is invalid");
  }
  const result = value.map((item) =>
    requireDatabaseBoundedString(item, MAX_REFERENCE_CHARS));
  if (new Set(result).size !== result.length) {
    throw new Error("answer reply database row is invalid");
  }
  return result;
}

function requireDeliveryContract(delivery: AnswerReplyDelivery): void {
  const timestamps = [
    delivery.lastSendStartedAt,
    delivery.sentAt,
    delivery.permissionBlockedAt,
    delivery.reconciliationRequiredAt,
    delivery.safeNoticeSentAt,
  ].filter((value): value is Date => value !== undefined);
  if (
    delivery.updatedAt.getTime() < delivery.createdAt.getTime()
    || timestamps.some((value) => value.getTime() > delivery.updatedAt.getTime())
    || (delivery.attemptCount === 0) !== (delivery.lastSendStartedAt === undefined)
    || (delivery.safeNoticeMessageId !== undefined && delivery.safeNoticeSentAt === undefined)
    || (delivery.safeNoticeSentAt !== undefined && delivery.safeNoticeAttemptCount === 0)
  ) {
    throw new Error("answer reply database row is invalid");
  }

  const hasPreparedText = delivery.preparedReplyText !== undefined;
  const isSafeNoticeState = delivery.state === "permission_blocked"
    || delivery.state === "reconciliation_required";
  if (
    !isSafeNoticeState
    && (
      delivery.safeNoticeAttemptCount !== 0
      || delivery.safeNoticeMessageId !== undefined
      || delivery.safeNoticeSentAt !== undefined
    )
  ) {
    throw new Error("answer reply database row is invalid");
  }

  const validState = delivery.state === "prepared"
    ? hasPreparedText
      && delivery.attemptCount === 0
      && delivery.replyMessageId === undefined
      && delivery.sentAt === undefined
      && delivery.permissionBlockedAt === undefined
      && delivery.reconciliationRequiredAt === undefined
    : delivery.state === "sending"
      ? hasPreparedText
        && delivery.attemptCount > 0
        && delivery.replyMessageId === undefined
        && delivery.sentAt === undefined
        && delivery.permissionBlockedAt === undefined
        && delivery.reconciliationRequiredAt === undefined
      : delivery.state === "sent"
        ? !hasPreparedText
          && delivery.attemptCount > 0
          && delivery.sentAt !== undefined
          && delivery.permissionBlockedAt === undefined
          && delivery.reconciliationRequiredAt === undefined
        : delivery.state === "permission_blocked"
          ? !hasPreparedText
            && delivery.attemptCount === 0
            && delivery.replyMessageId === undefined
            && delivery.sentAt === undefined
            && delivery.permissionBlockedAt !== undefined
            && delivery.reconciliationRequiredAt === undefined
          : !hasPreparedText
            && delivery.attemptCount > 0
            && delivery.replyMessageId === undefined
            && delivery.sentAt === undefined
            && delivery.permissionBlockedAt === undefined
            && delivery.reconciliationRequiredAt !== undefined;
  if (!validState) {
    throw new Error("answer reply database row is invalid");
  }
}

function isContentFreeDomainError(error: unknown): boolean {
  return error instanceof AnswerReplyPreparationConflictError
    || error instanceof AnswerReplyVersionConflictError
    || error instanceof AnswerReplyTransitionError
    || error instanceof AnswerReplyNotFoundError;
}
