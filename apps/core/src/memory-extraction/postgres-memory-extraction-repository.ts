import { createHash, randomUUID } from "node:crypto";

import type {
  ClaimedMemoryExtractionRun,
  ExtractionExistingMemory,
  ExtractionMessage,
  MemoryExtractionRepository,
  MemoryExtractionRequest,
  MemoryExtractionRequestStatus,
} from "./memory-extraction-repository.js";

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

type SeedRequestRow = RequestRow & {
  message_group_id: unknown;
  message_provider_id: unknown;
  message_text: unknown;
};

type ExistingRequestRow = RequestRow & {
  message_group_id: unknown;
  message_provider_id: unknown;
  message_text: unknown;
};

type MessageRow = {
  request_id?: unknown;
  stored_message_id?: unknown;
  stored_content_hash?: unknown;
  id: unknown;
  chat_id: unknown;
  sender_id: unknown;
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
};

type StatusCountsRow = {
  pending: unknown;
  processing: unknown;
  completed: unknown;
  skipped: unknown;
  failed_runs: unknown;
};

const MAX_IDENTIFIER_CHARS = 512;
const MAX_CLASSIFICATION_CHARS = 128;
const MAX_EVIDENCE_MESSAGES = 40;
const MAX_CONTEXT_MESSAGES = 10;
const MAX_ACTIVE_MEMORIES = 8;
const READABLE_MESSAGE_TEXT_SQL = "cm.text ~ '[^[:space:]]'";

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

    async claimRun(rawInput) {
      const seedRequestId = requireBoundedString(
        "seedRequestId",
        rawInput.seedRequestId,
        MAX_IDENTIFIER_CHARS,
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
      if (maxEvidenceMessages === 0) {
        return undefined;
      }

      return withTransaction(dataSource, async (client) => {
        const seedRow = await findSeedRequest(client, seedRequestId, false);
        if (seedRow === undefined) {
          return undefined;
        }
        let seed = mapValidSeedRequest(seedRow);
        if (seed.status === "completed" || seed.status === "skipped") {
          return undefined;
        }
        if (seed.status === "processing" && seed.runId !== undefined) {
          const loaded = await loadStoredRun(client, seed.runId);
          const lockedSeedRow = await findSeedRequest(client, seedRequestId, true);
          if (lockedSeedRow === undefined) {
            return undefined;
          }
          const lockedSeed = mapValidSeedRequest(lockedSeedRow);
          if (lockedSeed.status !== "processing" || lockedSeed.runId !== seed.runId) {
            return undefined;
          }
          if (loaded.status === "ready") {
            await client.query(
              `
              UPDATE group_memory_extraction_runs
              SET status = 'processing', failure_classification = NULL,
                  completed_at = NULL, updated_at = NOW()
              WHERE id = $1 AND status = 'failed'
              `,
              [seed.runId],
            );
            return loaded.run;
          }
          return undefined;
        }
        const lockedSeedRow = await findSeedRequest(client, seedRequestId, true);
        if (lockedSeedRow === undefined) {
          return undefined;
        }
        seed = mapValidSeedRequest(lockedSeedRow);
        if (seed.status !== "pending") {
          return undefined;
        }
        if (!isReadableText(lockedSeedRow.message_text)) {
          await client.query(
            `
            UPDATE group_memory_extraction_requests
            SET status = 'skipped', skip_reason = 'unreadable_message', updated_at = NOW()
            WHERE id = $1 AND status = 'pending'
            `,
            [seedRequestId],
          );
          return undefined;
        }

        const evidenceResult = await client.query<MessageRow>(
          `
          SELECT
            r.id AS request_id,
            cm.id,
            cm.chat_id,
            cm.sender_id,
            cm.text,
            cm.sent_at,
            cm.created_at
          FROM group_memory_extraction_requests r
          JOIN conversation_messages cm
            ON cm.id = r.conversation_message_id
           AND cm.chat_id = r.group_id
           AND cm.provider_message_id = r.provider_message_id
          WHERE r.group_id = $1
            AND r.status = 'pending'
            AND ${READABLE_MESSAGE_TEXT_SQL}
          ORDER BY cm.created_at ASC, cm.id ASC
          LIMIT $2
          FOR UPDATE OF r SKIP LOCKED
          `,
          [seed.groupId, maxEvidenceMessages],
        );
        if (evidenceResult.rows.length === 0) {
          return undefined;
        }
        const evidenceMessages = evidenceResult.rows.map((row) => mapMessage(row, true));
        const requestIds = evidenceResult.rows.map((row) =>
          requireString("request id", row.request_id),
        );
        const firstEvidence = evidenceMessages[0]!;

        const contextResult = await client.query<MessageRow>(
          `
          SELECT cm.id, cm.chat_id, cm.sender_id, cm.text, cm.sent_at, cm.created_at
          FROM conversation_messages cm
          WHERE cm.chat_id = $1
            AND ${READABLE_MESSAGE_TEXT_SQL}
            AND (cm.created_at, cm.id) < ($2, $3)
            AND NOT (cm.id = ANY($4::text[]))
          ORDER BY cm.created_at DESC, cm.id DESC
          LIMIT $5
          `,
          [
            seed.groupId,
            firstEvidence.createdAt,
            firstEvidence.id,
            evidenceMessages.map((message) => message.id),
            contextMessageLimit,
          ],
        );
        const contextMessages = contextResult.rows
          .map((row) => mapMessage(row, false))
          .reverse();

        const memoryResult = await client.query<MemoryRow>(
          `
          SELECT id, group_id, category, content, status, updated_at
          FROM group_memories
          WHERE group_id = $1 AND status = 'active'
          ORDER BY importance DESC, updated_at DESC, id ASC
          LIMIT $2
          `,
          [seed.groupId, activeMemoryLimit],
        );
        const existingMemories = memoryResult.rows.map(mapMemory);
        const inputFingerprint = fingerprintInput({
          groupId: seed.groupId,
          evidenceMessages,
          contextMessages,
          existingMemories,
        });
        const runId = randomUUID();
        const runResult = await client.query<RunRow>(
          `
          INSERT INTO group_memory_extraction_runs (
            id, group_id, input_fingerprint, status
          )
          VALUES ($1, $2, $3, 'processing')
          RETURNING id, group_id, input_fingerprint, status
          `,
          [runId, seed.groupId, inputFingerprint],
        );
        if (runResult.rows.length !== 1) {
          throw new Error("memory extraction run insert returned no rows");
        }

        for (const [ordinal, row] of evidenceResult.rows.entries()) {
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
        await client.query(
          `
          UPDATE group_memory_extraction_requests
          SET status = 'processing', run_id = $1, skip_reason = NULL, updated_at = NOW()
          WHERE id = ANY($2::text[])
          `,
          [runId, requestIds],
        );

        return {
          id: runId,
          groupId: seed.groupId,
          inputFingerprint,
          requestIds,
          evidenceMessages,
          contextMessages,
          existingMemories,
        };
      });
    },

    async loadRunInput(runIdValue) {
      const runId = requireBoundedString("runId", runIdValue, MAX_IDENTIFIER_CHARS);
      return withTransaction(dataSource, async (client) => {
        const loaded = await loadStoredRun(client, runId);
        if (loaded.status !== "stale") {
          return loaded;
        }
        await client.query(
          `
          UPDATE group_memory_extraction_runs
          SET status = 'failed', failure_classification = 'input_stale',
              completed_at = NULL, updated_at = NOW()
          WHERE id = $1 AND status <> 'completed'
          `,
          [runId],
        );
        await client.query(
          `
          UPDATE group_memory_extraction_requests
          SET status = 'pending', run_id = NULL, skip_reason = NULL, updated_at = NOW()
          WHERE run_id = $1 AND status = 'processing'
          `,
          [runId],
        );
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
      await dataSource.query(
        `
        UPDATE group_memory_extraction_requests
        SET status = 'skipped', skip_reason = $2, updated_at = NOW()
        WHERE id = $1 AND status = 'pending'
        `,
        [requestId, reason],
      );
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
            completed_at = NULL, updated_at = NOW()
        WHERE id = $1 AND status <> 'completed'
        `,
        [runId, classification],
      );
    },

    async getStatusCounts() {
      const result = await dataSource.query<StatusCountsRow>(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
          COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
          (SELECT COUNT(*)::int FROM group_memory_extraction_runs WHERE status = 'failed')
            AS failed_runs
        FROM group_memory_extraction_requests
      `);
      const [row] = result.rows;
      if (row === undefined) {
        throw new Error("memory extraction status count returned no rows");
      }
      return {
        pending: requireNumber("pending count", row.pending),
        processing: requireNumber("processing count", row.processing),
        completed: requireNumber("completed count", row.completed),
        skipped: requireNumber("skipped count", row.skipped),
        failedRuns: requireNumber("failed run count", row.failed_runs),
      };
    },
  };
}

async function loadStoredRun(
  queryable: Queryable,
  runId: string,
): Promise<
  | { status: "ready"; run: ClaimedMemoryExtractionRun }
  | { status: "completed" }
  | { status: "stale"; groupId: string; requestIds: string[] }
  | { status: "not_found" }
> {
  const runResult = await queryable.query<RunRow>(
    `
    SELECT id, group_id, input_fingerprint, status
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

  const evidenceResult = await queryable.query<MessageRow>(
    `
    SELECT
      e.request_id,
      e.conversation_message_id AS stored_message_id,
      e.content_hash AS stored_content_hash,
      cm.id,
      cm.chat_id,
      cm.sender_id,
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

  if (
    evidenceResult.rows.length === 0 ||
    evidenceResult.rows.some((row) => !messageRowIsCurrent(row, groupId, true)) ||
    contextResult.rows.some((row) => !messageRowIsCurrent(row, groupId, false)) ||
    memoryResult.rows.some((row) => !memoryRowIsCurrent(row, groupId))
  ) {
    return { status: "stale", groupId, requestIds };
  }

  const evidenceMessages = evidenceResult.rows.map((row) => mapMessage(row, true));
  const contextMessages = contextResult.rows.map((row) => mapMessage(row, false));
  const existingMemories = memoryResult.rows.map(mapMemory);
  const currentFingerprint = fingerprintInput({
    groupId,
    evidenceMessages,
    contextMessages,
    existingMemories,
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
    },
  };
}

async function findSeedRequest(
  queryable: Queryable,
  seedRequestId: string,
  lock: boolean,
): Promise<SeedRequestRow | undefined> {
  const result = await queryable.query<SeedRequestRow>(
    `
    SELECT
      r.*,
      cm.chat_id AS message_group_id,
      cm.provider_message_id AS message_provider_id,
      cm.text AS message_text
    FROM group_memory_extraction_requests r
    JOIN conversation_messages cm ON cm.id = r.conversation_message_id
    WHERE r.id = $1
    ${lock ? "FOR UPDATE OF r SKIP LOCKED" : ""}
    `,
    [seedRequestId],
  );
  return result.rows[0];
}

function mapValidSeedRequest(row: SeedRequestRow): MemoryExtractionRequest {
  const seed = mapRequest(row);
  if (
    seed.groupId !== requireString("message group id", row.message_group_id) ||
    seed.providerMessageId !== requireString("message provider id", row.message_provider_id)
  ) {
    throw new Error("extraction request does not match conversation message");
  }
  return seed;
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
    }),
  );
}

function fingerprintMessage(message: ExtractionMessage): string {
  return sha256(
    JSON.stringify({
      id: message.id,
      groupId: message.groupId,
      senderId: message.senderId ?? null,
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
    conversationMessageId: requireString(
      "request conversation message id",
      row.conversation_message_id,
    ),
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

function requireBoundedString(fieldName: string, value: string, maxChars: number): string {
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
