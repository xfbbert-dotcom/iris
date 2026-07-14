import type { GroupMemoryRepository } from "./group-memory-repository.js";
import type { PromptGroupMemory } from "./context-assembly.js";

export type GroupMemoryContextProvider = {
  loadActiveMemories(input: {
    groupId: string;
    limit?: number;
  }): Promise<PromptGroupMemory[]>;
};

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 8;
const MAX_GROUP_ID_CHARS = 512;

export function createGroupMemoryContextProvider({
  repository,
}: {
  repository: Pick<GroupMemoryRepository, "listActiveByGroup">;
}): GroupMemoryContextProvider {
  return {
    async loadActiveMemories(input) {
      const groupId = normalizeGroupId(input.groupId);
      const limit = sanitizeLimit(input.limit);
      if (limit === 0) {
        return [];
      }

      const memories = await repository.listActiveByGroup({ groupId, limit });
      return memories
        .filter((memory) => (
          memory.groupId === groupId &&
          memory.status === "active" &&
          memory.id.trim().length > 0 &&
          memory.content.trim().length > 0
        ))
        .slice(0, limit)
        .map((memory) => ({
          id: memory.id,
          scope: memory.scope,
          category: memory.category,
          content: memory.content,
          evidenceMessageIds: [...memory.evidenceMessageIds],
        }));
    },
  };
}

function normalizeGroupId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("groupId must not be blank");
  }
  if (normalized.length > MAX_GROUP_ID_CHARS) {
    throw new Error(`groupId must be at most ${MAX_GROUP_ID_CHARS} characters`);
  }
  return normalized;
}

function sanitizeLimit(value: number | undefined): number {
  if (
    value !== undefined &&
    (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("group memory context limit must be a finite safe-magnitude number");
  }
  if (value === undefined) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(0, Math.floor(value)));
}
