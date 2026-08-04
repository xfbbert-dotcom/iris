import { describe, expect, it, vi } from "vitest";

import type { AuditLog } from "../src/audit/audit-log.js";
import type {
  GroupMemory,
  GroupMemoryRepository,
} from "../src/memory/group-memory-repository.js";
import {
  createGroupMemoryService,
  GroupMemoryInputError,
} from "../src/memory/group-memory-service.js";

describe("createGroupMemoryService", () => {
  it("normalizes creation input, deduplicates evidence, and audits no content", async () => {
    const memory = sampleMemory();
    const repository = fakeRepository({ create: vi.fn(async () => ({ memory, created: true })) });
    const auditLog = fakeAuditLog();
    const service = createGroupMemoryService({ repository, auditLog });

    await expect(
      service.create({
        groupId: " chat-a ",
        scope: "group",
        category: "decision",
        content: " Launch Thursday. ",
        importance: 4,
        confidence: 0.9,
        idempotencyKey: " create-1 ",
        origin: "operator",
        createdBy: " alice ",
        evidenceMessageIds: [" msg-1 ", "msg-1", "msg-2"],
        operatorHint: " alice ",
      }),
    ).resolves.toEqual({ memory, created: true });

    expect(repository.create).toHaveBeenCalledWith({
      groupId: "chat-a",
      scope: "group",
      category: "decision",
      content: "Launch Thursday.",
      importance: 4,
      confidence: 0.9,
      idempotencyKey: "create-1",
      origin: "operator",
      createdBy: "alice",
      evidenceMessageIds: ["msg-1", "msg-2"],
    });
    expect(auditLog.record).toHaveBeenCalledWith({
      type: "group_memory_created",
      documentId: "memory-1",
      fragmentIds: ["msg-1", "msg-2"],
      operatorHint: "alice",
    });
    expect(JSON.stringify(auditLog.record.mock.calls)).not.toContain("Launch Thursday");
  });

  it("does not duplicate audit records for idempotent creation", async () => {
    const repository = fakeRepository({
      create: vi.fn(async () => ({ memory: sampleMemory(), created: false })),
    });
    const auditLog = fakeAuditLog();
    const service = createGroupMemoryService({ repository, auditLog });

    await service.create(validCreateCommand());

    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it("preserves an optional thread key for action memory", async () => {
    const memory = sampleMemory({ scope: "action", threadKey: "thread-7" });
    const repository = fakeRepository({
      create: vi.fn(async () => ({ memory, created: true })),
    });
    const service = createGroupMemoryService({ repository });

    await service.create({
      ...validCreateCommand(),
      scope: "action",
      threadKey: " thread-7 ",
    });

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "action", threadKey: "thread-7" }),
    );
  });

  it.each([
    ["blank group", { groupId: " " }],
    ["oversized content", { content: "x".repeat(4001) }],
    ["fractional importance", { importance: 2.5 }],
    ["infinite confidence", { confidence: Number.POSITIVE_INFINITY }],
    ["unsupported scope", { scope: "company" }],
    ["thread without key", { scope: "thread", threadKey: undefined }],
    ["group with key", { scope: "group", threadKey: "topic" }],
    ["empty evidence", { evidenceMessageIds: [] }],
    ["oversized operator", { operatorHint: "o".repeat(513) }],
  ])("rejects %s before calling the repository", async (_label, override) => {
    const repository = fakeRepository();
    const service = createGroupMemoryService({ repository });

    await expect(
      service.create({ ...validCreateCommand(), ...override } as never),
    ).rejects.toBeInstanceOf(GroupMemoryInputError);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("audits an idempotent correction only when a replacement is created", async () => {
    const replacement = sampleMemory({
      id: "memory-2",
      content: "Launch Friday.",
      supersedesMemoryId: "memory-1",
      evidenceMessageIds: ["msg-1", "msg-3"],
    });
    const repository = fakeRepository({
      correct: vi.fn(async () => ({ memory: replacement, created: true })),
    });
    const auditLog = fakeAuditLog();
    const service = createGroupMemoryService({ repository, auditLog });

    await service.correct({
      memoryId: " memory-1 ",
      content: " Launch Friday. ",
      idempotencyKey: " correction-1 ",
      origin: "operator",
      createdBy: "alice",
      evidenceMessageIds: [" msg-3 "],
      operatorHint: "alice",
    });

    expect(repository.correct).toHaveBeenCalledWith({
      memoryId: "memory-1",
      content: "Launch Friday.",
      idempotencyKey: "correction-1",
      origin: "operator",
      createdBy: "alice",
      evidenceMessageIds: ["msg-3"],
    });
    expect(auditLog.record).toHaveBeenCalledWith({
      type: "group_memory_corrected",
      documentId: "memory-2",
      fragmentIds: ["msg-1", "msg-3"],
      operatorHint: "alice",
      message: "supersedes:memory-1",
    });
  });

  it("normalizes an explicit action thread key correction", async () => {
    const replacement = sampleMemory({ scope: "action", threadKey: "thread-8" });
    const repository = fakeRepository({
      correct: vi.fn(async () => ({ memory: replacement, created: true })),
    });
    const service = createGroupMemoryService({ repository });

    await service.correct({
      memoryId: "memory-1",
      threadKey: " thread-8 ",
      content: "Ship the repair projector.",
      idempotencyKey: "action-correction-1",
      origin: "system",
      createdBy: "conversation-state-projector",
      evidenceMessageIds: ["msg-1"],
    });

    expect(repository.correct).toHaveBeenCalledWith(
      expect.objectContaining({ threadKey: "thread-8" }),
    );
  });

  it("hard deletes an existing memory and audits its evidence IDs", async () => {
    const repository = fakeRepository({
      getById: vi.fn(async () => sampleMemory()),
      deleteById: vi.fn(async () => "deleted" as const),
    });
    const auditLog = fakeAuditLog();
    const service = createGroupMemoryService({ repository, auditLog });

    await expect(
      service.delete({ memoryId: "memory-1", operatorHint: "alice" }),
    ).resolves.toBe("deleted");
    expect(auditLog.record).toHaveBeenCalledWith({
      type: "group_memory_deleted",
      documentId: "memory-1",
      fragmentIds: ["msg-1", "msg-2"],
      operatorHint: "alice",
    });
  });

  it("keeps a committed mutation successful when audit storage fails", async () => {
    const auditError = new Error("audit unavailable");
    const onAuditError = vi.fn();
    const service = createGroupMemoryService({
      repository: fakeRepository({
        create: vi.fn(async () => ({ memory: sampleMemory(), created: true })),
      }),
      auditLog: { record: vi.fn(async () => { throw auditError; }) },
      onAuditError,
    });

    await expect(service.create(validCreateCommand())).resolves.toMatchObject({
      created: true,
    });
    expect(onAuditError).toHaveBeenCalledWith(auditError);
  });
});

function validCreateCommand() {
  return {
    groupId: "chat-a",
    scope: "group" as const,
    category: "decision" as const,
    content: "Launch Thursday.",
    importance: 4,
    confidence: 0.9,
    idempotencyKey: "create-1",
    origin: "operator" as const,
    createdBy: "alice",
    evidenceMessageIds: ["msg-1", "msg-2"],
    operatorHint: "alice",
  };
}

function sampleMemory(overrides: Partial<GroupMemory> = {}): GroupMemory {
  return {
    id: "memory-1",
    groupId: "chat-a",
    scope: "group",
    category: "decision",
    content: "Launch Thursday.",
    importance: 4,
    confidence: 0.9,
    status: "active",
    idempotencyKey: "create-1",
    origin: "operator",
    createdBy: "alice",
    evidenceMessageIds: ["msg-1", "msg-2"],
    createdAt: new Date("2026-07-14T00:00:00.000Z"),
    updatedAt: new Date("2026-07-14T00:00:00.000Z"),
    ...overrides,
  };
}

function fakeRepository(overrides: Partial<GroupMemoryRepository> = {}) {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    listActiveByGroup: vi.fn(),
    listByGroup: vi.fn(),
    correct: vi.fn(),
    deleteById: vi.fn(),
    ...overrides,
  } as unknown as GroupMemoryRepository & Record<string, ReturnType<typeof vi.fn>>;
}

function fakeAuditLog() {
  return { record: vi.fn(async () => undefined) } as AuditLog & {
    record: ReturnType<typeof vi.fn>;
  };
}
