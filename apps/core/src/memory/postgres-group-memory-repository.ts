import { randomUUID } from "node:crypto";

import {
  GROUP_MEMORY_CATEGORIES,
  GROUP_MEMORY_ORIGINS,
  GROUP_MEMORY_SCOPES,
  type CorrectGroupMemoryInput,
  type CreateGroupMemoryInput,
  type GroupMemory,
  type GroupMemoryCategory,
  type GroupMemoryOrigin,
  type GroupMemoryRepository,
  type GroupMemoryScope,
  type GroupMemoryStatus,
} from "./group-memory-repository.js";

export type Queryable = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

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
  evidence_message_ids?: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type EvidenceMessageRow = { id: unknown; chat_id: unknown };

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
      const input = normalizeCreateInput(rawInput);
      return withTransaction(dataSource, async (client) => {
        const existing = await findByIdempotencyKey(
          client,
          input.groupId,
          input.idempotencyKey,
        );
        if (existing !== undefined) {
          return { memory: existing, created: false };
        }

        await assertEvidenceBelongsToGroup(
          client,
          input.groupId,
          input.evidenceMessageIds,
        );
        const id = randomUUID();
        const inserted = await insertMemory(client, id, input);
        if (inserted === undefined) {
          const racedExisting = await findByIdempotencyKey(
            client,
            input.groupId,
            input.idempotencyKey,
          );
          if (racedExisting === undefined) {
            throw new Error("group memory insert conflict returned no memory");
          }
          return { memory: racedExisting, created: false };
        }

        const insertedId = requireBoundedString(
          "memory id",
          inserted.id,
          MAX_IDENTIFIER_CHARS,
        );
        await insertEvidence(client, insertedId, input.evidenceMessageIds);
        return {
          memory: mapRow(inserted, input.evidenceMessageIds),
          created: true,
        };
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
          return { memory: existing, created: false };
        }
        if (original.status !== "active") {
          throw new Error("group memory is not active");
        }

        const evidenceMessageIds = dedupeStrings([
          ...original.evidenceMessageIds,
          ...(input.evidenceMessageIds ?? []),
        ]);
        await assertEvidenceBelongsToGroup(client, original.groupId, evidenceMessageIds);

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
        const inserted = await insertMemory(
          client,
          replacementId,
          replacementInput,
          original.id,
        );
        if (inserted === undefined) {
          const racedExisting = await findByIdempotencyKey(
            client,
            original.groupId,
            input.idempotencyKey,
          );
          if (racedExisting === undefined) {
            throw new Error("group memory correction conflict returned no memory");
          }
          return { memory: racedExisting, created: false };
        }

        const insertedId = requireBoundedString(
          "memory id",
          inserted.id,
          MAX_IDENTIFIER_CHARS,
        );
        await insertEvidence(client, insertedId, evidenceMessageIds);
        await client.query(
          `
          UPDATE group_memories
          SET status = 'superseded', updated_at = NOW()
          WHERE id = $1 AND status = 'active'
          `,
          [original.id],
        );
        return {
          memory: mapRow(inserted, evidenceMessageIds),
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
): Promise<GroupMemory | undefined> {
  const result = await queryable.query<GroupMemoryRow>(
    `
    SELECT ${selectMemoryColumns}
    FROM group_memories gm
    WHERE gm.group_id = $1 AND gm.idempotency_key = $2
    `,
    [groupId, idempotencyKey],
  );
  return mapOptionalSingleRow(result.rows);
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

async function assertEvidenceBelongsToGroup(
  queryable: Queryable,
  groupId: string,
  evidenceMessageIds: string[],
): Promise<void> {
  const result = await queryable.query<EvidenceMessageRow>(
    `
    SELECT id, chat_id
    FROM conversation_messages
    WHERE id = ANY($1::text[])
    FOR SHARE
    `,
    [evidenceMessageIds],
  );
  const evidenceById = new Map(
    result.rows.map((row) => [
      requireBoundedString("evidence message id", row.id, MAX_IDENTIFIER_CHARS),
      requireBoundedString("evidence chat id", row.chat_id, MAX_IDENTIFIER_CHARS),
    ]),
  );
  if (
    evidenceById.size !== evidenceMessageIds.length ||
    evidenceMessageIds.some((id) => evidenceById.get(id) !== groupId)
  ) {
    throw new Error("memory evidence must belong to the same group");
  }
}

async function insertMemory(
  client: TransactionClient,
  id: string,
  input: CreateGroupMemoryInput,
  supersedesMemoryId?: string,
): Promise<GroupMemoryRow | undefined> {
  const result = await client.query<GroupMemoryRow>(
    `
    INSERT INTO group_memories (
      id, group_id, memory_scope, category, thread_key, content,
      importance, confidence, status, idempotency_key, origin,
      created_by, supersedes_memory_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, $11, $12)
    ON CONFLICT (group_id, idempotency_key) DO NOTHING
    RETURNING *
    `,
    [
      id,
      input.groupId,
      input.scope,
      input.category,
      input.threadKey ?? null,
      input.content,
      input.importance,
      input.confidence,
      input.idempotencyKey,
      input.origin,
      input.createdBy,
      supersedesMemoryId ?? null,
    ],
  );
  return result.rows[0];
}

async function insertEvidence(
  client: TransactionClient,
  memoryId: string,
  evidenceMessageIds: string[],
): Promise<void> {
  await client.query(
    `
    INSERT INTO group_memory_message_evidence (memory_id, conversation_message_id)
    SELECT $1, evidence_id
    FROM unnest($2::text[]) AS evidence_id
    ON CONFLICT (memory_id, conversation_message_id) DO NOTHING
    `,
    [memoryId, evidenceMessageIds],
  );
}

function normalizeCreateInput(input: CreateGroupMemoryInput): CreateGroupMemoryInput {
  const scope = requireEnum("scope", input.scope, GROUP_MEMORY_SCOPES);
  const threadKey = normalizeThreadKey(scope, input.threadKey);
  return {
    groupId: requireBoundedString("groupId", input.groupId, MAX_IDENTIFIER_CHARS),
    scope,
    category: requireEnum("category", input.category, GROUP_MEMORY_CATEGORIES),
    ...(threadKey === undefined ? {} : { threadKey }),
    content: requireBoundedString("content", input.content, MAX_CONTENT_CHARS),
    importance: requireImportance(input.importance),
    confidence: requireConfidence(input.confidence),
    idempotencyKey: requireBoundedString(
      "idempotencyKey",
      input.idempotencyKey,
      MAX_IDENTIFIER_CHARS,
    ),
    origin: requireEnum("origin", input.origin, GROUP_MEMORY_ORIGINS),
    createdBy: requireBoundedString("createdBy", input.createdBy, MAX_IDENTIFIER_CHARS),
    evidenceMessageIds: requireEvidenceMessageIds(input.evidenceMessageIds),
  };
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

function normalizeThreadKey(
  scope: GroupMemoryScope,
  threadKey: string | undefined,
): string | undefined {
  if (scope === "thread") {
    if (threadKey === undefined) {
      throw new Error("threadKey is required for thread memory");
    }
    return requireBoundedString("threadKey", threadKey, MAX_IDENTIFIER_CHARS);
  }
  if (threadKey !== undefined) {
    throw new Error("threadKey is only allowed for thread memory");
  }
  return undefined;
}

function requireEvidenceMessageIds(value: string[]): string[] {
  const normalized = normalizeOptionalEvidence(value);
  if (normalized.length === 0) {
    throw new Error("evidenceMessageIds must not be empty");
  }
  return normalized;
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
  return value.map((id) =>
    requireBoundedString("evidence message id", id, MAX_IDENTIFIER_CHARS),
  );
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
