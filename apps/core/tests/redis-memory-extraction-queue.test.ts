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
  readyIndex: "iris:memory:extraction:ready:index",
  readySequence: "iris:memory:extraction:ready:sequence",
  readyCounts: "iris:memory:extraction:ready:counts",
  delayed: "iris:memory:extraction:delayed",
  processing: "iris:memory:extraction:processing",
  processingSequence: "iris:memory:extraction:processing:sequence",
  recovery: "iris:memory:extraction:processing:recovery",
  recoverySet: "iris:memory:extraction:processing:recovery:ids",
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
    client.pushList(KEYS.ready, job.idempotencyKey);

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
    client.pushList(KEYS.ready, job.idempotencyKey);
    await expect(firstQueue.dequeueBatch(1, job.enqueuedAt)).resolves.toEqual([]);

    const restartedQueue = createRedisMemoryExtractionQueue({ client });
    await expect(restartedQueue.dequeueBatch(1, job.enqueuedAt)).resolves.toEqual([job]);
  });

  it("repairs a missing reverse member before claiming ready work", async () => {
    const client = new StatefulRedisClient();
    const job = jobFixture({ requestId: "request-ready-no-reverse" });
    const payload = serializeMemoryExtractionJob(job);
    const queue = createRedisMemoryExtractionQueue({ client });
    await queue.enqueue(job);
    client.deleteHash(KEYS.members, payload);

    await expect(queue.dequeueBatch(1, job.enqueuedAt)).resolves.toEqual([job]);
    expect(await queue.getPendingCount()).toBe(0);
    expect(await queue.getDeadLetterCount()).toBe(0);
  });

  it("repairs a missing reverse member before promoting delayed work", async () => {
    const client = new StatefulRedisClient();
    const enqueuedAt = jobFixture().enqueuedAt;
    const dueAt = new Date(enqueuedAt.getTime() + 60_000);
    const job = { ...jobFixture({ requestId: "request-delayed-no-reverse" }), notBefore: dueAt };
    const payload = serializeMemoryExtractionJob(job);
    const queue = createRedisMemoryExtractionQueue({ client, now: () => enqueuedAt });
    await queue.enqueue(job);
    client.deleteHash(KEYS.members, payload);

    await expect(queue.dequeueBatch(1, dueAt)).resolves.toEqual([job]);
    expect(await queue.getDelayedCount()).toBe(0);
    expect(await queue.getDeadLetterCount()).toBe(0);
  });

  it("repairs a missing reverse member before recovering processing work", async () => {
    const client = new StatefulRedisClient();
    const job = jobFixture({ requestId: "request-processing-no-reverse" });
    const payload = serializeMemoryExtractionJob(job);
    const firstQueue = createRedisMemoryExtractionQueue({ client });
    await firstQueue.enqueue(job);
    await firstQueue.dequeueBatch(1, job.enqueuedAt);
    client.deleteHash(KEYS.members, payload);

    const restartedQueue = createRedisMemoryExtractionQueue({ client });
    await expect(restartedQueue.dequeueBatch(1, job.enqueuedAt)).resolves.toEqual([job]);
    expect(await restartedQueue.getProcessingCount()).toBe(1);
    expect(await restartedQueue.getDeadLetterCount()).toBe(0);
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
      '"ZRANGEBYSCORE", KEYS[1], "-inf", "+inf", "WITHSCORES", "LIMIT", 0, ARGV[1]',
    );
    expect(recoveryScript).toContain('redis.call("ZREM", KEYS[1], idempotency_key)');
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

  it("prioritizes all recovery pages ahead of existing and concurrent ready work", async () => {
    const client = new StatefulRedisClient();
    const claimedAt = jobFixture().enqueuedAt;
    const abandoned = Array.from({ length: 101 }, (_, index) =>
      jobFixture({ requestId: `request-recovery-priority-${String(index + 1).padStart(3, "0")}` }),
    );
    const existingPending = jobFixture({ requestId: "request-existing-pending" });
    const concurrentPending = jobFixture({ requestId: "request-concurrent-pending" });
    const firstQueue = createRedisMemoryExtractionQueue({ client, now: () => claimedAt });
    for (const job of abandoned) {
      await firstQueue.enqueue(job);
    }
    await firstQueue.dequeueBatch(100, claimedAt);
    await firstQueue.dequeueBatch(1, claimedAt);
    await firstQueue.enqueue(existingPending);

    const restartedQueue = createRedisMemoryExtractionQueue({ client, now: () => claimedAt });
    await expect(restartedQueue.dequeueBatch(100, claimedAt)).resolves.toEqual([]);
    await restartedQueue.enqueue(concurrentPending);

    const dequeued = [
      ...(await restartedQueue.dequeueBatch(100, claimedAt)),
      ...(await restartedQueue.dequeueBatch(3, claimedAt)),
    ];
    expect(dequeued.map((job) => job.requestId)).toEqual([
      ...abandoned.map((job) => job.requestId),
      existingPending.requestId,
      concurrentPending.requestId,
    ]);
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
    const diagnosticAck = client.eval.mock.calls.find(([script]) =>
      script.includes("memory-extraction:ack-dead-letter"),
    );
    expect(diagnosticAck?.[1].arguments[3]).not.toContain("sensitive message body");
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
    client.pushList(KEYS.ready, job.idempotencyKey);
    client.addSorted(KEYS.delayed, job.idempotencyKey, job.notBefore.getTime());

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
      KEYS.readyIndex,
      KEYS.readySet,
      KEYS.delayed,
      KEYS.processing,
      KEYS.recoverySet,
      KEYS.state,
      KEYS.payloads,
      KEYS.members,
      KEYS.dlqIndex,
      KEYS.dlqOrder,
      KEYS.readyCounts,
      KEYS.readySequence,
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

  it("drains valid ready duplicates independently of missing, low, or high counts", async () => {
    const paths = ["success", "retry", "terminal", "replay"] as const;
    const drifts = ["missing", "low", "high"] as const;

    for (const path of paths) {
      for (const drift of drifts) {
        const client = new StatefulRedisClient();
        const job = jobFixture();
        const payload = serializeMemoryExtractionJob(job);
        const queue = createRedisMemoryExtractionQueue({
          client,
          maxAttempts: path === "terminal" ? 1 : 5,
          now: () => job.enqueuedAt,
          idGenerator: () => `dlq-${path}-${drift}`,
        });

        let claimed: MemoryExtractionJob | undefined;
        if (path === "replay") {
          client.pushDeadLetter(deadLetterPayload("dlq-replay-source"));
          client.pushReadyPayload(payload, job.idempotencyKey);
          client.pushReadyDuplicate(payload);
        } else {
          await queue.enqueue(job);
          [claimed] = await queue.dequeueBatch(1, job.enqueuedAt);
          client.pushReadyDuplicate(payload);
          client.pushReadyDuplicate(payload);
        }

        if (drift === "missing") {
          client.deleteHash(KEYS.readyCounts, payload);
        } else {
          client.setHash(KEYS.readyCounts, payload, drift === "low" ? "1" : "99");
        }

        if (path === "success") {
          await queue.handleProcessedJob(claimed!);
        } else if (path === "retry" || path === "terminal") {
          await queue.handleFailedJob({ job: claimed!, errorMessage: "provider_timeout" });
        } else {
          await queue.replayDeadLetter("dlq-replay-source");
        }

        await queue.dequeueBatch(10, job.enqueuedAt);

        const deadLetters = await queue.listDeadLetters({ limit: 10 });
        expect(
          deadLetters.filter((deadLetter) => !deadLetter.replayable),
          `${path}/${drift} must not create a diagnostic DLQ`,
        ).toEqual([]);
        expect(deadLetters).toHaveLength(path === "terminal" ? 1 : 0);
        expect(
          client.hashValue(KEYS.readyCounts, payload),
          `${path}/${drift} must clear count drift while draining`,
        ).toBeUndefined();
      }
    }
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

  it("repairs stale DLQ order entries without hiding later active records", async () => {
    const client = new StatefulRedisClient();
    client.pushDeadLetter(deadLetterPayload("dlq-stale-order"));
    client.pushDeadLetter(deadLetterPayload("dlq-active-order"));
    client.deleteHash(KEYS.dlqIndex, "dlq-stale-order");
    const queue = createRedisMemoryExtractionQueue({ client });

    expect(await queue.getDeadLetterCount()).toBe(1);
    await expect(queue.listDeadLetters({ limit: 1 })).resolves.toEqual([
      expect.objectContaining({ id: "dlq-active-order" }),
    ]);
    expect(await client.zRange(KEYS.dlqOrder, 0, 10)).toEqual(["dlq-active-order"]);
  });

  it("repairs a hash-only DLQ record so count and bounded listing agree", async () => {
    const client = new StatefulRedisClient();
    client.setHash(KEYS.dlqIndex, "dlq-hash-only", deadLetterPayload("dlq-hash-only"));
    const queue = createRedisMemoryExtractionQueue({ client });

    expect(await queue.getDeadLetterCount()).toBe(1);
    await expect(queue.listDeadLetters({ limit: 1 })).resolves.toEqual([
      expect.objectContaining({ id: "dlq-hash-only" }),
    ]);
    expect(await client.zRange(KEYS.dlqOrder, 0, 10)).toEqual(["dlq-hash-only"]);
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
    client.pushReadyPayload(corruptPayload, "memory-extraction:corrupt-batch-claim");
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
      if (script.includes("memory-extraction:repair-dead-letter-order")) return this.repairDeadLetterOrder(options.keys, options.arguments);
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
  readonly hScan = vi.fn(
    async (key: string, cursor: string, options: { COUNT: number }) => {
      const entries = [...this.hash(key).entries()];
      const start = Number(cursor);
      const page = entries.slice(start, start + options.COUNT);
      const next = start + page.length >= entries.length ? "0" : String(start + page.length);
      return {
        cursor: next,
        entries: page.map(([field, value]) => ({ field, value })),
      };
    },
  );
  readonly get = vi.fn(async (key: string) => this.strings.get(key) ?? null);

  pushList(key: string, value: string): void {
    this.list(key).push(value);
  }

  pushReadyPayload(payload: string, idempotencyKey: string): void {
    this.list(KEYS.ready).push(idempotencyKey);
    const sequence = Number(this.strings.get(KEYS.readySequence) ?? 0) + 1;
    this.strings.set(KEYS.readySequence, String(sequence));
    this.sortedSet(KEYS.readyIndex).set(idempotencyKey, sequence);
    this.set(KEYS.readySet).add(idempotencyKey);
    this.set(KEYS.seen).add(idempotencyKey);
    this.hash(KEYS.state).set(idempotencyKey, "ready");
    this.hash(KEYS.payloads).set(idempotencyKey, payload);
    this.hash(KEYS.members).set(payload, idempotencyKey);
  }

  pushReadyDuplicate(payload: string): void {
    this.list(KEYS.ready).push(parseMemoryExtractionJob(payload).idempotencyKey);
  }

  pushProcessingPayload(payload: string, idempotencyKey: string): void {
    const sequence = Number(this.strings.get(KEYS.processingSequence) ?? 0) + 1;
    this.strings.set(KEYS.processingSequence, String(sequence));
    this.sortedSet(KEYS.processing).set(idempotencyKey, sequence);
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

  deleteHash(key: string, field: string): void {
    this.hash(key).delete(field);
  }

  hashValue(key: string, field: string): string | undefined {
    return this.hash(key).get(field);
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
    const [seenKey, readyKey, readyIndexKey, delayedKey, processingKey, recoverySetKey, stateKey, payloadKey, memberKey, readyCountKey, readySetKey, readySequenceKey] = keys;
    const [idempotencyKey, payload, destination, score] = args;
    const state = this.hash(stateKey!).get(idempotencyKey!);
    const indexedPayload = this.hash(payloadKey!).get(idempotencyKey!);
    const physical =
      (state === "ready" &&
        indexedPayload !== undefined &&
        this.sortedSet(readyIndexKey!).has(idempotencyKey!)) ||
      (state === "delayed" &&
        indexedPayload !== undefined &&
        this.sortedSet(delayedKey!).has(idempotencyKey!)) ||
      (state === "processing" &&
        indexedPayload !== undefined &&
        this.sortedSet(processingKey!).has(idempotencyKey!)) ||
      (state === "recovery" &&
        indexedPayload !== undefined &&
        this.set(recoverySetKey!).has(idempotencyKey!));
    if (physical) {
      this.set(seenKey!).add(idempotencyKey!);
      return 0;
    }
    this.sortedSet(readyIndexKey!).delete(idempotencyKey!);
    this.sortedSet(delayedKey!).delete(idempotencyKey!);
    this.sortedSet(processingKey!).delete(idempotencyKey!);
    this.set(recoverySetKey!).delete(idempotencyKey!);
    this.set(readySetKey!).delete(idempotencyKey!);
    if (indexedPayload !== undefined) {
      this.hash(memberKey!).delete(indexedPayload);
      this.hash(readyCountKey!).delete(indexedPayload);
    }
    this.hash(payloadKey!).set(idempotencyKey!, payload!);
    if (destination === "delayed") {
      this.sortedSet(delayedKey!).set(idempotencyKey!, Number(score));
      this.hash(stateKey!).set(idempotencyKey!, "delayed");
    } else {
      const sequence = Number(this.strings.get(readySequenceKey!) ?? 0) + 1;
      this.strings.set(readySequenceKey!, String(sequence));
      this.list(readyKey!).push(idempotencyKey!);
      this.sortedSet(readyIndexKey!).set(idempotencyKey!, sequence);
      this.set(readySetKey!).add(idempotencyKey!);
      this.hash(stateKey!).set(idempotencyKey!, "ready");
    }
    this.set(seenKey!).add(idempotencyKey!);
    return 1;
  }

  private recoverProcessing(keys: string[], args: string[]): number {
    const [processingKey, recoveryKey, recoverySetKey, readyIndexKey, readySetKey, stateKey, payloadKey] = keys;
    const processing = [...this.sortedSet(processingKey!).entries()]
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
      .slice(0, Number(args[0]));
    for (const [id, sequence] of processing) {
      this.sortedSet(processingKey!).delete(id);
      if (this.hash(stateKey!).get(id) === "processing" && this.hash(payloadKey!).has(id)) {
        this.list(recoveryKey!).push(id);
        this.set(recoverySetKey!).add(id);
        this.sortedSet(readyIndexKey!).set(id, sequence);
        this.set(readySetKey!).add(id);
        this.hash(stateKey!).set(id, "recovery");
      } else {
        this.sortedSet(readyIndexKey!).delete(id);
        this.set(readySetKey!).delete(id);
      }
    }
    return this.sortedSet(processingKey!).size;
  }

  private promoteDue(keys: string[], args: string[]): number {
    const [delayedKey, readyKey, readyIndexKey, stateKey, payloadKey, readySetKey, readySequenceKey] = keys;
    const delayed = this.sortedSet(delayedKey!);
    const due = [...delayed.entries()]
      .filter(([, score]) => score <= Number(args[0]))
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
      .slice(0, Number(args[1]));
    for (const [id] of due) {
      delayed.delete(id);
      if (this.hash(stateKey!).get(id) === "delayed" && this.hash(payloadKey!).has(id)) {
        const sequence = Number(this.strings.get(readySequenceKey!) ?? 0) + 1;
        this.strings.set(readySequenceKey!, String(sequence));
        this.list(readyKey!).push(id);
        this.sortedSet(readyIndexKey!).set(id, sequence);
        this.set(readySetKey!).add(id);
        this.hash(stateKey!).set(id, "ready");
      }
    }
    return due.length;
  }

  private dequeue(keys: string[], args: string[]): string[] {
    const [recoveryKey, recoverySetKey, readyKey, readyIndexKey, readySetKey, processingKey, stateKey, payloadKey, processingSequenceKey] = keys;
    const claimed: string[] = [];
    let popped = 0;
    while (claimed.length / 2 < Number(args[0]) && popped < Number(args[1])) {
      let id = this.list(recoveryKey!).shift();
      let expectedState = "recovery";
      if (id !== undefined) {
        this.set(recoverySetKey!).delete(id);
      } else {
        id = this.list(readyKey!).shift();
        expectedState = "ready";
      }
      if (id === undefined) break;
      popped += 1;
      const payload = this.hash(payloadKey!).get(id);
      const indexed = this.sortedSet(readyIndexKey!).has(id);
      if (payload !== undefined && indexed && this.hash(stateKey!).get(id) === expectedState) {
        this.sortedSet(readyIndexKey!).delete(id);
        this.set(readySetKey!).delete(id);
        const sequence = Number(this.strings.get(processingSequenceKey!) ?? 0) + 1;
        this.strings.set(processingSequenceKey!, String(sequence));
        this.sortedSet(processingKey!).set(id, sequence);
        this.hash(stateKey!).set(id, "processing");
        claimed.push(id, payload);
      } else if (id.startsWith("memory-extraction:")) {
        if (indexed && this.hash(stateKey!).get(id) === expectedState) {
          this.sortedSet(readyIndexKey!).delete(id);
          this.set(readySetKey!).delete(id);
        }
      } else {
        const rawPayload = id;
        const invalidId = `invalid:${createHash("sha1").update(rawPayload).digest("hex")}`;
        if (
          this.hash(stateKey!).get(invalidId) !== "processing" ||
          this.hash(payloadKey!).get(invalidId) !== invalidId
        ) {
          this.hash(stateKey!).set(invalidId, "processing");
          this.hash(payloadKey!).set(invalidId, invalidId);
          const sequence = Number(this.strings.get(processingSequenceKey!) ?? 0) + 1;
          this.strings.set(processingSequenceKey!, String(sequence));
          this.sortedSet(processingKey!).set(invalidId, sequence);
          claimed.push(invalidId, rawPayload);
        }
      }
    }
    return claimed;
  }

  private ackProcessed(keys: string[], args: string[]): number {
    const [processingKey, seenKey, readyIndexKey, readySetKey, delayedKey, recoverySetKey, stateKey, payloadKey, memberKey, readyCountKey] = keys;
    const [id, payload] = args;
    if (this.hash(stateKey!).get(id!) !== "processing" || this.hash(payloadKey!).get(id!) !== payload || !this.sortedSet(processingKey!).has(id!)) return 0;
    this.sortedSet(processingKey!).delete(id!);
    this.hash(stateKey!).delete(id!);
    this.hash(payloadKey!).delete(id!);
    this.set(seenKey!).delete(id!);
    this.sortedSet(readyIndexKey!).delete(id!);
    this.set(readySetKey!).delete(id!);
    this.sortedSet(delayedKey!).delete(id!);
    this.set(recoverySetKey!).delete(id!);
    this.hash(memberKey!).delete(payload!);
    this.hash(readyCountKey!).delete(payload!);
    return 1;
  }

  private ackRetry(keys: string[], args: string[]): number {
    const [seenKey, readyKey, readyIndexKey, readySetKey, delayedKey, processingKey, recoverySetKey, stateKey, payloadKey, memberKey, readyCountKey, readySequenceKey] = keys;
    const [id, payload, originalPayload, score, destination] = args;
    if (this.hash(stateKey!).get(id!) !== "processing" || this.hash(payloadKey!).get(id!) !== originalPayload || !this.sortedSet(processingKey!).has(id!)) return 0;
    this.sortedSet(processingKey!).delete(id!);
    this.sortedSet(readyIndexKey!).delete(id!);
    this.set(readySetKey!).delete(id!);
    this.sortedSet(delayedKey!).delete(id!);
    this.set(recoverySetKey!).delete(id!);
    this.hash(memberKey!).delete(originalPayload!);
    this.hash(readyCountKey!).delete(originalPayload!);
    this.hash(payloadKey!).set(id!, payload!);
    if (destination === "delayed") {
      this.sortedSet(delayedKey!).set(id!, Number(score));
      this.hash(stateKey!).set(id!, "delayed");
    } else {
      const sequence = Number(this.strings.get(readySequenceKey!) ?? 0) + 1;
      this.strings.set(readySequenceKey!, String(sequence));
      this.list(readyKey!).push(id!);
      this.sortedSet(readyIndexKey!).set(id!, sequence);
      this.set(readySetKey!).add(id!);
      this.hash(stateKey!).set(id!, "ready");
    }
    this.set(seenKey!).add(id!);
    return 1;
  }

  private ackDeadLetter(keys: string[], args: string[]): number {
    const [deadLetterOrderKey, deadLetterIndexKey, readyIndexKey, seenKey, readySetKey, processingKey, delayedKey, recoverySetKey, stateKey, payloadKey, memberKey, deadLetterSequenceKey, readyCountKey] = keys;
    const [deadLetterId, deadLetterPayload, id, originalPayload] = args;
    if (this.hash(stateKey!).get(id!) !== "processing" || this.hash(payloadKey!).get(id!) !== originalPayload || !this.sortedSet(processingKey!).has(id!)) return 0;
    const sequence = Number(this.strings.get(deadLetterSequenceKey!) ?? 0) + 1;
    this.strings.set(deadLetterSequenceKey!, String(sequence));
    this.sortedSet(deadLetterOrderKey!).set(deadLetterId!, sequence);
    this.hash(deadLetterIndexKey!).set(deadLetterId!, deadLetterPayload!);
    this.hash(stateKey!).delete(id!);
    this.hash(payloadKey!).delete(id!);
    this.set(seenKey!).delete(id!);
    this.sortedSet(readyIndexKey!).delete(id!);
    this.set(readySetKey!).delete(id!);
    this.sortedSet(delayedKey!).delete(id!);
    this.sortedSet(processingKey!).delete(id!);
    this.set(recoverySetKey!).delete(id!);
    this.hash(memberKey!).delete(originalPayload!);
    this.hash(readyCountKey!).delete(originalPayload!);
    return 1;
  }

  private replayDeadLetter(keys: string[], args: string[]): number {
    const [seenKey, readyKey, readyIndexKey, readySetKey, delayedKey, processingKey, recoverySetKey, stateKey, payloadKey, memberKey, deadLetterIndexKey, deadLetterOrderKey, readyCountKey, readySequenceKey] = keys;
    const [id, payload, deadLetterId, deadLetterPayload] = args;
    if (this.hash(deadLetterIndexKey!).get(deadLetterId!) !== deadLetterPayload) return 0;
    const existingPayload = this.hash(payloadKey!).get(id!);
    if (
      this.hash(stateKey!).get(id!) === "processing" &&
      existingPayload !== undefined &&
      this.sortedSet(processingKey!).has(id!)
    ) {
      this.hash(deadLetterIndexKey!).delete(deadLetterId!);
      this.sortedSet(deadLetterOrderKey!).delete(deadLetterId!);
      return 1;
    }
    if (existingPayload) {
      this.hash(memberKey!).delete(existingPayload);
      this.hash(readyCountKey!).delete(existingPayload);
    }
    this.sortedSet(readyIndexKey!).delete(id!);
    this.set(readySetKey!).delete(id!);
    this.sortedSet(delayedKey!).delete(id!);
    this.sortedSet(processingKey!).delete(id!);
    this.set(recoverySetKey!).delete(id!);
    this.hash(payloadKey!).set(id!, payload!);
    const sequence = Number(this.strings.get(readySequenceKey!) ?? 0) + 1;
    this.strings.set(readySequenceKey!, String(sequence));
    this.list(readyKey!).push(id!);
    this.sortedSet(readyIndexKey!).set(id!, sequence);
    this.set(readySetKey!).add(id!);
    this.hash(stateKey!).set(id!, "ready");
    this.set(seenKey!).add(id!);
    this.hash(deadLetterIndexKey!).delete(deadLetterId!);
    this.sortedSet(deadLetterOrderKey!).delete(deadLetterId!);
    return 1;
  }

  private repairDeadLetterOrder(keys: string[], args: string[]): number {
    const [indexKey, orderKey, sequenceKey] = keys;
    const [id, expectedPayload] = args;
    const payload = this.hash(indexKey!).get(id!);
    if (payload === undefined) {
      return this.sortedSet(orderKey!).delete(id!) ? 1 : 0;
    }
    if (payload === expectedPayload && !this.sortedSet(orderKey!).has(id!)) {
      const sequence = Number(this.strings.get(sequenceKey!) ?? 0) + 1;
      this.strings.set(sequenceKey!, String(sequence));
      this.sortedSet(orderKey!).set(id!, sequence);
      return 1;
    }
    return 0;
  }

  private deleteDeadLetter(keys: string[], args: string[]): number {
    const [indexKey, orderKey] = keys;
    const [id, payload] = args;
    if (this.hash(indexKey!).get(id!) !== payload) return 0;
    this.hash(indexKey!).delete(id!);
    this.sortedSet(orderKey!).delete(id!);
    return 1;
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
