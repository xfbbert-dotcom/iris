import { describe, expect, it, vi } from "vitest";

import { RuntimeController } from "../src/admin/runtime-controller.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import {
  createKnowledgeCardRuntime,
  type KnowledgeCardRuntimeDependencies,
} from "../src/runtime/knowledge-card-runtime.js";

describe("KnowledgeCardRuntime", () => {
  it("does not acquire slow resources while default-off", () => {
    const dependencies = runtimeDependencies();

    expect(createKnowledgeCardRuntime({ env: {}, dependencies })).toBeUndefined();
    expect(dependencies.createPostgresPool).not.toHaveBeenCalled();
    expect(dependencies.createRedisClient).not.toHaveBeenCalled();
  });

  it("owns one pool and Redis client, shares one token provider, and combines every group gate", async () => {
    const dependencies = runtimeDependencies();
    const controller = new RuntimeController(createDefaultRuntimeConfig());
    const canGenerate = vi.spyOn(controller, "canGenerateKnowledgeDrafts");
    const runtime = createKnowledgeCardRuntime({
      env: enabledEnv(),
      runtimeController: controller,
      dependencies,
    });

    expect(runtime).toBeDefined();
    expect(dependencies.createPostgresPool).toHaveBeenCalledOnce();
    expect(dependencies.createRedisClient).toHaveBeenCalledOnce();
    expect(dependencies.createFeishuTenantAccessTokenProvider).toHaveBeenCalledOnce();
    const tokenProvider = vi.mocked(dependencies.createFeishuTenantAccessTokenProvider).mock.results[0]?.value;
    expect(dependencies.createFeishuInteractiveCardClient).toHaveBeenCalledWith(
      expect.objectContaining({ tokenProvider }),
    );
    expect(dependencies.createFeishuGroupMembershipChecker).toHaveBeenCalledWith(
      expect.objectContaining({ tokenProvider }),
    );

    expect(runtime?.canUseKnowledgeCards(" oc_pilot ")).toBe(true);
    expect(canGenerate).toHaveBeenLastCalledWith({ sourceGroupId: "oc_pilot" });
    expect(runtime?.canUseKnowledgeCards("oc_not_allowed")).toBe(false);
    controller.disableGroup("oc_pilot");
    expect(runtime?.canUseKnowledgeCards("oc_pilot")).toBe(false);
    controller.enableGroup("oc_pilot");
    controller.setCapability("generateKnowledgeDrafts", false);
    expect(runtime?.canUseKnowledgeCards("oc_pilot")).toBe(false);
    controller.setCapability("generateKnowledgeDrafts", true);
    controller.disableGlobal();
    expect(runtime?.canUseKnowledgeCards("oc_pilot")).toBe(false);

    runtime?.start();
    runtime?.start();
    expect(dependencies.dispatcherLoop.start).toHaveBeenCalledOnce();
    expect(dependencies.interactionLoop.start).toHaveBeenCalledOnce();

    await expect(runtime?.getStatus()).resolves.toEqual({
      enabled: true,
      running: true,
      enabledGroupCount: 2,
      dispatcher: { running: true, intervalMs: 1000, batchLimit: 10 },
      worker: { running: true, intervalMs: 1000, batchLimit: 10 },
      queue: { pending: 1, processing: 2, delayed: 3, deadLetter: 4 },
      presentations: {
        pending_send: 1,
        active: 2,
        superseded: 3,
        closed: 4,
        send_failed: 5,
        pendingSend: 1,
      },
    });
    expect(JSON.stringify(await runtime?.getStatus())).not.toMatch(
      /draft body|evidence|actorOpenId|reason|token-secret/u,
    );

    await runtime?.close();
  });

  it("waits for both loops before closing Redis then Postgres and closes idempotently", async () => {
    const order: string[] = [];
    const dispatcherStop = deferred<void>();
    const interactionStop = deferred<void>();
    const dependencies = runtimeDependencies({
      dispatcherStop: vi.fn(() => {
        order.push("dispatcher-stop");
        return dispatcherStop.promise;
      }),
      interactionStop: vi.fn(() => {
        order.push("interaction-stop");
        return interactionStop.promise;
      }),
      redisQuit: vi.fn(async () => {
        order.push("redis-quit");
      }),
      poolEnd: vi.fn(async () => {
        order.push("pool-end");
      }),
    });
    const runtime = createKnowledgeCardRuntime({
      env: enabledEnv(),
      runtimeController: enabledController(),
      dependencies,
    });

    const firstClose = runtime!.close();
    const secondClose = runtime!.close();
    expect(firstClose).toBe(secondClose);
    await Promise.resolve();
    expect(order).toEqual(["dispatcher-stop"]);
    dispatcherStop.resolve();
    await Promise.resolve();
    expect(order).toEqual(["dispatcher-stop", "interaction-stop"]);
    interactionStop.resolve();
    await firstClose;

    expect(order).toEqual([
      "dispatcher-stop",
      "interaction-stop",
      "redis-quit",
      "pool-end",
    ]);
    expect(dependencies.redis.quit).toHaveBeenCalledOnce();
    expect(dependencies.pool.end).toHaveBeenCalledOnce();
  });

  it("cleans every acquired resource when enabled composition fails", async () => {
    const cleanupPromises: Promise<void>[] = [];
    const dependencies = runtimeDependencies({
      createCardClient: vi.fn(() => {
        throw new Error("card client composition failed");
      }),
      onStartupCleanup: (cleanup) => cleanupPromises.push(cleanup),
    });

    expect(() => createKnowledgeCardRuntime({
      env: enabledEnv(),
      runtimeController: enabledController(),
      dependencies,
    })).toThrow("card client composition failed");
    expect(cleanupPromises).toHaveLength(1);
    await expect(cleanupPromises[0]).resolves.toBeUndefined();
    expect(dependencies.redis.quit).toHaveBeenCalledOnce();
    expect(dependencies.pool.end).toHaveBeenCalledOnce();
  });
});

function enabledEnv() {
  return {
    IRIS_KNOWLEDGE_CARD_ENABLED: "true",
    IRIS_KNOWLEDGE_CARD_GROUP_IDS: "oc_pilot, oc_review",
    DATABASE_URL: "postgres://iris:secret@postgres:5432/iris",
    REDIS_URL: "redis://redis:6379",
    FEISHU_VERIFICATION_TOKEN: "verification-token",
    FEISHU_APP_ID: "app-id",
    FEISHU_APP_SECRET: "app-secret",
    FEISHU_OPEN_BASE_URL: "https://open.example.com",
    IRIS_FEISHU_BOT_OPEN_ID: "ou_irisbot",
  };
}

function enabledController() {
  return new RuntimeController(createDefaultRuntimeConfig());
}

function runtimeDependencies(overrides: {
  dispatcherStop?: ReturnType<typeof vi.fn>;
  interactionStop?: ReturnType<typeof vi.fn>;
  redisQuit?: ReturnType<typeof vi.fn>;
  poolEnd?: ReturnType<typeof vi.fn>;
  createCardClient?: ReturnType<typeof vi.fn>;
  onStartupCleanup?: (cleanup: Promise<void>) => void;
} = {}) {
  const pool = {
    query: vi.fn(async () => ({ rows: [] })),
    connect: vi.fn(),
    end: overrides.poolEnd ?? vi.fn(async () => undefined),
  };
  const redis = {
    connect: vi.fn(async () => redis),
    quit: overrides.redisQuit ?? vi.fn(async () => undefined),
    eval: vi.fn(async () => 1),
  };
  const repository = {
    createPresentation: vi.fn(),
    claimPresentationSend: vi.fn(async () => undefined),
    beginExternalAttempt: vi.fn(),
    failPresentationPreparation: vi.fn(),
    completePresentationSend: vi.fn(),
    failPresentationSend: vi.fn(),
    applyInteraction: vi.fn(),
    getPresentation: vi.fn(),
    getPresentationContext: vi.fn(),
    listPresentations: vi.fn(async () => []),
    getStatusCounts: vi.fn(async () => ({
      pending_send: 1,
      active: 2,
      superseded: 3,
      closed: 4,
      send_failed: 5,
      pendingSend: 1,
    })),
  };
  const drafts = { getDraft: vi.fn() };
  const queue = {
    enqueue: vi.fn(async () => "enqueued" as const),
    claimBatch: vi.fn(async () => []),
    acknowledge: vi.fn(),
    handleFailure: vi.fn(),
    getCounts: vi.fn(async () => ({ pending: 1, processing: 2, delayed: 3, deadLetter: 4 })),
    listDeadLetters: vi.fn(async () => []),
    replayDeadLetter: vi.fn(async () => "not_found" as const),
    deleteDeadLetter: vi.fn(async () => "not_found" as const),
  };
  const dispatcherLoop = {
    start: vi.fn(),
    stop: overrides.dispatcherStop ?? vi.fn(async () => undefined),
    isRunning: vi.fn(() => true),
    getSnapshot: vi.fn(() => ({ running: true, intervalMs: 1000, batchLimit: 10 })),
  };
  const interactionLoop = {
    start: vi.fn(),
    stop: overrides.interactionStop ?? vi.fn(async () => undefined),
    isRunning: vi.fn(() => true),
    getSnapshot: vi.fn(() => ({ running: true, intervalMs: 1000, batchLimit: 10 })),
  };
  const tokenProvider = { getTenantAccessToken: vi.fn(async () => "token-secret") };
  const dependencies = {
    createPostgresPool: vi.fn(() => pool),
    createRedisClient: vi.fn(() => redis),
    createKnowledgeDraftRepository: vi.fn(() => drafts),
    createKnowledgeCardRepository: vi.fn(() => repository),
    createApprovalInteractionQueue: vi.fn(() => queue),
    createFeishuTenantAccessTokenProvider: vi.fn(() => tokenProvider),
    createFeishuInteractiveCardClient: overrides.createCardClient ?? vi.fn(() => ({
      sendCard: vi.fn(),
      updateCard: vi.fn(),
    })),
    createFeishuGroupMembershipChecker: vi.fn(() => ({ isCurrentMember: vi.fn() })),
    createDispatcherLoop: vi.fn(() => dispatcherLoop),
    createInteractionLoop: vi.fn(() => interactionLoop),
    ...(overrides.onStartupCleanup === undefined
      ? {}
      : { onStartupCleanup: overrides.onStartupCleanup }),
  } satisfies KnowledgeCardRuntimeDependencies;

  return Object.assign(dependencies, {
    pool,
    redis,
    repository,
    drafts,
    queue,
    dispatcherLoop,
    interactionLoop,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
