import { once } from "node:events";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "redis";

import { InMemoryAuditLog } from "../src/audit/audit-log.js";
import { RuntimeController } from "../src/admin/runtime-controller.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import type { ConversationMessage } from "../src/conversation/conversation-message-repository.js";
import type { MemoryExtractionQueue } from "../src/memory-extraction/memory-extraction-queue.js";
import type { MemoryExtractionRepository } from "../src/memory-extraction/memory-extraction-repository.js";
import {
  createMemoryExtractionRuntime,
  type MemoryExtractionRuntimeDependencies,
} from "../src/runtime/memory-extraction-runtime.js";

const redisCreations = vi.hoisted(() => [] as Array<{
  client: unknown;
  options: unknown;
}>);

vi.mock("redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("redis")>();
  return {
    ...actual,
    createClient(options: Parameters<typeof actual.createClient>[0]) {
      const client = actual.createClient(options);
      redisCreations.push({ client, options });
      return client;
    },
  };
});

const redisTestUrl = process.env.IRIS_TEST_REDIS_URL?.trim();
const runIfRedis = redisTestUrl === undefined ? it.skip : it;
const networkTestResources = {
  clients: new Set<{ readonly isOpen: boolean; destroy(): void }>(),
  runtimeClosers: new Set<() => Promise<void>>(),
  servers: new Set<Server>(),
  sockets: new Set<Socket>(),
};

afterEach(async () => {
  const errors: unknown[] = [];
  try {
    for (const socket of networkTestResources.sockets) {
      try {
        socket.destroy();
      } catch (error) {
        errors.push(error);
      }
    }
    await Promise.all(
      [...networkTestResources.runtimeClosers].map(async (close) => {
        try {
          await settleBeforeDeadline(close(), 1_000, "runtime cleanup timed out");
        } catch (error) {
          errors.push(error);
        }
      }),
    );
    for (const client of networkTestResources.clients) {
      try {
        if (client.isOpen) {
          client.destroy();
        }
      } catch (error) {
        errors.push(error);
      }
    }
    await Promise.all(
      [...networkTestResources.servers].map(async (server) => {
        try {
          await settleBeforeDeadline(closeTcpServer(server), 1_000, "server cleanup timed out");
        } catch (error) {
          errors.push(error);
        }
      }),
    );
  } finally {
    networkTestResources.clients.clear();
    networkTestResources.runtimeClosers.clear();
    networkTestResources.servers.clear();
    networkTestResources.sockets.clear();
  }
  if (errors.length > 0) {
    throw errors[0];
  }
});

describe("createMemoryExtractionRuntime", () => {
  it("returns no runtime and opens no resources when disabled", () => {
    const createPostgresPool = vi.fn();
    const createRedisClient = vi.fn();
    const createAiWorkerClient = vi.fn();

    expect(
      createMemoryExtractionRuntime({
        env: {
          IRIS_MEMORY_EXTRACTION_ENABLED: "false",
          DATABASE_URL: "not-a-database-url",
          REDIS_URL: "not-a-redis-url",
          IRIS_AI_WORKER_BASE_URL: "file:///secret",
          IRIS_AI_WORKER_TOKEN: "unsafe token",
        },
        runtimeController: runtimeController(),
        dependencies: {
          createPostgresPool,
          createRedisClient,
          createAiWorkerClient,
        },
      }),
    ).toBeUndefined();

    expect(createPostgresPool).not.toHaveBeenCalled();
    expect(createRedisClient).not.toHaveBeenCalled();
    expect(createAiWorkerClient).not.toHaveBeenCalled();
  });

  it("owns one dependency graph, waits for database and Redis, and closes once in reverse order", async () => {
    const fixture = runtimeFixture({ deferRedisConnect: true });
    const auditLog = new InMemoryAuditLog();
    const controller = runtimeController();
    const runtime = createMemoryExtractionRuntime({
      env: enabledEnv(),
      runtimeController: controller,
      auditLog,
      dependencies: fixture.dependencies,
    });

    expect(runtime).toBeDefined();
    expect(fixture.dependencies.createPostgresPool).toHaveBeenCalledOnce();
    expect(fixture.dependencies.createRedisClient).toHaveBeenCalledOnce();
    expect(fixture.dependencies.createRepository).toHaveBeenCalledWith({
      dataSource: expect.objectContaining({
        query: expect.any(Function),
        connect: expect.any(Function),
      }),
    });
    expect(fixture.dependencies.createQueue).toHaveBeenCalledWith({
      client: expect.objectContaining({
        eval: expect.any(Function),
        sCard: expect.any(Function),
        zCard: expect.any(Function),
        get: expect.any(Function),
      }),
    });
    expect(fixture.dependencies.createAiWorkerClient).toHaveBeenCalledWith({
      baseUrl: "http://ai-worker:8000",
      token: "worker-token",
    });
    expect(fixture.dependencies.createWorker).toHaveBeenCalledWith({
      queue: fixture.queue,
      repository: fixture.repository,
      client: fixture.aiClient,
      auditLog,
      runtimeController: controller,
      minConfidence: 0.85,
    });
    expect(fixture.dependencies.createWorkerLoop).toHaveBeenCalledWith({
      worker: fixture.worker,
      intervalMs: 1000,
      batchLimit: 20,
      onError: expect.any(Function),
    });
    expect(fixture.dependencies.createPlanner).toHaveBeenCalledWith({
      repository: fixture.repository,
      queue: fixture.queue,
      runtimeController: controller,
      irisBotOpenId: "ou_iris",
    });
    expect(fixture.redis.connect).not.toHaveBeenCalled();
    expect(fixture.loop.start).not.toHaveBeenCalled();

    runtime?.start();
    runtime?.start();

    expect(fixture.pool.query).toHaveBeenCalledOnce();
    expect(fixture.loop.start).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fixture.redis.connect).toHaveBeenCalledOnce());

    fixture.resolveRedisConnect();
    await vi.waitFor(() => expect(fixture.loop.start).toHaveBeenCalledOnce());

    const message = conversationMessage();
    await runtime?.planner.registerMessage(message, { senderOpenId: "ou_human" });
    expect(fixture.planner.registerMessage).toHaveBeenCalledWith(message, {
      senderOpenId: "ou_human",
    });

    await expect(runtime?.getStatus()).resolves.toEqual({
      enabled: true,
      running: true,
      workerHealthy: true,
      intervalMs: 1000,
      batchLimit: 20,
      minConfidence: 0.85,
      pendingJobCount: 3,
      processingJobCount: 2,
      delayedJobCount: 1,
      deadLetterJobCount: 4,
      acceptedCandidateCount: 9,
      rejectedCandidateCount: 7,
      duplicateCandidateCount: 3,
      conflictCandidateCount: 2,
      skippedRequestCount: 6,
      failedRunCount: 5,
      providerCooldownUntil: new Date("2026-07-15T02:00:00.000Z"),
      latestBatch: {
        status: "succeeded",
        startedAt: new Date("2026-07-15T01:00:00.000Z"),
        finishedAt: new Date("2026-07-15T01:00:01.000Z"),
        completedCount: 2,
        skippedCount: 1,
        deferredCount: 1,
        failedCount: 0,
        failed: false,
      },
    });
    await expect(runtime?.deadLetters.list({ limit: 20 })).resolves.toEqual([]);
    await expect(runtime?.deadLetters.replay("dlq-1")).resolves.toBe("replayed");
    await expect(runtime?.deadLetters.replayBatch({ ids: ["dlq-1"] })).resolves.toEqual({
      replayedCount: 1,
      notFoundIds: [],
      unsupportedLegacyIds: [],
    });
    await expect(runtime?.deadLetters.delete("dlq-1")).resolves.toBe("deleted");

    await Promise.all([runtime?.close(), runtime?.close()]);
    expect(fixture.cleanupOrder).toEqual(["loop", "redis", "postgres"]);
    expect(fixture.loop.stop).toHaveBeenCalledOnce();
    expect(fixture.redis.quit).toHaveBeenCalledOnce();
    expect(fixture.pool.end).toHaveBeenCalledOnce();

    runtime?.start();
    expect(fixture.redis.connect).toHaveBeenCalledOnce();
    expect(fixture.loop.start).toHaveBeenCalledOnce();
  });

  it("reports an unhealthy AI worker without exposing connection configuration", async () => {
    const fixture = runtimeFixture();
    fixture.aiClient.checkHealth.mockRejectedValueOnce(new Error("provider secret response"));
    fixture.loop.getSnapshot.mockReturnValueOnce({
      running: true,
      intervalMs: 1000,
      batchLimit: 20,
      latestBatch: {
        status: "failed",
        startedAt: new Date("2026-07-15T01:00:00.000Z"),
        finishedAt: new Date("2026-07-15T01:00:01.000Z"),
        completedCount: 0,
        skippedCount: 0,
        deferredCount: 0,
        failedCount: 0,
        failed: true,
        errorMessage: "provider secret response",
        providerPayload: "secret upstream body",
      },
    } as never);
    const runtime = createMemoryExtractionRuntime({
      env: {
        ...enabledEnv(),
        IRIS_AI_WORKER_TOKEN: "do-not-expose-this-token",
      },
      runtimeController: runtimeController(),
      dependencies: fixture.dependencies,
    });
    runtime?.start();
    await vi.waitFor(() => expect(fixture.loop.start).toHaveBeenCalledOnce());

    const status = await runtime?.getStatus();

    expect(status).toMatchObject({
      enabled: true,
      running: true,
      workerHealthy: false,
      pendingJobCount: 3,
      processingJobCount: 2,
      delayedJobCount: 1,
      deadLetterJobCount: 4,
    });
    expect(JSON.stringify(status)).not.toContain("do-not-expose-this-token");
    expect(JSON.stringify(status)).not.toContain("provider secret response");
    expect(JSON.stringify(status)).not.toContain("secret upstream body");
    expect(JSON.stringify(status)).not.toContain("ai-worker:8000");

    await runtime?.close();
  });

  it("wires configured minimum confidence into worker behavior and status", async () => {
    const fixture = runtimeFixture();
    const runtime = createMemoryExtractionRuntime({
      env: {
        ...enabledEnv(),
        IRIS_MEMORY_EXTRACTION_MIN_CONFIDENCE: "1",
      },
      runtimeController: runtimeController(),
      dependencies: fixture.dependencies,
    });

    expect(fixture.dependencies.createWorker).toHaveBeenCalledWith(
      expect.objectContaining({ minConfidence: 1 }),
    );
    runtime?.start();
    await vi.waitFor(() => expect(fixture.loop.start).toHaveBeenCalledOnce());
    await expect(runtime?.getStatus()).resolves.toMatchObject({ minConfidence: 1 });
    await runtime?.close();
  });

  it("prevents Redis connect when close begins during a pending database probe", async () => {
    const fixture = runtimeFixture({ deferDatabaseProbe: true });
    const runtime = createMemoryExtractionRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      dependencies: fixture.dependencies,
    });
    runtime?.start();
    expect(fixture.redis.connect).not.toHaveBeenCalled();

    const close = runtime?.close();
    fixture.resolveDatabaseProbe();
    await close;

    expect(fixture.redis.connect).not.toHaveBeenCalled();
    expect(fixture.redis.destroy).not.toHaveBeenCalled();
    expect(fixture.loop.start).not.toHaveBeenCalled();
    expect(fixture.cleanupOrder).toEqual(["loop", "postgres"]);
  });

  it("prevents Redis connect when close wins after the database probe settles", async () => {
    const fixture = runtimeFixture({ deferDatabaseProbe: true });
    const runtime = createMemoryExtractionRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      dependencies: fixture.dependencies,
    });
    runtime?.start();

    fixture.resolveDatabaseProbe();
    await runtime?.close();

    expect(fixture.redis.connect).not.toHaveBeenCalled();
    expect(fixture.redis.destroy).not.toHaveBeenCalled();
    expect(fixture.loop.start).not.toHaveBeenCalled();
    expect(fixture.pool.end).toHaveBeenCalledOnce();
  });

  it("closes a real redis@6 client that was never connected", async () => {
    const fixture = runtimeFixture();
    const dependencies: MemoryExtractionRuntimeDependencies = {
      createPostgresPool: fixture.dependencies.createPostgresPool,
      createRepository: fixture.dependencies.createRepository,
      createQueue: fixture.dependencies.createQueue,
      createAiWorkerClient: fixture.dependencies.createAiWorkerClient,
      createWorker: fixture.dependencies.createWorker,
      createWorkerLoop: fixture.dependencies.createWorkerLoop,
      createPlanner: fixture.dependencies.createPlanner,
    };
    const runtime = createMemoryExtractionRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      dependencies,
    });

    await expect(runtime?.close()).resolves.toBeUndefined();
    expect(fixture.pool.end).toHaveBeenCalledOnce();
  });

  it("creates the production Redis client with reconnect disabled and a safe error listener", async () => {
    redisCreations.length = 0;
    const fixture = runtimeFixture();
    const dependencies = withoutRedisFactory(fixture.dependencies);
    const runtime = createMemoryExtractionRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      dependencies,
    });
    const creation = redisCreations.at(-1);
    const client = creation?.client as ReturnType<typeof createClient> | undefined;

    expect.soft(creation?.options).toMatchObject({
      url: "redis://localhost:6379",
      socket: { reconnectStrategy: false },
    });
    expect.soft(client?.listenerCount("error")).toBe(1);
    expect(() => client?.emit("error", new Error("private Redis failure"))).not.toThrow();

    await runtime?.close();
    expect(fixture.pool.end).toHaveBeenCalledOnce();
  });

  it("does not call a redis@6-like throwing destroy before connect starts", async () => {
    const clientClosedError = new Error("The client is closed");
    clientClosedError.name = "ClientClosedError";
    const fixture = runtimeFixture({ destroyError: clientClosedError });
    const runtime = createMemoryExtractionRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      dependencies: fixture.dependencies,
    });

    await expect(runtime?.close()).resolves.toBeUndefined();
    expect(fixture.redis.destroy).not.toHaveBeenCalled();
    expect(fixture.pool.end).toHaveBeenCalledOnce();
  });

  runIfRedis("connects and closes a live redis@6 client without leaking it", async () => {
    const fixture = runtimeFixture();
    const redis = createClient({ url: redisTestUrl });
    networkTestResources.clients.add(redis);
    redis.on("error", () => undefined);
    const dependencies: MemoryExtractionRuntimeDependencies = {
      ...fixture.dependencies,
      createRedisClient: () => redis as never,
    };
    const runtime = createMemoryExtractionRuntime({
      env: { ...enabledEnv(), REDIS_URL: redisTestUrl },
      runtimeController: runtimeController(),
      dependencies,
    });
    if (runtime !== undefined) {
      networkTestResources.runtimeClosers.add(() => runtime.close());
    }

    runtime?.start();
    await vi.waitFor(() => expect(fixture.loop.start).toHaveBeenCalledOnce());
    expect(redis.isReady).toBe(true);

    await expect(runtime?.close()).resolves.toBeUndefined();
    expect(redis.isOpen).toBe(false);
    expect(fixture.pool.end).toHaveBeenCalledOnce();
  });

  it("cancels a real node-redis half-handshake after the transport connects", async () => {
    const sockets = new Set<Socket>();
    let acceptSocket: (socket: Socket) => void = () => undefined;
    const acceptedSocket = new Promise<Socket>((resolve) => {
      acceptSocket = resolve;
    });
    const server = createServer((socket) => {
      sockets.add(socket);
      networkTestResources.sockets.add(socket);
      socket.once("close", () => {
        sockets.delete(socket);
        networkTestResources.sockets.delete(socket);
      });
      socket.resume();
      acceptSocket(socket);
    });
    networkTestResources.servers.add(server);
    const port = await listenOnLoopback(server);
    const redis = createClient({
      url: `redis://127.0.0.1:${port}`,
      socket: { reconnectStrategy: false },
    });
    networkTestResources.clients.add(redis);
    redis.on("error", () => undefined);
    const transportConnect = vi.fn();
    redis.on("connect", transportConnect);
    const nativeDestroy = redis.destroy.bind(redis);
    const destroy = vi.fn(() => nativeDestroy());
    redis.destroy = destroy as typeof redis.destroy;
    const nativeConnect = redis.connect.bind(redis);
    let signalConnectStarted: () => void = () => undefined;
    const connectStarted = new Promise<void>((resolve) => {
      signalConnectStarted = resolve;
    });
    redis.connect = (() => {
      const connection = nativeConnect();
      signalConnectStarted();
      return connection;
    }) as typeof redis.connect;
    const fixture = runtimeFixture();
    const runtime = createMemoryExtractionRuntime({
      env: {
        ...enabledEnv(),
        REDIS_URL: `redis://127.0.0.1:${port}`,
      },
      runtimeController: runtimeController(),
      dependencies: {
        ...fixture.dependencies,
        createRedisClient: () => redis as never,
      },
    });
    if (runtime !== undefined) {
      networkTestResources.runtimeClosers.add(() => runtime.close());
    }
    let close: Promise<void> | undefined;

    try {
      runtime?.start();
      await connectStarted;
      const socket = await settleBeforeDeadline(
        acceptedSocket,
        1_000,
        "half-handshake server did not accept the connection",
      );
      close = runtime?.close();

      try {
        await settleBeforeDeadline(close, 1_000, "half-handshake close timed out");
      } catch (error) {
        throw new Error(
          `half-handshake state: transport=${transportConnect.mock.calls.length}, ` +
          `destroy=${destroy.mock.calls.length}, open=${String(redis.isOpen)}, ` +
          `poolEnd=${fixture.pool.end.mock.calls.length}`,
          { cause: error },
        );
      }
      expect(socket).toBeDefined();
      const accepted = socket!;
      if (!accepted.destroyed) {
        await settleBeforeDeadline(
          once(accepted, "close"),
          1_000,
          "half-handshake socket close timed out",
        );
      }

      expect(redis.isOpen).toBe(false);
      expect(transportConnect).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledOnce();
      expect(accepted.destroyed).toBe(true);
      expect(sockets.size).toBe(0);
      expect(fixture.loop.start).not.toHaveBeenCalled();
      expect(fixture.pool.end).toHaveBeenCalledOnce();
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
    }
  }, 3_000);

  runIfRedis("absorbs a live Redis peer disconnect without reconnecting or leaking", async () => {
    redisCreations.length = 0;
    const fixture = runtimeFixture();
    const runtime = createMemoryExtractionRuntime({
      env: { ...enabledEnv(), REDIS_URL: redisTestUrl },
      runtimeController: runtimeController(),
      dependencies: withoutRedisFactory(fixture.dependencies),
    });
    const creation = redisCreations.at(-1);
    const redis = creation?.client as ReturnType<typeof createClient> | undefined;
    if (redis === undefined) {
      throw new Error("production Redis client was not created");
    }
    networkTestResources.clients.add(redis);
    if (runtime !== undefined) {
      networkTestResources.runtimeClosers.add(() => runtime.close());
    }
    const hadProductionErrorListener = redis.listenerCount("error") > 0;
    expect.soft(hadProductionErrorListener).toBe(true);
    if (!hadProductionErrorListener) {
      redis.on("error", () => undefined);
    }
    const reconnecting = vi.fn();
    redis.on("reconnecting", reconnecting);
    const peerError = once(redis, "error");
    const admin = createClient({
      url: redisTestUrl,
      socket: { reconnectStrategy: false },
    });
    networkTestResources.clients.add(admin);
    admin.on("error", () => undefined);

    try {
      runtime?.start();
      await vi.waitFor(() => expect(fixture.loop.start).toHaveBeenCalledOnce());
      await admin.connect();
      const clientId = await redis.sendCommand(["CLIENT", "ID"]);
      await admin.sendCommand(["CLIENT", "KILL", "ID", String(clientId)]);
      await peerError;

      expect(redis.isOpen).toBe(false);
      expect(reconnecting).not.toHaveBeenCalled();
      await expect(runtime?.close()).resolves.toBeUndefined();
      expect(fixture.pool.end).toHaveBeenCalledOnce();
    } finally {
      if (admin.isOpen) {
        admin.destroy();
      }
      await runtime?.close().catch(() => undefined);
    }
  });

  it("destroys a pending Redis connect and awaits readiness plus pool shutdown", async () => {
    const fixture = runtimeFixture({ deferRedisConnect: true, deferPoolEnd: true });
    const runtime = createMemoryExtractionRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      dependencies: fixture.dependencies,
    });
    runtime?.start();
    await vi.waitFor(() => expect(fixture.redis.connect).toHaveBeenCalledOnce());

    let closed = false;
    const close = runtime?.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.redis.destroy).not.toHaveBeenCalled();
    expect(fixture.pool.end).not.toHaveBeenCalled();
    fixture.emitRedisTransportConnect();
    await vi.waitFor(() => expect(fixture.pool.end).toHaveBeenCalledOnce());

    expect(fixture.redis.destroy).toHaveBeenCalledOnce();
    expect(fixture.redis.quit).not.toHaveBeenCalled();
    expect(fixture.loop.start).not.toHaveBeenCalled();
    expect(closed).toBe(false);
    fixture.resolvePoolEnd();
    await close;
    expect(closed).toBe(true);
    expect(fixture.cleanupOrder).toEqual(["loop", "redis-destroy", "postgres"]);
  });

  it("awaits pending readiness and pool shutdown when Redis destroy throws", async () => {
    const destroyError = new Error("pending destroy failed");
    const fixture = runtimeFixture({
      deferRedisConnect: true,
      deferPoolEnd: true,
      destroyError,
    });
    const runtime = createMemoryExtractionRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      dependencies: fixture.dependencies,
    });
    runtime?.start();
    await vi.waitFor(() => expect(fixture.redis.connect).toHaveBeenCalledOnce());

    let closeSettled = false;
    const close = runtime?.close().finally(() => {
      closeSettled = true;
    });
    expect(fixture.redis.destroy).not.toHaveBeenCalled();
    fixture.emitRedisTransportConnect();
    await vi.waitFor(() => expect(fixture.redis.destroy).toHaveBeenCalledOnce());

    expect(fixture.pool.end).not.toHaveBeenCalled();
    expect(closeSettled).toBe(false);
    fixture.rejectRedisConnect();
    await vi.waitFor(() => expect(fixture.pool.end).toHaveBeenCalledOnce());
    expect(closeSettled).toBe(false);
    fixture.resolvePoolEnd();
    await expect(close).rejects.toBe(destroyError);
    expect(closeSettled).toBe(true);
    expect(fixture.cleanupOrder).toEqual(["loop", "redis-destroy", "postgres"]);
  });

  it("quits a connection that succeeds after pending Redis destroy throws", async () => {
    const destroyError = new Error("pending destroy failed");
    const fixture = runtimeFixture({ deferRedisConnect: true, destroyError });
    const runtime = createMemoryExtractionRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      dependencies: fixture.dependencies,
    });
    runtime?.start();
    await vi.waitFor(() => expect(fixture.redis.connect).toHaveBeenCalledOnce());

    const close = runtime?.close();
    expect(fixture.redis.destroy).not.toHaveBeenCalled();
    fixture.emitRedisTransportConnect();
    await vi.waitFor(() => expect(fixture.redis.destroy).toHaveBeenCalledOnce());
    fixture.resolveRedisConnect();

    await expect(close).rejects.toBe(destroyError);
    expect(fixture.redis.quit).toHaveBeenCalledOnce();
    expect(fixture.pool.end).toHaveBeenCalledOnce();
    expect(fixture.cleanupOrder).toEqual([
      "loop",
      "redis-destroy",
      "redis",
      "postgres",
    ]);
  });

  it("closes every later resource when an earlier close operation fails", async () => {
    const fixture = runtimeFixture();
    fixture.loop.stop.mockImplementationOnce(async () => {
      fixture.cleanupOrder.push("loop");
      throw new Error("loop stop failed");
    });
    const runtime = createMemoryExtractionRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      dependencies: fixture.dependencies,
    });
    runtime?.start();
    await vi.waitFor(() => expect(fixture.loop.start).toHaveBeenCalledOnce());

    await expect(runtime?.close()).rejects.toThrow("loop stop failed");

    expect(fixture.cleanupOrder).toEqual(["loop", "redis", "postgres"]);
    expect(fixture.redis.quit).toHaveBeenCalledOnce();
    expect(fixture.pool.end).toHaveBeenCalledOnce();
    await expect(runtime?.close()).rejects.toThrow("loop stop failed");
    expect(fixture.pool.end).toHaveBeenCalledOnce();
  });

  it("runs fallible pure composition before creating connection resources", () => {
    const fixture = runtimeFixture();
    const compositionError = new Error("queue composition failed");
    fixture.dependencies.createQueue.mockImplementationOnce(() => {
      throw compositionError;
    });

    expect(() =>
      createMemoryExtractionRuntime({
        env: enabledEnv(),
        runtimeController: runtimeController(),
        dependencies: fixture.dependencies,
      }),
    ).toThrow(compositionError);

    expect(fixture.dependencies.createPostgresPool).not.toHaveBeenCalled();
    expect(fixture.dependencies.createRedisClient).not.toHaveBeenCalled();
    expect(fixture.pool.end).not.toHaveBeenCalled();
    expect(fixture.redis.connect).not.toHaveBeenCalled();
  });

  it("leaves an unopened Redis client alone when the pool factory throws", () => {
    const fixture = runtimeFixture();
    const poolError = new Error("pool factory failed");
    fixture.dependencies.createPostgresPool.mockImplementationOnce(() => {
      throw poolError;
    });

    expect(() =>
      createMemoryExtractionRuntime({
        env: enabledEnv(),
        runtimeController: runtimeController(),
        dependencies: fixture.dependencies,
      }),
    ).toThrow(poolError);

    expect(fixture.dependencies.createRedisClient).toHaveBeenCalledOnce();
    expect(fixture.redis.destroy).not.toHaveBeenCalled();
    expect(fixture.redis.connect).not.toHaveBeenCalled();
    expect(fixture.pool.end).not.toHaveBeenCalled();
  });

  it("surfaces a synchronous dependency-start failure for app startup cleanup", async () => {
    const fixture = runtimeFixture();
    const databaseError = new Error("database readiness failed");
    fixture.poolQuery.mockImplementationOnce(() => {
      throw databaseError;
    });
    const runtime = createMemoryExtractionRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      dependencies: fixture.dependencies,
    });

    expect(() => runtime?.start()).toThrow(databaseError);
    expect(fixture.redis.connect).not.toHaveBeenCalled();
    await runtime?.close();
    expect(fixture.pool.end).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "database readiness",
      fail(fixture: ReturnType<typeof runtimeFixture>) {
        fixture.poolQuery.mockRejectedValueOnce(new Error("database readiness failed"));
      },
      expectedRedisConnects: 0,
    },
    {
      name: "Redis readiness",
      fail(fixture: ReturnType<typeof runtimeFixture>) {
        fixture.redis.connect.mockRejectedValueOnce(new Error("Redis readiness failed"));
      },
      expectedRedisConnects: 1,
    },
  ])("cleans owned resources after asynchronous $name failure", async ({
    fail,
    expectedRedisConnects,
  }) => {
    const fixture = runtimeFixture();
    fail(fixture);
    const runtime = createMemoryExtractionRuntime({
      env: enabledEnv(),
      runtimeController: runtimeController(),
      dependencies: fixture.dependencies,
    });

    runtime?.start();

    await vi.waitFor(() => expect(fixture.pool.end).toHaveBeenCalledOnce());
    expect(fixture.redis.connect).toHaveBeenCalledTimes(expectedRedisConnects);
    expect(fixture.redis.destroy).not.toHaveBeenCalled();
    expect(fixture.redis.quit).not.toHaveBeenCalled();
    expect(fixture.loop.start).not.toHaveBeenCalled();
    expect(fixture.cleanupOrder).toEqual(["loop", "postgres"]);
    await runtime?.close();
    expect(fixture.pool.end).toHaveBeenCalledOnce();
  });
});

function runtimeFixture({
  deferDatabaseProbe = false,
  deferRedisConnect = false,
  deferPoolEnd = false,
  destroyError,
}: {
  deferDatabaseProbe?: boolean;
  deferRedisConnect?: boolean;
  deferPoolEnd?: boolean;
  destroyError?: Error;
} = {}) {
  const cleanupOrder: string[] = [];
  let resolveDatabaseProbe: () => void = () => undefined;
  let resolveRedisConnect: () => void = () => undefined;
  let rejectRedisConnect: () => void = () => undefined;
  let resolvePoolEnd: () => void = () => undefined;
  const redisListeners = new Map<
    string,
    Set<{ listener: (...args: unknown[]) => void; once: boolean }>
  >();
  let redisOpen = false;
  const addRedisListener = (
    event: string,
    listener: (...args: unknown[]) => void,
    once: boolean,
  ) => {
    const listeners = redisListeners.get(event) ?? new Set();
    listeners.add({ listener, once });
    redisListeners.set(event, listeners);
  };
  const emitRedisEvent = (event: string, ...args: unknown[]) => {
    const listeners = redisListeners.get(event);
    if (listeners === undefined) {
      return;
    }
    for (const entry of [...listeners]) {
      entry.listener(...args);
      if (entry.once) {
        listeners.delete(entry);
      }
    }
  };
  const transactionClient = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  };
  const poolQuery = vi.fn(() => {
    if (!deferDatabaseProbe) {
      return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 });
    }
    return new Promise<{ rows: Array<{ ok: number }>; rowCount: number }>((resolve) => {
      resolveDatabaseProbe = () => resolve({ rows: [{ ok: 1 }], rowCount: 1 });
    });
  });
  const pool = {
    query: poolQuery,
    connect: vi.fn(async () => transactionClient),
    end: vi.fn(() => {
      cleanupOrder.push("postgres");
      if (!deferPoolEnd) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        resolvePoolEnd = resolve;
      });
    }),
  };
  const redis = {
    connect: vi.fn(() => {
      redisOpen = true;
      if (!deferRedisConnect) {
        emitRedisEvent("connect");
        return Promise.resolve(redis);
      }
      return new Promise<typeof redis>((resolve, reject) => {
        resolveRedisConnect = () => resolve(redis);
        rejectRedisConnect = () => {
          redisOpen = false;
          reject(new Error("Redis connect aborted"));
        };
      });
    }),
    get isOpen() {
      return redisOpen;
    },
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      addRedisListener(event, listener, true);
      return redis;
    }),
    off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const listeners = redisListeners.get(event);
      if (listeners !== undefined) {
        for (const entry of listeners) {
          if (entry.listener === listener) {
            listeners.delete(entry);
          }
        }
      }
      return redis;
    }),
    eval: vi.fn(async () => 1),
    sCard: vi.fn(async () => 0),
    zCard: vi.fn(async () => 0),
    get: vi.fn(async () => null),
    quit: vi.fn(async () => {
      cleanupOrder.push("redis");
      redisOpen = false;
    }),
    destroy: vi.fn(() => {
      cleanupOrder.push("redis-destroy");
      if (destroyError !== undefined) {
        throw destroyError;
      }
      redisOpen = false;
      rejectRedisConnect();
    }),
  };
  const repository = {
    getStatusCounts: vi.fn(async () => ({
      pending: 0,
      processing: 0,
      completed: 0,
      skipped: 6,
      failedRuns: 5,
      acceptedCandidates: 9,
      rejectedCandidates: 7,
      duplicateCandidates: 3,
      conflictCandidates: 2,
    })),
  } as unknown as MemoryExtractionRepository;
  const queue: MemoryExtractionQueue = {
    enqueue: vi.fn(async () => undefined),
    recoverProcessing: vi.fn(async () => ({ recoveredCount: 0, remainingCount: 0 })),
    dequeueBatch: vi.fn(async () => []),
    deferJob: vi.fn(async () => undefined),
    handleProcessedJob: vi.fn(async () => undefined),
    handleTerminalJob: vi.fn(async () => ({ action: "dead_lettered" as const, attempts: 1 })),
    handleFailedJob: vi.fn(async () => ({ action: "requeued" as const, attempts: 1 })),
    getPendingCount: vi.fn(async () => 3),
    getProcessingCount: vi.fn(async () => 2),
    getDelayedCount: vi.fn(async () => 1),
    getDeadLetterCount: vi.fn(async () => 4),
    getProviderCooldown: vi.fn(async () => new Date("2026-07-15T02:00:00.000Z")),
    setProviderCooldown: vi.fn(async () => undefined),
    listDeadLetters: vi.fn(async () => []),
    replayDeadLetter: vi.fn(async () => "replayed" as const),
    deleteDeadLetter: vi.fn(async () => "deleted" as const),
    replayDeadLetters: vi.fn(async () => ({
      replayedCount: 1,
      notFoundIds: [],
      unsupportedLegacyIds: [],
    })),
  };
  const aiClient = {
    checkHealth: vi.fn(async () => true),
    extract: vi.fn(),
  };
  const worker = { processBatch: vi.fn(async () => []) };
  const loop = {
    start: vi.fn(),
    stop: vi.fn(async () => {
      cleanupOrder.push("loop");
    }),
    isRunning: vi.fn(() => true),
    getSnapshot: vi.fn(() => ({
      running: true,
      intervalMs: 1000,
      batchLimit: 20,
      latestBatch: {
        status: "succeeded" as const,
        startedAt: new Date("2026-07-15T01:00:00.000Z"),
        finishedAt: new Date("2026-07-15T01:00:01.000Z"),
        completedCount: 2,
        skippedCount: 1,
        deferredCount: 1,
        failedCount: 0,
        failed: false as const,
      },
    })),
  };
  const planner = { registerMessage: vi.fn(async () => undefined) };
  const rawDependencies = {
    createPostgresPool: vi.fn(() => pool),
    createRedisClient: vi.fn(() => redis),
    createRepository: vi.fn(() => repository),
    createQueue: vi.fn(() => queue),
    createAiWorkerClient: vi.fn(() => aiClient),
    createWorker: vi.fn(() => worker),
    createWorkerLoop: vi.fn(() => loop),
    createPlanner: vi.fn(() => planner),
  };
  const dependencies = rawDependencies as typeof rawDependencies &
    MemoryExtractionRuntimeDependencies;

  return {
    aiClient,
    cleanupOrder,
    dependencies,
    emitRedisTransportConnect: () => emitRedisEvent("connect"),
    loop,
    planner,
    pool,
    poolQuery,
    queue,
    redis,
    repository,
    resolveDatabaseProbe: () => resolveDatabaseProbe(),
    rejectRedisConnect: () => rejectRedisConnect(),
    resolvePoolEnd: () => resolvePoolEnd(),
    resolveRedisConnect: () => resolveRedisConnect(),
    worker,
  };
}

function enabledEnv() {
  return {
    IRIS_MEMORY_EXTRACTION_ENABLED: "true",
    DATABASE_URL: "postgres://example/iris",
    REDIS_URL: "redis://localhost:6379",
    IRIS_AI_WORKER_BASE_URL: "http://ai-worker:8000",
    IRIS_AI_WORKER_TOKEN: "worker-token",
    IRIS_FEISHU_BOT_OPEN_ID: "ou_iris",
  };
}

function withoutRedisFactory(
  dependencies: MemoryExtractionRuntimeDependencies,
): MemoryExtractionRuntimeDependencies {
  const {
    createRedisClient: _createRedisClient,
    ...withoutRedis
  } = dependencies;
  return withoutRedis;
}

async function listenOnLoopback(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function closeTcpServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

async function settleBeforeDeadline<T>(
  promise: Promise<T> | undefined,
  timeoutMs: number,
  message: string,
): Promise<T | undefined> {
  if (promise === undefined) {
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function runtimeController() {
  return new RuntimeController(createDefaultRuntimeConfig());
}

function conversationMessage(): ConversationMessage {
  return {
    id: "message-1",
    provider: "feishu",
    providerMessageId: "om_1",
    chatId: "group-1",
    senderId: "ou_human",
    messageType: "text",
    text: "A durable project fact",
    sentAt: new Date("2026-07-15T00:00:00.000Z"),
    rawEventIdempotencyKey: "raw-event:feishu:event-1",
    createdAt: new Date("2026-07-15T00:00:01.000Z"),
  };
}
