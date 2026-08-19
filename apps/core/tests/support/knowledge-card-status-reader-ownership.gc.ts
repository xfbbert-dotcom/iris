import assert from "node:assert/strict";

import { createKnowledgeCardStatusReader } from "../../src/runtime/knowledge-card-runtime.js";

await verifyGenerationOwnership().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

async function verifyGenerationOwnership(): Promise<void> {
  assert.equal(typeof globalThis.gc, "function", "fixture requires --expose-gc");
  const references: Array<WeakRef<object>> = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let currentClient: ReturnType<typeof createFakeRedisClient> | undefined;
  let createdClientCount = 0;
  let openClientCount = 0;
  let destroyCallCount = 0;
  let readerListenerCount = 0;
  let poolEndCallCount = 0;
  const reader = createKnowledgeCardStatusReader({
    env: {
      IRIS_KNOWLEDGE_CARD_ENABLED: "false",
      DATABASE_URL: "postgres://127.0.0.1/iris_status_ownership",
      REDIS_URL: "redis://127.0.0.1:1",
    },
    dependencies: {
      createPostgresPool: () => ({
        query: async () => ({ rows: [] }),
        end: async () => {
          poolEndCallCount += 1;
        },
      }) as never,
      createRedisClient: () => {
        const client = createFakeRedisClient({
          onOpened: () => {
            openClientCount += 1;
          },
          onClosed: () => {
            openClientCount -= 1;
          },
          onDestroyed: () => {
            destroyCallCount += 1;
          },
          onListenerAttached: () => {
            readerListenerCount += 1;
          },
          onListenerDetached: () => {
            readerListenerCount -= 1;
          },
        });
        currentClient = client;
        createdClientCount += 1;
        references.push(new WeakRef(client));
        return client as never;
      },
      createKnowledgeCardRepository: () => ({
        getStatusCounts: async () => ({
          pending_send: 0,
          active: 0,
          superseded: 0,
          closed: 0,
          send_failed: 0,
          pendingSend: 0,
        }),
        getOutboxStatusCounts: async () => ({
          pending: 0,
          processing: 0,
          external_attempting: 0,
          sent: 0,
          failed: 0,
          outcome_unknown: 0,
          terminalFailed: 0,
        }),
      }),
      createApprovalInteractionQueue: ({ client }) => ({
        getCounts: async () => {
          await client.eval("status-counts", { keys: [], arguments: [] });
          return { pending: 0, processing: 0, delayed: 0, deadLetter: 0 };
        },
      }),
    },
  });
  assert.ok(reader);

  try {
    await createAndReplaceGenerations(reader, () => currentClient!);

    assert.equal(createdClientCount, 51);
    assert.equal(openClientCount, 1);
    assert.equal(readerListenerCount, 2);
    const retainedBeforeClose = await retainedGenerationCount(references);
    assert.ok(
      retainedBeforeClose <= 1,
      `completed Redis generations remained strongly owned before reader close: ${retainedBeforeClose}/51 alive`,
    );

    const firstClose = reader.close();
    assert.strictEqual(reader.close(), firstClose);
    await firstClose;
    assert.strictEqual(reader.close(), firstClose);
    await assert.rejects(reader.getStatus(), /Redis client is closed/);
    assert.equal(createdClientCount, 51);
    assert.equal(openClientCount, 0);
    assert.equal(destroyCallCount, 1);
    assert.equal(readerListenerCount, 0);
    assert.equal(poolEndCallCount, 1);
    await nextTurn();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await reader.close().catch(() => undefined);
  }
}

async function createAndReplaceGenerations(
  reader: NonNullable<ReturnType<typeof createKnowledgeCardStatusReader>>,
  getClient: () => ReturnType<typeof createFakeRedisClient>,
): Promise<void> {
  await reader.getStatus();
  for (let generation = 0; generation < 50; generation += 1) {
    getClient().disconnectUnexpectedly();
    await nextTurn();
    await reader.getStatus();
  }
}

async function retainedGenerationCount(references: Array<WeakRef<object>>): Promise<number> {
  let previousCount = Number.POSITIVE_INFINITY;
  let stableRounds = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    globalThis.gc!();
    await nextTurn();
    globalThis.gc!();
    const count = references.filter((reference) => reference.deref() !== undefined).length;
    if (count <= 1) return count;
    if (count === previousCount) {
      stableRounds += 1;
      if (stableRounds >= 4) return count;
    } else {
      previousCount = count;
      stableRounds = 0;
    }
  }
  return references.filter((reference) => reference.deref() !== undefined).length;
}

function createFakeRedisClient(callbacks: {
  onOpened(): void;
  onClosed(): void;
  onDestroyed(): void;
  onListenerAttached(): void;
  onListenerDetached(): void;
}) {
  let isOpen = false;
  let isReady = false;
  const listeners = {
    error: new Set<(error: Error) => void>(),
    connect: new Set<() => void>(),
  };
  const client = {
    get isOpen() {
      return isOpen;
    },
    get isReady() {
      return isReady;
    },
    async connect() {
      isOpen = true;
      callbacks.onOpened();
      for (const listener of listeners.connect) listener();
      isReady = true;
      return client;
    },
    destroy() {
      callbacks.onDestroyed();
      if (isOpen) {
        isOpen = false;
        isReady = false;
        callbacks.onClosed();
      }
    },
    async eval() {
      return 0;
    },
    on(event: "error" | "connect", listener: ((error: Error) => void) | (() => void)) {
      if (event === "error") listeners.error.add(listener as (error: Error) => void);
      else listeners.connect.add(listener as () => void);
      callbacks.onListenerAttached();
      return client;
    },
    off(event: "error" | "connect", listener: ((error: Error) => void) | (() => void)) {
      const deleted = event === "error"
        ? listeners.error.delete(listener as (error: Error) => void)
        : listeners.connect.delete(listener as () => void);
      if (deleted) callbacks.onListenerDetached();
      return client;
    },
    disconnectUnexpectedly() {
      if (!isOpen || !isReady) throw new Error("fake Redis client is not ready");
      isOpen = false;
      isReady = false;
      callbacks.onClosed();
      for (const listener of listeners.error) {
        listener(new Error("fake Redis transport disconnected"));
      }
    },
  };
  return client;
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
