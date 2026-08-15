import { describe, expect, it, vi } from "vitest";

import { RuntimeController } from "../src/admin/runtime-controller.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import { createApprovalInteractionWorker } from
  "../src/knowledge-cards/approval-interaction-worker.js";
import type { KnowledgeConflictRepository } from
  "../src/knowledge-conflicts/knowledge-conflict-repository.js";
import {
  createKnowledgeConflictRuntime,
  createPresentationAwareInteractionDelegate,
  type KnowledgeConflictRuntimeComposition,
} from "../src/runtime/knowledge-conflict-runtime.js";

describe("createKnowledgeConflictRuntime", () => {
  it("returns undefined without opening resources when disabled", () => {
    const createPostgresPool = vi.fn();

    expect(createKnowledgeConflictRuntime({
      env: {},
      runtimeController: runtimeController(),
      getKnowledgeCardPresentationRuntime: () => undefined,
      dependencies: { createPostgresPool },
    })).toBeUndefined();
    expect(createPostgresPool).not.toHaveBeenCalled();
  });

  it("starts scanner before dispatcher and opens the full delivery gate only after startup", async () => {
    const order: string[] = [];
    const composition = fakeComposition({
      scannerLoop: fakeScannerLoop({
        start: vi.fn(async () => { order.push("scanner"); }),
      }),
      dispatcherLoop: fakeDispatcherLoop({
        start: vi.fn(() => { order.push("dispatcher"); }),
      }),
    });
    const controller = runtimeController();
    const runtime = createKnowledgeConflictRuntime({
      env: enabledEnv(),
      runtimeController: controller,
      getKnowledgeCardPresentationRuntime: () => undefined,
      dependencies: runtimeDependencies(composition),
    })!;

    expect(runtime.canUseKnowledgeConflict("group-a")).toBe(false);
    await runtime.start();

    expect(order).toEqual(["scanner", "dispatcher"]);
    expect(runtime.canUseKnowledgeConflict("group-a")).toBe(true);
    expect(runtime.canUseKnowledgeConflict("group-b")).toBe(false);
    controller.pauseProactiveBehavior();
    expect(runtime.canUseKnowledgeConflict("group-a")).toBe(false);
    expect(composition.canUseForAnswer("group-a")).toBe(true);
    expect(composition.canUseForEvidence("group-a")).toBe(true);
  });

  it("queries the shared answer provider only for started allowlisted groups", async () => {
    const findConflictPlan = vi.fn(async () => undefined);
    const composition = fakeComposition({ answerProvider: { findConflictPlan } });
    const runtime = createKnowledgeConflictRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      getKnowledgeCardPresentationRuntime: () => undefined,
      dependencies: runtimeDependencies(composition),
    })!;
    const answerInput = { usedGroupMemories: [], allowedFragments: [] };

    await runtime.answerProvider.findConflictPlan({ groupId: "group-a", ...answerInput });
    expect(findConflictPlan).not.toHaveBeenCalled();

    await runtime.start();
    await runtime.answerProvider.findConflictPlan({
      groupId: "group-outside-allowlist",
      ...answerInput,
    });
    expect(findConflictPlan).not.toHaveBeenCalled();

    await runtime.answerProvider.findConflictPlan({ groupId: "group-a", ...answerInput });
    expect(findConflictPlan).toHaveBeenCalledOnce();
  });

  it("reports only content-free lifecycle and durable counts", async () => {
    const composition = fakeComposition();
    const runtime = createKnowledgeConflictRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      getKnowledgeCardPresentationRuntime: () => undefined,
      dependencies: runtimeDependencies(composition),
    })!;
    await runtime.start();

    const status = await runtime.getStatus();

    expect(status).toMatchObject({
      enabled: true,
      running: true,
      migration0046Applied: true,
      migration0047Applied: true,
      migration0048Applied: true,
      enabledGroupCount: 1,
      scans: { pending: 1, processing: 2, retry: 3, completed: 4, deadLettered: 0 },
      candidates: { pending_review: 1 },
      deliveries: { terminalFailed: 0, outcomeUnknown: 0 },
      interactions: { applied: 1, alreadyApplied: 0, rejected: 0 },
      reconciliation: { terminalFailed: 0, outcomeUnknown: 0 },
    });
    expect(JSON.stringify(status)).not.toMatch(
      /statement|sourceText|prompt|actorOpenId|token|secret|candidate-id|group-a/u,
    );
  });

  it("fails status closed when durable counts cannot be read", async () => {
    const composition = fakeComposition({
      repository: fakeRepository({
        getScanStatusCounts: vi.fn(async () => { throw new Error("raw database detail"); }),
      }),
    });
    const runtime = createKnowledgeConflictRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      getKnowledgeCardPresentationRuntime: () => undefined,
      dependencies: runtimeDependencies(composition),
    })!;
    await runtime.start();

    await expect(runtime.getStatus()).rejects.toThrow("knowledge conflict status unavailable");
  });

  it.each([
    ["0046", { migration0046Applied: false }, "migration0046Applied"],
    ["0047", { migration0047Applied: false }, "migration0047Applied"],
    ["0048", { migration0048Applied: false }, "migration0048Applied"],
  ] as const)("reports missing migration %s without querying conflict tables", async (
    _migration,
    override,
    missingField,
  ) => {
    const repository = fakeRepository();
    const composition = fakeComposition({
      repository,
      getRequiredMigrationStatus: vi.fn(async () => ({
        migration0046Applied: true,
        migration0047Applied: true,
        migration0048Applied: true,
        ...override,
      })),
    } as never);
    const runtime = createKnowledgeConflictRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      getKnowledgeCardPresentationRuntime: () => undefined,
      dependencies: runtimeDependencies(composition),
    })!;
    await runtime.start();

    await expect(runtime.getStatus()).resolves.toMatchObject({
      [missingField]: false,
      scans: { pending: 0, deadLettered: 0 },
      deliveries: { terminalFailed: 0, outcomeUnknown: 0 },
    });
    expect(repository.getScanStatusCounts).not.toHaveBeenCalled();
    expect(repository.getCandidateStatusCounts).not.toHaveBeenCalled();
    expect(repository.getDeliveryStatusCounts).not.toHaveBeenCalled();
    expect(repository.getInteractionResultCounts).not.toHaveBeenCalled();
  });

  it("retains a callback during dependency preparation and applies it after startup", async () => {
    const prepared = deferred<void>();
    let dependencyReady = false;
    const processInteraction = vi.fn(async () => dependencyReady
      ? { status: "applied" as const, code: "conflict_dismissed" as const }
      : { status: "denied" as const, code: "runtime_disabled" as const });
    const composition = fakeComposition({
      prepare: vi.fn(async () => {
        await prepared.promise;
        dependencyReady = true;
      }),
      interactionWorker: { processInteraction },
    });
    const runtime = createKnowledgeConflictRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      getKnowledgeCardPresentationRuntime: () => undefined,
      dependencies: runtimeDependencies(composition),
    })!;
    const callback = conflictCallbackJob();
    const queue = {
      claimBatch: vi.fn(async () => [callback]),
      acknowledge: vi.fn(async () => undefined),
      handleFailure: vi.fn(async () => ({ action: "delayed" as const })),
    };
    const approvalWorker = createApprovalInteractionWorker({
      queue,
      repository: {
        getPresentation: vi.fn(),
        getPresentationContext: vi.fn(),
        applyInteraction: vi.fn(),
      },
      membershipChecker: { isCurrentMember: vi.fn() },
      cardClient: { updateCard: vi.fn() },
      canUseKnowledgeCards: () => true,
      botOpenId: "ou_iris",
      workerId: "approval-worker-1",
      leaseMs: 30_000,
      now: () => new Date("2026-08-15T08:00:00.000Z"),
      callbackIdentityStore: {
        resolveIdentity: vi.fn(async () => ({
          eventId: "event-1",
          appId: "app-id",
          actorOpenId: "ou_member",
          chatId: "group-a",
          messageId: "message-1",
        })),
      },
      knowledgeConflictInteractionWorker: runtime.interactionWorker,
    });

    const startup = runtime.start();
    await Promise.resolve();
    expect(composition.prepare).toHaveBeenCalledOnce();

    await expect(approvalWorker.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "retrying",
      idempotencyKey: callback.idempotencyKey,
      code: "internal_error",
    }]);
    expect(queue.handleFailure).toHaveBeenCalledOnce();
    expect(queue.acknowledge).not.toHaveBeenCalled();

    prepared.resolve();
    await startup;
    await expect(approvalWorker.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "applied",
      idempotencyKey: callback.idempotencyKey,
      code: "conflict_dismissed",
    }]);
    expect(queue.acknowledge).toHaveBeenCalledOnce();
  });

  it("closes both loops before Postgres exactly once", async () => {
    const order: string[] = [];
    const pool = { end: vi.fn(async () => { order.push("postgres"); }) };
    const composition = fakeComposition({
      scannerLoop: fakeScannerLoop({ stop: vi.fn(async () => { order.push("scanner"); }) }),
      dispatcherLoop: fakeDispatcherLoop({ stop: vi.fn(async () => { order.push("dispatcher"); }) }),
    });
    const runtime = createKnowledgeConflictRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      getKnowledgeCardPresentationRuntime: () => undefined,
      dependencies: runtimeDependencies(composition, pool),
    })!;
    await runtime.start();

    await Promise.all([runtime.close(), runtime.close()]);

    expect(order).toEqual(["dispatcher", "scanner", "postgres"]);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("closes earlier resources once when composition or startup fails", async () => {
    const compositionPool = { end: vi.fn(async () => undefined) };
    let compositionCleanup: Promise<void> | undefined;
    expect(() => createKnowledgeConflictRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      getKnowledgeCardPresentationRuntime: () => undefined,
      dependencies: {
        createPostgresPool: () => compositionPool as never,
        createComposition: () => { throw new Error("composition failed"); },
        onStartupCleanup: (cleanup) => { compositionCleanup = cleanup; },
      },
    })).toThrow("composition failed");
    await compositionCleanup;
    expect(compositionPool.end).toHaveBeenCalledOnce();

    const startupPool = { end: vi.fn(async () => undefined) };
    const dispatcherStop = vi.fn(async () => undefined);
    const scannerStop = vi.fn(async () => undefined);
    const composition = fakeComposition({
      scannerLoop: fakeScannerLoop({
        start: vi.fn(async () => { throw new Error("scanner dependency failed"); }),
        stop: scannerStop,
      }),
      dispatcherLoop: fakeDispatcherLoop({ stop: dispatcherStop }),
    });
    const runtime = createKnowledgeConflictRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      getKnowledgeCardPresentationRuntime: () => undefined,
      dependencies: runtimeDependencies(composition, startupPool),
    })!;

    await expect(runtime.start()).rejects.toThrow("scanner dependency failed");
    expect(dispatcherStop).toHaveBeenCalledOnce();
    expect(scannerStop).toHaveBeenCalledOnce();
    expect(startupPool.end).toHaveBeenCalledOnce();
    await runtime.close();
    expect(startupPool.end).toHaveBeenCalledOnce();
  });
});

describe("lazy knowledge-card presentation binding", () => {
  it("returns retryable internal_error while unresolved and never skips presentation", async () => {
    const worker = { processInteraction: vi.fn(async () => ({
      status: "applied" as const,
      code: "draft_created" as const,
      draftId: "draft",
      presentationId: "presentation",
    })) };
    let presentationRuntime: object | undefined;
    const delegate = createPresentationAwareInteractionDelegate(
      worker,
      () => presentationRuntime as never,
    );
    const job = { action: "create_update_draft" } as never;

    await expect(delegate.processInteraction(job)).resolves.toEqual({
      status: "retryable",
      code: "internal_error",
    });
    expect(worker.processInteraction).not.toHaveBeenCalled();

    presentationRuntime = {};
    await expect(delegate.processInteraction(job)).resolves.toMatchObject({
      status: "applied",
      code: "draft_created",
    });
    expect(worker.processInteraction).toHaveBeenCalledOnce();
  });
});

function runtimeDependencies(
  composition: KnowledgeConflictRuntimeComposition,
  pool: { end(): Promise<void> } = { end: vi.fn(async () => undefined) },
) {
  return {
    createPostgresPool: vi.fn(() => pool as never),
    createComposition: vi.fn((input) => Object.assign(composition, {
      canUseForEvidence: input.canUseForEvidence,
      canUseForAnswer: input.canUseForAnswer,
    })),
  };
}

function fakeComposition(
  overrides: Partial<KnowledgeConflictRuntimeComposition> = {},
): KnowledgeConflictRuntimeComposition {
  return {
    repository: fakeRepository(),
    currentValidator: { validate: vi.fn() } as never,
    answerProvider: { findConflictPlan: vi.fn(async () => undefined) },
    interactionWorker: { processInteraction: vi.fn() } as never,
    scannerLoop: fakeScannerLoop(),
    dispatcherLoop: fakeDispatcherLoop(),
    prepare: vi.fn(async () => undefined),
    getRequiredMigrationStatus: vi.fn(async () => ({
      migration0046Applied: true,
      migration0047Applied: true,
      migration0048Applied: true,
    })),
    canUseForEvidence: vi.fn(() => false),
    canUseForAnswer: vi.fn(() => false),
    ...overrides,
  };
}

function fakeScannerLoop(overrides: Record<string, unknown> = {}) {
  let running = false;
  return {
    start: vi.fn(async () => { running = true; }),
    stop: vi.fn(async () => { running = false; }),
    isRunning: vi.fn(() => running),
    getSnapshot: vi.fn(() => ({ running, intervalMs: 60_000, batchLimit: 10 })),
    ...overrides,
  } as never;
}

function fakeDispatcherLoop(overrides: Record<string, unknown> = {}) {
  let running = false;
  return {
    start: vi.fn(() => { running = true; }),
    stop: vi.fn(async () => { running = false; }),
    isRunning: vi.fn(() => running),
    getSnapshot: vi.fn(() => ({ running, intervalMs: 1_000, batchLimit: 10 })),
    ...overrides,
  } as never;
}

function fakeRepository(
  overrides: Partial<KnowledgeConflictRepository> = {},
): KnowledgeConflictRepository {
  return {
    getScanStatusCounts: vi.fn(async () => ({
      pending: 1, processing: 2, retry: 3, completed: 4, deadLettered: 0,
    })),
    getCandidateStatusCounts: vi.fn(async () => ({
      pending_review: 1,
      dismissed: 0,
      approved_for_delivery: 0,
      delivered: 0,
      draft_created: 0,
      superseded: 0,
    })),
    getDeliveryStatusCounts: vi.fn(async () => ({
      pending: 0,
      processing: 0,
      externalAttempting: 0,
      sent: 1,
      failed: 0,
      terminalFailed: 0,
      outcomeUnknown: 0,
      cancelled: 0,
    })),
    getInteractionResultCounts: vi.fn(async () => ({
      applied: 1, alreadyApplied: 0, rejected: 0,
    })),
    ...overrides,
  } as KnowledgeConflictRepository;
}

function conflictCallbackJob() {
  return {
    kind: "knowledge_conflict_confirmation" as const,
    idempotencyKey: "feishu-card:app-id:event-1",
    callbackIdentityId: "callback-identity-1",
    presentationId: "candidate-1",
    candidateId: "candidate-1",
    candidateVersion: 1,
    groupId: "group-a",
    nonce: "4eaf0d0d991a4cf19b5f84c0f6c120d4",
    action: "not_a_conflict" as const,
    receivedAt: new Date("2026-08-15T07:59:59.000Z"),
    attempts: 0,
  };
}

function deferred<T>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise as typeof resolve;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function runtimeController() {
  return new RuntimeController(createDefaultRuntimeConfig({}));
}

function enabledEnv() {
  return {
    IRIS_KNOWLEDGE_CONFLICT_ENABLED: "true",
    IRIS_KNOWLEDGE_CONFLICT_GROUP_ALLOWLIST: "group-a",
    DATABASE_URL: "postgres://example/iris",
    REDIS_URL: "redis://localhost:6379",
    IRIS_MODEL_PROVIDER: "openai-compatible",
    IRIS_MODEL_BASE_URL: "https://model.example.com/v1",
    IRIS_MODEL_API_KEY: "model-key",
    IRIS_MODEL_NAME: "model-name",
    IRIS_EMBEDDING_PROVIDER: "openai-compatible",
    IRIS_EMBEDDING_BASE_URL: "https://embedding.example.com/v1",
    IRIS_EMBEDDING_API_KEY: "embedding-key",
    IRIS_EMBEDDING_MODEL: "embedding-model",
    IRIS_EMBEDDING_DIMENSIONS: "1536",
    FEISHU_APP_ID: "app-id",
    FEISHU_APP_SECRET: "app-secret",
    FEISHU_VERIFICATION_TOKEN: "verification-token",
    FEISHU_ENCRYPT_KEY: "encrypt-key",
    IRIS_FEISHU_BOT_OPEN_ID: "ou_iris",
    IRIS_KNOWLEDGE_CARD_ENABLED: "true",
    IRIS_KNOWLEDGE_CARD_GROUP_IDS: "group-a",
    IRIS_APPROVAL_ACTIONS_ENABLED: "true",
    IRIS_APPROVAL_ACTION_GROUP_IDS: "group-a",
  };
}
