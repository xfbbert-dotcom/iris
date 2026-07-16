import { describe, expect, it, vi } from "vitest";

import type {
  ActionItem,
  ConversationStateProjectionTarget,
  ConversationStateRepository,
  DiscussionThread,
  ProjectionRepair,
} from "../src/conversation-state/conversation-state-repository.js";
import { createConversationStateProjector } from "../src/conversation-state/conversation-state-projector.js";
import type { GroupMemoryService } from "../src/memory/group-memory-service.js";

describe("conversation state projector", () => {
  it("projects an exact open thread with its durable evidence", async () => {
    const target: ConversationStateProjectionTarget = {
      entityType: "thread",
      entity: thread({ id: "thread-open", version: 3 }),
      evidenceMessageIds: ["message-1", "message-2"],
    };
    const repository = repositoryFixture({
      repairs: [repair({ entityType: "thread", entityId: "thread-open", entityVersion: 3 })],
      targets: [target],
    });
    const memories = memoryFixture();
    const projector = createConversationStateProjector({ repository, memories });

    const result = await projector.processBatch({ limit: 4, now: new Date("2026-07-16T00:00:00.000Z") });

    expect(result).toEqual({ claimedCount: 1, completedCount: 1, failedCount: 0 });
    expect(repository.loadProjectionTarget).toHaveBeenCalledWith({
      entityType: "thread",
      entityId: "thread-open",
      groupId: "group-1",
    });
    expect(memories.list).not.toHaveBeenCalled();
    expect(memories.create).toHaveBeenCalledWith(expect.objectContaining({
      groupId: "group-1",
      scope: "thread",
      category: "summary",
      threadKey: "thread-open",
      content: "Open summary.",
      evidenceMessageIds: ["message-1", "message-2"],
      idempotencyKey: "projection:thread:thread-open:3",
      origin: "system",
    }));
    expect(repository.completeProjectionRepair).toHaveBeenCalledWith({
      id: "repair-thread-open",
      attemptCount: 1,
      memoryId: "memory-created",
    });
  });

  it("corrects the exact mapped action projection with durable evidence", async () => {
    const target: ConversationStateProjectionTarget = {
      entityType: "action",
      entity: action({ id: "action-open", version: 2, threadId: "thread-1" }),
      evidenceMessageIds: ["message-1", "message-3"],
      memoryId: "memory-previous",
    };
    const repository = repositoryFixture({
      repairs: [repair({ entityType: "action", entityId: "action-open", entityVersion: 2 })],
      targets: [target],
    });
    const memories = memoryFixture();
    const projector = createConversationStateProjector({ repository, memories });

    await projector.processBatch({ limit: 1, now: new Date("2026-07-16T00:00:00.000Z") });

    expect(memories.correct).toHaveBeenCalledWith(expect.objectContaining({
      memoryId: "memory-previous",
      threadKey: "thread-1",
      content: "Open action.",
      evidenceMessageIds: ["message-1", "message-3"],
      idempotencyKey: "projection:action:action-open:2",
    }));
    expect(memories.create).not.toHaveBeenCalled();
    expect(repository.completeProjectionRepair).toHaveBeenCalledWith({
      id: "repair-action-open",
      attemptCount: 1,
      memoryId: "memory-corrected",
    });
  });

  it("deletes the exact mapped projection for an inactive entity", async () => {
    const target: ConversationStateProjectionTarget = {
      entityType: "thread",
      entity: thread({ id: "thread-resolved", status: "resolved", version: 4, resolvedAt: new Date() }),
      evidenceMessageIds: ["message-1"],
      memoryId: "memory-active",
    };
    const repository = repositoryFixture({
      repairs: [repair({ entityType: "thread", entityId: "thread-resolved", entityVersion: 4 })],
      targets: [target],
    });
    const memories = memoryFixture();
    const projector = createConversationStateProjector({ repository, memories });

    await projector.processBatch({ limit: 1, now: new Date("2026-07-16T00:00:00.000Z") });

    expect(memories.delete).toHaveBeenCalledWith({ memoryId: "memory-active" });
    expect(repository.completeProjectionRepair).toHaveBeenCalledWith({
      id: "repair-thread-resolved",
      attemptCount: 1,
    });
  });

  it("safely completes a stale repair without changing the current projection", async () => {
    const target: ConversationStateProjectionTarget = {
      entityType: "thread",
      entity: thread({ id: "thread-open", version: 5 }),
      evidenceMessageIds: ["message-1"],
      memoryId: "memory-current",
    };
    const repository = repositoryFixture({
      repairs: [repair({ entityType: "thread", entityId: "thread-open", entityVersion: 4 })],
      targets: [target],
    });
    const memories = memoryFixture();
    const projector = createConversationStateProjector({ repository, memories });

    await projector.processBatch({ limit: 1, now: new Date("2026-07-16T00:00:00.000Z") });

    expect(memories.create).not.toHaveBeenCalled();
    expect(memories.correct).not.toHaveBeenCalled();
    expect(memories.delete).not.toHaveBeenCalled();
    expect(repository.completeProjectionRepair).toHaveBeenCalledWith({
      id: "repair-thread-open",
      attemptCount: 1,
    });
  });

  it("schedules a bounded content-free retry when exact projection fails", async () => {
    const now = new Date("2026-07-16T00:00:00.000Z");
    const repository = repositoryFixture({
      repairs: [repair({ entityType: "thread", entityId: "thread-open", entityVersion: 3, attemptCount: 3 })],
      targets: [{
        entityType: "thread",
        entity: thread({ id: "thread-open", version: 3 }),
        evidenceMessageIds: ["message-1"],
      }],
    });
    const memories = memoryFixture({ createError: new Error("candidate content must never escape") });
    const projector = createConversationStateProjector({ repository, memories });

    const result = await projector.processBatch({ limit: 1, now });

    expect(result).toEqual({ claimedCount: 1, completedCount: 0, failedCount: 1 });
    expect(repository.failProjectionRepair).toHaveBeenCalledWith({
      id: "repair-thread-open",
      attemptCount: 3,
      retryAt: new Date("2026-07-16T00:00:04.000Z"),
      classification: "projection_repair_failed",
    });
    expect(JSON.stringify(repository.failProjectionRepair.mock.calls)).not.toContain(
      "candidate content must never escape",
    );
  });
});

function repositoryFixture({
  repairs = [],
  targets = [],
}: {
  repairs?: ProjectionRepair[];
  targets?: ConversationStateProjectionTarget[];
} = {}) {
  const targetByKey = new Map(targets.map((target) => [
    `${target.entityType}:${target.entity.id}:${target.entity.groupId}`,
    target,
  ]));
  return {
    claimProjectionRepairs: vi.fn(async () => repairs),
    completeProjectionRepair: vi.fn(async () => undefined),
    failProjectionRepair: vi.fn(async () => undefined),
    loadProjectionTarget: vi.fn(async (input: {
      entityType: "thread" | "action";
      entityId: string;
      groupId: string;
    }) => targetByKey.get(`${input.entityType}:${input.entityId}:${input.groupId}`)),
    listRelevantThreads: vi.fn(() => Promise.reject(new Error("bounded list must not be used"))),
    listRelevantActions: vi.fn(() => Promise.reject(new Error("bounded list must not be used"))),
  } as unknown as ConversationStateRepository & Record<
    "claimProjectionRepairs" | "completeProjectionRepair" | "failProjectionRepair" |
    "loadProjectionTarget" | "listRelevantThreads" | "listRelevantActions",
    ReturnType<typeof vi.fn>
  >;
}

function memoryFixture({ createError }: { createError?: Error } = {}) {
  return {
    list: vi.fn(() => Promise.reject(new Error("memory list must not be used"))),
    create: vi.fn(async () => {
      if (createError !== undefined) throw createError;
      return { memory: memory({ id: "memory-created" }), created: true };
    }),
    correct: vi.fn(async () => ({ memory: memory({ id: "memory-corrected" }), created: true })),
    delete: vi.fn(async () => "deleted" as const),
  } as unknown as GroupMemoryService & Record<
    "list" | "create" | "correct" | "delete",
    ReturnType<typeof vi.fn>
  >;
}

function repair(input: Partial<ProjectionRepair> & Pick<ProjectionRepair, "entityType" | "entityId" | "entityVersion">): ProjectionRepair {
  const now = new Date("2026-07-15T00:00:00.000Z");
  return {
    id: `repair-${input.entityId}`,
    groupId: "group-1",
    status: "processing",
    attemptCount: 1,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

function thread(input: Partial<DiscussionThread> = {}): DiscussionThread {
  const now = new Date("2026-07-15T00:00:00.000Z");
  return {
    id: "thread-open",
    groupId: "group-1",
    title: "Open thread",
    summary: "Open summary.",
    status: "open",
    confidence: 0.9,
    version: 3,
    firstEvidenceAt: now,
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

function action(input: Partial<ActionItem> = {}): ActionItem {
  const now = new Date("2026-07-15T00:00:00.000Z");
  return {
    id: "action-open",
    groupId: "group-1",
    description: "Open action.",
    ownerRefType: "text_label",
    ownerRef: "Owner",
    status: "open",
    confidence: 0.9,
    version: 2,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

function memory(input: { id: string }) {
  const now = new Date("2026-07-15T00:00:00.000Z");
  return {
    id: input.id,
    groupId: "group-1",
    scope: "thread" as const,
    category: "summary" as const,
    threadKey: "thread-1",
    content: "Previous projection.",
    importance: 1,
    confidence: 0.9,
    status: "active" as const,
    idempotencyKey: "projection:thread:thread-1:1",
    origin: "system" as const,
    createdBy: "conversation-state-projector",
    evidenceMessageIds: ["message-1"],
    createdAt: now,
    updatedAt: now,
  };
}
