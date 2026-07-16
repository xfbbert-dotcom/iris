import type {
  ActionItem,
  ConversationStateRepository,
  DiscussionThread,
  ProjectionRepair,
} from "./conversation-state-repository.js";
import type { GroupMemoryService } from "../memory/group-memory-service.js";
import type { GroupMemory } from "../memory/group-memory-repository.js";

const LOOKUP_LIMIT = 100;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 60_000;

export type ConversationStateProjectionBatchResult = {
  claimedCount: number;
  completedCount: number;
  failedCount: number;
};

export type ConversationStateProjector = {
  processBatch(input: { limit: number; now: Date }): Promise<ConversationStateProjectionBatchResult>;
  getStatusCounts(): Promise<{ pending: number; failed: number }>;
};

export function createConversationStateProjector({
  repository,
  memories,
}: {
  repository: ConversationStateRepository;
  memories: GroupMemoryService;
}): ConversationStateProjector {
  return {
    async processBatch({ limit, now }) {
      const repairs = await repository.claimProjectionRepairs({ limit, now });
      let completedCount = 0;
      let failedCount = 0;
      for (const repair of repairs) {
        try {
          await processRepair({ repair, repository, memories });
          completedCount += 1;
        } catch {
          failedCount += 1;
          await repository.failProjectionRepair({
            id: repair.id,
            retryAt: retryAt(now, repair.attemptCount),
            classification: "projection_repair_failed",
          });
        }
      }
      return { claimedCount: repairs.length, completedCount, failedCount };
    },

    async getStatusCounts() {
      const counts = await repository.getStatusCounts();
      return {
        pending: counts.projectionRepairs.pending,
        failed: counts.projectionRepairs.failed,
      };
    },
  };
}

async function processRepair({
  repair,
  repository,
  memories,
}: {
  repair: ProjectionRepair;
  repository: ConversationStateRepository;
  memories: GroupMemoryService;
}): Promise<void> {
  const existing = await findExistingProjection(memories, repair);
  if (repair.entityType === "thread") {
    const threads = await repository.listRelevantThreads({
      groupId: repair.groupId,
      limit: LOOKUP_LIMIT,
      statuses: ["open"],
    });
    const current = threads.find((thread) => thread.id === repair.entityId);
    if (current !== undefined && current.version === repair.entityVersion) {
      const memoryId = await projectThread(memories, repair, current, existing);
      await repository.completeProjectionRepair({ id: repair.id, memoryId });
      return;
    }
    if (current !== undefined) {
      await repository.completeProjectionRepair({ id: repair.id });
      return;
    }
  } else {
    const actions = await repository.listRelevantActions({
      groupId: repair.groupId,
      limit: LOOKUP_LIMIT,
      statuses: ["open"],
    });
    const current = actions.find((action) => action.id === repair.entityId);
    if (current !== undefined && current.version === repair.entityVersion) {
      const memoryId = await projectAction(memories, repair, current, existing);
      await repository.completeProjectionRepair({ id: repair.id, memoryId });
      return;
    }
    if (current !== undefined) {
      await repository.completeProjectionRepair({ id: repair.id });
      return;
    }
  }

  if (existing !== undefined) {
    await memories.delete({ memoryId: existing.id });
  }
  await repository.completeProjectionRepair({ id: repair.id });
}

async function projectThread(
  memories: GroupMemoryService,
  repair: ProjectionRepair,
  thread: DiscussionThread,
  existing: GroupMemory | undefined,
): Promise<string> {
  const idempotencyKey = projectionKey(repair);
  if (existing === undefined) {
    const result = await memories.create({
      groupId: thread.groupId,
      scope: "thread",
      category: "summary",
      threadKey: thread.id,
      content: thread.summary,
      importance: 1,
      confidence: thread.confidence,
      idempotencyKey,
      origin: "system",
      createdBy: "conversation-state-projector",
      evidenceMessageIds: [],
    });
    return result.memory.id;
  }
  const result = await memories.correct({
    memoryId: existing.id,
    content: thread.summary,
    importance: 1,
    confidence: thread.confidence,
    idempotencyKey,
    origin: "system",
    createdBy: "conversation-state-projector",
  });
  return result.memory.id;
}

async function projectAction(
  memories: GroupMemoryService,
  repair: ProjectionRepair,
  action: ActionItem,
  existing: GroupMemory | undefined,
): Promise<string> {
  const idempotencyKey = projectionKey(repair);
  if (existing === undefined) {
    const result = await memories.create({
      groupId: action.groupId,
      scope: "action",
      category: "action",
      ...(action.threadId === undefined ? {} : { threadKey: action.threadId }),
      content: action.description,
      importance: 1,
      confidence: action.confidence,
      idempotencyKey,
      origin: "system",
      createdBy: "conversation-state-projector",
      evidenceMessageIds: [],
    });
    return result.memory.id;
  }
  const result = await memories.correct({
    memoryId: existing.id,
    content: action.description,
    importance: 1,
    confidence: action.confidence,
    idempotencyKey,
    origin: "system",
    createdBy: "conversation-state-projector",
  });
  return result.memory.id;
}

async function findExistingProjection(
  memories: GroupMemoryService,
  repair: ProjectionRepair,
): Promise<GroupMemory | undefined> {
  const prefix = `projection:${repair.entityType}:${repair.entityId}:`;
  const projections = await memories.list({ groupId: repair.groupId, limit: LOOKUP_LIMIT });
  return projections
    .filter((memory) => memory.status === "active" && memory.idempotencyKey.startsWith(prefix))
    .sort((left, right) => right.idempotencyKey.localeCompare(left.idempotencyKey))[0];
}

function projectionKey(repair: ProjectionRepair): string {
  return `projection:${repair.entityType}:${repair.entityId}:${repair.entityVersion}`;
}

function retryAt(now: Date, attemptCount: number): Date {
  const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptCount - 1), RETRY_MAX_DELAY_MS);
  return new Date(now.getTime() + delay);
}
