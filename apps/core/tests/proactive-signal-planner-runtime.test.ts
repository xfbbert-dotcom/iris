import { describe, expect, it, vi } from "vitest";

import { RuntimeController } from "../src/admin/runtime-controller.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import type { ConversationStateInspectionStore } from "../src/conversation-state/conversation-state-api.js";
import type { ProactiveSignalRepository } from "../src/proactive-signals/proactive-signal-repository.js";
import { createProactiveSignalScanner } from "../src/proactive-signals/proactive-signal-scanner.js";
import {
  createProactiveSignalPlannerRuntime,
  type ProactiveSignalPlannerRuntimeDependencies,
} from "../src/runtime/proactive-signal-planner-runtime.js";

describe("ProactiveSignalPlannerRuntime", () => {
  it("allocates no resources while disabled by default", () => {
    const dependencies = runtimeDependencies();

    expect(createProactiveSignalPlannerRuntime({ env: {}, dependencies })).toBeUndefined();
    expect(dependencies.createPostgresPool).not.toHaveBeenCalled();
  });

  it("starts a scanner loop that records candidates for enabled groups only", async () => {
    const order: string[] = [];
    const runtimeController = new RuntimeController(createDefaultRuntimeConfig());
    runtimeController.disableGroup("oc_control");
    const dependencies = runtimeDependencies({ order });
    const runtime = createProactiveSignalPlannerRuntime({
      env: enabledEnv(),
      runtimeController,
      store: dependencies.store,
      dependencies,
      now: () => new Date("2026-07-26T08:00:00.000Z"),
    })!;

    expect(dependencies.createPostgresPool).toHaveBeenCalledWith({
      databaseUrl: "postgres://iris:secret@postgres:5432/iris",
    });

    await runtime.start();
    expect(order).toEqual(["scanner-start"]);
    expect(runtime.canUseProactiveSignalPlanning("oc_pilot")).toBe(true);
    expect(runtime.canUseProactiveSignalPlanning("oc_control")).toBe(false);
    expect(runtime.canUseProactiveSignalPlanning("oc_other")).toBe(false);

    const scanner = dependencies.createScanner.mock.results[0]!.value;
    await scanner.scanOnce({ groupId: "oc_pilot", limit: 10 });

    expect(dependencies.store.listThreads).toHaveBeenCalledWith({ groupId: "oc_pilot", limit: 20 });
    expect(dependencies.repository.recordCandidates).toHaveBeenCalledWith({
      signals: [expect.objectContaining({
        idempotencyKey: "quiet_open_thread:thread-quiet:2",
        groupId: "oc_pilot",
      })],
      now: new Date("2026-07-26T08:00:00.000Z"),
    });
    await expect(runtime.getStatus()).resolves.toEqual({
      enabled: true,
      running: true,
      enabledGroupCount: 2,
      scanner: { running: true, intervalMs: 60000, batchLimit: 10 },
    });

    await runtime.close();
    expect(order).toEqual(["scanner-start", "scanner-stop", "pool-end"]);
  });

  it("fails closed when proactive speech is disabled", async () => {
    const runtimeController = new RuntimeController(createDefaultRuntimeConfig());
    runtimeController.pauseProactiveBehavior();
    const dependencies = runtimeDependencies();
    const runtime = createProactiveSignalPlannerRuntime({
      env: enabledEnv(),
      runtimeController,
      store: dependencies.store,
      dependencies,
    })!;

    await runtime.start();

    expect(runtime.canUseProactiveSignalPlanning("oc_pilot")).toBe(false);
    const scanner = dependencies.createScanner.mock.results[0]!.value;
    await expect(scanner.scanOnce({ groupId: "oc_pilot", limit: 10 })).resolves.toEqual({
      groupId: "oc_pilot",
      status: "skipped",
      reason: "runtime_disabled",
      recordedCount: 0,
      existingCount: 0,
    });
    expect(dependencies.store.listThreads).not.toHaveBeenCalled();
    await runtime.close();
  });
});

function enabledEnv() {
  return {
    IRIS_PROACTIVE_SIGNAL_PLANNER_ENABLED: "true",
    IRIS_PROACTIVE_SIGNAL_PLANNER_GROUP_IDS: "oc_pilot,oc_control",
    DATABASE_URL: "postgres://iris:secret@postgres:5432/iris",
  };
}

function runtimeDependencies({ order = [] }: { order?: string[] } = {}) {
  const pool = {
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(async () => { order.push("pool-end"); }),
  };
  const repository = {
    recordCandidates: vi.fn<ProactiveSignalRepository["recordCandidates"]>().mockResolvedValue({
      recordedCount: 1,
      existingCount: 0,
      suppressedCount: 0,
      recordedKeys: ["quiet_open_thread:thread-quiet:2"],
    }),
  } as unknown as ProactiveSignalRepository;
  const store = {
    getStatus: vi.fn(),
    listThreads: vi.fn<ConversationStateInspectionStore["listThreads"]>().mockResolvedValue([
      {
        id: "thread-quiet",
        groupId: "oc_pilot",
        title: "Launch decision",
        summary: "Waiting for a final launch call.",
        status: "open",
        confidence: 0.9,
        version: 2,
        firstEvidenceAt: new Date("2026-07-25T06:00:00.000Z"),
        lastActivityAt: new Date("2026-07-25T07:00:00.000Z"),
        createdAt: new Date("2026-07-25T06:00:00.000Z"),
        updatedAt: new Date("2026-07-25T07:00:00.000Z"),
        evidenceMessageIds: ["message-thread"],
      },
    ]),
    listActions: vi.fn<ConversationStateInspectionStore["listActions"]>().mockResolvedValue([]),
    listThreadEvents: vi.fn(),
    listActionEvents: vi.fn(),
    deleteMessageEvidence: vi.fn(),
  } as unknown as ConversationStateInspectionStore;
  const scannerLoop = {
    start: vi.fn(() => { order.push("scanner-start"); }),
    stop: vi.fn(async () => { order.push("scanner-stop"); }),
    getSnapshot: vi.fn(() => ({ running: true, intervalMs: 60000, batchLimit: 10 })),
  };
  const dependencies = {
    createPostgresPool: vi.fn(() => pool),
    createRepository: vi.fn(() => repository),
    createScanner: vi.fn((input: Parameters<NonNullable<ProactiveSignalPlannerRuntimeDependencies["createScanner"]>>[0]) =>
      createProactiveSignalScanner(input),
    ),
    createScannerLoop: vi.fn(() => scannerLoop),
  } satisfies ProactiveSignalPlannerRuntimeDependencies;
  return Object.assign(dependencies, { pool, repository, store, scannerLoop });
}
