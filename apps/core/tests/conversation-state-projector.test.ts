import { describe, expect, it, vi } from "vitest";

import type {
  ActionItem,
  ConversationStateRepository,
  DiscussionThread,
  ProjectionRepair,
} from "../src/conversation-state/conversation-state-repository.js";
import {
  createConversationStateProjector,
} from "../src/conversation-state/conversation-state-projector.js";
import type { GroupMemoryService } from "../src/memory/group-memory-service.js";

describe("conversation state projector", () => {
  it("projects an exact open thread with a stable idempotency key and no candidate content", async () => {
    const repository = repositoryFixture({
      repairs: [repair({ entityType: "thread", entityId: "thread-open", entityVersion: 3 })],
      threads: [thread({ id: "thread-open", version: 3 })],
    });
    const memories = memoryFixture();
    const projector = createConversationStateProjector({ repository, memories });

    const result = await projector.processBatch({ limit: 4, now: new Date("2026-07-16T00:00:00.000Z") });

    expect(result).toEqual({ claimedCount: 1, completedCount: 1, failedCount: 0 });
    expect(repository.listRelevantThreads).toHaveBeenCalledWith({
      groupId: "group-1",
      limit: 100,
      statuses: ["open"],
    });
    expect(memories.create).toHaveBeenCalledWith(expect.objectContaining({
      groupId: "group-1",
      scope: "thread",
      category: "summary",
      threadKey: "thread-open",
      content: "Open summary.",
      idempotencyKey: "projection:thread:thread-open:3",
      origin: "system",
    }));
    expect(repository.completeProjectionRepair).toHaveBeenCalledWith({
      id: "repair-thread-open",
      memoryId: "memory-created",
    });
    expect(JSON.stringify([memories.create.mock.calls, memories.correct.mock.calls])).not.toContain(
      "candidate content must never escape",
    );
  });

  it("supersedes an open action projection and preserves its linked thread key", async () => {
    const repository = repositoryFixture({
      repairs: [repair({ entityType: "action", entityId: "action-open", entityVersion: 2 })],
      actions: [action({ id: "action-open", version: 2, threadId: "thread-1" })],
    });
    const memories = memoryFixture({
      listed: [memory({ id: "memory-previous", idempotencyKey: "projection:action:action-open:1" })],
    });
    const projector = createConversationStateProjector({ repository, memories });

    await projector.processBatch({ limit: 1, now: new Date("2026-07-16T00:00:00.000Z") });

    expect(memories.correct).toHaveBeenCalledWith(expect.objectContaining({
      memoryId: "memory-previous",
      content: "Open action.",
      idempotencyKey: "projection:action:action-open:2",
    }));
    expect(memories.create).not.toHaveBeenCalled();
    expect(repository.completeProjectionRepair).toHaveBeenCalledWith({
      id: "repair-action-open",
      memoryId: "memory-corrected",
    });
  });

  it("deletes an active projection when the repaired entity is no longer active", async () => {
    const repository = repositoryFixture({
      repairs: [repair({ entityType: "thread", entityId: "thread-resolved", entityVersion: 4 })],
      threads: [],
    });
    const memories = memoryFixture({
      listed: [memory({ id: "memory-active", idempotencyKey: "projection:thread:thread-resolved:3" })],
    });
    const projector = createConversationStateProjector({ repository, memories });

    await projector.processBatch({ limit: 1, now: new Date("2026-07-16T00:00:00.000Z") });

    expect(memories.delete).toHaveBeenCalledWith({ memoryId: "memory-active" });
    expect(repository.completeProjectionRepair).toHaveBeenCalledWith({ id: "repair-thread-resolved" });
  });

  it("schedules a bounded exponential retry without exposing failure content", async () => {
    const now = new Date("2026-07-16T00:00:00.000Z");
    const repository = repositoryFixture({
      repairs: [repair({ entityType: "thread", entityId: "thread-open", entityVersion: 3, attemptCount: 3 })],
      threads: [thread({ id: "thread-open", version: 3 })],
    });
    const memories = memoryFixture({ createError: new Error("candidate content must never escape") });
    const projector = createConversationStateProjector({ repository, memories });

    const result = await projector.processBatch({ limit: 1, now });

    expect(result).toEqual({ claimedCount: 1, completedCount: 0, failedCount: 1 });
    expect(repository.failProjectionRepair).toHaveBeenCalledWith({
      id: "repair-thread-open",
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
  threads = [],
  actions = [],
}: {
  repairs?: ProjectionRepair[];
  threads?: DiscussionThread[];
  actions?: ActionItem[];
} = {}) {
  return {
    claimProjectionRepairs: vi.fn(async () => repairs),
    completeProjectionRepair: vi.fn(async () => undefined),
    failProjectionRepair: vi.fn(async () => undefined),
    listRelevantThreads: vi.fn(async () => threads),
    listRelevantActions: vi.fn(async () => actions),
  } as unknown as ConversationStateRepository & {
    claimProjectionRepairs: ReturnType<typeof vi.fn>;
    completeProjectionRepair: ReturnType<typeof vi.fn>;
    failProjectionRepair: ReturnType<typeof vi.fn>;
    listRelevantThreads: ReturnType<typeof vi.fn>;
    listRelevantActions: ReturnType<typeof vi.fn>;
  };
}

function memoryFixture({ listed = [], createError }: { listed?: any[]; createError?: Error } = {}) {
  return {
    list: vi.fn(async () => listed),
    create: vi.fn(async () => {
      if (createError !== undefined) throw createError;
      return { memory: memory({ id: "memory-created" }), created: true };
    }),
    correct: vi.fn(async () => ({ memory: memory({ id: "memory-corrected" }), created: true })),
    delete: vi.fn(async () => "deleted" as const),
  } as unknown as GroupMemoryService & {
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    correct: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
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

function memory(input: { id: string; idempotencyKey?: string }) {
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
    idempotencyKey: input.idempotencyKey ?? "projection:thread:thread-1:1",
    origin: "system" as const,
    createdBy: "conversation-state-projector",
    evidenceMessageIds: [],
    createdAt: now,
    updatedAt: now,
  };
}
