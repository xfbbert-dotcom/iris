import { describe, expect, it, vi } from "vitest";

import {
  createFeishuTaskCreator,
} from "../src/formal-tasks/feishu-task-creator.js";

const clientToken = "iris-task-79f4f7eb74d74bea9ec08f4a";
const createInput = {
  title: "Complete governed pilot",
  description: "Archive the exact acceptance evidence.",
  assigneeOpenId: "ou_assignee",
  dueAt: new Date("2026-08-24T06:00:00.123Z"),
  reminderMinutes: 30 as const,
  clientToken,
};

describe("FeishuTaskCreator", () => {
  it("creates one exact Task v2 assignment with millisecond due time and idempotency token", async () => {
    const fetch = vi.fn(async (
      _url: string | URL | Request,
      _init?: RequestInit,
    ) => taskResponse());
    const creator = createCreator({ fetch });

    await expect(creator.createTask(createInput)).resolves.toEqual({
      kind: "created",
      task: expectedTask(),
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(
      "https://open.feishu.cn/open-apis/task/v2/tasks?user_id_type=open_id",
    );
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: {
        authorization: "Bearer tenant-secret",
        "content-type": "application/json; charset=utf-8",
      },
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      summary: "Complete governed pilot",
      description: "Archive the exact acceptance evidence.",
      due: { timestamp: "1787551200123", is_all_day: false },
      members: [{ id: "ou_assignee", type: "user", role: "assignee" }],
      reminders: [{ relative_fire_minute: 30 }],
      client_token: clientToken,
    });
  });

  it("omits due and reminder together when the approved task has no due time", async () => {
    const fetch = vi.fn(async (
      _url: string | URL | Request,
      _init?: RequestInit,
    ) => taskResponse({ due: undefined, reminders: [] }));
    const creator = createCreator({ fetch });

    await creator.createTask({
      title: "No due task",
      description: "This task intentionally has no due time.",
      assigneeOpenId: "ou_assignee",
      clientToken,
    });

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      summary: "No due task",
      description: "This task intentionally has no due time.",
      members: [{ id: "ou_assignee", type: "user", role: "assignee" }],
      client_token: clientToken,
    });
  });

  it("reads back one exact Task v2 projection by GUID", async () => {
    const fetch = vi.fn(async (
      _url: string | URL | Request,
      _init?: RequestInit,
    ) => taskResponse());
    const creator = createCreator({ fetch });

    await expect(creator.getTask({ taskGuid: "task-guid-1" })).resolves.toEqual({
      kind: "found",
      task: expectedTask(),
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/task/v2/tasks/task-guid-1?user_id_type=open_id",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        credentials: "omit",
        headers: { authorization: "Bearer tenant-secret" },
      }),
    );
  });

  it.each([
    { name: "rate limit", status: 429, code: 99991400, expected: { kind: "retryable", code: "rate_limited" } },
    { name: "server error", status: 500, code: 1470500, expected: { kind: "retryable", code: "server_error" } },
    { name: "concurrent token", status: 500, code: 1470422, expected: { kind: "retryable", code: "server_error" } },
    { name: "unauthorized", status: 401, code: 99991663, expected: { kind: "rejected", code: "unauthorized" } },
    { name: "forbidden", status: 403, code: 1470403, expected: { kind: "rejected", code: "forbidden" } },
    { name: "missing app permission", status: 400, code: 99991672, expected: { kind: "rejected", code: "forbidden" } },
    { name: "invalid request", status: 400, code: 1470400, expected: { kind: "rejected", code: "invalid_request" } },
    { name: "missing target", status: 404, code: 1470404, expected: { kind: "rejected", code: "not_found" } },
  ])("classifies a create $name without exposing the response", async ({ status, code, expected }) => {
    const creator = createCreator({
      fetch: vi.fn(async () => jsonResponse({
        code,
        msg: "tenant-secret ou_assignee Archive the exact acceptance evidence.",
      }, { status })),
    });

    const outcome = await creator.createTask(createInput);
    expect(outcome).toEqual(expected);
    expect(JSON.stringify(outcome)).not.toMatch(/tenant-secret|ou_assignee|Archive/iu);
  });

  it("returns missing for an exact Task v2 readback 404", async () => {
    const creator = createCreator({
      fetch: vi.fn(async () => jsonResponse({ code: 1470404, msg: "missing" }, { status: 404 })),
    });
    await expect(creator.getTask({ taskGuid: "task-guid-1" })).resolves.toEqual({
      kind: "missing",
    });
  });

  it("rejects a readback when Feishu reports the app permission is missing", async () => {
    const creator = createCreator({
      fetch: vi.fn(async () => jsonResponse({ code: 99991672, msg: "missing scope" }, { status: 400 })),
    });

    await expect(creator.getTask({ taskGuid: "task-guid-1" })).resolves.toEqual({
      kind: "rejected",
      code: "forbidden",
    });
  });

  it.each([
    { name: "missing data", body: { code: 0 } },
    { name: "missing task", body: { code: 0, data: {} } },
    { name: "missing guid", body: { code: 0, data: { task: { ...taskBody(), guid: undefined } } } },
    { name: "missing task ID", body: { code: 0, data: { task: { ...taskBody(), task_id: undefined } } } },
    { name: "unsafe URL", body: { code: 0, data: { task: { ...taskBody(), url: "https://evil.example/task" } } } },
    { name: "malformed member", body: { code: 0, data: { task: { ...taskBody(), members: [{ id: "ou_assignee", role: "owner" }] } } } },
    { name: "two reminders", body: { code: 0, data: { task: { ...taskBody(), reminders: [{ relative_fire_minute: 30 }, { relative_fire_minute: 60 }] } } } },
  ])("fails closed for a $name success response", async ({ body }) => {
    const creator = createCreator({ fetch: vi.fn(async () => jsonResponse(body)) });
    await expect(creator.createTask(createInput)).resolves.toEqual({
      kind: "unknown",
      code: "malformed_response",
    });
  });

  it.each([
    new Response("not-json tenant-secret ou_assignee", { status: 200 }),
    new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "65537" },
    }),
    new Response(null, { status: 302, headers: { location: "https://evil.example/task" } }),
  ])("rejects invalid, oversized, or redirect responses", async (response) => {
    const creator = createCreator({ fetch: vi.fn(async () => response) });
    await expect(creator.createTask(createInput)).resolves.toEqual({
      kind: "unknown",
      code: "malformed_response",
    });
  });

  it("classifies a deadline abort after dispatch as outcome unknown", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("secret", "AbortError")));
        }));
      const creator = createCreator({ fetch, timeoutMs: 25 });
      const pending = creator.createTask(createInput);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toEqual({ kind: "unknown", code: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes caller abort before and after dispatch", async () => {
    const before = new AbortController();
    before.abort();
    const beforeFetch = vi.fn();
    const creator = createCreator({ fetch: beforeFetch });
    await expect(creator.createTask({ ...createInput, signal: before.signal })).resolves.toEqual({
      kind: "retryable",
      code: "aborted_before_dispatch",
    });
    expect(beforeFetch).not.toHaveBeenCalled();

    const after = new AbortController();
    const afterFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("secret", "AbortError")));
      }));
    const afterCreator = createCreator({ fetch: afterFetch });
    const pending = afterCreator.createTask({ ...createInput, signal: after.signal });
    await vi.waitFor(() => expect(afterFetch).toHaveBeenCalledOnce());
    after.abort();
    await expect(pending).resolves.toEqual({ kind: "unknown", code: "aborted_after_dispatch" });
  });

  it("classifies a connection loss after dispatch as outcome unknown", async () => {
    const creator = createCreator({
      fetch: vi.fn(async () => {
        throw new TypeError("tenant-secret ou_assignee description");
      }),
    });
    await expect(creator.createTask(createInput)).resolves.toEqual({
      kind: "unknown",
      code: "connection_lost",
    });
  });

  it("redacts token-provider failures and never dispatches", async () => {
    const fetch = vi.fn();
    const creator = createCreator({
      fetch,
      tokenProvider: {
        getTenantAccessToken: vi.fn(async () => {
          throw new Error("tenant-secret ou_assignee description");
        }),
      },
    });
    const rejection = creator.createTask(createInput);
    await expect(rejection).rejects.toThrow("authorization failed");
    await rejection.catch((error) => {
      expect(String(error)).not.toMatch(/tenant-secret|ou_assignee|description/iu);
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "http://open.feishu.cn",
    "https://user:secret@open.feishu.cn",
    "https://evil.example",
    "https://open.feishu.cn:444",
    "https://open.feishu.cn/open-apis",
    "https://open.feishu.cn?token=secret",
    "https://open.feishu.cn#fragment",
  ])("accepts only the fixed official Feishu origin: %s", (baseUrl) => {
    expect(() => createFeishuTaskCreator({
      baseUrl,
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-secret") },
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
    })).toThrow(/baseUrl/iu);
  });

  it.each([
    { name: "short client token", input: { ...createInput, clientToken: "short" } },
    { name: "reminder without due", input: { ...createInput, dueAt: undefined } },
    { name: "oversized assignee", input: { ...createInput, assigneeOpenId: "o".repeat(101) } },
    { name: "blank title", input: { ...createInput, title: " " } },
    { name: "oversized description", input: { ...createInput, description: "x".repeat(3001) } },
  ])("rejects a $name before token or network access", async ({ input }) => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-secret") };
    const fetch = vi.fn();
    const creator = createCreator({ tokenProvider, fetch });
    await expect(creator.createTask(input)).rejects.toThrow();
    expect(tokenProvider.getTenantAccessToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

function createCreator(overrides: {
  fetch?: ReturnType<typeof vi.fn>;
  timeoutMs?: number;
  tokenProvider?: { getTenantAccessToken(): Promise<string> };
} = {}) {
  return createFeishuTaskCreator({
    baseUrl: "https://open.feishu.cn/",
    tokenProvider: overrides.tokenProvider ?? {
      getTenantAccessToken: vi.fn(async () => "tenant-secret"),
    },
    fetch: (overrides.fetch ?? vi.fn()) as unknown as typeof globalThis.fetch,
    timeoutMs: overrides.timeoutMs ?? 1_000,
  });
}

function taskBody(overrides: Record<string, unknown> = {}) {
  return {
    guid: "task-guid-1",
    task_id: "t123456",
    url: "https://applink.feishu.cn/client/todo/detail?guid=task-guid-1",
    summary: "Complete governed pilot",
    description: "Archive the exact acceptance evidence.",
    due: { timestamp: "1787551200123", is_all_day: false },
    members: [{ id: "ou_assignee", type: "user", role: "assignee" }],
    reminders: [{ id: "10", relative_fire_minute: 30 }],
    ...overrides,
  };
}

function taskResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({ code: 0, msg: "success", data: { task: taskBody(overrides) } });
}

function expectedTask() {
  return {
    guid: "task-guid-1",
    taskId: "t123456",
    url: "https://applink.feishu.cn/client/todo/detail?guid=task-guid-1",
    title: "Complete governed pilot",
    description: "Archive the exact acceptance evidence.",
    dueAt: new Date("2026-08-24T06:00:00.123Z"),
    dueIsAllDay: false,
    members: [{ id: "ou_assignee", type: "user", role: "assignee" }],
    reminderMinutes: 30,
  };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}
