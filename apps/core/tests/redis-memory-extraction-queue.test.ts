import { describe, expect, it, vi } from "vitest";

import {
  createMemoryExtractionJob,
  type MemoryExtractionJob,
} from "../src/memory-extraction/memory-extraction-queue.js";
import {
  createRedisMemoryExtractionQueue,
  parseMemoryExtractionJob,
  serializeMemoryExtractionJob,
  type RedisMemoryExtractionQueueClient,
} from "../src/memory-extraction/redis-memory-extraction-queue.js";

const KEYS = {
  seen: "iris:memory:extraction:seen",
  ready: "iris:memory:extraction:ready",
  delayed: "iris:memory:extraction:delayed",
  processing: "iris:memory:extraction:processing",
  cooldown: "iris:memory:extraction:cooldown",
  dlq: "iris:memory:extraction:dlq",
} as const;

describe("Redis memory extraction queue", () => {
  it("deduplicates ready work and promotes delayed retries only when due", async () => {
    const client = new StatefulRedisClient();
    const queue = createRedisMemoryExtractionQueue({ client });
    const job = jobFixture();

    await queue.enqueue(job);
    await queue.enqueue(job);
    expect(await queue.getPendingCount()).toBe(1);

    const [claimed] = await queue.dequeueBatch(1, new Date("2026-07-14T00:00:00.000Z"));
    await queue.handleFailedJob({
      job: claimed!,
      errorMessage: "provider_rate_limited",
      retryAt: new Date("2026-07-14T00:15:00.000Z"),
    });

    expect(await queue.getDelayedCount()).toBe(1);
    await expect(
      queue.dequeueBatch(10, new Date("2026-07-14T00:14:59.000Z")),
    ).resolves.toEqual([]);
    await expect(
      queue.dequeueBatch(10, new Date("2026-07-14T00:15:00.000Z")),
    ).resolves.toEqual([
      {
        ...job,
        notBefore: new Date("2026-07-14T00:15:00.000Z"),
        attempts: 1,
      },
    ]);
    expect(await queue.getDelayedCount()).toBe(0);
  });

  it("ACKs only the exact serialized processing payload", async () => {
    const client = new StatefulRedisClient();
    const queue = createRedisMemoryExtractionQueue({ client });
    const job = jobFixture();

    await queue.enqueue(job);
    const [claimed] = await queue.dequeueBatch(1, job.enqueuedAt);
    await queue.handleProcessedJob({ ...claimed!, attempts: 1 });

    expect(await queue.getProcessingCount()).toBe(1);
    expect(client.setMembers(KEYS.seen)).toEqual([job.idempotencyKey]);

    await queue.handleProcessedJob(claimed!);
    expect(await queue.getProcessingCount()).toBe(0);
    expect(client.setMembers(KEYS.seen)).toEqual([]);
    expect(client.eval.mock.calls.at(-1)?.[0]).toContain("LREM");
  });

  it("upgrades a pending duplicate when an in-flight job is retried", async () => {
    const client = new StatefulRedisClient();
    const queue = createRedisMemoryExtractionQueue({ client });
    const job = jobFixture();

    await queue.enqueue(job);
    const [claimed] = await queue.dequeueBatch(1, job.enqueuedAt);
    client.pushList(KEYS.ready, serializeMemoryExtractionJob(job));

    await expect(
      queue.handleFailedJob({ job: claimed!, errorMessage: "provider_timeout" }),
    ).resolves.toEqual({ action: "requeued", attempts: 1 });

    expect(client.listValues(KEYS.ready)).toHaveLength(1);
    await expect(queue.dequeueBatch(10, job.enqueuedAt)).resolves.toEqual([
      { ...job, attempts: 1 },
    ]);
  });

  it("recovers startup processing once without reclaiming active work on later dequeues", async () => {
    const client = new StatefulRedisClient();
    const abandoned = jobFixture({ requestId: "request-abandoned" });
    const next = jobFixture({ requestId: "request-next" });
    client.pushList(KEYS.processing, serializeMemoryExtractionJob(abandoned));
    client.addSet(KEYS.seen, abandoned.idempotencyKey);
    const queue = createRedisMemoryExtractionQueue({ client });

    await expect(queue.dequeueBatch(1, abandoned.enqueuedAt)).resolves.toEqual([abandoned]);
    await queue.enqueue(next);
    await expect(queue.dequeueBatch(1, next.enqueuedAt)).resolves.toEqual([next]);

    expect(await queue.getProcessingCount()).toBe(2);
    const recoveryCalls = client.eval.mock.calls.filter(([script]) =>
      script.includes("memory-extraction:recover-processing"),
    );
    expect(recoveryCalls).toHaveLength(1);
  });

  it("moves corrupt payloads to a bounded diagnostic DLQ without retaining their contents", async () => {
    const client = new StatefulRedisClient();
    const corruptPayload = JSON.stringify({
      requestId: "request-1",
      messageText: "sensitive message body",
    });
    client.pushList(KEYS.ready, corruptPayload);
    const queue = createRedisMemoryExtractionQueue({
      client,
      now: () => new Date("2026-07-14T01:00:00.000Z"),
      idGenerator: () => "dlq-corrupt",
    });

    await expect(queue.dequeueBatch(1, new Date("2026-07-14T01:00:00.000Z"))).resolves.toEqual(
      [],
    );
    expect(await queue.getProcessingCount()).toBe(0);
    expect(await queue.getDeadLetterCount()).toBe(1);

    const [deadLetter] = await queue.listDeadLetters({ limit: 1 });
    expect(deadLetter).toEqual({
      id: "dlq-corrupt",
      payloadDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      payloadBytes: Buffer.byteLength(corruptPayload),
      errorMessage: "Invalid memory extraction job payload",
      failedAt: new Date("2026-07-14T01:00:00.000Z"),
      replayable: false,
    });
    expect(JSON.stringify(deadLetter)).not.toContain("sensitive message body");
    await expect(queue.replayDeadLetter("dlq-corrupt")).resolves.toBe(
      "unsupported_legacy_item",
    );
  });

  it("bounds attempts and dead-letter error diagnostics", async () => {
    const client = new StatefulRedisClient();
    const queue = createRedisMemoryExtractionQueue({
      client,
      maxAttempts: 2,
      now: () => new Date("2026-07-14T02:00:00.000Z"),
      idGenerator: () => "dlq-terminal",
    });
    const job = jobFixture();

    await queue.enqueue(job);
    const [first] = await queue.dequeueBatch(1, job.enqueuedAt);
    await queue.handleFailedJob({ job: first!, errorMessage: "provider_timeout" });
    const [second] = await queue.dequeueBatch(1, job.enqueuedAt);
    await expect(
      queue.handleFailedJob({ job: second!, errorMessage: `provider_5xx:${"x".repeat(2000)}` }),
    ).resolves.toEqual({ action: "dead_lettered", attempts: 2 });

    const [deadLetter] = await queue.listDeadLetters({ limit: 1 });
    expect(deadLetter).toMatchObject({ id: "dlq-terminal", replayable: true });
    if (deadLetter === undefined || !("job" in deadLetter)) {
      throw new Error("expected replayable memory extraction dead letter");
    }
    expect(deadLetter.job.attempts).toBe(2);
    expect(deadLetter.errorMessage.length).toBeLessThanOrEqual(1000);
    expect(deadLetter.errorMessage).toContain("[truncated]");

    expect(() =>
      createRedisMemoryExtractionQueue({ client, maxAttempts: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow("maxAttempts must be a positive safe integer");
    expect(() =>
      parseMemoryExtractionJob(
        JSON.stringify({
          ...serializedJobFixture(),
          attempts: Number.MAX_SAFE_INTEGER + 1,
        }),
      ),
    ).toThrow("Invalid memory extraction job payload");
  });

  it("removes ready and delayed duplicates when terminally dead-lettering work", async () => {
    const client = new StatefulRedisClient();
    const queue = createRedisMemoryExtractionQueue({
      client,
      maxAttempts: 1,
      idGenerator: () => "dlq-terminal-duplicate",
    });
    const job = jobFixture();

    await queue.enqueue(job);
    const [claimed] = await queue.dequeueBatch(1, job.enqueuedAt);
    client.pushList(KEYS.ready, serializeMemoryExtractionJob(job));
    client.addSorted(KEYS.delayed, serializeMemoryExtractionJob(job), job.notBefore.getTime());

    await queue.handleFailedJob({ job: claimed!, errorMessage: "provider_auth_failed" });

    expect(await queue.getPendingCount()).toBe(0);
    expect(await queue.getDelayedCount()).toBe(0);
    expect(await queue.getDeadLetterCount()).toBe(1);
    expect(client.setMembers(KEYS.seen)).toEqual([]);
  });

  it("atomically replays terminal jobs with attempts reset", async () => {
    const client = new StatefulRedisClient();
    const queue = createRedisMemoryExtractionQueue({
      client,
      maxAttempts: 1,
      now: () => new Date("2026-07-14T03:00:00.000Z"),
      idGenerator: () => "dlq-replay",
    });
    const job = jobFixture();

    await queue.enqueue(job);
    const [claimed] = await queue.dequeueBatch(1, job.enqueuedAt);
    await queue.handleFailedJob({ job: claimed!, errorMessage: "provider_auth_failed" });
    client.addSet(KEYS.seen, job.idempotencyKey);

    await expect(queue.replayDeadLetter("dlq-replay")).resolves.toBe("replayed");
    expect(await queue.getDeadLetterCount()).toBe(0);
    expect(await queue.getPendingCount()).toBe(1);
    await expect(
      queue.dequeueBatch(1, new Date("2026-07-14T03:00:00.000Z")),
    ).resolves.toEqual([
      {
        ...job,
        notBefore: new Date("2026-07-14T03:00:00.000Z"),
        attempts: 0,
      },
    ]);

    const replayCall = client.eval.mock.calls.find(([script]) =>
      script.includes("memory-extraction:replay-dead-letter"),
    );
    expect(replayCall?.[0]).toContain("LREM");
    expect(replayCall?.[0]).toContain("RPUSH");
    expect(replayCall?.[1].keys).toEqual([
      KEYS.seen,
      KEYS.ready,
      KEYS.delayed,
      KEYS.processing,
      KEYS.dlq,
    ]);
  });

  it("repairs a stale seen claim when no ready, delayed, or processing job exists", async () => {
    const client = new StatefulRedisClient();
    const job = jobFixture();
    client.addSet(KEYS.seen, job.idempotencyKey);
    const queue = createRedisMemoryExtractionQueue({ client });

    await queue.enqueue(job);
    await queue.enqueue(job);

    expect(await queue.getPendingCount()).toBe(1);
  });

  it("shares provider cooldown and never shortens an existing cooldown", async () => {
    const client = new StatefulRedisClient();
    const firstQueue = createRedisMemoryExtractionQueue({ client });
    const secondQueue = createRedisMemoryExtractionQueue({ client });
    const later = new Date("2026-07-14T04:30:00.000Z");

    await firstQueue.setProviderCooldown(later);
    await secondQueue.setProviderCooldown(new Date("2026-07-14T04:15:00.000Z"));

    await expect(secondQueue.getProviderCooldown()).resolves.toEqual(later);
    expect(client.eval.mock.calls.at(-1)?.[1].keys).toEqual([KEYS.cooldown]);
    await expect(firstQueue.setProviderCooldown(new Date(Number.NaN))).rejects.toThrow(
      "until must be a valid date",
    );
  });

  it("compares and updates provider cooldown entirely inside one Lua call", async () => {
    const client = new StatefulRedisClient();
    const queue = createRedisMemoryExtractionQueue({ client });

    await queue.setProviderCooldown(new Date("2026-07-14T04:30:00.000Z"));

    const [script, options] = client.eval.mock.calls.at(-1)!;
    expect(script).toContain('local current = tonumber(redis.call("GET", KEYS[1]))');
    expect(script).not.toContain("ARGV[3]");
    expect(options.arguments).toEqual([String(new Date("2026-07-14T04:30:00.000Z").getTime())]);
  });

  it("rejects unknown payload fields, invalid dates, and oversized identifiers", () => {
    expect(() =>
      parseMemoryExtractionJob(
        JSON.stringify({ ...serializedJobFixture(), messageText: "forbidden" }),
      ),
    ).toThrow("Invalid memory extraction job payload");
    expect(() =>
      parseMemoryExtractionJob(
        JSON.stringify({ ...serializedJobFixture(), notBefore: "not-a-date" }),
      ),
    ).toThrow("Invalid memory extraction job payload");
    expect(() =>
      parseMemoryExtractionJob(
        JSON.stringify({ ...serializedJobFixture(), groupId: "g".repeat(513) }),
      ),
    ).toThrow("Invalid memory extraction job payload");
  });

  it("caps direct reads at 100 and rejects unsafe limits", async () => {
    const client = new StatefulRedisClient();
    const queue = createRedisMemoryExtractionQueue({ client });

    await expect(queue.listDeadLetters({ limit: 101 })).resolves.toEqual([]);
    expect(client.lRange.mock.calls.at(-1)).toEqual([KEYS.dlq, 0, 99]);
    await expect(queue.dequeueBatch(Number.POSITIVE_INFINITY)).rejects.toThrow(
      "memory extraction queue limit must be a finite safe-magnitude number",
    );
    await expect(queue.listDeadLetters({ limit: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow(
      "memory extraction queue limit must be a finite safe-magnitude number",
    );
    await expect(
      queue.replayDeadLetters({ ids: Array.from({ length: 101 }, (_, index) => `dlq-${index}`) }),
    ).rejects.toThrow("memory extraction dead-letter batch must contain at most 100 ids");
  });

  it("deduplicates batch replay ids and reports unsupported diagnostics", async () => {
    const client = new StatefulRedisClient();
    const corruptPayload = "{";
    client.pushList(KEYS.ready, corruptPayload);
    const queue = createRedisMemoryExtractionQueue({
      client,
      idGenerator: () => "dlq-diagnostic",
    });
    await queue.dequeueBatch(1, jobFixture().enqueuedAt);

    await expect(
      queue.replayDeadLetters({ ids: ["dlq-diagnostic", "dlq-diagnostic", "missing"] }),
    ).resolves.toEqual({
      replayedCount: 0,
      notFoundIds: ["missing"],
      unsupportedLegacyIds: ["dlq-diagnostic"],
    });
  });
});

function jobFixture(
  overrides: Partial<Pick<MemoryExtractionJob, "requestId" | "groupId" | "enqueuedAt">> = {},
): MemoryExtractionJob {
  return createMemoryExtractionJob({
    requestId: overrides.requestId ?? "request-1",
    groupId: overrides.groupId ?? "chat-a",
    now: overrides.enqueuedAt ?? new Date("2026-07-14T00:00:00.000Z"),
  });
}

function serializedJobFixture(): Record<string, unknown> {
  return JSON.parse(serializeMemoryExtractionJob(jobFixture())) as Record<string, unknown>;
}

class StatefulRedisClient implements RedisMemoryExtractionQueueClient {
  private readonly lists = new Map<string, string[]>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly sortedSets = new Map<string, Map<string, number>>();
  private readonly strings = new Map<string, string>();

  readonly eval = vi.fn(
    async (
      script: string,
      options: { keys: string[]; arguments: string[] },
    ): Promise<number | string | null> => {
      if (script.includes("memory-extraction:enqueue")) {
        return this.enqueue(options.keys, options.arguments);
      }
      if (script.includes("memory-extraction:recover-processing")) {
        return this.recoverProcessing(options.keys);
      }
      if (script.includes("memory-extraction:promote-due")) {
        return this.promoteDue(options.keys, options.arguments);
      }
      if (script.includes("memory-extraction:dequeue")) {
        return this.dequeue(options.keys);
      }
      if (script.includes("memory-extraction:ack-processed")) {
        return this.ackProcessed(options.keys, options.arguments);
      }
      if (script.includes("memory-extraction:ack-retry")) {
        return this.ackRetry(options.keys, options.arguments);
      }
      if (script.includes("memory-extraction:ack-dead-letter")) {
        return this.ackDeadLetter(options.keys, options.arguments);
      }
      if (script.includes("memory-extraction:replay-dead-letter")) {
        return this.replayDeadLetter(options.keys, options.arguments);
      }
      if (script.includes("memory-extraction:delete-dead-letter")) {
        return this.removeExact(this.list(options.keys[0]!), options.arguments[0]!) ? 1 : 0;
      }
      if (script.includes("memory-extraction:set-cooldown")) {
        const [key] = options.keys;
        const [milliseconds] = options.arguments;
        const current = Number(this.strings.get(key!));
        if (!Number.isFinite(current) || Number(milliseconds) > current) {
          this.strings.set(key!, milliseconds!);
        }
        return 1;
      }
      throw new Error("unknown memory extraction Lua script");
    },
  );

  readonly lLen = vi.fn(async (key: string) => this.list(key).length);
  readonly lRange = vi.fn(async (key: string, start: number, stop: number) => {
    const values = this.list(key);
    const inclusiveStop = stop < 0 ? values.length : stop + 1;
    return values.slice(start, inclusiveStop);
  });
  readonly lRem = vi.fn(async (key: string, _count: number, value: string) =>
    this.removeExact(this.list(key), value) ? 1 : 0,
  );
  readonly zCard = vi.fn(async (key: string) => this.sortedSet(key).size);
  readonly get = vi.fn(async (key: string) => this.strings.get(key) ?? null);

  pushList(key: string, value: string): void {
    this.list(key).push(value);
  }

  addSet(key: string, value: string): void {
    this.set(key).add(value);
  }

  addSorted(key: string, value: string, score: number): void {
    this.sortedSet(key).set(value, score);
  }

  listValues(key: string): string[] {
    return [...this.list(key)];
  }

  setMembers(key: string): string[] {
    return [...this.set(key)];
  }

  private enqueue(keys: string[], args: string[]): number {
    const [seenKey, readyKey, delayedKey, processingKey] = keys;
    const [idempotencyKey, payload] = args;
    const seen = this.set(seenKey!);
    if (seen.has(idempotencyKey!)) {
      const backed =
        this.list(readyKey!).some((value) => payloadId(value) === idempotencyKey) ||
        [...this.sortedSet(delayedKey!).keys()].some((value) => payloadId(value) === idempotencyKey) ||
        this.list(processingKey!).some((value) => payloadId(value) === idempotencyKey);
      if (backed) {
        return 0;
      }
    } else {
      seen.add(idempotencyKey!);
    }
    this.list(readyKey!).push(payload!);
    return 1;
  }

  private recoverProcessing(keys: string[]): number {
    const [processingKey, readyKey] = keys;
    const processing = this.list(processingKey!);
    const ready = this.list(readyKey!);
    let recovered = 0;
    while (processing.length > 0) {
      ready.unshift(processing.pop()!);
      recovered += 1;
    }
    return recovered;
  }

  private promoteDue(keys: string[], args: string[]): number {
    const [delayedKey, readyKey] = keys;
    const [nowMilliseconds, rawLimit] = args;
    const delayed = this.sortedSet(delayedKey!);
    const due = [...delayed.entries()]
      .filter(([, score]) => score <= Number(nowMilliseconds))
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
      .slice(0, Number(rawLimit));
    for (const [payload] of due) {
      delayed.delete(payload);
      this.list(readyKey!).push(payload);
    }
    return due.length;
  }

  private dequeue(keys: string[]): string | null {
    const [readyKey, processingKey] = keys;
    const payload = this.list(readyKey!).shift() ?? null;
    if (payload !== null) {
      this.list(processingKey!).push(payload);
    }
    return payload;
  }

  private ackProcessed(keys: string[], args: string[]): number {
    const [processingKey, seenKey] = keys;
    const [payload, idempotencyKey] = args;
    if (!this.removeExact(this.list(processingKey!), payload!)) {
      return 0;
    }
    this.set(seenKey!).delete(idempotencyKey!);
    return 1;
  }

  private ackRetry(keys: string[], args: string[]): number {
    const [seenKey, readyKey, delayedKey, processingKey] = keys;
    const [idempotencyKey, payload, originalPayload, score, destination] = args;
    const processing = this.list(processingKey!);
    if (!processing.includes(originalPayload!)) {
      return 0;
    }
    this.removeById(this.list(readyKey!), idempotencyKey!);
    this.removeSortedById(this.sortedSet(delayedKey!), idempotencyKey!);
    this.set(seenKey!).add(idempotencyKey!);
    if (destination === "delayed") {
      this.sortedSet(delayedKey!).set(payload!, Number(score));
    } else {
      this.list(readyKey!).push(payload!);
    }
    this.removeExact(processing, originalPayload!);
    return 1;
  }

  private ackDeadLetter(keys: string[], args: string[]): number {
    const [deadLetterKey, processingKey, seenKey, readyKey, delayedKey] = keys;
    const [deadLetterPayload, originalPayload, idempotencyKey] = args;
    const processing = this.list(processingKey!);
    if (!processing.includes(originalPayload!)) {
      return 0;
    }
    this.list(deadLetterKey!).push(deadLetterPayload!);
    this.removeExact(processing, originalPayload!);
    if (idempotencyKey !== "") {
      if (readyKey !== undefined) {
        this.removeById(this.list(readyKey), idempotencyKey!);
      }
      if (delayedKey !== undefined) {
        this.removeSortedById(this.sortedSet(delayedKey), idempotencyKey!);
      }
      this.set(seenKey!).delete(idempotencyKey!);
    }
    return 1;
  }

  private replayDeadLetter(keys: string[], args: string[]): number {
    const [seenKey, readyKey, delayedKey, processingKey, deadLetterKey] = keys;
    const [idempotencyKey, payload, deadLetterPayload] = args;
    const deadLetters = this.list(deadLetterKey!);
    if (!deadLetters.includes(deadLetterPayload!)) {
      return 0;
    }
    const alreadyProcessing = this.list(processingKey!).some(
      (value) => payloadId(value) === idempotencyKey,
    );
    if (!alreadyProcessing) {
      this.removeById(this.list(readyKey!), idempotencyKey!);
      this.removeSortedById(this.sortedSet(delayedKey!), idempotencyKey!);
      this.set(seenKey!).add(idempotencyKey!);
      this.list(readyKey!).push(payload!);
    }
    this.removeExact(deadLetters, deadLetterPayload!);
    return 1;
  }

  private removeById(values: string[], idempotencyKey: string): void {
    for (let index = values.length - 1; index >= 0; index -= 1) {
      if (payloadId(values[index]!) === idempotencyKey) {
        values.splice(index, 1);
      }
    }
  }

  private removeSortedById(values: Map<string, number>, idempotencyKey: string): void {
    for (const payload of values.keys()) {
      if (payloadId(payload) === idempotencyKey) {
        values.delete(payload);
      }
    }
  }

  private removeExact(values: string[], payload: string): boolean {
    const index = values.indexOf(payload);
    if (index < 0) {
      return false;
    }
    values.splice(index, 1);
    return true;
  }

  private list(key: string): string[] {
    const existing = this.lists.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: string[] = [];
    this.lists.set(key, created);
    return created;
  }

  private set(key: string): Set<string> {
    const existing = this.sets.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Set<string>();
    this.sets.set(key, created);
    return created;
  }

  private sortedSet(key: string): Map<string, number> {
    const existing = this.sortedSets.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Map<string, number>();
    this.sortedSets.set(key, created);
    return created;
  }
}

function payloadId(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as { idempotencyKey?: unknown };
    return typeof parsed.idempotencyKey === "string" ? parsed.idempotencyKey : undefined;
  } catch {
    return undefined;
  }
}
