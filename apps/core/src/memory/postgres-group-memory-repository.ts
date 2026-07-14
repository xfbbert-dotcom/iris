import { createHash, randomUUID } from "node:crypto";

import {
  GROUP_MEMORY_CATEGORIES,
  GroupMemoryIdempotencyConflictError,
  GROUP_MEMORY_ORIGINS,
  GROUP_MEMORY_SCOPES,
  type CorrectGroupMemoryInput,
  type CreateGroupMemoryInput,
  type GroupMemory,
  type GroupMemoryCategory,
  type GroupMemoryOrigin,
  type GroupMemoryRepository,
  type GroupMemoryStatus,
} from "./group-memory-repository.js";
import {
  fingerprintCreateGroupMemoryRequest,
  insertGroupMemoryRecordWithEvidence,
  normalizeCreateGroupMemory,
  type Queryable as GroupMemoryQueryable,
} from "./postgres-group-memory-writer.js";

export type Queryable = GroupMemoryQueryable;

export type TransactionClient = Queryable & { release(): void };

export type PostgresGroupMemoryDataSource = Queryable & {
  connect(): Promise<TransactionClient>;
};

type GroupMemoryRow = {
  id: unknown;
  group_id: unknown;
  memory_scope: unknown;
  category: unknown;
  thread_key: unknown;
  content: unknown;
  importance: unknown;
  confidence: unknown;
  status: unknown;
  idempotency_key: unknown;
  origin: unknown;
  created_by: unknown;
  supersedes_memory_id: unknown;
  request_fingerprint: unknown;
  evidence_message_ids?: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type IdempotentMemoryRecord = {
  memory: GroupMemory;
  requestFingerprint: string;
};

const MAX_IDENTIFIER_CHARS = 512;
const MAX_CONTENT_CHARS = 4000;
const MAX_LIST_LIMIT = 100;

const selectMemoryColumns = `
  gm.id,
  gm.group_id,
  gm.memory_scope,
  gm.category,
  gm.thread_key,
  gm.content,
  gm.importance,
  gm.confidence,
  gm.status,
  gm.idempotency_key,
  gm.origin,
  gm.created_by,
  gm.supersedes_memory_id,
  gm.request_fingerprint,
  COALESCE((
    SELECT array_agg(gmme.conversation_message_id ORDER BY gmme.conversation_message_id)
    FROM group_memory_message_evidence gmme
    WHERE gmme.memory_id = gm.id
  ), ARRAY[]::text[]) AS evidence_message_ids,
  gm.created_at,
  gm.updated_at
`;

export function createPostgresGroupMemoryRepository({
  dataSource,
}: {
  dataSource: PostgresGroupMemoryDataSource;
}): GroupMemoryRepository {
  return {
    async create(rawInput) {
      const id = randomUUID();
      const memoryInput = normalizeCreateGroupMemory({ id, ...rawInput });
      return withTransaction(dataSource, async (client) => {
        const result = await insertGroupMemoryRecordWithEvidence({
          queryable: client,
          memory: memoryInput,
          requestFingerprint: fingerprintCreateGroupMemoryRequest(memoryInput),
        });
        return result;
      });
    },

    async getById(id) {
      const memoryId = requireBoundedString("memoryId", id, MAX_IDENTIFIER_CHARS);
      return findById(dataSource, memoryId);
    },

    async listActiveByGroup(input) {
      return listByGroup(dataSource, input.groupId, input.limit, true);
    },

    async listByGroup(input) {
      return listByGroup(dataSource, input.groupId, input.limit, false);
    },

    async correct(rawInput) {
      const input = normalizeCorrectionInput(rawInput);
      const requestFingerprint = fingerprintCorrectionRequest(input);
      return withTransaction(dataSource, async (client) => {
        const original = await findByIdForUpdate(client, input.memoryId);
        if (original === undefined) {
          throw new Error("group memory not found");
        }

        const existing = await findByIdempotencyKey(
          client,
          original.groupId,
          input.idempotencyKey,
        );
        if (existing !== undefined) {
          assertCorrectionReplayMatches(existing, original, input, requestFingerprint);
          return { memory: existing.memory, created: false };
        }
        if (original.status !== "active") {
          throw new Error("group memory is not active");
        }

        const evidenceMessageIds = dedupeStrings([
          ...original.evidenceMessageIds,
          ...(input.evidenceMessageIds ?? []),
        ]);
        const replacementInput: CreateGroupMemoryInput = {
          groupId: original.groupId,
          scope: original.scope,
          category: original.category,
          ...(original.threadKey === undefined ? {} : { threadKey: original.threadKey }),
          content: input.content,
          importance: input.importance ?? original.importance,
          confidence: input.confidence ?? original.confidence,
          idempotencyKey: input.idempotencyKey,
          origin: input.origin,
          createdBy: input.createdBy,
          evidenceMessageIds,
        };
        const replacementId = randomUUID();
        const replacementResult = await insertGroupMemoryRecordWithEvidence({
          queryable: client,
          memory: { id: replacementId, ...replacementInput },
          requestFingerprint,
          supersedesMemoryId: original.id,
          existingChecked: true,
        });
        if (!replacementResult.created) {
          assertCorrectionReplayMatches(
            { memory: replacementResult.memory, requestFingerprint },
            original,
            input,
            requestFingerprint,
          );
          return { memory: replacementResult.memory, created: false };
        }

        await client.query(
          `
          UPDATE group_memories
          SET status = 'superseded', updated_at = NOW()
          WHERE id = $1 AND status = 'active'
          `,
          [original.id],
        );
        return {
          memory: replacementResult.memory,
          created: true,
        };
      });
    },

    async deleteById(id) {
      const memoryId = requireBoundedString("memoryId", id, MAX_IDENTIFIER_CHARS);
      const result = await dataSource.query<{ id: unknown }>(
        `DELETE FROM group_memories WHERE id = $1 RETURNING id`,
        [memoryId],
      );
      return result.rows.length === 0 ? "not_found" : "deleted";
    },
  };
}

function assertCorrectionReplayMatches(
  existing: IdempotentMemoryRecord,
  original: GroupMemory,
  input: CorrectGroupMemoryInput,
  requestFingerprint: string,
): void {
  const memory = existing.memory;
  const expectedEvidence = dedupeStrings([
    ...original.evidenceMessageIds,
    ...(input.evidenceMessageIds ?? []),
  ]);
  if (
    existing.requestFingerprint !== requestFingerprint ||
    memory.supersedesMemoryId !== original.id ||
    memory.groupId !== original.groupId ||
    memory.scope !== original.scope ||
    memory.category !== original.category ||
    memory.threadKey !== original.threadKey ||
    memory.content !== input.content ||
    memory.importance !== (input.importance ?? original.importance) ||
    memory.confidence !== (input.confidence ?? original.confidence) ||
    memory.origin !== input.origin ||
    memory.createdBy !== input.createdBy ||
    !haveSameStrings(memory.evidenceMessageIds, expectedEvidence)
  ) {
    throw new GroupMemoryIdempotencyConflictError();
  }
}

function fingerprintCorrectionRequest(input: CorrectGroupMemoryInput): string {
  return fingerprintRequest({
    version: 1,
    operation: "correct",
    memoryId: input.memoryId,
    content: input.content,
    importance: input.importance ?? null,
    confidence: input.confidence ?? null,
    idempotencyKey: input.idempotencyKey,
    origin: input.origin,
    createdBy: input.createdBy,
    evidenceMessageIds: input.evidenceMessageIds === undefined
      ? null
      : canonicalizeStrings(input.evidenceMessageIds),
  });
}

function fingerprintRequest(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function canonicalizeStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function haveSameStrings(left: string[], right: string[]): boolean {
  const leftValues = [...new Set(left)].sort();
  const rightValues = [...new Set(right)].sort();
  return (
    leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index])
  );
}

async function withTransaction<T>(
  dataSource: PostgresGroupMemoryDataSource,
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
      // Preserve the operation failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function findById(
  queryable: Queryable,
  id: string,
): Promise<GroupMemory | undefined> {
  const result = await queryable.query<GroupMemoryRow>(
    `SELECT ${selectMemoryColumns} FROM group_memories gm WHERE gm.id = $1`,
    [id],
  );
  return mapOptionalSingleRow(result.rows);
}

async function findByIdForUpdate(
  client: TransactionClient,
  id: string,
): Promise<GroupMemory | undefined> {
  const result = await client.query<GroupMemoryRow>(
    `SELECT ${selectMemoryColumns} FROM group_memories gm WHERE gm.id = $1 FOR UPDATE OF gm`,
    [id],
  );
  return mapOptionalSingleRow(result.rows);
}

async function findByIdempotencyKey(
  queryable: Queryable,
  groupId: string,
  idempotencyKey: string,
): Promise<IdempotentMemoryRecord | undefined> {
  const result = await queryable.query<GroupMemoryRow>(
    `
    SELECT ${selectMemoryColumns}
    FROM group_memories gm
    WHERE gm.group_id = $1 AND gm.idempotency_key = $2
    `,
    [groupId, idempotencyKey],
  );
  if (result.rows.length > 1) {
    throw new Error("group memory idempotency query returned multiple rows");
  }
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : {
        memory: mapRow(row),
        requestFingerprint: requireRequestFingerprint(row.request_fingerprint),
      };
}

async function listByGroup(
  queryable: Queryable,
  rawGroupId: string,
  rawLimit: number,
  activeOnly: boolean,
): Promise<GroupMemory[]> {
  const groupId = requireBoundedString("groupId", rawGroupId, MAX_IDENTIFIER_CHARS);
  const limit = sanitizeLimit(rawLimit);
  const result = await queryable.query<GroupMemoryRow>(
    `
    SELECT ${selectMemoryColumns}
    FROM group_memories gm
    WHERE gm.group_id = $1${activeOnly ? " AND gm.status = 'active'" : ""}
    ORDER BY gm.importance DESC, gm.updated_at DESC, gm.id ASC
    LIMIT $2
    `,
    [groupId, limit],
  );
  return result.rows.map((row) => mapRow(row));
}

function requireRequestFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("memory request fingerprint is invalid");
  }
  return value;
}

function normalizeCorrectionInput(input: CorrectGroupMemoryInput): CorrectGroupMemoryInput {
  return {
    memoryId: requireBoundedString("memoryId", input.memoryId, MAX_IDENTIFIER_CHARS),
    content: requireBoundedString("content", input.content, MAX_CONTENT_CHARS),
    ...(input.importance === undefined
      ? {}
      : { importance: requireImportance(input.importance) }),
    ...(input.confidence === undefined
      ? {}
      : { confidence: requireConfidence(input.confidence) }),
    idempotencyKey: requireBoundedString(
      "idempotencyKey",
      input.idempotencyKey,
      MAX_IDENTIFIER_CHARS,
    ),
    origin: requireEnum("origin", input.origin, GROUP_MEMORY_ORIGINS),
    createdBy: requireBoundedString("createdBy", input.createdBy, MAX_IDENTIFIER_CHARS),
    ...(input.evidenceMessageIds === undefined
      ? {}
      : { evidenceMessageIds: normalizeOptionalEvidence(input.evidenceMessageIds) }),
  };
}

function normalizeOptionalEvidence(value: string[]): string[] {
  if (!Array.isArray(value)) {
    throw new Error("evidenceMessageIds must be an array");
  }
  return dedupeStrings(
    value.map((id) =>
      requireBoundedString("evidenceMessageId", id, MAX_IDENTIFIER_CHARS),
    ),
  );
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function requireBoundedString(fieldName: string, value: unknown, maxChars: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must not be blank`);
  }
  if (value.length > maxChars) {
    throw new Error(`${fieldName} must be at most ${maxChars} characters`);
  }
  return value.trim();
}

function requireEnum<T extends string>(
  fieldName: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${fieldName} is invalid`);
  }
  return value as T;
}

function requireImportance(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error("importance must be an integer from 1 to 5");
  }
  return value;
}

function requireConfidence(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("confidence must be a finite number from 0 to 1");
  }
  return value;
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error("group memory limit must be a finite safe-magnitude number");
  }
  return Math.min(MAX_LIST_LIMIT, Math.max(0, Math.floor(value)));
}

function mapOptionalSingleRow(rows: GroupMemoryRow[]): GroupMemory | undefined {
  if (rows.length > 1) {
    throw new Error("group memory query returned multiple rows");
  }
  return rows[0] === undefined ? undefined : mapRow(rows[0]);
}

function mapRow(row: GroupMemoryRow, evidenceOverride?: string[]): GroupMemory {
  const scope = requireEnum("memory scope", row.memory_scope, GROUP_MEMORY_SCOPES);
  const threadKey = row.thread_key === null
    ? undefined
    : requireBoundedString("memory thread key", row.thread_key, MAX_IDENTIFIER_CHARS);
  const supersedesMemoryId = row.supersedes_memory_id === null
    ? undefined
    : requireBoundedString(
        "supersedes memory id",
        row.supersedes_memory_id,
        MAX_IDENTIFIER_CHARS,
      );
  const evidenceMessageIds = evidenceOverride ?? readEvidenceArray(row.evidence_message_ids);
  return {
    id: requireBoundedString("memory id", row.id, MAX_IDENTIFIER_CHARS),
    groupId: requireBoundedString("memory group id", row.group_id, MAX_IDENTIFIER_CHARS),
    scope,
    category: requireEnum("memory category", row.category, GROUP_MEMORY_CATEGORIES),
    ...(threadKey === undefined ? {} : { threadKey }),
    content: requireBoundedString("memory content", row.content, MAX_CONTENT_CHARS),
    importance: requireImportance(Number(row.importance)),
    confidence: requireConfidence(Number(row.confidence)),
    status: requireEnum(
      "memory status",
      row.status,
      ["active", "superseded"] as const satisfies readonly GroupMemoryStatus[],
    ),
    idempotencyKey: requireBoundedString(
      "memory idempotency key",
      row.idempotency_key,
      MAX_IDENTIFIER_CHARS,
    ),
    origin: requireEnum(
      "memory origin",
      row.origin,
      GROUP_MEMORY_ORIGINS as readonly GroupMemoryOrigin[],
    ),
    createdBy: requireBoundedString(
      "memory creator",
      row.created_by,
      MAX_IDENTIFIER_CHARS,
    ),
    ...(supersedesMemoryId === undefined ? {} : { supersedesMemoryId }),
    evidenceMessageIds: [...evidenceMessageIds],
    createdAt: requireDate("memory createdAt", row.created_at),
    updatedAt: requireDate("memory updatedAt", row.updated_at),
  };
}

function readEvidenceArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("memory evidence is invalid");
  }
  const evidence = value.map((id) =>
    requireBoundedString("evidence message id", id, MAX_IDENTIFIER_CHARS),
  );
  if (evidence.length === 0) {
    throw new Error("memory evidence must not be empty");
  }
  return evidence;
}

function requireDate(fieldName: string, value: unknown): Date {
  if (!(value instanceof Date)) {
    throw new Error(`${fieldName} must be a Date`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be valid`);
  }
  return date;
}
