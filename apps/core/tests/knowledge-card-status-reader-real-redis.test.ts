import { createServer, type Server, type Socket } from "node:net";

import { createClient } from "redis";
import { describe, expect, it, vi } from "vitest";

import { createKnowledgeCardStatusReader } from "../src/runtime/knowledge-card-runtime.js";

describe("KnowledgeCardStatusReader real node-redis lifecycle", () => {
  it("closes a refused non-reconnecting client without reopening or leaking rejection", async () => {
    const client = realRedisClient("redis://127.0.0.1:1", true);
    const destroy = vi.spyOn(client, "destroy");
    const fixture = readerFixture(client);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const status = await outcomeWithin(fixture.reader.getStatus());
      expect(status.status).toBe("rejected");

      const firstClose = fixture.reader.close();
      expect(fixture.reader.close()).toBe(firstClose);
      await expect(outcomeWithin(firstClose)).resolves.toEqual({ status: "fulfilled" });
      expect(fixture.reader.close()).toBe(firstClose);
      expect(client.isOpen).toBe(false);
      expect(destroy).not.toHaveBeenCalled();
      expect(fixture.pool.end).toHaveBeenCalledOnce();
      await nextTurn();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      closeClientIfOpen(client);
    }
  });

  it("destroys a connected read-only client without sending QUIT", async () => {
    const server = await tcpHarness({ replyToEval: true });
    const client = realRedisClient(server.url, true);
    const destroy = vi.spyOn(client, "destroy");
    const fixture = readerFixture(client);
    try {
      await expect(outcomeWithin(fixture.reader.getStatus())).resolves.toEqual({
        status: "fulfilled",
        value: expect.objectContaining({ enabled: false }),
      });
      expect(client.isOpen).toBe(true);

      await expect(outcomeWithin(fixture.reader.close())).resolves.toEqual({ status: "fulfilled" });
      await server.waitForNoSockets();
      expect(server.received).not.toContain("$4\r\nQUIT\r\n");
      expect(client.isOpen).toBe(false);
      expect(destroy).toHaveBeenCalledOnce();
      expect(fixture.pool.end).toHaveBeenCalledOnce();
    } finally {
      closeClientIfOpen(client);
      await server.close();
    }
  });

  it("does not schedule connect after synchronous composition failure", async () => {
    const server = await tcpHarness();
    const client = realRedisClient(server.url, true);
    const connect = vi.spyOn(client, "connect");
    const destroy = vi.spyOn(client, "destroy");
    const pool = poolFixture();
    const cleanups: Promise<void>[] = [];
    const primaryError = new Error("status repository composition failed");
    try {
      expect(() => createKnowledgeCardStatusReader({
        env: statusEnv(server.url),
        dependencies: {
          createPostgresPool: () => pool as never,
          createRedisClient: () => client as never,
          createKnowledgeCardRepository: () => {
            throw primaryError;
          },
          onStartupCleanup: (cleanup) => cleanups.push(cleanup),
        },
      })).toThrow(primaryError);
      expect(cleanups).toHaveLength(1);
      await expect(outcomeWithin(cleanups[0])).resolves.toEqual({ status: "fulfilled" });
      await nextTurn();
      expect(connect).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(server.connectionCount).toBe(0);
      expect(client.isOpen).toBe(false);
      expect(pool.end).toHaveBeenCalledOnce();
    } finally {
      closeClientIfOpen(client);
      await server.close();
    }
  });

  it("never starts a connection after close wins before first status read", async () => {
    const server = await tcpHarness();
    const client = realRedisClient(server.url, true);
    const connect = vi.spyOn(client, "connect");
    const destroy = vi.spyOn(client, "destroy");
    const fixture = readerFixture(client);
    try {
      const firstClose = fixture.reader.close();
      expect(fixture.reader.close()).toBe(firstClose);
      await expect(outcomeWithin(firstClose)).resolves.toEqual({ status: "fulfilled" });
      await nextTurn();
      expect(connect).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(server.connectionCount).toBe(0);
      expect(client.isOpen).toBe(false);
      expect(fixture.pool.end).toHaveBeenCalledOnce();
    } finally {
      closeClientIfOpen(client);
      await server.close();
    }
  });

  it("coordinates concurrent close with a real pending handshake", async () => {
    const server = await tcpHarness();
    const client = realRedisClient(server.url, false);
    const destroy = vi.spyOn(client, "destroy");
    const fixture = readerFixture(client);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const statusOutcome = outcomeWithin(fixture.reader.getStatus());
      await server.waitForConnection();
      const firstClose = fixture.reader.close();
      expect(fixture.reader.close()).toBe(firstClose);
      await expect(outcomeWithin(firstClose)).resolves.toEqual({ status: "fulfilled" });
      expect((await statusOutcome).status).toBe("rejected");
      await server.waitForNoSockets();
      expect(client.isOpen).toBe(false);
      expect(destroy).toHaveBeenCalledOnce();
      expect(fixture.pool.end).toHaveBeenCalledOnce();
      await nextTurn();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      closeClientIfOpen(client);
      await server.close();
    }
  });
});

function realRedisClient(url: string, disableClientInfo: boolean) {
  const client = createClient({
    url,
    RESP: 2,
    disableClientInfo,
    maintNotifications: "disabled",
    socket: { reconnectStrategy: false, connectTimeout: 250 },
  });
  client.on("error", () => undefined);
  return client;
}

function readerFixture(client: ReturnType<typeof realRedisClient>) {
  const pool = poolFixture();
  const reader = createKnowledgeCardStatusReader({
    env: statusEnv("redis://127.0.0.1:1"),
    dependencies: {
      createPostgresPool: () => pool as never,
      createRedisClient: () => client as never,
      createKnowledgeCardRepository: () => ({
        getStatusCounts: vi.fn(async () => ({
          pending_send: 0,
          active: 0,
          superseded: 0,
          closed: 0,
          send_failed: 0,
          pendingSend: 0,
        })),
        getOutboxStatusCounts: vi.fn(async () => ({
          pending: 0,
          processing: 0,
          external_attempting: 0,
          sent: 0,
          failed: 0,
          outcome_unknown: 0,
          terminalFailed: 0,
        })),
      }),
    },
  });
  expect(reader).toBeDefined();
  return { reader: reader!, pool };
}

function poolFixture() {
  return {
    query: vi.fn(),
    end: vi.fn(async () => undefined),
  };
}

function statusEnv(redisUrl: string) {
  return {
    IRIS_KNOWLEDGE_CARD_ENABLED: "false",
    DATABASE_URL: "postgres://127.0.0.1/iris_status_test",
    REDIS_URL: redisUrl,
  };
}

async function tcpHarness({ replyToEval = false }: { replyToEval?: boolean } = {}) {
  const sockets = new Set<Socket>();
  let received = "";
  let connectionCount = 0;
  let resolveFirstConnection!: () => void;
  const firstConnection = new Promise<void>((resolve) => {
    resolveFirstConnection = resolve;
  });
  const server: Server = createServer((socket) => {
    connectionCount += 1;
    sockets.add(socket);
    resolveFirstConnection();
    let evalReplied = false;
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (replyToEval && !evalReplied && received.includes("$4\r\nEVAL\r\n")) {
        evalReplied = true;
        socket.write("*4\r\n:0\r\n:0\r\n:0\r\n:0\r\n");
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("TCP test address unavailable");
  return {
    url: `redis://127.0.0.1:${address.port}`,
    get received() {
      return received;
    },
    get connectionCount() {
      return connectionCount;
    },
    waitForConnection: () => outcomeValueWithin(firstConnection),
    waitForNoSockets: () => waitForCondition(() => sockets.size === 0),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
}

async function outcomeWithin<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<
  { status: "fulfilled"; value?: T } | { status: "rejected"; reason?: unknown }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("operation did not settle within test bound")), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ status: "fulfilled" as const, ...(value === undefined ? {} : { value }) }),
        (reason) => ({ status: "rejected" as const, reason }),
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function outcomeValueWithin<T>(promise: Promise<T>): Promise<T> {
  const outcome = await outcomeWithin(promise);
  if (outcome.status === "rejected") throw outcome.reason;
  return outcome.value as T;
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not settle within test bound");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function closeClientIfOpen(client: ReturnType<typeof realRedisClient>): void {
  if (client.isOpen) client.destroy();
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
