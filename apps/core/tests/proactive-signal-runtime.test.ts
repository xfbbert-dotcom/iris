import { describe, expect, it, vi } from "vitest";

import { RuntimeController } from "../src/admin/runtime-controller.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import type { FeishuInteractiveCardClient } from "../src/feishu/feishu-interactive-card-client.js";
import type { ProactiveSignalRepository } from "../src/proactive-signals/proactive-signal-repository.js";
import { createProactiveSignalDeliveryRuntime, type ProactiveSignalDeliveryRuntimeDependencies } from "../src/runtime/proactive-signal-delivery-runtime.js";

describe("ProactiveSignalDeliveryRuntime", () => {
  it("allocates no resources while disabled by default", () => {
    const dependencies = runtimeDependencies();

    expect(createProactiveSignalDeliveryRuntime({ env: {}, dependencies })).toBeUndefined();
    expect(dependencies.createPostgresPool).not.toHaveBeenCalled();
  });

  it("composes, starts, reports, gates by allowlist and runtime controller, and closes", async () => {
    const order: string[] = [];
    const runtimeController = new RuntimeController(createDefaultRuntimeConfig());
    runtimeController.disableGroup("oc_review");
    const dependencies = runtimeDependencies({ order });
    const runtime = createProactiveSignalDeliveryRuntime({
      env: enabledEnv(),
      runtimeController,
      dependencies,
    })!;

    expect(dependencies.createPostgresPool).toHaveBeenCalledWith({
      databaseUrl: "postgres://iris:secret@postgres:5432/iris",
    });
    expect(dependencies.createFeishuTenantAccessTokenProvider).toHaveBeenCalledWith({
      baseUrl: "https://open.feishu.cn",
      appId: "app-id",
      appSecret: "app-secret",
    });
    expect(dependencies.createFeishuInteractiveCardClient).toHaveBeenCalledWith({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: dependencies.tokenProvider,
    });
    const deliveryGate = dependencies.createDispatcher.mock.calls[0]?.[0].canDeliverProactiveSignals;
    expect(deliveryGate?.("oc_pilot")).toBe(false);
    expect(runtime.canUseProactiveSignalDelivery("oc_pilot")).toBe(false);

    await runtime.start();
    expect(order).toEqual(["dispatcher-start"]);
    expect(runtime.canUseProactiveSignalDelivery("oc_pilot")).toBe(true);
    expect(runtime.canUseProactiveSignalDelivery("oc_review")).toBe(false);
    expect(runtime.canUseProactiveSignalDelivery("oc_other")).toBe(false);
    expect(deliveryGate?.("oc_pilot")).toBe(true);
    expect(deliveryGate?.("oc_review")).toBe(false);
    await expect(runtime.getStatus()).resolves.toEqual({
      enabled: true,
      running: true,
      enabledGroupCount: 2,
      dispatcher: { running: true, intervalMs: 1000, batchLimit: 10 },
    });

    await runtime.close();
    expect(order).toEqual(["dispatcher-start", "dispatcher-stop", "pool-end"]);
  });

  it("fails closed when proactive speech is disabled", async () => {
    const runtimeController = new RuntimeController(createDefaultRuntimeConfig());
    runtimeController.pauseProactiveBehavior();
    const runtime = createProactiveSignalDeliveryRuntime({
      env: enabledEnv(),
      runtimeController,
      dependencies: runtimeDependencies(),
    })!;

    await runtime.start();

    expect(runtime.canUseProactiveSignalDelivery("oc_pilot")).toBe(false);
    await runtime.close();
  });
});

function enabledEnv() {
  return {
    IRIS_PROACTIVE_SIGNAL_DELIVERY_ENABLED: "true",
    IRIS_PROACTIVE_SIGNAL_DELIVERY_GROUP_IDS: "oc_pilot,oc_review",
    DATABASE_URL: "postgres://iris:secret@postgres:5432/iris",
    FEISHU_APP_ID: "app-id",
    FEISHU_APP_SECRET: "app-secret",
  };
}

function runtimeDependencies({ order = [] }: { order?: string[] } = {}) {
  const pool = {
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(async () => { order.push("pool-end"); }),
  };
  const repository = {
    recordCandidates: vi.fn(),
    listPendingCandidates: vi.fn(),
    dismissCandidate: vi.fn(),
    approveCandidateForDelivery: vi.fn(),
    claimProactiveSignalDelivery: vi.fn(),
    getProactiveSignalDeliveryContext: vi.fn(),
    beginProactiveSignalDeliveryAttempt: vi.fn(),
    failProactiveSignalDeliveryPreparation: vi.fn(),
    completeProactiveSignalDelivery: vi.fn(),
    failProactiveSignalDelivery: vi.fn(),
  } as unknown as ProactiveSignalRepository;
  const dispatcherLoop = {
    start: vi.fn(() => { order.push("dispatcher-start"); }),
    stop: vi.fn(async () => { order.push("dispatcher-stop"); }),
    isRunning: vi.fn(() => true),
    getSnapshot: vi.fn(() => ({ running: true, intervalMs: 1000, batchLimit: 10 })),
  };
  const tokenProvider = { getTenantAccessToken: vi.fn() };
  const cardClient = {
    sendCard: vi.fn(),
    sendCardToUser: vi.fn(),
    updateCard: vi.fn(),
  } as unknown as FeishuInteractiveCardClient;
  const dependencies = {
    createPostgresPool: vi.fn(() => pool),
    createRepository: vi.fn(() => repository),
    createDispatcher: vi.fn((
      _input: Parameters<NonNullable<ProactiveSignalDeliveryRuntimeDependencies["createDispatcher"]>>[0],
    ) => ({ processBatch: vi.fn() })),
    createFeishuTenantAccessTokenProvider: vi.fn(() => tokenProvider),
    createFeishuInteractiveCardClient: vi.fn(() => cardClient),
    createDispatcherLoop: vi.fn(() => dispatcherLoop),
  } satisfies ProactiveSignalDeliveryRuntimeDependencies;
  return Object.assign(dependencies, {
    pool,
    repository,
    dispatcherLoop,
    tokenProvider,
    cardClient,
  });
}
