import { ClientClosedError, createClient } from "redis";
import { describe, expect, it, vi } from "vitest";

import * as knowledgeCardRuntimeModule from "../src/runtime/knowledge-card-runtime.js";

vi.mock("redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("redis")>();
  return { ...actual, createClient: vi.fn(actual.createClient) };
});

type StatusReaderFactory = (input: {
  env: Record<string, string | undefined>;
  dependencies: ReturnType<typeof statusReaderDependencies>;
}) => {
  getStatus(): Promise<unknown>;
  close(): Promise<void>;
} | undefined;

describe("KnowledgeCardStatusReader", () => {
  it("constructs its production Redis client without background reconnect", async () => {
    const factory = getStatusReaderFactory();
    if (factory === undefined) return;
    const dependencies = statusReaderDependencies();
    vi.mocked(createClient).mockClear();

    const reader = factory({
      env: disabledStatusEnv(),
      dependencies: {
        ...dependencies,
        createRedisClient: undefined,
      } as unknown as ReturnType<typeof statusReaderDependencies>,
    });

    expect(reader).toBeDefined();
    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      url: "redis://redis:6379",
      socket: expect.objectContaining({ reconnectStrategy: false }),
    }));
    await reader?.close();
    expect(dependencies.pool.end).toHaveBeenCalledOnce();
  });

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
    expect(dependencies.redis.quit).not.toHaveBeenCalled();
    expect(dependencies.redis.destroy).toHaveBeenCalledOnce();
    expect(dependencies.pool.end).toHaveBeenCalledOnce();
    expect(dependencies.redisListenerCount("error")).toBe(0);
    expect(dependencies.redisListenerCount("connect")).toBe(0);
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
    expect(dependencies.redis.destroy).not.toHaveBeenCalled();
    expect(dependencies.pool.end).toHaveBeenCalledOnce();
  });

  it("accepts ClientClosedError only after destroy made the client not open", async () => {
    const factory = getStatusReaderFactory();
    if (factory === undefined) return;
    const dependencies = statusReaderDependencies();
    dependencies.redis.destroy.mockImplementation(() => {
      dependencies.setRedisOpen(false);
      throw new ClientClosedError();
    });
    const reader = factory({ env: disabledStatusEnv(), dependencies });

    await reader?.getStatus();
    await expectSettlesWithin(reader!.close());
    expect(dependencies.redis.quit).not.toHaveBeenCalled();
    expect(dependencies.redis.destroy).toHaveBeenCalledOnce();
    expect(dependencies.pool.end).toHaveBeenCalledOnce();
  });

  it("fails closed when destroy throws and the client remains open", async () => {
    const factory = getStatusReaderFactory();
    if (factory === undefined) return;
    const dependencies = statusReaderDependencies();
    dependencies.redis.destroy.mockImplementation(() => {
      throw new ClientClosedError();
    });
    const reader = factory({ env: disabledStatusEnv(), dependencies });

    await reader?.getStatus();
    await expect(reader!.close()).rejects.toBeInstanceOf(ClientClosedError);
    expect(dependencies.redis.quit).not.toHaveBeenCalled();
    expect(dependencies.redis.destroy).toHaveBeenCalledOnce();
    expect(dependencies.pool.end).toHaveBeenCalledOnce();
    dependencies.setRedisOpen(false);
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
    dependencies.createKnowledgeCardRepository.mockImplementation(() => {
      throw new Error("status repository composition failed");
    });
    dependencies.onStartupCleanup = (cleanup) => cleanups.push(cleanup);

    expect(() => factory({ env: disabledStatusEnv(), dependencies })).toThrow(
      "status repository composition failed",
    );
    expect(cleanups).toHaveLength(1);
    await expectSettlesWithin(cleanups[0]);
    expect(dependencies.redis.connect).not.toHaveBeenCalled();
    expect(dependencies.redis.quit).not.toHaveBeenCalled();
    expect(dependencies.redis.destroy).not.toHaveBeenCalled();
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
  let redisOpen = false;
  let redisReady = false;
  const listeners = {
    error: [] as Array<(error: Error) => void>,
    connect: [] as Array<() => void>,
  };
  const redis = {
    get isOpen() {
      return redisOpen;
    },
    get isReady() {
      return redisReady;
    },
    connect: vi.fn(async () => {
      redisOpen = true;
      for (const listener of listeners.connect) listener();
      redisReady = true;
      return redis;
    }),
    quit: vi.fn(async () => undefined),
    destroy: vi.fn(() => {
      redisOpen = false;
      redisReady = false;
    }),
    eval: vi.fn(async () => 0),
    on: vi.fn((event: "error" | "connect", listener: ((error: Error) => void) | (() => void)) => {
      if (event === "error") listeners.error.push(listener as (error: Error) => void);
      else listeners.connect.push(listener as () => void);
      return redis;
    }),
    off: vi.fn((event: "error" | "connect", listener: ((error: Error) => void) | (() => void)) => {
      const eventListeners = listeners[event] as Array<typeof listener>;
      const index = eventListeners.indexOf(listener);
      if (index !== -1) eventListeners.splice(index, 1);
      return redis;
    }),
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
    createApprovalInteractionQueue: vi.fn((input: {
      client: { eval(
        script: string,
        options: { keys: string[]; arguments: string[] },
      ): Promise<unknown> };
    }) => ({
      getCounts: vi.fn(async () => {
        await input.client.eval("status-counts", { keys: [], arguments: [] });
        return queue.getCounts();
      }),
    })),
    onStartupCleanup: undefined as ((cleanup: Promise<void>) => void) | undefined,
    pool,
    redis,
    repository,
    queue,
    setRedisOpen(value: boolean) {
      redisOpen = value;
      if (!value) redisReady = false;
    },
    redisListenerCount(event: "error" | "connect") {
      return listeners[event].length;
    },
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
