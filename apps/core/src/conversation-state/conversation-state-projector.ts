import type {
  ActionItem,
  ConversationStateRepository,
  DiscussionThread,
  ProjectionRepair,
} from "./conversation-state-repository.js";
import type { GroupMemoryService } from "../memory/group-memory-service.js";

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
  const target = await repository.loadProjectionTarget({
    entityType: repair.entityType,
    entityId: repair.entityId,
    groupId: repair.groupId,
  });
  if (target === undefined || target.entity.version !== repair.entityVersion) {
    await repository.completeProjectionRepair({ id: repair.id });
    return;
  }
  const active = target.entity.status === "open";
  if (!active) {
    if (target.memoryId !== undefined) {
      await memories.delete({ memoryId: target.memoryId });
    }
    await repository.completeProjectionRepair({ id: repair.id });
    return;
  }
  const memoryId = target.entityType === "thread"
    ? await projectThread(
        memories,
        repair,
        target.entity,
        target.evidenceMessageIds,
        target.memoryId,
      )
    : await projectAction(
        memories,
        repair,
        target.entity,
        target.evidenceMessageIds,
        target.memoryId,
      );
  await repository.completeProjectionRepair({ id: repair.id, memoryId });
}

async function projectThread(
  memories: GroupMemoryService,
  repair: ProjectionRepair,
  thread: DiscussionThread,
  evidenceMessageIds: string[],
  memoryId: string | undefined,
): Promise<string> {
  const idempotencyKey = projectionKey(repair);
  if (memoryId === undefined) {
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
      evidenceMessageIds,
    });
    return result.memory.id;
  }
  const result = await memories.correct({
    memoryId,
    content: thread.summary,
    importance: 1,
    confidence: thread.confidence,
    idempotencyKey,
    origin: "system",
    createdBy: "conversation-state-projector",
    evidenceMessageIds,
  });
  return result.memory.id;
}

async function projectAction(
  memories: GroupMemoryService,
  repair: ProjectionRepair,
  action: ActionItem,
  evidenceMessageIds: string[],
  memoryId: string | undefined,
): Promise<string> {
  const idempotencyKey = projectionKey(repair);
  if (memoryId === undefined) {
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
      evidenceMessageIds,
    });
    return result.memory.id;
  }
  const result = await memories.correct({
    memoryId,
    threadKey: action.threadId ?? null,
    content: action.description,
    importance: 1,
    confidence: action.confidence,
    idempotencyKey,
    origin: "system",
    createdBy: "conversation-state-projector",
    evidenceMessageIds,
  });
  return result.memory.id;
}

function projectionKey(repair: ProjectionRepair): string {
  return `projection:${repair.entityType}:${repair.entityId}:${repair.entityVersion}`;
}

function retryAt(now: Date, attemptCount: number): Date {
  const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptCount - 1), RETRY_MAX_DELAY_MS);
  return new Date(now.getTime() + delay);
}
