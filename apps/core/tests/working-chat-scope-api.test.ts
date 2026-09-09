import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import {
  WorkingChatScopeConflictError,
  normalizeWorkingChatScopeReplacement,
  type WorkingChatScope,
  type WorkingChatScopeRepository,
} from "../src/shared-chat/working-chat-scope.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const at = new Date("2026-09-09T00:00:00Z");
const payload = { expectedVersion: 0, state: "active", updatedBy: "pilot-operator",
  groups: [{ chatId: "group-b", name: "B" }, { chatId: "group-a", name: "A" }] };
const headers = { authorization: "Bearer scope-test-token" };

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  vi.unstubAllEnvs();
});

describe("working chat scope internal API", () => {
  it("requires authentication before changing the shared audience", async () => {
    const repo = fakeRepository();
    const app = await createApp(repo);
    const result = await app.inject({ method: "PUT", url: "/internal/working-chat-scope", payload });
    expect(result.statusCode).toBe(401);
    expect(await repo.get()).toBeUndefined();
  });

  it("defaults closed and roundtrips only explicit normalized groups", async () => {
    const app = await createApp(fakeRepository());
    const before = await app.inject({ method: "GET", url: "/internal/working-chat-scope", headers });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ ok: true, scope: null });
    const updated = await app.inject({ method: "PUT", url: "/internal/working-chat-scope", headers, payload });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().scope).toEqual({ id: "pilot-working-chat", version: 1,
      state: "active", updatedBy: "pilot-operator", updatedAt: at.toISOString(),
      groups: [{ chatId: "group-a", name: "A" }, { chatId: "group-b", name: "B" }] });
    const after = await app.inject({ method: "GET", url: "/internal/working-chat-scope", headers });
    expect(after.json()).toEqual(updated.json());
  });

  it.each([
    { ...payload, groups: [{ chatId: "group-a", name: "A" }] },
    { ...payload, expectedVersion: -1 },
    { ...payload, updatedBy: " " },
    { ...payload, state: "enabled" },
    { ...payload, allowAllBotChats: true },
    { ...payload, at: "2030-01-01" },
  ])("rejects invalid or unknown mutation fields without writing", async invalid => {
    const repo = fakeRepository();
    const app = await createApp(repo);
    const result = await app.inject({ method: "PUT", url: "/internal/working-chat-scope", headers, payload: invalid });
    expect(result.statusCode).toBe(400);
    expect(await repo.get()).toBeUndefined();
  });

  it("returns conflict on stale CAS without replacing the active audience", async () => {
    const repo = fakeRepository();
    const app = await createApp(repo);
    await app.inject({ method: "PUT", url: "/internal/working-chat-scope", headers, payload });
    const result = await app.inject({ method: "PUT", url: "/internal/working-chat-scope", headers,
      payload: { ...payload, state: "revoked" } });
    expect(result.statusCode).toBe(409);
    expect((await repo.get())?.state).toBe("active");
  });

  it("fails closed when no repository is configured", async () => {
    const app = await createApp();
    const result = await app.inject({ method: "PUT", url: "/internal/working-chat-scope", headers, payload });
    expect(result.statusCode).toBe(503);
  });

  it("does not expose the scope when internal authentication is unconfigured", async () => {
    vi.stubEnv("IRIS_INTERNAL_API_TOKEN", "");
    vi.stubEnv("IRIS_INGRESS_HEALTH_TOKEN", "");
    const app = await createApp(fakeRepository(), false);
    const result = await app.inject({ method: "GET", url: "/internal/working-chat-scope" });
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ ok: false, error: "working_chat_scope_auth_unavailable" });
  });

  it("returns bounded unavailable errors without repository details", async () => {
    const repo = fakeRepository();
    repo.get = async () => { throw new Error("postgres://private-password@database"); };
    const app = await createApp(repo);
    const result = await app.inject({ method: "GET", url: "/internal/working-chat-scope", headers });
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain("private-password");
  });
});

async function createApp(workingChatScopes?: WorkingChatScopeRepository, authenticated = true) {
  const app = await buildApp({
    ...(authenticated ? { internalApiToken: "scope-test-token" } : {}),
    workingChatScopes, now: () => at,
    verifyFeishuRequest: () => true,
    createAnswerDraftRuntime: () => undefined,
    createEventWorkerRuntime: () => undefined,
    createDocumentSyncRuntime: () => undefined,
    createReindexWorkerRuntime: () => undefined,
  });
  apps.push(app);
  return app;
}

function fakeRepository(): WorkingChatScopeRepository {
  let scope: WorkingChatScope | undefined;
  return {
    async get() { return scope === undefined ? undefined : structuredClone(scope); },
    async replace(input) {
      const value = normalizeWorkingChatScopeReplacement(input);
      if ((scope?.version ?? 0) !== value.expectedVersion) throw new WorkingChatScopeConflictError();
      scope = { id: "pilot-working-chat", version: value.expectedVersion + 1, state: value.state,
        groups: value.groups, updatedAt: value.at, updatedBy: value.updatedBy };
      return structuredClone(scope);
    },
    async resolveForChat() { return undefined; },
    async validateExact() { return false; },
  };
}
