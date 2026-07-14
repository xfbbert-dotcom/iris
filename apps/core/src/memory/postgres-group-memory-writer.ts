import { createHash } from "node:crypto";

import {
  GROUP_MEMORY_CATEGORIES,
  GroupMemoryIdempotencyConflictError,
  GROUP_MEMORY_ORIGINS,
  GROUP_MEMORY_SCOPES,
  type CreateGroupMemoryInput,
  type GroupMemory,
  type GroupMemoryOrigin,
  type GroupMemoryScope,
  type GroupMemoryStatus,
} from "./group-memory-repository.js";

export type Queryable = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
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

type EvidenceMessageRow = { id: unknown; chat_id: unknown };

type IdempotentMemoryRecord = {
  memory: GroupMemory;
  requestFingerprint: string;
};

export const MAX_GROUP_MEMORY_IDENTIFIER_CHARS = 512;
export const MAX_GROUP_MEMORY_CONTENT_CHARS = 4000;

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

export async function insertGroupMemoryWithEvidence(input: {
  queryable: Queryable;
  memory: CreateGroupMemoryInput & { id: string };
}): Promise<GroupMemory> {
  const memory = normalizeCreateGroupMemory(input.memory);
  const result = await insertGroupMemoryRecordWithEvidence({
    queryable: input.queryable,
    memory,
    requestFingerprint: fingerprintCreateGroupMemoryRequest(memory),
  });
  return result.memory;
}

export async function insertGroupMemoryRecordWithEvidence(input: {
  queryable: Queryable;
  memory: CreateGroupMemoryInput & { id: string };
  requestFingerprint: string;
  supersedesMemoryId?: string;
  existingChecked?: boolean;
}): Promise<{ memory: GroupMemory; created: boolean }> {
  const memory = normalizeCreateGroupMemory(input.memory);
  const requestFingerprint = requireRequestFingerprint(input.requestFingerprint);
  const supersedesMemoryId = input.supersedesMemoryId === undefined
    ? undefined
    : requireBoundedString(
        "supersedesMemoryId",
        input.supersedesMemoryId,
        MAX_GROUP_MEMORY_IDENTIFIER_CHARS,
      );

  if (input.existingChecked !== true) {
    const existing = await findByIdempotencyKey(
      input.queryable,
      memory.groupId,
      memory.idempotencyKey,
    );
    if (existing !== undefined) {
      assertReplayMatches(existing, memory, requestFingerprint, supersedesMemoryId);
      return { memory: existing.memory, created: false };
    }
  }

  await assertEvidenceBelongsToGroup(
    input.queryable,
    memory.groupId,
    memory.evidenceMessageIds,
  );
  const inserted = await insertMemory(
    input.queryable,
    memory,
    requestFingerprint,
    supersedesMemoryId,
  );
  if (inserted === undefined) {
    const racedExisting = await findByIdempotencyKey(
      input.queryable,
      memory.groupId,
      memory.idempotencyKey,
    );
    if (racedExisting === undefined) {
      throw new Error("group memory insert conflict returned no memory");
    }
    assertReplayMatches(racedExisting, memory, requestFingerprint, supersedesMemoryId);
    return { memory: racedExisting.memory, created: false };
  }

  const insertedId = requireBoundedString(
    "memory id",
    inserted.id,
    MAX_GROUP_MEMORY_IDENTIFIER_CHARS,
  );
  await insertEvidence(input.queryable, insertedId, memory.evidenceMessageIds);
  return {
    memory: mapGroupMemoryRow(inserted, memory.evidenceMessageIds),
    created: true,
  };
}

export function normalizeCreateGroupMemory(
  input: CreateGroupMemoryInput & { id?: string },
): CreateGroupMemoryInput & { id: string } {
  const scope = requireEnum("scope", input.scope, GROUP_MEMORY_SCOPES);
  const threadKey = normalizeThreadKey(scope, input.threadKey);
  return {
    id: requireBoundedString("id", input.id, MAX_GROUP_MEMORY_IDENTIFIER_CHARS),
    groupId: requireBoundedString(
      "groupId",
      input.groupId,
      MAX_GROUP_MEMORY_IDENTIFIER_CHARS,
    ),
    scope,
    category: requireEnum("category", input.category, GROUP_MEMORY_CATEGORIES),
    ...(threadKey === undefined ? {} : { threadKey }),
    content: requireBoundedString(
      "content",
      input.content,
      MAX_GROUP_MEMORY_CONTENT_CHARS,
    ),
    importance: requireImportance(input.importance),
    confidence: requireConfidence(input.confidence),
    idempotencyKey: requireBoundedString(
      "idempotencyKey",
      input.idempotencyKey,
      MAX_GROUP_MEMORY_IDENTIFIER_CHARS,
    ),
    origin: requireEnum("origin", input.origin, GROUP_MEMORY_ORIGINS),
    createdBy: requireBoundedString(
      "createdBy",
      input.createdBy,
      MAX_GROUP_MEMORY_IDENTIFIER_CHARS,
    ),
    evidenceMessageIds: requireEvidenceMessageIds(input.evidenceMessageIds),
  };
}

export function fingerprintCreateGroupMemoryRequest(input: CreateGroupMemoryInput): string {
  return fingerprintRequest({
    version: 1,
    operation: "create",
    groupId: input.groupId,
    scope: input.scope,
    category: input.category,
    threadKey: input.threadKey ?? null,
    content: input.content,
    importance: input.importance,
    confidence: input.confidence,
    idempotencyKey: input.idempotencyKey,
    origin: input.origin,
    createdBy: input.createdBy,
    evidenceMessageIds: canonicalizeStrings(input.evidenceMessageIds),
  });
}

function assertReplayMatches(
  existing: IdempotentMemoryRecord,
  input: CreateGroupMemoryInput & { id: string },
  requestFingerprint: string,
  supersedesMemoryId: string | undefined,
): void {
  const memory = existing.memory;
  if (
    existing.requestFingerprint !== requestFingerprint ||
    memory.supersedesMemoryId !== supersedesMemoryId ||
    memory.groupId !== input.groupId ||
    memory.scope !== input.scope ||
    memory.category !== input.category ||
    memory.threadKey !== input.threadKey ||
    memory.content !== input.content ||
    memory.importance !== input.importance ||
    memory.confidence !== input.confidence ||
    memory.origin !== input.origin ||
    memory.createdBy !== input.createdBy ||
    !haveSameStrings(memory.evidenceMessageIds, input.evidenceMessageIds)
  ) {
    throw new GroupMemoryIdempotencyConflictError();
  }
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
        memory: mapGroupMemoryRow(row),
        requestFingerprint: requireRequestFingerprint(row.request_fingerprint),
      };
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
    ORDER BY id ASC
    FOR SHARE
    `,
    [evidenceMessageIds],
  );
  const evidenceById = new Map(
    result.rows.map((row) => [
      requireBoundedString(
        "evidence message id",
        row.id,
        MAX_GROUP_MEMORY_IDENTIFIER_CHARS,
      ),
      requireBoundedString(
        "evidence chat id",
        row.chat_id,
        MAX_GROUP_MEMORY_IDENTIFIER_CHARS,
      ),
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
  queryable: Queryable,
  input: CreateGroupMemoryInput & { id: string },
  requestFingerprint: string,
  supersedesMemoryId?: string,
): Promise<GroupMemoryRow | undefined> {
  const result = await queryable.query<GroupMemoryRow>(
    `
    INSERT INTO group_memories (
      id, group_id, memory_scope, category, thread_key, content,
      importance, confidence, status, idempotency_key, origin,
      created_by, supersedes_memory_id, request_fingerprint
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, $11, $12, $13)
    ON CONFLICT (group_id, idempotency_key) DO NOTHING
    RETURNING *
    `,
    [
      input.id,
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
      requestFingerprint,
    ],
  );
  return result.rows[0];
}

async function insertEvidence(
  queryable: Queryable,
  memoryId: string,
  evidenceMessageIds: string[],
): Promise<void> {
  await queryable.query(
    `
    INSERT INTO group_memory_message_evidence (memory_id, conversation_message_id)
    SELECT $1, evidence_id
    FROM unnest($2::text[]) AS evidence_id
    ON CONFLICT (memory_id, conversation_message_id) DO NOTHING
    `,
    [memoryId, evidenceMessageIds],
  );
}

function mapGroupMemoryRow(row: GroupMemoryRow, evidenceOverride?: string[]): GroupMemory {
  const scope = requireEnum("memory scope", row.memory_scope, GROUP_MEMORY_SCOPES);
  const threadKey = row.thread_key === null
    ? undefined
    : requireBoundedString(
        "memory thread key",
        row.thread_key,
        MAX_GROUP_MEMORY_IDENTIFIER_CHARS,
      );
  const supersedesMemoryId = row.supersedes_memory_id === null
    ? undefined
    : requireBoundedString(
        "supersedes memory id",
        row.supersedes_memory_id,
        MAX_GROUP_MEMORY_IDENTIFIER_CHARS,
      );
  const evidenceMessageIds = evidenceOverride ?? readEvidenceArray(row.evidence_message_ids);
  return {
    id: requireBoundedString("memory id", row.id, MAX_GROUP_MEMORY_IDENTIFIER_CHARS),
    groupId: requireBoundedString(
      "memory group id",
      row.group_id,
      MAX_GROUP_MEMORY_IDENTIFIER_CHARS,
    ),
    scope,
    category: requireEnum("memory category", row.category, GROUP_MEMORY_CATEGORIES),
    ...(threadKey === undefined ? {} : { threadKey }),
    content: requireBoundedString(
      "memory content",
      row.content,
      MAX_GROUP_MEMORY_CONTENT_CHARS,
    ),
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
      MAX_GROUP_MEMORY_IDENTIFIER_CHARS,
    ),
    origin: requireEnum(
      "memory origin",
      row.origin,
      GROUP_MEMORY_ORIGINS as readonly GroupMemoryOrigin[],
    ),
    createdBy: requireBoundedString(
      "memory creator",
      row.created_by,
      MAX_GROUP_MEMORY_IDENTIFIER_CHARS,
    ),
    ...(supersedesMemoryId === undefined ? {} : { supersedesMemoryId }),
    evidenceMessageIds: [...evidenceMessageIds],
    createdAt: requireDate("memory createdAt", row.created_at),
    updatedAt: requireDate("memory updatedAt", row.updated_at),
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
    return requireBoundedString(
      "threadKey",
      threadKey,
      MAX_GROUP_MEMORY_IDENTIFIER_CHARS,
    );
  }
  if (threadKey !== undefined) {
    throw new Error("threadKey is only allowed for thread memory");
  }
  return undefined;
}

function requireEvidenceMessageIds(value: string[]): string[] {
  if (!Array.isArray(value)) {
    throw new Error("evidenceMessageIds must be an array");
  }
  const normalized = [...new Set(value.map((id) =>
    requireBoundedString(
      "evidenceMessageId",
      id,
      MAX_GROUP_MEMORY_IDENTIFIER_CHARS,
    )))];
  if (normalized.length === 0) {
    throw new Error("evidenceMessageIds must not be empty");
  }
  return normalized;
}

function canonicalizeStrings(values: string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function haveSameStrings(left: string[], right: string[]): boolean {
  const leftValues = canonicalizeStrings(left);
  const rightValues = canonicalizeStrings(right);
  return leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index]);
}

function fingerprintRequest(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function requireRequestFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("memory request fingerprint is invalid");
  }
  return value;
}

function requireBoundedString(
  fieldName: string,
  value: unknown,
  maxChars: number,
): string {
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

function readEvidenceArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("memory evidence is invalid");
  }
  const evidence = value.map((id) =>
    requireBoundedString(
      "evidence message id",
      id,
      MAX_GROUP_MEMORY_IDENTIFIER_CHARS,
    ),
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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
