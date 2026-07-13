import { describe, expect, it, vi } from "vitest";

import {
  createPostgresRuntimeControlStateRepository,
  type Queryable,
} from "../src/admin/postgres-runtime-control-state-repository.js";

describe("createPostgresRuntimeControlStateRepository", () => {
  it("decodes the singleton row without sharing mutable values", async () => {
    const row = validRow();
    const queryable = fakeQueryable([row]);
    const repository = createPostgresRuntimeControlStateRepository({ queryable });

    const snapshot = await repository.getSnapshot();

    expect(snapshot).toEqual({
      revision: 4,
      desiredGlobalEnabled: true,
      disabledGroupIds: ["chat-a"],
      capabilities: defaultCapabilities(),
      updatedAt: new Date("2026-07-13T00:00:00.000Z"),
      updatedBy: "operator@example.com",
    });

    snapshot.disabledGroupIds.push("chat-b");
    snapshot.capabilities.callExternalTools = true;
    expect(row.disabled_group_ids).toEqual(["chat-a"]);
    expect(row.capabilities).toEqual(defaultCapabilities());
  });

  it("clones Date values from database rows", async () => {
    const updatedAt = new Date("2026-07-13T00:00:00.000Z");
    const repository = createPostgresRuntimeControlStateRepository({
      queryable: fakeQueryable([validRow({ updated_at: updatedAt })]),
    });

    const snapshot = await repository.getSnapshot();
    updatedAt.setUTCFullYear(2030);

    expect(snapshot.updatedAt).toEqual(new Date("2026-07-13T00:00:00.000Z"));
  });

  it("trims and sorts disabled group IDs deterministically", async () => {
    const repository = createPostgresRuntimeControlStateRepository({
      queryable: fakeQueryable([
        validRow({ disabled_group_ids: [" chat-b ", "chat-a"] }),
      ]),
    });

    await expect(repository.getSnapshot()).resolves.toMatchObject({
      disabledGroupIds: ["chat-a", "chat-b"],
    });
  });

  it("omits updatedBy only when the database value is null", async () => {
    const repository = createPostgresRuntimeControlStateRepository({
      queryable: fakeQueryable([validRow({ updated_by: null })]),
    });

    await expect(repository.getSnapshot()).resolves.toEqual({
      revision: 4,
      desiredGlobalEnabled: true,
      disabledGroupIds: ["chat-a"],
      capabilities: defaultCapabilities(),
      updatedAt: new Date("2026-07-13T00:00:00.000Z"),
    });
  });

  it("rejects capabilities with inherited unknown keys", async () => {
    const capabilities = Object.assign(Object.create({ unknown: false }), defaultCapabilities());
    const repository = createPostgresRuntimeControlStateRepository({
      queryable: fakeQueryable([validRow({ capabilities })]),
    });

    await expect(repository.getSnapshot()).rejects.toThrow("invalid runtime control snapshot");
  });

  it("rejects rows without an own revision property", async () => {
    const row = validRow() as Record<string, unknown>;
    delete row.revision;
    const repository = createPostgresRuntimeControlStateRepository({
      queryable: fakeQueryable([row]),
    });

    await expect(repository.getSnapshot()).rejects.toThrow("invalid runtime control snapshot");
  });

  it("rejects capabilities without all required own properties", async () => {
    const capabilities = defaultCapabilities() as Record<string, unknown>;
    delete capabilities.callExternalTools;
    const repository = createPostgresRuntimeControlStateRepository({
      queryable: fakeQueryable([validRow({ capabilities })]),
    });

    await expect(repository.getSnapshot()).rejects.toThrow("invalid runtime control snapshot");
  });

  it("rejects sparse disabled group ID arrays", async () => {
    const disabledGroupIds = ["chat-a", , "chat-c"];
    const repository = createPostgresRuntimeControlStateRepository({
      queryable: fakeQueryable([validRow({ disabled_group_ids: disabledGroupIds })]),
    });

    await expect(repository.getSnapshot()).rejects.toThrow("invalid runtime control snapshot");
  });

  it("rejects disabled group ID arrays with inherited indexes", async () => {
    const disabledGroupIds = ["chat-a", , "chat-c"];
    Object.setPrototypeOf(
      disabledGroupIds,
      Object.assign(Object.create(Array.prototype), { 1: "chat-b" }),
    );
    const repository = createPostgresRuntimeControlStateRepository({
      queryable: fakeQueryable([validRow({ disabled_group_ids: disabledGroupIds })]),
    });

    await expect(repository.getSnapshot()).rejects.toThrow("invalid runtime control snapshot");
  });

  it("rejects disabled group ID arrays with non-index enumerable properties", async () => {
    const disabledGroupIds = Object.assign(["chat-a"], { source: "legacy" });
    const repository = createPostgresRuntimeControlStateRepository({
      queryable: fakeQueryable([validRow({ disabled_group_ids: disabledGroupIds })]),
    });

    await expect(repository.getSnapshot()).rejects.toThrow("invalid runtime control snapshot");
  });

  it.each([
    ["missing row", undefined],
    ["unknown row field", { extra: true }],
    ["negative revision", { revision: "-1" }],
    ["unsafe revision", { revision: "9007199254740992" }],
    ["fractional revision", { revision: "4.5" }],
    ["non-boolean desired global enabled", { desired_global_enabled: "true" }],
    ["non-array groups", { disabled_group_ids: "chat-a" }],
    ["non-string group", { disabled_group_ids: [1] }],
    ["duplicate group", { disabled_group_ids: ["chat-a", " chat-a "] }],
    ["blank group", { disabled_group_ids: [" "] }],
    ["unknown capability", { capabilities: { ...defaultCapabilities(), unknown: false } }],
    [
      "non-boolean capability",
      { capabilities: { ...defaultCapabilities(), proactiveSpeech: "false" } },
    ],
    ["invalid timestamp", { updated_at: "not-a-date" }],
    ["numeric timestamp", { updated_at: 0 }],
    ["missing operator", { updated_by: undefined }],
    ["blank operator", { updated_by: " " }],
    ["oversized operator", { updated_by: "o".repeat(257) }],
  ])("rejects %s", async (_label, override) => {
    const row =
      override === undefined ? undefined : { ...validRow(), ...(override as Record<string, unknown>) };
    const repository = createPostgresRuntimeControlStateRepository({
      queryable: fakeQueryable(row === undefined ? [] : [row]),
    });

    await expect(repository.getSnapshot()).rejects.toThrow("invalid runtime control snapshot");
  });

  it("rejects reads that return multiple rows", async () => {
    const repository = createPostgresRuntimeControlStateRepository({
      queryable: fakeQueryable([validRow(), validRow({ revision: "5" })]),
    });

    await expect(repository.getSnapshot()).rejects.toThrow("invalid runtime control snapshot");
  });

  it("writes the complete next snapshot through a revision compare-and-swap", async () => {
    const queryable = fakeQueryable([
      validRow({
        revision: "5",
        desired_global_enabled: false,
        disabled_group_ids: ["chat-a", "chat-b"],
        updated_by: null,
      }),
    ]);
    const repository = createPostgresRuntimeControlStateRepository({ queryable });

    await expect(
      repository.replaceSnapshot({
        expectedRevision: 4,
        next: {
          desiredGlobalEnabled: false,
          disabledGroupIds: [" chat-b ", "chat-a"],
          capabilities: defaultCapabilities(),
        },
      }),
    ).resolves.toEqual({
      revision: 5,
      desiredGlobalEnabled: false,
      disabledGroupIds: ["chat-a", "chat-b"],
      capabilities: defaultCapabilities(),
      updatedAt: new Date("2026-07-13T00:00:00.000Z"),
    });

    const [sql, params] = queryCalls(queryable)[0] ?? [];
    expect(normalizeSql(sql)).toBe(
      "update runtime_control_state set revision = revision + 1, desired_global_enabled = $2, disabled_group_ids = $3, capabilities = $4::jsonb, updated_at = now(), updated_by = $5 where singleton_id = 1 and revision = $1 returning revision, desired_global_enabled, disabled_group_ids, capabilities, updated_at, updated_by",
    );
    expect(params).toEqual([
      4,
      false,
      ["chat-a", "chat-b"],
      JSON.stringify(defaultCapabilities()),
      null,
    ]);
  });

  it("returns conflict exactly when the compare-and-swap updates zero rows", async () => {
    const queryable = fakeQueryable([]);
    const repository = createPostgresRuntimeControlStateRepository({ queryable });

    await expect(
      repository.replaceSnapshot({ expectedRevision: 4, next: validNextSnapshot() }),
    ).resolves.toBe("conflict");
  });

  it("rejects malformed compare-and-swap input before querying Postgres", async () => {
    const queryable = fakeQueryable([]);
    const repository = createPostgresRuntimeControlStateRepository({ queryable });

    await expect(
      repository.replaceSnapshot({
        expectedRevision: Number.MAX_SAFE_INTEGER + 1,
        next: validNextSnapshot(),
      }),
    ).rejects.toThrow("invalid runtime control snapshot");
    await expect(
      repository.replaceSnapshot({
        expectedRevision: 4,
        next: { ...validNextSnapshot(), disabledGroupIds: ["chat-a", "chat-a"] },
      }),
    ).rejects.toThrow("invalid runtime control snapshot");
    expect(queryable.query).not.toHaveBeenCalled();
  });
});

function defaultCapabilities() {
  return {
    readGroupContext: true,
    replyWhenMentioned: true,
    readGroupDocuments: true,
    retrieveKnowledgeBase: true,
    proactiveSpeech: true,
    generateKnowledgeDrafts: true,
    writeKnowledgeBase: false,
    callExternalTools: false,
  };
}

function validRow(overrides: Record<string, unknown> = {}) {
  return {
    revision: "4",
    desired_global_enabled: true,
    disabled_group_ids: ["chat-a"],
    capabilities: defaultCapabilities(),
    updated_at: "2026-07-13T00:00:00.000Z",
    updated_by: "operator@example.com",
    ...overrides,
  };
}

function validNextSnapshot() {
  return {
    desiredGlobalEnabled: true,
    disabledGroupIds: ["chat-a"],
    capabilities: defaultCapabilities(),
    updatedBy: "operator@example.com",
  };
}

function fakeQueryable(rows: unknown[]): Queryable {
  const query = vi.fn(async () => ({ rows }));
  return { query } as unknown as Queryable;
}

function queryCalls(queryable: Queryable): Array<[string, unknown[] | undefined]> {
  return (queryable.query as unknown as { mock: { calls: Array<[string, unknown[] | undefined]> } })
    .mock.calls;
}

function normalizeSql(sql: string | undefined): string {
  return sql?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
}
