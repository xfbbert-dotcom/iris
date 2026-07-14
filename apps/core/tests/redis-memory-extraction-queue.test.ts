import { createHash } from "node:crypto";

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
  readySet: "iris:memory:extraction:ready:ids",
  readyCounts: "iris:memory:extraction:ready:counts",
  delayed: "iris:memory:extraction:delayed",
  processing: "iris:memory:extraction:processing",
  processingSequence: "iris:memory:extraction:processing:sequence",
  state: "iris:memory:extraction:state",
  payloads: "iris:memory:extraction:payloads",
  members: "iris:memory:extraction:members",
  cooldown: "iris:memory:extraction:cooldown",
  dlq: "iris:memory:extraction:dlq",
  dlqIndex: "iris:memory:extraction:dlq:index",
  dlqOrder: "iris:memory:extraction:dlq:order",
  dlqSequence: "iris:memory:extraction:dlq:sequence",
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

  it("enqueues future work into delayed storage until the exact due boundary", async () => {
    const client = new StatefulRedisClient();
    const queue = createRedisMemoryExtractionQueue({
      client,
      now: () => new Date("2026-07-14T00:00:00.000Z"),
    });
    const job = {
      ...jobFixture(),
      notBefore: new Date("2026-07-14T00:15:00.000Z"),
    };

    await queue.enqueue(job);
    expect(await queue.getPendingCount()).toBe(0);
    expect(await queue.getDelayedCount()).toBe(1);
    await expect(
      queue.dequeueBatch(1, new Date("2026-07-14T00:14:59.999Z")),
    ).resolves.toEqual([]);
    await expect(
      queue.dequeueBatch(1, new Date("2026-07-14T00:15:00.000Z")),
    ).resolves.toEqual([job]);
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
    expect(client.eval.mock.calls.at(-1)?.[0]).toContain("ZREM");
  });

  it("ACKs the exact noncanonical claimed payload after successful processing", async () => {
    const client = new StatefulRedisClient();
    const payload = nonCanonicalJobPayload();
    client.pushReadyPayload(payload, jobFixture().idempotencyKey);
    const queue = createRedisMemoryExtractionQueue({ client });

    const [claimed] = await queue.dequeueBatch(1, jobFixture().enqueuedAt);
    await queue.handleProcessedJob(claimed!);

    expect(await queue.getProcessingCount()).toBe(0);
    expect(client.setMembers(KEYS.seen)).toEqual([]);
  });

  it("retries the exact noncanonical claimed payload after failed processing", async () => {
    const client = new StatefulRedisClient();
    const payload = nonCanonicalJobPayload();
    client.pushReadyPayload(payload, jobFixture().idempotencyKey);
    const queue = createRedisMemoryExtractionQueue({ client, maxAttempts: 2 });

    const [claimed] = await queue.dequeueBatch(1, jobFixture().enqueuedAt);
    await queue.handleFailedJob({ job: claimed!, errorMessage: "provider_timeout" });

    expect(await queue.getProcessingCount()).toBe(0);
    await expect(queue.dequeueBatch(1, jobFixture().enqueuedAt)).resolves.toEqual([
      { ...jobFixture(), attempts: 1 },
    ]);
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

    expect(await queue.getPendingCount()).toBe(1);
    await expect(queue.dequeueBatch(10, job.enqueuedAt)).resolves.toEqual([
      { ...job, attempts: 1 },
    ]);
  });

  it("drains multiple stale ready duplicates after retry without diagnostic DLQ records", async () => {
    const client = new StatefulRedisClient();
    const queue = createRedisMemoryExtractionQueue({ client });
    const job = jobFixture();
    const payload = serializeMemoryExtractionJob(job);

    await queue.enqueue(job);
    const [claimed] = await queue.dequeueBatch(1, job.enqueuedAt);
    client.pushReadyDuplicate(payload);
    client.pushReadyDuplicate(payload);
    await queue.handleFailedJob({ job: claimed!, errorMessage: "provider_timeout" });

    await expect(queue.dequeueBatch(10, job.enqueuedAt)).resolves.toEqual([
      { ...job, attempts: 1 },
    ]);
    expect(await queue.getDeadLetterCount()).toBe(0);
  });

  it("preserves crash recovery after discarding an exact ready duplicate", async () => {
    const client = new StatefulRedisClient();
    const firstQueue = createRedisMemoryExtractionQueue({ client });
    const job = jobFixture();
    const payload = serializeMemoryExtractionJob(job);

    await firstQueue.enqueue(job);
    await firstQueue.dequeueBatch(1, job.enqueuedAt);
    client.pushList(KEYS.ready, payload);
    await expect(firstQueue.dequeueBatch(1, job.enqueuedAt)).resolves.toEqual([]);

    const restartedQueue = createRedisMemoryExtractionQueue({ client });
    await expect(restartedQueue.dequeueBatch(1, job.enqueuedAt)).resolves.toEqual([job]);
  });

  it("recovers startup processing once without reclaiming active work on later dequeues", async () => {
    const client = new StatefulRedisClient();
    const abandoned = jobFixture({ requestId: "request-abandoned" });
    const next = jobFixture({ requestId: "request-next" });
    client.pushProcessingPayload(
      serializeMemoryExtractionJob(abandoned),
      abandoned.idempotencyKey,
    );
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

  it("bounds startup recovery before removing processing payloads", async () => {
    const client = new StatefulRedisClient();
    const queue = createRedisMemoryExtractionQueue({ client });

    await queue.dequeueBatch(1, jobFixture().enqueuedAt);

    const recoveryScript = client.eval.mock.calls.find(([script]) =>
      script.includes("memory-extraction:recover-processing"),
    )?.[0];
    expect(recoveryScript).toContain(
      '"ZRANGEBYSCORE", KEYS[1], "-inf", "+inf", "LIMIT", 0, ARGV[1]',
    );
    expect(recoveryScript).toContain('redis.call("ZREM", KEYS[1], payload)');
  });

  it("continues bounded startup recovery until all abandoned processing is reclaimed", async () => {
    const client = new StatefulRedisClient();
    for (let index = 0; index < 101; index += 1) {
      const job = jobFixture({ requestId: `request-abandoned-${index}` });
      client.pushProcessingPayload(serializeMemoryExtractionJob(job), job.idempotencyKey);
    }
    const queue = createRedisMemoryExtractionQueue({ client });

    await expect(queue.dequeueBatch(1, jobFixture().enqueuedAt)).resolves.toEqual([]);
    expect(await queue.getProcessingCount()).toBe(1);
    await expect(queue.dequeueBatch(1, jobFixture().enqueuedAt)).resolves.toHaveLength(1);

    const recoveryCalls = client.eval.mock.calls.filter(([script]) =>
      script.includes("memory-extraction:recover-processing"),
    );
    expect(recoveryCalls).toHaveLength(2);
  });

  it("preserves FIFO claim order across bounded processing recovery pages", async () => {
    const client = new StatefulRedisClient();
    const claimedAt = jobFixture().enqueuedAt;
    const jobs = Array.from({ length: 101 }, (_, index) =>
      jobFixture({ requestId: `request-${String((index * 37) % 101).padStart(3, "0")}` }),
    );
    const firstQueue = createRedisMemoryExtractionQueue({ client, now: () => claimedAt });
    for (const job of jobs) {
      await firstQueue.enqueue(job);
    }

    const initiallyClaimed = [
      ...(await firstQueue.dequeueBatch(100, claimedAt)),
      ...(await firstQueue.dequeueBatch(1, claimedAt)),
    ];
    expect(initiallyClaimed.map((job) => job.requestId)).toEqual(
      jobs.map((job) => job.requestId),
    );

    const restartedQueue = createRedisMemoryExtractionQueue({ client, now: () => claimedAt });
    await expect(restartedQueue.dequeueBatch(100, claimedAt)).resolves.toEqual([]);
    const recovered = [
      ...(await restartedQueue.dequeueBatch(100, claimedAt)),
      ...(await restartedQueue.dequeueBatch(1, claimedAt)),
    ];
    expect(recovered.map((job) => job.requestId)).toEqual(jobs.map((job) => job.requestId));
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
      errorMessage: "invalid_queue_payload",
      failedAt: new Date("2026-07-14T01:00:00.000Z"),
      replayable: false,
    });
    expect(JSON.stringify(deadLetter)).not.toContain("sensitive message body");
    await expect(queue.replayDeadLetter("dlq-corrupt")).resolves.toBe(
      "unsupported_legacy_item",
    );
  });

  it("diagnostic-dead-letters attempts that cannot be safely incremented", async () => {
    const client = new StatefulRedisClient();
    const payload = JSON.stringify({
      ...serializedJobFixture(),
      attempts: Number.MAX_SAFE_INTEGER,
    });
    client.pushReadyPayload(payload, jobFixture().idempotencyKey);
    const queue = createRedisMemoryExtractionQueue({
      client,
      idGenerator: () => "dlq-attempt-overflow",
    });

    await expect(queue.dequeueBatch(1, jobFixture().enqueuedAt)).resolves.toEqual([]);
    expect(await queue.getProcessingCount()).toBe(0);
    await expect(queue.listDeadLetters({ limit: 1 })).resolves.toEqual([
      {
        id: "dlq-attempt-overflow",
        payloadDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        payloadBytes: Buffer.byteLength(payload),
        errorMessage: "invalid_queue_payload",
        failedAt: expect.any(Date),
        replayable: false,
      },
    ]);
  });

  it("diagnostic-dead-letters jobs already at the configured attempt ceiling", async () => {
    const client = new StatefulRedisClient();
    const payload = JSON.stringify({ ...serializedJobFixture(), attempts: 2 });
    client.pushReadyPayload(payload, jobFixture().idempotencyKey);
    const queue = createRedisMemoryExtractionQueue({
      client,
      maxAttempts: 2,
      idGenerator: () => "dlq-attempt-ceiling",
    });

    await expect(queue.dequeueBatch(1, jobFixture().enqueuedAt)).resolves.toEqual([]);
    await expect(queue.listDeadLetters({ limit: 1 })).resolves.toEqual([
      expect.objectContaining({
        id: "dlq-attempt-ceiling",
        errorMessage: "invalid_queue_payload",
        replayable: false,
      }),
    ]);
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
    expect(deadLetter.errorMessage).toBe("internal_error");

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

  it("caps maxAttempts below the first unrepresentable terminal attempt", async () => {
    const client = new StatefulRedisClient();
    expect(() =>
      createRedisMemoryExtractionQueue({ client, maxAttempts: Number.MAX_SAFE_INTEGER }),
    ).toThrow("maxAttempts must be less than Number.MAX_SAFE_INTEGER");

    const queue = createRedisMemoryExtractionQueue({
      client,
      maxAttempts: Number.MAX_SAFE_INTEGER - 1,
      idGenerator: () => "dlq-safe-attempt-boundary",
    });
    const job = {
      ...jobFixture(),
      attempts: Number.MAX_SAFE_INTEGER - 2,
    };
    await queue.enqueue(job);
    const [claimed] = await queue.dequeueBatch(1, job.enqueuedAt);

    await expect(
      queue.handleFailedJob({ job: claimed!, errorMessage: "provider_timeout" }),
    ).resolves.toEqual({
      action: "dead_lettered",
      attempts: Number.MAX_SAFE_INTEGER - 1,
    });
    await expect(queue.listDeadLetters({ limit: 1 })).resolves.toEqual([
      expect.objectContaining({
        id: "dlq-safe-attempt-boundary",
        job: expect.objectContaining({ attempts: Number.MAX_SAFE_INTEGER - 1 }),
      }),
    ]);
  });

  it("never persists unknown failure text or provider bodies in the DLQ", async () => {
    const client = new StatefulRedisClient();
    const queue = createRedisMemoryExtractionQueue({
      client,
      maxAttempts: 1,
      idGenerator: () => "dlq-secret",
    });
    const job = jobFixture();
    const secretBearingFailure =
      'provider body={"prompt":"private chat","apiKey":"secret-token"}';

    await queue.enqueue(job);
    const [claimed] = await queue.dequeueBatch(1, job.enqueuedAt);
    await queue.handleFailedJob({ job: claimed!, errorMessage: secretBearingFailure });

    const [deadLetter] = await queue.listDeadLetters({ limit: 1 });
    expect(deadLetter).toMatchObject({
      id: "dlq-secret",
      errorMessage: "internal_error",
      replayable: true,
    });
    expect(client.hashValues(KEYS.dlqIndex).join("\n")).not.toContain("private chat");
    expect(client.hashValues(KEYS.dlqIndex).join("\n")).not.toContain("secret-token");
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

  it("drains multiple stale ready duplicates after terminal failure without a spurious DLQ", async () => {
    const client = new StatefulRedisClient();
    const queue = createRedisMemoryExtractionQueue({
      client,
      maxAttempts: 1,
      idGenerator: () => "dlq-terminal-only",
    });
    const job = jobFixture();
    const payload = serializeMemoryExtractionJob(job);

    await queue.enqueue(job);
    const [claimed] = await queue.dequeueBatch(1, job.enqueuedAt);
    client.pushReadyDuplicate(payload);
    client.pushReadyDuplicate(payload);
    await queue.handleFailedJob({ job: claimed!, errorMessage: "provider_timeout" });

    await expect(queue.dequeueBatch(10, job.enqueuedAt)).resolves.toEqual([]);
    expect(await queue.getDeadLetterCount()).toBe(1);
    await expect(queue.listDeadLetters({ limit: 10 })).resolves.toEqual([
      expect.objectContaining({ id: "dlq-terminal-only", replayable: true }),
    ]);
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
    expect(replayCall?.[0]).toContain("HDEL");
    expect(replayCall?.[0]).toContain("RPUSH");
    expect(replayCall?.[1].keys).toEqual([
      KEYS.seen,
      KEYS.ready,
      KEYS.readySet,
      KEYS.delayed,
      KEYS.processing,
      KEYS.state,
      KEYS.payloads,
      KEYS.members,
      KEYS.dlqIndex,
      KEYS.dlqOrder,
      KEYS.readyCounts,
    ]);
  });

  it("replays a direct DLQ id beyond the first 100 list entries", async () => {
    const client = new StatefulRedisClient();
    for (let index = 0; index < 101; index += 1) {
      client.pushDeadLetter(deadLetterPayload(`dlq-${index}`));
    }
    const queue = createRedisMemoryExtractionQueue({ client });

    await expect(queue.replayDeadLetter("dlq-100")).resolves.toBe("replayed");
    expect(await queue.getPendingCount()).toBe(1);
  });

  it("drains replaced ready duplicates after replay without a diagnostic DLQ", async () => {
    const client = new StatefulRedisClient();
    const job = jobFixture();
    const payload = serializeMemoryExtractionJob(job);
    client.pushDeadLetter(deadLetterPayload("dlq-replace-ready"));
    client.pushReadyPayload(payload, job.idempotencyKey);
    client.pushReadyDuplicate(payload);
    const replayedAt = new Date("2026-07-14T03:00:00.000Z");
    const queue = createRedisMemoryExtractionQueue({
      client,
      now: () => replayedAt,
      idGenerator: () => "dlq-spurious",
    });

    await expect(queue.replayDeadLetter("dlq-replace-ready")).resolves.toBe("replayed");
    await expect(queue.dequeueBatch(10, replayedAt)).resolves.toEqual([
      { ...job, notBefore: replayedAt },
    ]);
    expect(await queue.getDeadLetterCount()).toBe(0);
  });

  it("deletes a direct DLQ id beyond the first 100 list entries", async () => {
    const client = new StatefulRedisClient();
    for (let index = 0; index < 101; index += 1) {
      client.pushDeadLetter(deadLetterPayload(`dlq-${index}`));
    }
    const queue = createRedisMemoryExtractionQueue({ client });

    await expect(queue.deleteDeadLetter("dlq-100")).resolves.toBe("deleted");
    expect(await queue.getDeadLetterCount()).toBe(100);
  });

  it("lists an active DLQ record after a tombstone when limit is one", async () => {
    const client = new StatefulRedisClient();
    client.pushDeadLetter(deadLetterPayload("dlq-deleted"));
    client.pushDeadLetter(deadLetterPayload("dlq-active"));
    const queue = createRedisMemoryExtractionQueue({ client });

    await expect(queue.deleteDeadLetter("dlq-deleted")).resolves.toBe("deleted");
    await expect(queue.listDeadLetters({ limit: 1 })).resolves.toEqual([
      expect.objectContaining({ id: "dlq-active" }),
    ]);
    expect(await queue.getDeadLetterCount()).toBe(1);
  });

  it("keeps DLQ count and bounded listing consistent beyond 100 removed records", async () => {
    const client = new StatefulRedisClient();
    for (let index = 0; index < 101; index += 1) {
      client.pushDeadLetter(deadLetterPayload(`dlq-removed-${index}`));
    }
    client.pushDeadLetter(deadLetterPayload("dlq-active-1"));
    client.pushDeadLetter(deadLetterPayload("dlq-active-2"));
    const queue = createRedisMemoryExtractionQueue({ client });

    for (let index = 0; index < 101; index += 1) {
      await queue.deleteDeadLetter(`dlq-removed-${index}`);
    }

    expect(await queue.getDeadLetterCount()).toBe(2);
    await expect(queue.listDeadLetters({ limit: 2 })).resolves.toEqual([
      expect.objectContaining({ id: "dlq-active-1" }),
      expect.objectContaining({ id: "dlq-active-2" }),
    ]);
  });

  it("does not grow the legacy DLQ payload list for new terminal records", async () => {
    const client = new StatefulRedisClient();
    const queue = createRedisMemoryExtractionQueue({
      client,
      maxAttempts: 1,
      idGenerator: () => "dlq-index-only",
    });
    const job = jobFixture();

    await queue.enqueue(job);
    const [claimed] = await queue.dequeueBatch(1, job.enqueuedAt);
    await queue.handleFailedJob({ job: claimed!, errorMessage: "provider_timeout" });

    expect(await queue.getDeadLetterCount()).toBe(1);
    expect(client.listValues(KEYS.dlq)).toEqual([]);
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

  it.each(["ready", "delayed", "processing"] as const)(
    "repairs stale %s indexes when exact physical work is missing",
    async (staleState) => {
      const client = new StatefulRedisClient();
      const job = jobFixture({ requestId: `request-stale-${staleState}` });
      const payload = serializeMemoryExtractionJob(job);
      client.setHash(KEYS.state, job.idempotencyKey, staleState);
      client.setHash(KEYS.payloads, job.idempotencyKey, payload);
      client.setHash(KEYS.members, payload, job.idempotencyKey);
      client.addSet(KEYS.seen, job.idempotencyKey);
      if (staleState === "ready") {
        client.addSet(KEYS.readySet, job.idempotencyKey);
      }
      const queue = createRedisMemoryExtractionQueue({ client, now: () => job.enqueuedAt });

      await queue.enqueue(job);

      expect(await queue.getPendingCount()).toBe(1);
      await expect(queue.dequeueBatch(1, job.enqueuedAt)).resolves.toEqual([job]);
    },
  );

  it("replays a DLQ record when processing metadata has no exact physical member", async () => {
    const client = new StatefulRedisClient();
    const job = jobFixture();
    const payload = serializeMemoryExtractionJob(job);
    client.pushDeadLetter(deadLetterPayload("dlq-stale-processing"));
    client.setHash(KEYS.state, job.idempotencyKey, "processing");
    client.setHash(KEYS.payloads, job.idempotencyKey, payload);
    client.setHash(KEYS.members, payload, job.idempotencyKey);
    client.addSet(KEYS.seen, job.idempotencyKey);
    const queue = createRedisMemoryExtractionQueue({ client, now: () => job.enqueuedAt });

    await expect(queue.replayDeadLetter("dlq-stale-processing")).resolves.toBe("replayed");

    expect(await queue.getDeadLetterCount()).toBe(0);
    expect(await queue.getPendingCount()).toBe(1);
    await expect(queue.dequeueBatch(1, job.enqueuedAt)).resolves.toEqual([job]);
  });

  it("uses indexed mutation scripts without backlog-wide JSON scans", async () => {
    const client = new StatefulRedisClient();
    const queue = createRedisMemoryExtractionQueue({
      client,
      maxAttempts: 2,
      idGenerator: () => "dlq-indexed",
    });
    const job = jobFixture();

    await queue.enqueue(job);
    const [first] = await queue.dequeueBatch(1, job.enqueuedAt);
    await queue.handleFailedJob({ job: first!, errorMessage: "provider_timeout" });
    const [second] = await queue.dequeueBatch(1, job.enqueuedAt);
    await queue.handleFailedJob({ job: second!, errorMessage: "provider_timeout" });
    await queue.replayDeadLetter("dlq-indexed");

    const mutationMarkers = [
      "memory-extraction:enqueue",
      "memory-extraction:ack-retry",
      "memory-extraction:ack-dead-letter",
      "memory-extraction:replay-dead-letter",
    ];
    for (const marker of mutationMarkers) {
      const script = client.eval.mock.calls.find(([candidate]) => candidate.includes(marker))?.[0];
      expect(script).toContain("HGET");
      expect(script).toContain("HSET");
      expect(script).not.toMatch(/\bLRANGE\b|\bZRANGE\b|cjson/);
    }
  });

  it("uses indexed processing mutations without unbounded list removal", async () => {
    const client = new StatefulRedisClient();
    const queue = createRedisMemoryExtractionQueue({
      client,
      maxAttempts: 2,
      idGenerator: () => "dlq-processing-index",
    });
    const first = jobFixture({ requestId: "request-success" });
    const second = jobFixture({ requestId: "request-terminal" });

    await queue.enqueue(first);
    await queue.enqueue(second);
    const [success, terminal] = await queue.dequeueBatch(2, first.enqueuedAt);
    await queue.handleProcessedJob(success!);
    await queue.handleFailedJob({ job: terminal!, errorMessage: "provider_timeout" });
    const [retried] = await queue.dequeueBatch(1, second.enqueuedAt);
    await queue.handleFailedJob({ job: retried!, errorMessage: "provider_timeout" });

    const markers = [
      "memory-extraction:recover-processing",
      "memory-extraction:ack-processed",
      "memory-extraction:ack-retry",
      "memory-extraction:ack-dead-letter",
    ];
    for (const marker of markers) {
      const script = client.eval.mock.calls.find(([candidate]) => candidate.includes(marker))?.[0];
      expect(script).toBeDefined();
      expect(script).not.toContain("LREM");
    }
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
    expect(client.zRange.mock.calls.at(-1)).toEqual([KEYS.dlqOrder, 0, 99]);
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

  it("rejects fractional queue and list limits", async () => {
    const client = new StatefulRedisClient();
    const queue = createRedisMemoryExtractionQueue({ client });

    await expect(queue.dequeueBatch(1.5)).rejects.toThrow(
      "memory extraction queue limit must be a safe integer",
    );
    await expect(queue.listDeadLetters({ limit: 2.25 })).rejects.toThrow(
      "memory extraction queue limit must be a safe integer",
    );
  });

  it("deduplicates batch replay ids and reports unsupported diagnostics", async () => {
    const client = new StatefulRedisClient();
    const corruptPayload = "{";
    client.pushReadyPayload(corruptPayload, "corrupt-batch-claim");
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

function nonCanonicalJobPayload(): string {
  return `{
    "attempts": 0,
    "notBefore": "2026-07-14T08:00:00+08:00",
    "groupId": "chat-a",
    "requestId": "request-1",
    "idempotencyKey": "memory-extraction:request-1",
    "enqueuedAt": "2026-07-14T08:00:00+08:00",
    "schemaVersion": 1
  }`;
}

function deadLetterPayload(id: string): string {
  return JSON.stringify({
    id,
    job: serializedJobFixture(),
    errorMessage: "provider_timeout",
    failedAt: "2026-07-14T01:00:00.000Z",
  });
}

class StatefulRedisClient implements RedisMemoryExtractionQueueClient {
  private readonly lists = new Map<string, string[]>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly sortedSets = new Map<string, Map<string, number>>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly strings = new Map<string, string>();

  readonly eval = vi.fn(
    async (
      script: string,
      options: { keys: string[]; arguments: string[] },
    ): Promise<number | string | string[] | null> => {
      if (script.includes("memory-extraction:enqueue")) return this.enqueue(options.keys, options.arguments);
      if (script.includes("memory-extraction:recover-processing")) return this.recoverProcessing(options.keys, options.arguments);
      if (script.includes("memory-extraction:promote-due")) return this.promoteDue(options.keys, options.arguments);
      if (script.includes("memory-extraction:dequeue")) return this.dequeue(options.keys, options.arguments);
      if (script.includes("memory-extraction:ack-processed")) return this.ackProcessed(options.keys, options.arguments);
      if (script.includes("memory-extraction:ack-retry")) return this.ackRetry(options.keys, options.arguments);
      if (script.includes("memory-extraction:ack-dead-letter")) return this.ackDeadLetter(options.keys, options.arguments);
      if (script.includes("memory-extraction:replay-dead-letter")) return this.replayDeadLetter(options.keys, options.arguments);
      if (script.includes("memory-extraction:delete-dead-letter")) return this.deleteDeadLetter(options.keys, options.arguments);
      if (script.includes("memory-extraction:set-cooldown")) {
        const [key] = options.keys;
        const [milliseconds] = options.arguments;
        const current = Number(this.strings.get(key!));
        if (!Number.isFinite(current) || Number(milliseconds) > current) this.strings.set(key!, milliseconds!);
        return 1;
      }
      throw new Error("unknown memory extraction Lua script");
    },
  );

  readonly lLen = vi.fn(async (key: string) => this.list(key).length);
  readonly lRange = vi.fn(async (key: string, start: number, stop: number) => {
    const values = this.list(key);
    return values.slice(start, stop < 0 ? values.length : stop + 1);
  });
  readonly sCard = vi.fn(async (key: string) => this.set(key).size);
  readonly zCard = vi.fn(async (key: string) => this.sortedSet(key).size);
  readonly zRange = vi.fn(async (key: string, start: number, stop: number) =>
    [...this.sortedSet(key).entries()]
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
      .slice(start, stop < 0 ? undefined : stop + 1)
      .map(([member]) => member),
  );
  readonly hLen = vi.fn(async (key: string) => this.hash(key).size);
  readonly hGet = vi.fn(async (key: string, field: string) => this.hash(key).get(field) ?? null);
  readonly get = vi.fn(async (key: string) => this.strings.get(key) ?? null);

  pushList(key: string, value: string): void {
    this.list(key).push(value);
  }

  pushReadyPayload(payload: string, idempotencyKey: string): void {
    this.list(KEYS.ready).push(payload);
    this.incrementHash(KEYS.readyCounts, payload, 1);
    this.set(KEYS.readySet).add(idempotencyKey);
    this.set(KEYS.seen).add(idempotencyKey);
    this.hash(KEYS.state).set(idempotencyKey, "ready");
    this.hash(KEYS.payloads).set(idempotencyKey, payload);
    this.hash(KEYS.members).set(payload, idempotencyKey);
  }

  pushReadyDuplicate(payload: string): void {
    this.list(KEYS.ready).push(payload);
    this.incrementHash(KEYS.readyCounts, payload, 1);
  }

  pushProcessingPayload(payload: string, idempotencyKey: string): void {
    const sequence = Number(this.strings.get(KEYS.processingSequence) ?? 0) + 1;
    this.strings.set(KEYS.processingSequence, String(sequence));
    this.sortedSet(KEYS.processing).set(payload, sequence);
    this.set(KEYS.seen).add(idempotencyKey);
    this.hash(KEYS.state).set(idempotencyKey, "processing");
    this.hash(KEYS.payloads).set(idempotencyKey, payload);
    this.hash(KEYS.members).set(payload, idempotencyKey);
  }

  pushDeadLetter(payload: string): void {
    const id = (JSON.parse(payload) as { id: string }).id;
    const sequence = Number(this.strings.get(KEYS.dlqSequence) ?? 0) + 1;
    this.strings.set(KEYS.dlqSequence, String(sequence));
    this.sortedSet(KEYS.dlqOrder).set(id, sequence);
    this.hash(KEYS.dlqIndex).set(id, payload);
  }

  addSet(key: string, value: string): void {
    this.set(key).add(value);
  }

  setHash(key: string, field: string, value: string): void {
    this.hash(key).set(field, value);
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

  hashValues(key: string): string[] {
    return [...this.hash(key).values()];
  }

  private enqueue(keys: string[], args: string[]): number {
    const [seenKey, readyKey, readySetKey, delayedKey, stateKey, payloadKey, memberKey, readyCountKey, processingKey] = keys;
    const [idempotencyKey, payload, destination, score] = args;
    const state = this.hash(stateKey!).get(idempotencyKey!);
    const indexedPayload = this.hash(payloadKey!).get(idempotencyKey!);
    const physical =
      (state === "ready" &&
        indexedPayload !== undefined &&
        this.set(readySetKey!).has(idempotencyKey!) &&
        Number(this.hash(readyCountKey!).get(indexedPayload) ?? 0) > 0) ||
      (state === "delayed" &&
        indexedPayload !== undefined &&
        this.sortedSet(delayedKey!).has(indexedPayload)) ||
      (state === "processing" &&
        indexedPayload !== undefined &&
        this.sortedSet(processingKey!).has(indexedPayload));
    if (physical && this.hash(memberKey!).get(indexedPayload!) === idempotencyKey) {
      this.set(seenKey!).add(idempotencyKey!);
      return 0;
    }
    this.set(readySetKey!).delete(idempotencyKey!);
    if (indexedPayload !== undefined) {
      this.sortedSet(delayedKey!).delete(indexedPayload);
      this.sortedSet(processingKey!).delete(indexedPayload);
      if (Number(this.hash(readyCountKey!).get(indexedPayload) ?? 0) <= 0) {
        this.hash(memberKey!).delete(indexedPayload);
      }
    }
    this.hash(stateKey!).delete(idempotencyKey!);
    this.hash(payloadKey!).delete(idempotencyKey!);
    this.hash(payloadKey!).set(idempotencyKey!, payload!);
    this.hash(memberKey!).set(payload!, idempotencyKey!);
    if (destination === "delayed") {
      this.sortedSet(delayedKey!).set(payload!, Number(score));
      this.hash(stateKey!).set(idempotencyKey!, "delayed");
    } else {
      this.list(readyKey!).push(payload!);
      this.incrementHash(readyCountKey!, payload!, 1);
      this.set(readySetKey!).add(idempotencyKey!);
      this.hash(stateKey!).set(idempotencyKey!, "ready");
    }
    this.set(seenKey!).add(idempotencyKey!);
    return 1;
  }

  private recoverProcessing(keys: string[], args: string[]): number {
    const [processingKey, readyKey, readySetKey, stateKey, payloadKey, memberKey, readyCountKey] = keys;
    const processing = [...this.sortedSet(processingKey!).entries()]
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
      .slice(0, Number(args[0]));
    for (const [payload] of processing) {
      this.sortedSet(processingKey!).delete(payload);
      const id = this.hash(memberKey!).get(payload);
      if (id && this.hash(stateKey!).get(id) === "processing" && this.hash(payloadKey!).get(id) === payload) {
        this.list(readyKey!).push(payload);
        this.incrementHash(readyCountKey!, payload, 1);
        this.set(readySetKey!).add(id);
        this.hash(stateKey!).set(id, "ready");
      } else if (id && this.hash(payloadKey!).get(id) !== payload) {
        this.hash(memberKey!).delete(payload);
      }
    }
    return this.sortedSet(processingKey!).size;
  }

  private promoteDue(keys: string[], args: string[]): number {
    const [delayedKey, readyKey, readySetKey, stateKey, payloadKey, memberKey, readyCountKey] = keys;
    const delayed = this.sortedSet(delayedKey!);
    const due = [...delayed.entries()]
      .filter(([, score]) => score <= Number(args[0]))
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
      .slice(0, Number(args[1]));
    for (const [payload] of due) {
      delayed.delete(payload);
      const id = this.hash(memberKey!).get(payload);
      if (id && this.hash(stateKey!).get(id) === "delayed" && this.hash(payloadKey!).get(id) === payload) {
        this.list(readyKey!).push(payload);
        this.incrementHash(readyCountKey!, payload, 1);
        this.set(readySetKey!).add(id);
        this.hash(stateKey!).set(id, "ready");
      } else if (id && this.hash(payloadKey!).get(id) !== payload) {
        this.hash(memberKey!).delete(payload);
      }
    }
    return due.length;
  }

  private dequeue(keys: string[], args: string[]): string[] {
    const [readyKey, readySetKey, processingKey, stateKey, payloadKey, memberKey, readyCountKey, processingSequenceKey] = keys;
    const claimed: string[] = [];
    let popped = 0;
    while (claimed.length / 2 < Number(args[0]) && popped < Number(args[1])) {
      const payload = this.list(readyKey!).shift();
      if (payload === undefined) break;
      popped += 1;
      this.incrementHash(readyCountKey!, payload, -1);
      const id = this.hash(memberKey!).get(payload);
      if (id && this.hash(stateKey!).get(id) === "ready" && this.hash(payloadKey!).get(id) === payload) {
        this.set(readySetKey!).delete(id);
        const sequence = Number(this.strings.get(processingSequenceKey!) ?? 0) + 1;
        this.strings.set(processingSequenceKey!, String(sequence));
        this.sortedSet(processingKey!).set(payload, sequence);
        this.hash(stateKey!).set(id, "processing");
        claimed.push(id, payload);
      } else if (id) {
        if (
          this.hash(payloadKey!).get(id) !== payload &&
          Number(this.hash(readyCountKey!).get(payload) ?? 0) <= 0
        ) {
          this.hash(memberKey!).delete(payload);
        }
      } else {
        const invalidId = `invalid:${createHash("sha1").update(payload).digest("hex")}`;
        if (
          this.hash(stateKey!).get(invalidId) !== "processing" ||
          this.hash(payloadKey!).get(invalidId) !== payload
        ) {
          this.hash(stateKey!).set(invalidId, "processing");
          this.hash(payloadKey!).set(invalidId, payload);
          this.hash(memberKey!).set(payload, invalidId);
          const sequence = Number(this.strings.get(processingSequenceKey!) ?? 0) + 1;
          this.strings.set(processingSequenceKey!, String(sequence));
          this.sortedSet(processingKey!).set(payload, sequence);
          claimed.push(invalidId, payload);
        }
      }
    }
    return claimed;
  }

  private ackProcessed(keys: string[], args: string[]): number {
    const [processingKey, seenKey, readySetKey, delayedKey, stateKey, payloadKey, memberKey, readyCountKey] = keys;
    const [id, payload] = args;
    if (this.hash(stateKey!).get(id!) !== "processing" || this.hash(payloadKey!).get(id!) !== payload) return 0;
    this.hash(stateKey!).delete(id!);
    this.hash(payloadKey!).delete(id!);
    this.set(seenKey!).delete(id!);
    this.set(readySetKey!).delete(id!);
    this.sortedSet(delayedKey!).delete(payload!);
    this.sortedSet(processingKey!).delete(payload!);
    if (Number(this.hash(readyCountKey!).get(payload!) ?? 0) <= 0) {
      this.hash(memberKey!).delete(payload!);
    }
    return 1;
  }

  private ackRetry(keys: string[], args: string[]): number {
    const [seenKey, readyKey, readySetKey, delayedKey, processingKey, stateKey, payloadKey, memberKey, readyCountKey] = keys;
    const [id, payload, originalPayload, score, destination] = args;
    if (this.hash(stateKey!).get(id!) !== "processing" || this.hash(payloadKey!).get(id!) !== originalPayload) return 0;
    this.set(readySetKey!).delete(id!);
    this.sortedSet(delayedKey!).delete(originalPayload!);
    this.sortedSet(processingKey!).delete(originalPayload!);
    if (Number(this.hash(readyCountKey!).get(originalPayload!) ?? 0) <= 0) {
      this.hash(memberKey!).delete(originalPayload!);
    }
    this.hash(payloadKey!).set(id!, payload!);
    this.hash(memberKey!).set(payload!, id!);
    if (destination === "delayed") {
      this.sortedSet(delayedKey!).set(payload!, Number(score));
      this.hash(stateKey!).set(id!, "delayed");
    } else {
      this.list(readyKey!).push(payload!);
      this.incrementHash(readyCountKey!, payload!, 1);
      this.set(readySetKey!).add(id!);
      this.hash(stateKey!).set(id!, "ready");
    }
    this.set(seenKey!).add(id!);
    return 1;
  }

  private ackDeadLetter(keys: string[], args: string[]): number {
    const [deadLetterOrderKey, deadLetterIndexKey, processingKey, seenKey, readySetKey, delayedKey, stateKey, payloadKey, memberKey, deadLetterSequenceKey, readyCountKey] = keys;
    const [deadLetterId, deadLetterPayload, id, originalPayload] = args;
    if (this.hash(stateKey!).get(id!) !== "processing" || this.hash(payloadKey!).get(id!) !== originalPayload) return 0;
    const sequence = Number(this.strings.get(deadLetterSequenceKey!) ?? 0) + 1;
    this.strings.set(deadLetterSequenceKey!, String(sequence));
    this.sortedSet(deadLetterOrderKey!).set(deadLetterId!, sequence);
    this.hash(deadLetterIndexKey!).set(deadLetterId!, deadLetterPayload!);
    this.hash(stateKey!).delete(id!);
    this.hash(payloadKey!).delete(id!);
    this.set(seenKey!).delete(id!);
    this.set(readySetKey!).delete(id!);
    this.sortedSet(delayedKey!).delete(originalPayload!);
    this.sortedSet(processingKey!).delete(originalPayload!);
    if (Number(this.hash(readyCountKey!).get(originalPayload!) ?? 0) <= 0) {
      this.hash(memberKey!).delete(originalPayload!);
    }
    return 1;
  }

  private replayDeadLetter(keys: string[], args: string[]): number {
    const [seenKey, readyKey, readySetKey, delayedKey, processingKey, stateKey, payloadKey, memberKey, deadLetterIndexKey, deadLetterOrderKey, readyCountKey] = keys;
    const [id, payload, deadLetterId, deadLetterPayload] = args;
    if (this.hash(deadLetterIndexKey!).get(deadLetterId!) !== deadLetterPayload) return 0;
    const existingPayload = this.hash(payloadKey!).get(id!);
    if (
      this.hash(stateKey!).get(id!) === "processing" &&
      existingPayload !== undefined &&
      this.hash(memberKey!).get(existingPayload) === id &&
      this.sortedSet(processingKey!).has(existingPayload)
    ) {
      this.hash(deadLetterIndexKey!).delete(deadLetterId!);
      this.sortedSet(deadLetterOrderKey!).delete(deadLetterId!);
      return 1;
    }
    if (existingPayload) {
      this.sortedSet(delayedKey!).delete(existingPayload);
      this.sortedSet(processingKey!).delete(existingPayload);
      if (Number(this.hash(readyCountKey!).get(existingPayload) ?? 0) <= 0) {
        this.hash(memberKey!).delete(existingPayload);
      }
    }
    this.set(readySetKey!).delete(id!);
    this.hash(stateKey!).delete(id!);
    this.hash(payloadKey!).delete(id!);
    this.hash(payloadKey!).set(id!, payload!);
    this.hash(memberKey!).set(payload!, id!);
    this.list(readyKey!).push(payload!);
    this.incrementHash(readyCountKey!, payload!, 1);
    this.set(readySetKey!).add(id!);
    this.hash(stateKey!).set(id!, "ready");
    this.set(seenKey!).add(id!);
    this.hash(deadLetterIndexKey!).delete(deadLetterId!);
    this.sortedSet(deadLetterOrderKey!).delete(deadLetterId!);
    return 1;
  }

  private deleteDeadLetter(keys: string[], args: string[]): number {
    const [indexKey, orderKey] = keys;
    const [id, payload] = args;
    if (this.hash(indexKey!).get(id!) !== payload) return 0;
    this.hash(indexKey!).delete(id!);
    this.sortedSet(orderKey!).delete(id!);
    return 1;
  }

  private removeExact(values: string[], payload: string): boolean {
    const index = values.indexOf(payload);
    if (index < 0) return false;
    values.splice(index, 1);
    return true;
  }

  private incrementHash(key: string, field: string, delta: number): number {
    const next = Number(this.hash(key).get(field) ?? 0) + delta;
    if (next <= 0) {
      this.hash(key).delete(field);
    } else {
      this.hash(key).set(field, String(next));
    }
    return next;
  }

  private list(key: string): string[] {
    if (!this.lists.has(key)) this.lists.set(key, []);
    return this.lists.get(key)!;
  }

  private set(key: string): Set<string> {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    return this.sets.get(key)!;
  }

  private sortedSet(key: string): Map<string, number> {
    if (!this.sortedSets.has(key)) this.sortedSets.set(key, new Map());
    return this.sortedSets.get(key)!;
  }

  private hash(key: string): Map<string, string> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    return this.hashes.get(key)!;
  }
}
