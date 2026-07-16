export const GROUP_MEMORY_SCOPES = ["group", "thread", "action"] as const;
export const GROUP_MEMORY_CATEGORIES = [
  "project",
  "preference",
  "person",
  "term",
  "workflow",
  "decision",
  "action",
  "summary",
] as const;
export const GROUP_MEMORY_ORIGINS = ["extractor", "operator", "system"] as const;

export type GroupMemoryScope = (typeof GROUP_MEMORY_SCOPES)[number];
export type GroupMemoryCategory = (typeof GROUP_MEMORY_CATEGORIES)[number];
export type GroupMemoryOrigin = (typeof GROUP_MEMORY_ORIGINS)[number];
export type GroupMemoryStatus = "active" | "superseded";

export class GroupMemoryIdempotencyConflictError extends Error {
  constructor() {
    super("group memory idempotency key conflicts with another operation");
    this.name = "GroupMemoryIdempotencyConflictError";
  }
}

export type GroupMemory = {
  id: string;
  groupId: string;
  scope: GroupMemoryScope;
  category: GroupMemoryCategory;
  threadKey?: string;
  content: string;
  importance: number;
  confidence: number;
  status: GroupMemoryStatus;
  idempotencyKey: string;
  origin: GroupMemoryOrigin;
  createdBy: string;
  supersedesMemoryId?: string;
  evidenceMessageIds: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type CreateGroupMemoryInput = {
  groupId: string;
  scope: GroupMemoryScope;
  category: GroupMemoryCategory;
  threadKey?: string;
  content: string;
  importance: number;
  confidence: number;
  idempotencyKey: string;
  origin: GroupMemoryOrigin;
  createdBy: string;
  evidenceMessageIds: string[];
};

export type CorrectGroupMemoryInput = {
  memoryId: string;
  threadKey?: string | null;
  content: string;
  importance?: number;
  confidence?: number;
  idempotencyKey: string;
  origin: GroupMemoryOrigin;
  createdBy: string;
  evidenceMessageIds?: string[];
};

export interface GroupMemoryRepository {
  create(input: CreateGroupMemoryInput): Promise<{ memory: GroupMemory; created: boolean }>;
  getById(id: string): Promise<GroupMemory | undefined>;
  listActiveByGroup(input: { groupId: string; limit: number }): Promise<GroupMemory[]>;
  listByGroup(input: { groupId: string; limit: number }): Promise<GroupMemory[]>;
  correct(input: CorrectGroupMemoryInput): Promise<{ memory: GroupMemory; created: boolean }>;
  deleteById(id: string): Promise<"deleted" | "not_found">;
}
