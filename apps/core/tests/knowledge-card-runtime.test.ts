import { createCipheriv, createHash } from "node:crypto";
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

  it("routes content-free callback diagnostics through the runtime observer", async () => {
    const dependencies = runtimeDependencies();
    const onCardCallbackDiagnostic = vi.fn();
    const runtime = createKnowledgeCardRuntime({
      env: enabledEnv(),
      runtimeController: enabledController(),
      dependencies: { ...dependencies, onCardCallbackDiagnostic },
    })!;

    await expect(runtime.gateway.handleCallback({
      headers: {},
      body: {
        type: "url_verification",
        challenge: "sensitive-challenge",
        token: "sensitive-token",
      },
      rawBody: "sensitive-raw-body",
    })).resolves.toMatchObject({ statusCode: 401 });

    expect(onCardCallbackDiagnostic).toHaveBeenCalledOnce();
    expect(onCardCallbackDiagnostic).toHaveBeenCalledWith({
      stage: "envelope_rejected",
      statusCode: 401,
      hasTimestamp: false,
      hasNonce: false,
      hasSignature: false,
      encrypted: false,
    });
    expect(JSON.stringify(onCardCallbackDiagnostic.mock.calls)).not.toMatch(
      /sensitive-(?:challenge|token|raw-body)/u,
    );

    await runtime.close();
  });

  it("accepts a signed URL challenge before requiring a card callback app id", async () => {
    const dependencies = runtimeDependencies();
    const runtime = createKnowledgeCardRuntime({
      env: enabledEnv(),
      runtimeController: enabledController(),
      dependencies,
    })!;
    const body = {
      type: "url_verification",
      challenge: "card-callback-challenge",
      token: "verification-token",
    };
    const rawBody = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const nonce = "card-callback-nonce";

    await expect(runtime.gateway.handleCallback({
      headers: {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": createHash("sha1")
          .update(timestamp + nonce + "verification-token" + rawBody)
          .digest("hex"),
      },
      body,
      rawBody,
    })).resolves.toEqual({
      statusCode: 200,
      body: { challenge: "card-callback-challenge" },
    });
    expect(dependencies.queue.enqueue).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("authenticates and decrypts Feishu URL challenges before responding", async () => {
    const dependencies = runtimeDependencies();
    const runtime = createKnowledgeCardRuntime({
      env: enabledEnv(),
      runtimeController: enabledController(),
      dependencies,
    })!;
    const request = encryptedRequest({
      type: "url_verification",
      challenge: "encrypted-card-callback-challenge",
      token: "verification-token",
    });

    await expect(runtime.gateway.handleCallback(request)).resolves.toEqual({
      statusCode: 200,
      body: { challenge: "encrypted-card-callback-challenge" },
    });
    expect(dependencies.queue.enqueue).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("accepts an unsigned encrypted Feishu URL challenge after exact token verification", async () => {
    const dependencies = runtimeDependencies();
    const onCardCallbackDiagnostic = vi.fn();
    const runtime = createKnowledgeCardRuntime({
      env: enabledEnv(),
      runtimeController: enabledController(),
      dependencies: { ...dependencies, onCardCallbackDiagnostic },
    })!;
    const signedRequest = encryptedRequest({
      type: "url_verification",
      challenge: "unsigned-encrypted-challenge",
      token: "verification-token",
    });
    const request = { ...signedRequest, headers: {} };

    await expect(runtime.gateway.handleCallback(request)).resolves.toEqual({
      statusCode: 200,
      body: { challenge: "unsigned-encrypted-challenge" },
    });
    expect(onCardCallbackDiagnostic).toHaveBeenCalledWith({
      stage: "unsigned_encrypted_challenge_accepted",
      statusCode: 200,
      hasTimestamp: false,
      hasNonce: false,
      hasSignature: false,
      encrypted: true,
    });
    expect(dependencies.queue.enqueue).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("rejects an unsigned encrypted normal card action", async () => {
    const dependencies = runtimeDependencies();
    const runtime = createKnowledgeCardRuntime({
      env: enabledEnv(),
      runtimeController: enabledController(),
      dependencies,
    })!;
    const request = { ...encryptedRequest(cardAction()), headers: {} };

    await expect(runtime.gateway.handleCallback(request)).resolves.toMatchObject({ statusCode: 401 });
    expect(dependencies.queue.enqueue).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("rejects an unsigned encrypted URL challenge with the wrong verification token", async () => {
    const dependencies = runtimeDependencies();
    const runtime = createKnowledgeCardRuntime({
      env: enabledEnv(),
      runtimeController: enabledController(),
      dependencies,
    })!;
    const signedRequest = encryptedRequest({
      type: "url_verification",
      challenge: "wrong-token-challenge",
      token: "wrong-verification-token",
    });
    const request = { ...signedRequest, headers: {} };

    await expect(runtime.gateway.handleCallback(request)).resolves.toMatchObject({ statusCode: 401 });
    expect(dependencies.queue.enqueue).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("rejects a partially signed encrypted URL challenge instead of using unsigned fallback", async () => {
    const dependencies = runtimeDependencies();
    const runtime = createKnowledgeCardRuntime({
      env: enabledEnv(),
      runtimeController: enabledController(),
      dependencies,
    })!;
    const signedRequest = encryptedRequest({
      type: "url_verification",
      challenge: "partial-signature-challenge",
      token: "verification-token",
    });
    const request = {
      ...signedRequest,
      headers: { "x-lark-request-timestamp": signedRequest.headers["x-lark-request-timestamp"] },
    };

    await expect(runtime.gateway.handleCallback(request)).resolves.toMatchObject({ statusCode: 401 });
    expect(dependencies.queue.enqueue).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("authenticates and decrypts Feishu card actions before enqueueing", async () => {
    const dependencies = runtimeDependencies();
    const runtime = createKnowledgeCardRuntime({
      env: enabledEnv(),
      runtimeController: enabledController(),
      dependencies,
    })!;
    const request = encryptedRequest(cardAction());

    await expect(runtime.gateway.handleCallback(request)).resolves.toEqual({
      statusCode: 200,
      body: { toast: { type: "info", content: "\u5df2\u6536\u5230\uff0c\u6b63\u5728\u6838\u9a8c" } },
    });
    expect(dependencies.queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "feishu-card:app-id:event-1",
      eventId: "event-1",
      appId: "app-id",
      actorOpenId: "ou_reviewer",
      chatId: "oc_pilot",
      presentationId: "presentation-1",
      draftId: "draft-1",
      revisionNumber: 7,
      draftVersion: 11,
      action: "confirm",
    }));

    await runtime.close();
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

    const firstStart = runtime!.start();
    const concurrentStart = runtime!.start();
    expect(firstStart).toBeInstanceOf(Promise);
    expect(concurrentStart).toBe(firstStart);
    await firstStart;
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
      outbox: {
        pending: 6,
        processing: 7,
        external_attempting: 8,
        sent: 9,
        failed: 10,
        outcome_unknown: 11,
        terminalFailed: 4,
      },
    });
    expect(JSON.stringify(await runtime?.getStatus())).not.toMatch(
      /draft body|evidence|actorOpenId|reason|token-secret/u,
    );

    await runtime?.close();
  });

  it("awaits full cleanup after the interaction loop throws and remains terminal", async () => {
    const order: string[] = [];
    const startError = new Error("interaction loop start failed");
    const dispatcherStop = deferred<void>();
    const interactionStop = deferred<void>();
    const dependencies = runtimeDependencies({
      dispatcherStart: vi.fn(() => order.push("dispatcher-start")),
      interactionStart: vi.fn(() => {
        order.push("interaction-start");
        throw startError;
      }),
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
    })!;

    const startup = runtime.start();
    const concurrentStartup = runtime.start();
    expect(startup).toBeInstanceOf(Promise);
    expect(concurrentStartup).toBe(startup);
    expect(order).toEqual(["dispatcher-start", "interaction-start", "dispatcher-stop"]);

    dispatcherStop.resolve();
    await Promise.resolve();
    expect(order).toEqual([
      "dispatcher-start",
      "interaction-start",
      "dispatcher-stop",
      "interaction-stop",
    ]);
    interactionStop.resolve();
    await expect(startup).rejects.toBe(startError);

    expect(order).toEqual([
      "dispatcher-start",
      "interaction-start",
      "dispatcher-stop",
      "interaction-stop",
      "redis-quit",
      "pool-end",
    ]);
    const laterStartup = runtime.start();
    expect(laterStartup).toBe(startup);
    await expect(laterStartup).rejects.toBe(startError);
    await expect(runtime.close()).resolves.toBeUndefined();
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(dependencies.dispatcherLoop.stop).toHaveBeenCalledOnce();
    expect(dependencies.interactionLoop.stop).toHaveBeenCalledOnce();
    expect(dependencies.redis.quit).toHaveBeenCalledOnce();
    expect(dependencies.pool.end).toHaveBeenCalledOnce();
  });

  it("cleans both loops and owned clients when the dispatcher loop start throws", async () => {
    const order: string[] = [];
    const startError = new Error("dispatcher loop start failed");
    const dependencies = runtimeDependencies({
      dispatcherStart: vi.fn(() => {
        order.push("dispatcher-start");
        throw startError;
      }),
      interactionStart: vi.fn(() => order.push("interaction-start")),
      dispatcherStop: vi.fn(async () => {
        order.push("dispatcher-stop");
      }),
      interactionStop: vi.fn(async () => {
        order.push("interaction-stop");
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
    })!;

    const startup = runtime.start();
    await expect(startup).rejects.toBe(startError);

    expect(order).toEqual([
      "dispatcher-start",
      "dispatcher-stop",
      "interaction-stop",
      "redis-quit",
      "pool-end",
    ]);
    expect(dependencies.interactionLoop.start).not.toHaveBeenCalled();
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(dependencies.dispatcherLoop.stop).toHaveBeenCalledOnce();
    expect(dependencies.interactionLoop.stop).toHaveBeenCalledOnce();
    expect(dependencies.redis.quit).toHaveBeenCalledOnce();
    expect(dependencies.pool.end).toHaveBeenCalledOnce();
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

  it("attempts every ordered close step and aggregates all cleanup failures", async () => {
    const order: string[] = [];
    const dispatcherError = new Error("dispatcher stop failed");
    const interactionError = new Error("interaction stop failed");
    const redisError = new Error("redis quit failed");
    const postgresError = new Error("postgres close failed");
    const dependencies = runtimeDependencies({
      dispatcherStop: vi.fn(async () => {
        order.push("dispatcher-stop");
        throw dispatcherError;
      }),
      interactionStop: vi.fn(async () => {
        order.push("interaction-stop");
        throw interactionError;
      }),
      redisQuit: vi.fn(async () => {
        order.push("redis-quit");
        throw redisError;
      }),
      poolEnd: vi.fn(async () => {
        order.push("pool-end");
        throw postgresError;
      }),
    });
    const runtime = createKnowledgeCardRuntime({
      env: enabledEnv(),
      runtimeController: enabledController(),
      dependencies,
    })!;
    await runtime.start();

    let closeError: unknown;
    try {
      await runtime.close();
    } catch (error) {
      closeError = error;
    }

    expect(closeError).toBeInstanceOf(AggregateError);
    expect((closeError as AggregateError).message).toBe(
      "Iris runtime resource cleanup failed",
    );
    expect((closeError as AggregateError).errors).toEqual([
      dispatcherError,
      interactionError,
      redisError,
      postgresError,
    ]);
    expect(order).toEqual([
      "dispatcher-stop",
      "interaction-stop",
      "redis-quit",
      "pool-end",
    ]);
    await expect(runtime.close()).rejects.toBe(closeError);
    expect(dependencies.dispatcherLoop.stop).toHaveBeenCalledOnce();
    expect(dependencies.interactionLoop.stop).toHaveBeenCalledOnce();
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
    FEISHU_ENCRYPT_KEY: "encrypt-key",
    FEISHU_APP_ID: "app-id",
    FEISHU_APP_SECRET: "app-secret",
    FEISHU_OPEN_BASE_URL: "https://open.example.com",
    IRIS_FEISHU_BOT_OPEN_ID: "ou_irisbot",
  };
}

function enabledController() {
  return new RuntimeController(createDefaultRuntimeConfig());
}

function encryptedRequest(payload: unknown) {
  const body = { encrypt: encryptPayload(payload) };
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = "encrypted-card-callback-nonce";
  return {
    headers: {
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": createHash("sha1")
        .update(timestamp + nonce + "verification-token" + rawBody)
        .digest("hex"),
    },
    body,
    rawBody,
  };
}

function encryptPayload(payload: unknown): string {
  const iv = Buffer.from("0123456789abcdef", "utf8");
  const cipher = createCipheriv(
    "aes-256-cbc",
    createHash("sha256").update("encrypt-key").digest(),
    iv,
  );
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]).toString("base64");
}

function cardAction(): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      event_id: "event-1",
      token: "verification-token",
      create_time: "1784419200000000",
      event_type: "card.action.trigger",
      tenant_key: "tenant-1",
      app_id: "app-id",
    },
    event: {
      operator: { tenant_key: "tenant-1", open_id: "ou_reviewer" },
      token: "card-token",
      action: {
        value: {
          action: "confirm",
          presentationId: "presentation-1",
          draftId: "draft-1",
          revisionNumber: 7,
          draftVersion: 11,
        },
        tag: "button",
        name: "confirm",
        form_value: { reason: "" },
      },
      host: "im_message",
      context: { open_message_id: "om_approval", open_chat_id: "oc_pilot" },
    },
  };
}

function runtimeDependencies(overrides: {
  dispatcherStart?: ReturnType<typeof vi.fn>;
  interactionStart?: ReturnType<typeof vi.fn>;
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
    getOutboxStatusCounts: vi.fn(async () => ({
      pending: 6,
      processing: 7,
      external_attempting: 8,
      sent: 9,
      failed: 10,
      outcome_unknown: 11,
      terminalFailed: 4,
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
    start: overrides.dispatcherStart ?? vi.fn(),
    stop: overrides.dispatcherStop ?? vi.fn(async () => undefined),
    isRunning: vi.fn(() => true),
    getSnapshot: vi.fn(() => ({ running: true, intervalMs: 1000, batchLimit: 10 })),
  };
  const interactionLoop = {
    start: overrides.interactionStart ?? vi.fn(),
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
