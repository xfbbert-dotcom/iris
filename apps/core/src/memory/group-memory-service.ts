import type { AuditEvent, AuditLog } from "../audit/audit-log.js";
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
} from "./group-memory-repository.js";

const MAX_IDENTIFIER_CHARS = 512;
const MAX_CONTENT_CHARS = 4000;
const MAX_LIST_LIMIT = 100;

export class GroupMemoryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupMemoryInputError";
  }
}

export type CreateGroupMemoryCommand = CreateGroupMemoryInput & {
  operatorHint?: string;
};

export type CorrectGroupMemoryCommand = CorrectGroupMemoryInput & {
  operatorHint?: string;
};

export type GroupMemoryService = {
  create(input: CreateGroupMemoryCommand): Promise<{ memory: GroupMemory; created: boolean }>;
  getById(id: string): Promise<GroupMemory | undefined>;
  list(input: { groupId: string; limit: number; activeOnly?: boolean }): Promise<GroupMemory[]>;
  correct(input: CorrectGroupMemoryCommand): Promise<{ memory: GroupMemory; created: boolean }>;
  delete(input: { memoryId: string; operatorHint?: string }): Promise<"deleted" | "not_found">;
};

export function createGroupMemoryService({
  repository,
  auditLog,
  onAuditError,
}: {
  repository: GroupMemoryRepository;
  auditLog?: AuditLog;
  onAuditError?: (error: unknown) => void;
}): GroupMemoryService {
  return {
    async create(rawInput) {
      const { operatorHint, ...input } = normalizeCreateCommand(rawInput);
      const result = await repository.create(input);
      if (result.created) {
        await recordAuditSafely(
          auditLog,
          {
            type: "group_memory_created",
            documentId: result.memory.id,
            fragmentIds: [...result.memory.evidenceMessageIds],
            ...(operatorHint === undefined ? {} : { operatorHint }),
          },
          onAuditError,
        );
      }
      return cloneMutationResult(result);
    },

    async getById(id) {
      const memory = await repository.getById(
        requireBoundedString("memoryId", id, MAX_IDENTIFIER_CHARS),
      );
      return memory === undefined ? undefined : cloneMemory(memory);
    },

    async list(rawInput) {
      const groupId = requireBoundedString(
        "groupId",
        rawInput.groupId,
        MAX_IDENTIFIER_CHARS,
      );
      const limit = sanitizeLimit(rawInput.limit);
      const memories = rawInput.activeOnly === false
        ? await repository.listByGroup({ groupId, limit })
        : await repository.listActiveByGroup({ groupId, limit });
      return memories.map(cloneMemory);
    },

    async correct(rawInput) {
      const { operatorHint, ...input } = normalizeCorrectionCommand(rawInput);
      const result = await repository.correct(input);
      if (result.created) {
        await recordAuditSafely(
          auditLog,
          {
            type: "group_memory_corrected",
            documentId: result.memory.id,
            fragmentIds: [...result.memory.evidenceMessageIds],
            ...(operatorHint === undefined ? {} : { operatorHint }),
            message: `supersedes:${input.memoryId}`,
          },
          onAuditError,
        );
      }
      return cloneMutationResult(result);
    },

    async delete(rawInput) {
      const memoryId = requireBoundedString(
        "memoryId",
        rawInput.memoryId,
        MAX_IDENTIFIER_CHARS,
      );
      const operatorHint = normalizeOptionalString(
        "operatorHint",
        rawInput.operatorHint,
        MAX_IDENTIFIER_CHARS,
      );
      const existing = await repository.getById(memoryId);
      if (existing === undefined) {
        return "not_found";
      }

      const status = await repository.deleteById(memoryId);
      if (status === "deleted") {
        await recordAuditSafely(
          auditLog,
          {
            type: "group_memory_deleted",
            documentId: memoryId,
            fragmentIds: [...existing.evidenceMessageIds],
            ...(operatorHint === undefined ? {} : { operatorHint }),
          },
          onAuditError,
        );
      }
      return status;
    },
  };
}

function normalizeCreateCommand(input: CreateGroupMemoryCommand): CreateGroupMemoryCommand {
  const scope = requireEnum("scope", input.scope, GROUP_MEMORY_SCOPES);
  const threadKey = normalizeThreadKey(scope, input.threadKey);
  const operatorHint = normalizeOptionalString(
    "operatorHint",
    input.operatorHint,
    MAX_IDENTIFIER_CHARS,
  );
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
    evidenceMessageIds: requireEvidence(input.evidenceMessageIds),
    ...(operatorHint === undefined ? {} : { operatorHint }),
  };
}

function normalizeCorrectionCommand(
  input: CorrectGroupMemoryCommand,
): CorrectGroupMemoryCommand {
  const operatorHint = normalizeOptionalString(
    "operatorHint",
    input.operatorHint,
    MAX_IDENTIFIER_CHARS,
  );
  return {
    memoryId: requireBoundedString("memoryId", input.memoryId, MAX_IDENTIFIER_CHARS),
    ...(Object.hasOwn(input, "threadKey")
      ? { threadKey: normalizeCorrectionThreadKey(input.threadKey) }
      : {}),
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
      : { evidenceMessageIds: normalizeEvidence(input.evidenceMessageIds) }),
    ...(operatorHint === undefined ? {} : { operatorHint }),
  };
}

function normalizeCorrectionThreadKey(value: string | null | undefined): string | null {
  if (value === null) {
    return null;
  }
  return requireBoundedString("threadKey", value, MAX_IDENTIFIER_CHARS);
}

function normalizeThreadKey(
  scope: GroupMemoryScope,
  value: string | undefined,
): string | undefined {
  if (scope === "group") {
    if (value !== undefined) {
      throw new GroupMemoryInputError("threadKey is not allowed for group memory");
    }
    return undefined;
  }
  if (value === undefined) {
    if (scope === "thread") {
      throw new GroupMemoryInputError("threadKey is required for thread memory");
    }
    return undefined;
  }
  return requireBoundedString("threadKey", value, MAX_IDENTIFIER_CHARS);
}

function requireEvidence(value: string[]): string[] {
  const evidence = normalizeEvidence(value);
  if (evidence.length === 0) {
    throw new GroupMemoryInputError("evidenceMessageIds must not be empty");
  }
  return evidence;
}

function normalizeEvidence(value: string[]): string[] {
  if (!Array.isArray(value)) {
    throw new GroupMemoryInputError("evidenceMessageIds must be an array");
  }
  return [
    ...new Set(
      value.map((id) =>
        requireBoundedString("evidenceMessageId", id, MAX_IDENTIFIER_CHARS),
      ),
    ),
  ];
}

function requireBoundedString(fieldName: string, value: unknown, maxChars: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GroupMemoryInputError(`${fieldName} must not be blank`);
  }
  const normalized = value.trim();
  if (normalized.length > maxChars) {
    throw new GroupMemoryInputError(`${fieldName} must be at most ${maxChars} characters`);
  }
  return normalized;
}

function normalizeOptionalString(
  fieldName: string,
  value: unknown,
  maxChars: number,
): string | undefined {
  return value === undefined ? undefined : requireBoundedString(fieldName, value, maxChars);
}

function requireEnum<T extends string>(
  fieldName: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new GroupMemoryInputError(`${fieldName} is invalid`);
  }
  return value as T;
}

function requireImportance(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new GroupMemoryInputError("importance must be an integer from 1 to 5");
  }
  return value;
}

function requireConfidence(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new GroupMemoryInputError("confidence must be a finite number from 0 to 1");
  }
  return value;
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new GroupMemoryInputError("limit must be a finite safe-magnitude number");
  }
  return Math.min(MAX_LIST_LIMIT, Math.max(0, Math.floor(value)));
}

async function recordAuditSafely(
  auditLog: AuditLog | undefined,
  event: AuditEvent,
  onAuditError: ((error: unknown) => void) | undefined,
): Promise<void> {
  if (auditLog === undefined) {
    return;
  }
  try {
    await auditLog.record(event);
  } catch (error) {
    try {
      onAuditError?.(error);
    } catch {
      // Audit diagnostics cannot reverse a committed memory mutation.
    }
  }
}

function cloneMutationResult(result: {
  memory: GroupMemory;
  created: boolean;
}): { memory: GroupMemory; created: boolean } {
  return { memory: cloneMemory(result.memory), created: result.created };
}

function cloneMemory(memory: GroupMemory): GroupMemory {
  return {
    ...memory,
    evidenceMessageIds: [...memory.evidenceMessageIds],
    createdAt: new Date(memory.createdAt),
    updatedAt: new Date(memory.updatedAt),
  };
}
