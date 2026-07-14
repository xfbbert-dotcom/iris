import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { GroupMemory } from "../src/memory/group-memory-repository.js";
import type { GroupMemoryService } from "../src/memory/group-memory-service.js";

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("group memory internal API", () => {
  it("requires the internal bearer token", async () => {
    const service = fakeService();
    const app = createApp(service);

    const response = await app.inject({
      method: "GET",
      url: "/internal/group-memories?groupId=chat-a",
    });

    expect(response.statusCode).toBe(401);
    expect(service.list).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before invoking the memory service", async () => {
    const service = fakeService();
    const app = createApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/internal/group-memories",
      headers: {
        authorization: "Bearer internal-token",
        "content-type": "application/json",
        "x-iris-operator": "alice",
      },
      payload: '{"groupId":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('{"groupId":');
    expect(service.create).not.toHaveBeenCalled();
  });

  it("rejects oversized JSON before invoking the memory service", async () => {
    const service = fakeService();
    const app = createApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/internal/group-memories",
      headers: {
        authorization: "Bearer internal-token",
        "x-iris-operator": "alice",
      },
      payload: { content: "x".repeat(256 * 1024) },
    });

    expect(response.statusCode).toBe(413);
    expect(service.create).not.toHaveBeenCalled();
  });

  it("creates an operator memory with bounded authenticated identity", async () => {
    const memory = sampleMemory();
    const service = fakeService({
      create: vi.fn(async () => ({ memory, created: true })),
    });
    const app = createApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/internal/group-memories",
      headers: {
        authorization: "Bearer internal-token",
        "x-iris-operator": " alice ",
      },
      payload: {
        groupId: "chat-a",
        scope: "group",
        category: "decision",
        content: "Launch Thursday.",
        importance: 4,
        confidence: 0.9,
        idempotencyKey: "create-1",
        evidenceMessageIds: ["msg-1"],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, created: true, memory: { id: "memory-1" } });
    expect(service.create).toHaveBeenCalledWith({
      groupId: "chat-a",
      scope: "group",
      category: "decision",
      content: "Launch Thursday.",
      importance: 4,
      confidence: 0.9,
      idempotencyKey: "create-1",
      origin: "operator",
      createdBy: "alice",
      evidenceMessageIds: ["msg-1"],
      operatorHint: "alice",
    });
  });

  it.each([
    ["missing operator", {}],
    ["blank operator", { "x-iris-operator": " " }],
    ["oversized operator", { "x-iris-operator": "x".repeat(513) }],
  ])("rejects mutations with %s", async (_label, operatorHeaders) => {
    const service = fakeService();
    const app = createApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/internal/group-memories",
      headers: { authorization: "Bearer internal-token", ...operatorHeaders },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(service.create).not.toHaveBeenCalled();
  });

  it("lists only the explicitly requested group", async () => {
    const service = fakeService({ list: vi.fn(async () => [sampleMemory()]) });
    const app = createApp(service);

    const response = await app.inject({
      method: "GET",
      url: "/internal/group-memories?groupId=chat-a&limit=20&activeOnly=false",
      headers: { authorization: "Bearer internal-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, memories: [{ id: "memory-1" }] });
    expect(service.list).toHaveBeenCalledWith({
      groupId: "chat-a",
      limit: 20,
      activeOnly: false,
    });
  });

  it("rejects list requests without a group boundary", async () => {
    const service = fakeService();
    const app = createApp(service);

    const response = await app.inject({
      method: "GET",
      url: "/internal/group-memories",
      headers: { authorization: "Bearer internal-token" },
    });

    expect(response.statusCode).toBe(400);
    expect(service.list).not.toHaveBeenCalled();
  });

  it("corrects memory as the authenticated operator", async () => {
    const replacement = sampleMemory({ id: "memory-2", supersedesMemoryId: "memory-1" });
    const service = fakeService({
      correct: vi.fn(async () => ({ memory: replacement, created: true })),
    });
    const app = createApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/internal/group-memories/memory-1/corrections",
      headers: {
        authorization: "Bearer internal-token",
        "x-iris-operator": "alice",
      },
      payload: {
        content: "Launch Friday.",
        idempotencyKey: "correction-1",
        evidenceMessageIds: ["msg-2"],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(service.correct).toHaveBeenCalledWith({
      memoryId: "memory-1",
      content: "Launch Friday.",
      idempotencyKey: "correction-1",
      origin: "operator",
      createdBy: "alice",
      evidenceMessageIds: ["msg-2"],
      operatorHint: "alice",
    });
  });

  it("returns 404 for a missing memory correction", async () => {
    const service = fakeService({
      correct: vi.fn(async () => { throw new Error("group memory not found"); }),
    });
    const app = createApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/internal/group-memories/missing/corrections",
      headers: {
        authorization: "Bearer internal-token",
        "x-iris-operator": "alice",
      },
      payload: {
        content: "Launch Friday.",
        idempotencyKey: "correction-1",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, error: "group_memory_not_found" });
  });

  it("returns 404 for a missing memory deletion", async () => {
    const service = fakeService({ delete: vi.fn(async () => "not_found" as const) });
    const app = createApp(service);

    const response = await app.inject({
      method: "DELETE",
      url: "/internal/group-memories/missing",
      headers: {
        authorization: "Bearer internal-token",
        "x-iris-operator": "alice",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, error: "group_memory_not_found" });
  });

  it("returns bounded errors without leaking repository details", async () => {
    const service = fakeService({
      list: vi.fn(async () => { throw new Error("postgres://secret@db/internal"); }),
    });
    const app = createApp(service);

    const response = await app.inject({
      method: "GET",
      url: "/internal/group-memories?groupId=chat-a",
      headers: { authorization: "Bearer internal-token" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ ok: false, error: "group_memory_operation_failed" });
    expect(response.body).not.toContain("secret");
  });
});

function createApp(groupMemoryService: GroupMemoryService) {
  const app = buildApp({
    internalApiToken: "internal-token",
    groupMemoryService,
    verifyFeishuRequest: () => true,
    createAnswerDraftRuntime: () => undefined,
    createEventWorkerRuntime: () => undefined,
    createDocumentSyncRuntime: () => undefined,
    createReindexWorkerRuntime: () => undefined,
  });
  apps.push(app);
  return app;
}

function fakeService(overrides: Partial<GroupMemoryService> = {}) {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    correct: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  } as unknown as GroupMemoryService & Record<string, ReturnType<typeof vi.fn>>;
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
    evidenceMessageIds: ["msg-1"],
    createdAt: new Date("2026-07-14T00:00:00.000Z"),
    updatedAt: new Date("2026-07-14T00:00:00.000Z"),
    ...overrides,
  };
}
