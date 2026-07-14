import { describe, expect, it, vi } from "vitest";

import type { GroupMemory } from "../src/memory/group-memory-repository.js";
import { createGroupMemoryContextProvider } from "../src/memory/group-memory-context-provider.js";

describe("GroupMemoryContextProvider", () => {
  it("loads only active memories for the explicitly requested group", async () => {
    const repository = {
      listActiveByGroup: vi.fn(async () => [memory()]),
    };
    const provider = createGroupMemoryContextProvider({ repository });

    const result = await provider.loadActiveMemories({ groupId: " chat-a " });

    expect(repository.listActiveByGroup).toHaveBeenCalledWith({
      groupId: "chat-a",
      limit: 8,
    });
    expect(result).toEqual([{
      id: "memory-1",
      scope: "group",
      category: "decision",
      content: "Launch Thursday.",
      evidenceMessageIds: ["msg-1"],
    }]);
  });

  it("caps output at eight and filters blank defensive rows", async () => {
    const repository = {
      listActiveByGroup: vi.fn(async () => [
        memory({ id: "blank", content: "   " }),
        ...Array.from({ length: 9 }, (_, index) => memory({
          id: `memory-${index + 1}`,
          content: `memory ${index + 1}`,
        })),
      ]),
    };
    const provider = createGroupMemoryContextProvider({ repository });

    const result = await provider.loadActiveMemories({ groupId: "chat-a", limit: 99 });

    expect(repository.listActiveByGroup).toHaveBeenCalledWith({
      groupId: "chat-a",
      limit: 8,
    });
    expect(result).toHaveLength(8);
    expect(result.map((item) => item.id)).toEqual([
      "memory-1", "memory-2", "memory-3", "memory-4",
      "memory-5", "memory-6", "memory-7", "memory-8",
    ]);
  });

  it("returns defensive evidence copies", async () => {
    const source = memory({ evidenceMessageIds: ["msg-1"] });
    const repository = { listActiveByGroup: vi.fn(async () => [source]) };
    const provider = createGroupMemoryContextProvider({ repository });

    const [result] = await provider.loadActiveMemories({ groupId: "chat-a" });
    result!.evidenceMessageIds.push("mutated");

    expect(source.evidenceMessageIds).toEqual(["msg-1"]);
  });

  it("does not query for a zero limit", async () => {
    const repository = { listActiveByGroup: vi.fn(async () => []) };
    const provider = createGroupMemoryContextProvider({ repository });

    await expect(
      provider.loadActiveMemories({ groupId: "chat-a", limit: 0 }),
    ).resolves.toEqual([]);
    expect(repository.listActiveByGroup).not.toHaveBeenCalled();
  });

  it("rejects invalid group IDs and unsafe limits before querying", async () => {
    const repository = { listActiveByGroup: vi.fn(async () => []) };
    const provider = createGroupMemoryContextProvider({ repository });

    await expect(provider.loadActiveMemories({ groupId: " " })).rejects.toThrow(
      "groupId must not be blank",
    );
    await expect(provider.loadActiveMemories({
      groupId: "chat-a",
      limit: Number.POSITIVE_INFINITY,
    })).rejects.toThrow("group memory context limit must be a finite safe-magnitude number");
    expect(repository.listActiveByGroup).not.toHaveBeenCalled();
  });
});

function memory(overrides: Partial<GroupMemory> = {}): GroupMemory {
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
    evidenceMessageIds: ["msg-1"],
    createdAt: new Date("2026-07-14T00:00:00.000Z"),
    updatedAt: new Date("2026-07-14T00:00:00.000Z"),
    ...overrides,
  };
}
