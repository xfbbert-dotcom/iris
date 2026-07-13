import { describe, expect, it, vi } from "vitest";

import {
  createInMemoryRuntimeControlService,
  createRuntimeControlService,
  type RuntimeControlService,
} from "../src/admin/runtime-control-service.js";
import type {
  DurableRuntimeControlSnapshot,
  RuntimeControlStateRepository,
} from "../src/admin/runtime-control-state-repository.js";
import { RuntimeController } from "../src/admin/runtime-controller.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";

describe("createRuntimeControlService ordinary mutations", () => {
  it("persists global enable before opening the live gate", async () => {
    const pending = deferred<DurableRuntimeControlSnapshot | "conflict">();
    const { controller, service, repository } = fixture({
      liveEnabled: false,
      replaceResult: pending.promise,
    });

    const mutation = service.setGlobal({ enabled: true, updatedBy: "alice" });

    expect(controller.getSnapshot()).toMatchObject({
      globalEnabled: false,
      desiredGlobalEnabled: true,
      revision: 3,
    });
    expect(repository.replaceSnapshot).toHaveBeenCalledTimes(1);
    expect(repository.replaceSnapshot).toHaveBeenCalledWith({
      expectedRevision: 3,
      next: {
        desiredGlobalEnabled: true,
        disabledGroupIds: ["chat-disabled"],
        capabilities: defaultCapabilities(),
        updatedBy: "alice",
      },
    });

    const persisted = durableSnapshot({
      revision: 4,
      desiredGlobalEnabled: true,
      updatedBy: "alice",
    });
    pending.resolve(persisted);

    await expect(mutation).resolves.toEqual({
      kind: "success",
      durable: true,
      status: {
        globalEnabled: true,
        desiredGlobalEnabled: true,
        activationRequired: false,
        disabledGroupIds: ["chat-disabled"],
        capabilities: defaultCapabilities(),
        revision: 4,
        updatedAt: persisted.updatedAt,
        updatedBy: "alice",
        persistence: { storage: "postgres", ok: true },
      },
    });
    expect(controller.getSnapshot().globalEnabled).toBe(true);
  });

  it.each([
    {
      label: "disable",
      groupId: " chat-new ",
      enabled: false,
      persistedGroups: ["chat-disabled", "chat-new"],
    },
    {
      label: "enable",
      groupId: " chat-disabled ",
      enabled: true,
      persistedGroups: [],
    },
  ])("persists group $label before replacing live policy", async ({
    groupId,
    enabled,
    persistedGroups,
  }) => {
    const pending = deferred<DurableRuntimeControlSnapshot | "conflict">();
    const { controller, service, repository } = fixture({ replaceResult: pending.promise });

    const mutation = service.setGroup({ groupId, enabled, updatedBy: "operator" });

    expect(controller.getSnapshot().disabledGroupIds).toEqual(["chat-disabled"]);
    expect(repository.replaceSnapshot).toHaveBeenCalledTimes(1);
    expect(repository.replaceSnapshot).toHaveBeenCalledWith({
      expectedRevision: 3,
      next: {
        desiredGlobalEnabled: true,
        disabledGroupIds: persistedGroups,
        capabilities: defaultCapabilities(),
        updatedBy: "operator",
      },
    });

    const persisted = durableSnapshot({
      revision: 4,
      disabledGroupIds: persistedGroups,
      updatedBy: "operator",
    });
    pending.resolve(persisted);

    await expect(mutation).resolves.toMatchObject({
      kind: "success",
      durable: true,
      status: {
        disabledGroupIds: persistedGroups,
        revision: 4,
        persistence: { storage: "postgres", ok: true },
      },
    });
    expect(controller.getSnapshot().disabledGroupIds).toEqual(persistedGroups);
  });

  it("persists a complete partial capability update before replacing live policy", async () => {
    const pending = deferred<DurableRuntimeControlSnapshot | "conflict">();
    const { controller, service, repository } = fixture({ replaceResult: pending.promise });

    const mutation = service.setCapabilities({
      updates: { proactiveSpeech: false, writeKnowledgeBase: true },
      updatedBy: "operator",
    });

    expect(controller.getSnapshot().capabilities).toEqual(defaultCapabilities());
    expect(repository.replaceSnapshot).toHaveBeenCalledTimes(1);
    expect(repository.replaceSnapshot).toHaveBeenCalledWith({
      expectedRevision: 3,
      next: {
        desiredGlobalEnabled: true,
        disabledGroupIds: ["chat-disabled"],
        capabilities: {
          ...defaultCapabilities(),
          proactiveSpeech: false,
          writeKnowledgeBase: true,
        },
        updatedBy: "operator",
      },
    });

    const persisted = durableSnapshot({
      revision: 4,
      capabilities: {
        ...defaultCapabilities(),
        proactiveSpeech: false,
        writeKnowledgeBase: true,
      },
      updatedBy: "operator",
    });
    pending.resolve(persisted);

    await expect(mutation).resolves.toMatchObject({
      kind: "success",
      status: { capabilities: persisted.capabilities },
    });
    expect(controller.getSnapshot().capabilities).toEqual(persisted.capabilities);
  });

  it.each([
    {
      label: "conflict",
      replaceResult: Promise.resolve("conflict" as const),
      kind: "conflict",
    },
    {
      label: "repository error",
      replaceError: new Error("postgres unavailable"),
      kind: "persistence_failed",
    },
  ])("leaves live state unchanged on ordinary $label", async ({
    replaceResult,
    replaceError,
    kind,
  }) => {
    const { controller, service, repository } = fixture({
      replaceResult,
      replaceError,
    });
    const before = controller.getSnapshot();

    await expect(
      service.setCapabilities({ updates: { proactiveSpeech: false } }),
    ).resolves.toEqual({ kind });

    expect(repository.replaceSnapshot).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toEqual(before);
  });
});

describe("createRuntimeControlService emergency disable", () => {
  it("closes the live gate before attempting persistence", async () => {
    const pending = deferred<DurableRuntimeControlSnapshot | "conflict">();
    const { controller, service, repository } = fixture({
      liveEnabled: true,
      replaceResult: pending.promise,
    });
    let liveEnabledDuringReplace: boolean | undefined;
    vi.mocked(repository.replaceSnapshot).mockImplementationOnce(() => {
      liveEnabledDuringReplace = controller.getSnapshot().globalEnabled;
      return pending.promise;
    });

    const mutation = service.setGlobal({ enabled: false, updatedBy: "operator" });

    expect(controller.getSnapshot().globalEnabled).toBe(false);
    expect(liveEnabledDuringReplace).toBe(false);
    expect(repository.replaceSnapshot).toHaveBeenCalledTimes(1);
    expect(repository.replaceSnapshot).toHaveBeenCalledWith({
      expectedRevision: 3,
      next: {
        desiredGlobalEnabled: false,
        disabledGroupIds: ["chat-disabled"],
        capabilities: defaultCapabilities(),
        updatedBy: "operator",
      },
    });

    pending.resolve(durableSnapshot({
      revision: 4,
      desiredGlobalEnabled: false,
      updatedBy: "operator",
    }));
    await expect(mutation).resolves.toMatchObject({
      kind: "success",
      durable: true,
      status: {
        globalEnabled: false,
        desiredGlobalEnabled: false,
        revision: 4,
      },
    });
  });

  it.each([
    { label: "conflict", replaceResult: Promise.resolve("conflict" as const) },
    { label: "repository error", replaceError: new Error("postgres unavailable") },
  ])("keeps emergency disable live on $label", async ({
    replaceResult,
    replaceError,
  }) => {
    const { controller, service, repository } = fixture({
      liveEnabled: true,
      replaceResult,
      replaceError,
    });

    await expect(service.setGlobal({ enabled: false })).resolves.toEqual({
      kind: "disable_not_persisted",
      status: {
        ...controller.getSnapshot(),
        globalEnabled: false,
        persistence: {
          storage: "postgres",
          ok: false,
          error: "runtime_control_persistence_failed",
        },
      },
    });

    expect(repository.replaceSnapshot).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      globalEnabled: false,
      desiredGlobalEnabled: true,
      revision: 3,
    });
  });

  it.each([
    { label: "conflicts", disableResult: "conflict" as const },
    { label: "fails", disableError: new Error("postgres unavailable") },
  ])("does not let a pending enable reopen live after a later disable $label", async ({
    disableResult,
    disableError,
  }) => {
    const enablePending = deferred<DurableRuntimeControlSnapshot | "conflict">();
    const { controller, service, repository } = fixture({ liveEnabled: false });
    vi.mocked(repository.replaceSnapshot)
      .mockImplementationOnce(() => enablePending.promise)
      .mockImplementationOnce(() => {
        if (disableError !== undefined) {
          return Promise.reject(disableError);
        }
        return Promise.resolve(disableResult ?? "conflict");
      });

    const enable = service.setGlobal({ enabled: true });
    const disable = service.setGlobal({ enabled: false });

    await expect(disable).resolves.toMatchObject({
      kind: "disable_not_persisted",
      status: { globalEnabled: false, revision: 3 },
    });

    enablePending.resolve(durableSnapshot({
      revision: 4,
      desiredGlobalEnabled: true,
      updatedBy: undefined,
    }));
    await expect(enable).resolves.toMatchObject({
      kind: "success",
      status: {
        globalEnabled: false,
        desiredGlobalEnabled: true,
        activationRequired: true,
        revision: 4,
      },
    });
    expect(controller.getSnapshot()).toMatchObject({
      globalEnabled: false,
      desiredGlobalEnabled: true,
      activationRequired: true,
      revision: 4,
    });
  });

  it("keeps a pending enable suppressed after an invalid later disable", async () => {
    const enablePending = deferred<DurableRuntimeControlSnapshot | "conflict">();
    const { controller, service, repository } = fixture({ liveEnabled: false });
    vi.mocked(repository.replaceSnapshot).mockImplementationOnce(
      () => enablePending.promise,
    );

    const enable = service.setGlobal({ enabled: true });
    expectRuntimeControlInputError(
      () => service.setGlobal({ enabled: false, updatedBy: "   " }),
      "updatedBy",
    );

    expect(controller.getSnapshot().globalEnabled).toBe(false);
    expect(repository.replaceSnapshot).toHaveBeenCalledTimes(1);

    enablePending.resolve(durableSnapshot({
      revision: 4,
      desiredGlobalEnabled: true,
      updatedBy: undefined,
    }));
    await expect(enable).resolves.toMatchObject({
      kind: "success",
      status: { globalEnabled: false, revision: 4 },
    });
    expect(controller.getSnapshot().globalEnabled).toBe(false);
  });
});

describe("createRuntimeControlService status", () => {
  it("reads once and refreshes durable proof without changing the live gate", async () => {
    const refreshed = durableSnapshot({
      revision: 8,
      desiredGlobalEnabled: false,
      disabledGroupIds: ["chat-new"],
      capabilities: { ...defaultCapabilities(), proactiveSpeech: false },
      updatedAt: new Date("2026-07-13T01:00:00.000Z"),
      updatedBy: "reader",
    });
    const { controller, service, repository } = fixture({
      liveEnabled: true,
      getResult: refreshed,
    });

    await expect(service.getStatus()).resolves.toEqual({
      globalEnabled: true,
      desiredGlobalEnabled: false,
      activationRequired: false,
      disabledGroupIds: ["chat-new"],
      capabilities: refreshed.capabilities,
      revision: 8,
      updatedAt: refreshed.updatedAt,
      updatedBy: "reader",
      persistence: { storage: "postgres", ok: true },
    });

    expect(repository.getSnapshot).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().globalEnabled).toBe(true);
  });

  it("reads once and exposes the last validated state when persistence fails", async () => {
    const { controller, service, repository } = fixture({
      liveEnabled: false,
      getError: new Error("postgres unavailable"),
    });
    const validated = controller.getSnapshot();

    await expect(service.getStatus()).resolves.toEqual({
      ...validated,
      persistence: {
        storage: "postgres",
        ok: false,
        error: "runtime_control_persistence_failed",
      },
    });

    expect(repository.getSnapshot).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toEqual(validated);
  });

  it("does not roll back a newer mutation when an older status read resolves", async () => {
    const statusPending = deferred<DurableRuntimeControlSnapshot>();
    const { controller, service, repository } = fixture();
    vi.mocked(repository.getSnapshot).mockImplementationOnce(() => statusPending.promise);
    vi.mocked(repository.replaceSnapshot).mockResolvedValueOnce(durableSnapshot({
      revision: 4,
      disabledGroupIds: ["chat-disabled", "chat-new"],
      updatedBy: undefined,
    }));

    const status = service.getStatus();
    await expect(
      service.setGroup({ groupId: "chat-new", enabled: false }),
    ).resolves.toMatchObject({
      kind: "success",
      status: { revision: 4, disabledGroupIds: ["chat-disabled", "chat-new"] },
    });

    statusPending.resolve(durableSnapshot({ revision: 3 }));
    await expect(status).resolves.toMatchObject({
      revision: 4,
      disabledGroupIds: ["chat-disabled", "chat-new"],
      persistence: { storage: "postgres", ok: true },
    });
    expect(repository.getSnapshot).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      revision: 4,
      disabledGroupIds: ["chat-disabled", "chat-new"],
    });
  });
});

describe("runtime control service compare-and-swap coordination", () => {
  it("allows only one concurrent mutation to win a shared revision without retrying", async () => {
    const config = createDefaultRuntimeConfig({});
    const controller = new RuntimeController(config);
    const initial = durableSnapshot();
    controller.replaceDurablePolicy(initial);
    const repository = inMemoryCasRepository(initial);
    const service = createRuntimeControlService({ controller, repository });

    const first = service.setGroup({ groupId: "chat-a", enabled: false });
    const second = service.setGroup({ groupId: "chat-b", enabled: false });

    await expect(Promise.all([first, second])).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "success" }),
        expect.objectContaining({ kind: "conflict" }),
      ]),
    );
    expect(repository.replaceSnapshot).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(repository.replaceSnapshot).mock.calls.map(([input]) => input.expectedRevision),
    ).toEqual([3, 3]);
    expect(controller.getSnapshot()).toMatchObject({
      revision: 4,
      disabledGroupIds: ["chat-a", "chat-disabled"],
    });
  });

  it("does not apply or activate a stale enable result superseded by a newer refresh", async () => {
    const enablePending = deferred<DurableRuntimeControlSnapshot | "conflict">();
    const { controller, service, repository } = fixture({ liveEnabled: false });
    vi.mocked(repository.replaceSnapshot).mockImplementationOnce(
      () => enablePending.promise,
    );
    vi.mocked(repository.getSnapshot).mockResolvedValueOnce(durableSnapshot({
      revision: 5,
      desiredGlobalEnabled: false,
      disabledGroupIds: ["chat-disabled", "chat-new"],
      updatedBy: undefined,
    }));

    const enable = service.setGlobal({ enabled: true });
    await expect(service.getStatus()).resolves.toMatchObject({ revision: 5 });

    enablePending.resolve(durableSnapshot({
      revision: 4,
      desiredGlobalEnabled: true,
      disabledGroupIds: ["stale-policy"],
      updatedBy: undefined,
    }));
    await expect(enable).resolves.toMatchObject({
      kind: "success",
      status: {
        globalEnabled: false,
        revision: 5,
        disabledGroupIds: ["chat-disabled", "chat-new"],
      },
    });
    expect(controller.getSnapshot()).toMatchObject({
      globalEnabled: false,
      desiredGlobalEnabled: false,
      revision: 5,
      disabledGroupIds: ["chat-disabled", "chat-new"],
    });
  });

  it("opens live when status already installed the enable result revision", async () => {
    const enablePending = deferred<DurableRuntimeControlSnapshot | "conflict">();
    const persisted = durableSnapshot({
      revision: 4,
      desiredGlobalEnabled: true,
      updatedBy: undefined,
    });
    const { controller, service, repository } = fixture({ liveEnabled: false });
    vi.mocked(repository.replaceSnapshot).mockImplementationOnce(
      () => enablePending.promise,
    );
    vi.mocked(repository.getSnapshot).mockResolvedValueOnce(
      cloneDurableSnapshot(persisted),
    );

    const enable = service.setGlobal({ enabled: true });
    await expect(service.getStatus()).resolves.toMatchObject({
      globalEnabled: false,
      desiredGlobalEnabled: true,
      revision: 4,
    });

    enablePending.resolve(cloneDurableSnapshot(persisted));
    await expect(enable).resolves.toMatchObject({
      kind: "success",
      status: {
        globalEnabled: true,
        desiredGlobalEnabled: true,
        revision: 4,
      },
    });
    expect(controller.getSnapshot().globalEnabled).toBe(true);
  });

  it("lets the winning concurrent same-intent enable open live", async () => {
    const winnerPending = deferred<DurableRuntimeControlSnapshot | "conflict">();
    const { controller, service, repository } = fixture({ liveEnabled: false });
    vi.mocked(repository.replaceSnapshot)
      .mockImplementationOnce(() => winnerPending.promise)
      .mockResolvedValueOnce("conflict");

    const winner = service.setGlobal({ enabled: true });
    const loser = service.setGlobal({ enabled: true });

    await expect(loser).resolves.toEqual({ kind: "conflict" });
    winnerPending.resolve(durableSnapshot({
      revision: 4,
      desiredGlobalEnabled: true,
      updatedBy: undefined,
    }));

    await expect(winner).resolves.toMatchObject({
      kind: "success",
      status: { globalEnabled: true, revision: 4 },
    });
    expect(controller.getSnapshot().globalEnabled).toBe(true);
  });

  it("does not let an invalid enable block a pending valid enable", async () => {
    const validPending = deferred<DurableRuntimeControlSnapshot | "conflict">();
    const { controller, service, repository } = fixture({ liveEnabled: false });
    vi.mocked(repository.replaceSnapshot).mockImplementationOnce(
      () => validPending.promise,
    );

    const validEnable = service.setGlobal({ enabled: true });
    expectRuntimeControlInputError(
      () => service.setGlobal({ enabled: true, updatedBy: "   " }),
      "updatedBy",
    );
    expect(repository.replaceSnapshot).toHaveBeenCalledTimes(1);

    validPending.resolve(durableSnapshot({
      revision: 4,
      desiredGlobalEnabled: true,
      updatedBy: undefined,
    }));
    await expect(validEnable).resolves.toMatchObject({
      kind: "success",
      status: { globalEnabled: true, revision: 4 },
    });
    expect(controller.getSnapshot().globalEnabled).toBe(true);
  });

  it.each([
    { desiredGlobalEnabled: true, expectedLive: true },
    { desiredGlobalEnabled: false, expectedLive: false },
  ])(
    "uses newer desired=$desiredGlobalEnabled policy when delayed enable completes",
    async ({ desiredGlobalEnabled, expectedLive }) => {
      const enablePending = deferred<DurableRuntimeControlSnapshot | "conflict">();
      const { controller, service, repository } = fixture({ liveEnabled: false });
      vi.mocked(repository.replaceSnapshot).mockImplementationOnce(
        () => enablePending.promise,
      );
      vi.mocked(repository.getSnapshot).mockResolvedValueOnce(durableSnapshot({
        revision: 5,
        desiredGlobalEnabled,
        updatedBy: undefined,
      }));

      const enable = service.setGlobal({ enabled: true });
      await service.getStatus();
      enablePending.resolve(durableSnapshot({
        revision: 4,
        desiredGlobalEnabled: true,
        updatedBy: undefined,
      }));

      await expect(enable).resolves.toMatchObject({
        kind: "success",
        status: {
          globalEnabled: expectedLive,
          desiredGlobalEnabled,
          revision: 5,
        },
      });
      expect(controller.getSnapshot().globalEnabled).toBe(expectedLive);
    },
  );
});

describe("createInMemoryRuntimeControlService", () => {
  it("advances revision for reactivation even when durable desired is already true", async () => {
    const config = createDefaultRuntimeConfig({});
    config.globalEnabled = false;
    const controller = new RuntimeController(config);
    controller.replaceDurablePolicy(durableSnapshot({ desiredGlobalEnabled: true }));
    const updatedAt = new Date("2026-07-13T02:00:00.000Z");
    const service = createInMemoryRuntimeControlService(controller, () => updatedAt);

    await expect(
      service.setGlobal({ enabled: true, updatedBy: " alice " }),
    ).resolves.toMatchObject({
      kind: "success",
      status: {
        globalEnabled: true,
        desiredGlobalEnabled: true,
        revision: 4,
        updatedAt,
        updatedBy: "alice",
        persistence: { storage: "in_memory", ok: true },
      },
    });
  });

  it("uses repository validation and returns cloned in-memory status", async () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig({}));
    controller.replaceDurablePolicy(durableSnapshot());
    const service = createInMemoryRuntimeControlService(
      controller,
      () => new Date("2026-07-13T03:00:00.000Z"),
    );

    const result = await service.setCapabilities({
      updates: { callExternalTools: true },
      updatedBy: " operator ",
    });
    expect(result).toMatchObject({
      kind: "success",
      status: {
        revision: 4,
        updatedBy: "operator",
        capabilities: { callExternalTools: true },
        persistence: { storage: "in_memory", ok: true },
      },
    });
    if (result.kind !== "success") {
      throw new Error("expected successful in-memory mutation");
    }

    result.status.disabledGroupIds.push("mutated");
    result.status.capabilities.callExternalTools = false;
    result.status.updatedAt.setUTCFullYear(2000);

    await expect(service.getStatus()).resolves.toMatchObject({
      disabledGroupIds: ["chat-disabled"],
      capabilities: { callExternalTools: true },
      updatedAt: new Date("2026-07-13T03:00:00.000Z"),
      updatedBy: "operator",
      persistence: { storage: "in_memory", ok: true },
    });
  });

  it("rejects invalid operator metadata without mutating live state", () => {
    const controller = new RuntimeController(createDefaultRuntimeConfig({}));
    controller.replaceDurablePolicy(durableSnapshot());
    const service = createInMemoryRuntimeControlService(controller, () => new Date());
    const before = controller.getSnapshot();

    expectRuntimeControlInputError(
      () => service.setGlobal({ enabled: true, updatedBy: "x".repeat(257) }),
      "updatedBy",
    );
    expect(controller.getSnapshot()).toEqual(before);
  });
});

describe("runtime control service input boundaries", () => {
  it.each([
    { label: "blank", groupId: "   " },
    { label: "null", groupId: null },
    { label: "non-string", groupId: 42 },
  ])("rejects a $label group id before repository access", ({ groupId }) => {
    const { controller, service, repository } = fixture();
    const before = controller.getSnapshot();

    expectRuntimeControlInputError(
      () => service.setGroup({ groupId: groupId as string, enabled: false }),
      "groupId",
    );

    expect(repository.replaceSnapshot).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual(before);
  });

  it.each([
    { label: "unknown key", updates: { unknownCapability: true } },
    { label: "non-boolean value", updates: { proactiveSpeech: "false" } },
    { label: "null", updates: null },
    { label: "array", updates: [] },
    { label: "non-object", updates: "proactiveSpeech" },
  ])("rejects capability partial with $label before repository access", ({ updates }) => {
    const { controller, service, repository } = fixture();
    const before = controller.getSnapshot();

    expectRuntimeControlInputError(
      () => service.setCapabilities({ updates: updates as never }),
      "capabilities",
    );

    expect(repository.replaceSnapshot).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual(before);
  });

  it.each([
    { label: "blank", updatedBy: "   " },
    { label: "oversized", updatedBy: "x".repeat(257) },
    { label: "non-string", updatedBy: 42 },
  ])("rejects $label updatedBy before repository access", ({ updatedBy }) => {
    const { controller, service, repository } = fixture();
    const before = controller.getSnapshot();

    expectRuntimeControlInputError(
      () => service.setGroup({
        groupId: "chat-new",
        enabled: false,
        updatedBy: updatedBy as string,
      }),
      "updatedBy",
    );

    expect(repository.replaceSnapshot).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual(before);
  });

  it("normalizes group ID and updatedBy before repository access", async () => {
    const { service, repository } = fixture();

    await service.setGroup({
      groupId: " chat-new ",
      enabled: false,
      updatedBy: " operator ",
    });

    expect(repository.replaceSnapshot).toHaveBeenCalledWith({
      expectedRevision: 3,
      next: expect.objectContaining({
        disabledGroupIds: ["chat-disabled", "chat-new"],
        updatedBy: "operator",
      }),
    });
  });

  it("keeps an emergency disable live when updatedBy validation rejects", () => {
    const { controller, service, repository } = fixture({ liveEnabled: true });

    expectRuntimeControlInputError(
      () => service.setGlobal({ enabled: false, updatedBy: "   " }),
      "updatedBy",
    );

    expect(controller.getSnapshot().globalEnabled).toBe(false);
    expect(repository.replaceSnapshot).not.toHaveBeenCalled();
  });
});

type FixtureOptions = {
  liveEnabled?: boolean;
  replaceResult?: Promise<DurableRuntimeControlSnapshot | "conflict">;
  replaceError?: Error;
  getResult?: DurableRuntimeControlSnapshot;
  getError?: Error;
};

function fixture(options: FixtureOptions = {}): {
  controller: RuntimeController;
  service: RuntimeControlService;
  repository: RuntimeControlStateRepository;
} {
  const config = createDefaultRuntimeConfig({});
  config.globalEnabled = options.liveEnabled ?? true;
  const controller = new RuntimeController(config);
  controller.replaceDurablePolicy(durableSnapshot());

  const repository: RuntimeControlStateRepository = {
    getSnapshot: vi.fn(async () => {
      if (options.getError !== undefined) {
        throw options.getError;
      }
      return options.getResult ?? durableSnapshot();
    }),
    replaceSnapshot: vi.fn(() => {
      if (options.replaceError !== undefined) {
        return Promise.reject(options.replaceError);
      }
      return options.replaceResult ?? Promise.resolve(durableSnapshot({ revision: 4 }));
    }),
  };

  return {
    controller,
    repository,
    service: createRuntimeControlService({ controller, repository }),
  };
}

function inMemoryCasRepository(
  initial: DurableRuntimeControlSnapshot,
): RuntimeControlStateRepository {
  let current = cloneDurableSnapshot(initial);
  return {
    getSnapshot: vi.fn(async () => cloneDurableSnapshot(current)),
    replaceSnapshot: vi.fn(async ({ expectedRevision, next }) => {
      if (current.revision !== expectedRevision) {
        return "conflict";
      }
      current = {
        revision: current.revision + 1,
        desiredGlobalEnabled: next.desiredGlobalEnabled,
        disabledGroupIds: [...next.disabledGroupIds],
        capabilities: { ...next.capabilities },
        updatedAt: new Date("2026-07-13T04:00:00.000Z"),
        ...(next.updatedBy === undefined ? {} : { updatedBy: next.updatedBy }),
      };
      return cloneDurableSnapshot(current);
    }),
  };
}

function cloneDurableSnapshot(
  snapshot: DurableRuntimeControlSnapshot,
): DurableRuntimeControlSnapshot {
  return {
    revision: snapshot.revision,
    desiredGlobalEnabled: snapshot.desiredGlobalEnabled,
    disabledGroupIds: [...snapshot.disabledGroupIds],
    capabilities: { ...snapshot.capabilities },
    updatedAt: new Date(snapshot.updatedAt),
    ...(snapshot.updatedBy === undefined ? {} : { updatedBy: snapshot.updatedBy }),
  };
}

function durableSnapshot(
  overrides: Partial<DurableRuntimeControlSnapshot> = {},
): DurableRuntimeControlSnapshot {
  return {
    revision: 3,
    desiredGlobalEnabled: true,
    disabledGroupIds: ["chat-disabled"],
    capabilities: defaultCapabilities(),
    updatedAt: new Date("2026-07-13T00:00:00.000Z"),
    updatedBy: "seed-operator",
    ...overrides,
  };
}

function defaultCapabilities() {
  return createDefaultRuntimeConfig({}).capabilities;
}

function expectRuntimeControlInputError(
  action: () => unknown,
  field: "groupId" | "updatedBy" | "capabilities",
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toMatchObject({
    name: "RuntimeControlInputError",
    message: `invalid runtime control input: ${field}`,
    code: "invalid_runtime_control_input",
    field,
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
