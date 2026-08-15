import { describe, expect, it, vi } from "vitest";

import * as knowledgeCardRuntimeModule from "../src/runtime/knowledge-card-runtime.js";

type StatusReaderFactory = (input: {
  env: Record<string, string | undefined>;
  dependencies: ReturnType<typeof statusReaderDependencies>;
}) => {
  getStatus(): Promise<unknown>;
  close(): Promise<void>;
} | undefined;

describe("KnowledgeCardStatusReader", () => {
  it("reads content-free PostgreSQL and Redis counts while card processing is disabled", async () => {
    const factory = getStatusReaderFactory();
    if (factory === undefined) return;
    const dependencies = statusReaderDependencies();

    const reader = factory({ env: disabledStatusEnv(), dependencies });

    expect(reader).toBeDefined();
    await expect(reader?.getStatus()).resolves.toEqual({
      enabled: false,
      running: false,
      enabledGroupCount: 0,
      queue: { pending: 2, processing: 1, delayed: 3, deadLetter: 4 },
      presentations: {
        pending_send: 5,
        active: 6,
        superseded: 7,
        closed: 8,
        send_failed: 9,
        pendingSend: 5,
      },
      outbox: {
        pending: 10,
        processing: 11,
        external_attempting: 12,
        sent: 13,
        failed: 14,
        outcome_unknown: 15,
        terminalFailed: 4,
      },
    });
    expect(dependencies.createPostgresPool).toHaveBeenCalledOnce();
    expect(dependencies.createRedisClient).toHaveBeenCalledOnce();
    expect(dependencies.createKnowledgeCardRepository).toHaveBeenCalledOnce();
    expect(dependencies.createApprovalInteractionQueue).toHaveBeenCalledOnce();

    const firstClose = reader!.close();
    const concurrentClose = reader!.close();
    expect(concurrentClose).toBe(firstClose);
    await firstClose;
    expect(reader!.close()).toBe(firstClose);
    expect(dependencies.redis.connect).toHaveBeenCalledOnce();
    expect(dependencies.redis.quit).toHaveBeenCalledOnce();
    expect(dependencies.redis.destroy).not.toHaveBeenCalled();
    expect(dependencies.pool.end).toHaveBeenCalledOnce();
  });

  it("propagates count-read failures without returning synthetic zero", async () => {
    const factory = getStatusReaderFactory();
    if (factory === undefined) return;
    const dependencies = statusReaderDependencies();
    dependencies.queue.getCounts.mockRejectedValue(new Error("redis count failed"));
    const reader = factory({ env: disabledStatusEnv(), dependencies });

    await expect(reader?.getStatus()).rejects.toThrow("redis count failed");
    await reader?.close();
  });

  it("destroys failed Redis connection state without waiting for quit", async () => {
    const factory = getStatusReaderFactory();
    if (factory === undefined) return;
    const connectionError = Object.assign(new Error("redis connection refused"), {
      code: "ECONNREFUSED",
    });
    const dependencies = statusReaderDependencies();
    dependencies.redis.connect.mockRejectedValue(connectionError);
    dependencies.queue.getCounts.mockRejectedValue(connectionError);
    dependencies.redis.quit.mockImplementation(() => new Promise(() => undefined));
    const reader = factory({ env: disabledStatusEnv(), dependencies });

    await expect(reader?.getStatus()).rejects.toBe(connectionError);
    const firstClose = reader!.close();
    const concurrentClose = reader!.close();
    expect(concurrentClose).toBe(firstClose);
    await expectSettlesWithin(firstClose);
    expect(reader!.close()).toBe(firstClose);
    await expectSettlesWithin(reader!.close());
    expect(dependencies.redis.quit).not.toHaveBeenCalled();
    expect(dependencies.redis.destroy).toHaveBeenCalledOnce();
    expect(dependencies.pool.end).toHaveBeenCalledOnce();
  });

  it("falls back to destroy when graceful Redis quit rejects", async () => {
    const factory = getStatusReaderFactory();
    if (factory === undefined) return;
    const dependencies = statusReaderDependencies();
    dependencies.redis.quit.mockRejectedValue(new Error("redis quit failed"));
    const reader = factory({ env: disabledStatusEnv(), dependencies });

    await reader?.getStatus();
    await expectSettlesWithin(reader!.close());
    expect(dependencies.redis.quit).toHaveBeenCalledOnce();
    expect(dependencies.redis.destroy).toHaveBeenCalledOnce();
    expect(dependencies.pool.end).toHaveBeenCalledOnce();
  });

  it("bounds a hanging graceful Redis quit and destroys the client", async () => {
    const factory = getStatusReaderFactory();
    if (factory === undefined) return;
    const dependencies = statusReaderDependencies();
    dependencies.redis.quit.mockImplementation(() => new Promise(() => undefined));
    const reader = factory({ env: disabledStatusEnv(), dependencies });

    await reader?.getStatus();
    await expectSettlesWithin(reader!.close());
    expect(dependencies.redis.quit).toHaveBeenCalledOnce();
    expect(dependencies.redis.destroy).toHaveBeenCalledOnce();
    expect(dependencies.pool.end).toHaveBeenCalledOnce();
  });

  it("acquires no resources when status datastores are not configured", () => {
    const factory = getStatusReaderFactory();
    if (factory === undefined) return;
    const dependencies = statusReaderDependencies();

    expect(factory({ env: {}, dependencies })).toBeUndefined();
    expect(dependencies.createPostgresPool).not.toHaveBeenCalled();
    expect(dependencies.createRedisClient).not.toHaveBeenCalled();
  });

  it("schedules cleanup for every acquired resource when composition fails", async () => {
    const factory = getStatusReaderFactory();
    if (factory === undefined) return;
    const cleanups: Promise<void>[] = [];
    const dependencies = statusReaderDependencies();
    dependencies.redis.connect.mockImplementation(() => new Promise(() => undefined));
    dependencies.redis.quit.mockImplementation(() => new Promise(() => undefined));
    dependencies.createKnowledgeCardRepository.mockImplementation(() => {
      throw new Error("status repository composition failed");
    });
    dependencies.onStartupCleanup = (cleanup) => cleanups.push(cleanup);

    expect(() => factory({ env: disabledStatusEnv(), dependencies })).toThrow(
      "status repository composition failed",
    );
    expect(cleanups).toHaveLength(1);
    await expectSettlesWithin(cleanups[0]);
    expect(dependencies.redis.quit).not.toHaveBeenCalled();
    expect(dependencies.redis.destroy).toHaveBeenCalledOnce();
    expect(dependencies.pool.end).toHaveBeenCalledOnce();
  });
});

function getStatusReaderFactory(): StatusReaderFactory | undefined {
  const factory = (knowledgeCardRuntimeModule as unknown as {
    createKnowledgeCardStatusReader?: StatusReaderFactory;
  }).createKnowledgeCardStatusReader;
  expect(factory).toBeTypeOf("function");
  return factory;
}

function disabledStatusEnv() {
  return {
    IRIS_KNOWLEDGE_CARD_ENABLED: "false",
    DATABASE_URL: "postgres://iris:secret@postgres:5432/iris",
    REDIS_URL: "redis://redis:6379",
  };
}

function statusReaderDependencies() {
  const pool = {
    query: vi.fn(),
    end: vi.fn(async () => undefined),
  };
  const redis = {
    connect: vi.fn(async () => redis),
    quit: vi.fn(async () => undefined),
    destroy: vi.fn(),
    eval: vi.fn(),
  };
  const repository = {
    getStatusCounts: vi.fn(async () => ({
      pending_send: 5,
      active: 6,
      superseded: 7,
      closed: 8,
      send_failed: 9,
      pendingSend: 5,
    })),
    getOutboxStatusCounts: vi.fn(async () => ({
      pending: 10,
      processing: 11,
      external_attempting: 12,
      sent: 13,
      failed: 14,
      outcome_unknown: 15,
      terminalFailed: 4,
    })),
  };
  const queue = {
    getCounts: vi.fn(async () => ({ pending: 2, processing: 1, delayed: 3, deadLetter: 4 })),
  };
  return {
    createPostgresPool: vi.fn(() => pool),
    createRedisClient: vi.fn(() => redis),
    createKnowledgeCardRepository: vi.fn(() => repository),
    createApprovalInteractionQueue: vi.fn(() => queue),
    onStartupCleanup: undefined as ((cleanup: Promise<void>) => void) | undefined,
    pool,
    redis,
    repository,
    queue,
  };
}

async function expectSettlesWithin(promise: Promise<void>, timeoutMs = 400): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("close did not settle within the bound")), timeoutMs);
    timer.unref();
  });
  try {
    await expect(Promise.race([promise, timeout])).resolves.toBeUndefined();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
