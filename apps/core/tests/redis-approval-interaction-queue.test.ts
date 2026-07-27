import { createHash } from "node:crypto";

import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { normalizeApprovalInteractionJob } from "../src/knowledge-cards/knowledge-card.js";
import {
  createRedisApprovalInteractionQueue,
  parseApprovalInteractionJob,
  serializeApprovalInteractionJob,
  type RedisApprovalInteractionQueueClient,
} from "../src/knowledge-cards/redis-approval-interaction-queue.js";

const BASE_PREFIX = "iris:approval:interactions";
const OUTCOME_RETENTION_SECONDS = 24 * 60 * 60;

describe("Redis approval interaction queue", () => {
  it("deduplicates active jobs and claims FIFO by receivedAt", async () => {
    const client = new StatefulRedisClient();
    const queue = createQueue(client);
    const later = jobFixture({ eventId: "event-later", receivedAt: "2026-07-19T00:00:02.000Z" });
    const earlier = jobFixture({ eventId: "event-earlier", receivedAt: "2026-07-19T00:00:01.000Z" });

    await expect(queue.enqueue(later)).resolves.toBe("enqueued");
    await expect(queue.enqueue(earlier)).resolves.toBe("enqueued");
    await expect(queue.enqueue(earlier)).resolves.toBe("duplicate");

    await expect(claim(queue, { limit: 2 })).resolves.toEqual([earlier, later]);
    await expect(queue.getCounts()).resolves.toEqual({
      pending: 0,
      processing: 2,
      delayed: 0,
      deadLetter: 0,
    });
  });

  it("breaks equal receivedAt ties with Redis binary member ordering", async () => {
    const client = new StatefulRedisClient();
    const queue = createQueue(client);
    const lowercase = jobFixture({ eventId: "event-a" });
    const uppercase = jobFixture({ eventId: "event-A" });
    await queue.enqueue(lowercase);
    await queue.enqueue(uppercase);

    await expect(claim(queue, { limit: 2 })).resolves.toEqual([uppercase, lowercase]);
  });

  it("atomically claims and only permits the owning worker to acknowledge", async () => {
    const client = new StatefulRedisClient();
    const queue = createQueue(client);
    const job = jobFixture();
    await queue.enqueue(job);
    const [claimed] = await claim(queue);

    await expect(queue.acknowledge({ job: claimed!, workerId: "worker-b" })).rejects.toThrow(
      "approval interaction acknowledge transition did not match processing job",
    );
    await expect(queue.getCounts()).resolves.toMatchObject({ processing: 1 });

    await queue.acknowledge({ job: claimed!, workerId: "worker-a" });
    await expect(queue.getCounts()).resolves.toEqual({
      pending: 0,
      processing: 0,
      delayed: 0,
      deadLetter: 0,
    });
    expect(client.eval.mock.calls.every(([script]) => script.includes("approval-interaction:"))).toBe(true);
  });

  it("reads all authoritative counts in one atomic snapshot", async () => {
    const client = new StatefulRedisClient();
    const queue = createQueue(client);
    await queue.enqueue(jobFixture());

    await expect(queue.getCounts()).resolves.toEqual({
      pending: 1,
      processing: 0,
      delayed: 0,
      deadLetter: 0,
    });
    expect(client.eval.mock.calls.at(-1)?.[0]).toContain("approval-interaction:get-counts");
  });

  it("consumes one attempt while recovering expired leases without reclaiming active work", async () => {
    const client = new StatefulRedisClient();
    const queue = createQueue(client);
    const expired = jobFixture({ eventId: "event-expired", receivedAt: "2026-07-19T00:00:00.000Z" });
    const active = jobFixture({ eventId: "event-active", receivedAt: "2026-07-19T00:00:01.000Z" });
    await queue.enqueue(expired);
    await queue.enqueue(active);
    await claim(queue, { limit: 2, leaseUntil: "2026-07-19T00:00:10.000Z" });

    await expect(claim(queue, {
      workerId: "worker-b",
      now: "2026-07-19T00:00:09.999Z",
      leaseUntil: "2026-07-19T00:00:20.000Z",
    })).resolves.toEqual([]);
    await expect(claim(queue, {
      limit: 2,
      workerId: "worker-b",
      now: "2026-07-19T00:00:10.000Z",
      leaseUntil: "2026-07-19T00:00:20.000Z",
    })).resolves.toEqual([
      { ...expired, attempts: 1 },
      { ...active, attempts: 1 },
    ]);
  });

  it("dead-letters a content-free deterministic record after five consecutive lease expiries", async () => {
    const client = new StatefulRedisClient();
    const queue = createQueue(client);
    const queued = normalizeApprovalInteractionJob({
      ...jobFixture({ eventId: "event-lease-expired" }),
      action: "request_revision",
      intentId: "intent-lease-expired",
    });
    await queue.enqueue(queued);

    let [processing] = await claim(queue, {
      now: "2026-07-19T00:00:00.000Z",
      leaseUntil: "2026-07-19T00:00:01.000Z",
    });
    expect(processing).toMatchObject({ attempts: 0 });

    for (let expiry = 1; expiry < 5; expiry += 1) {
      [processing] = await claim(queue, {
        workerId: `worker-${expiry}`,
        now: `2026-07-19T00:00:0${expiry}.000Z`,
        leaseUntil: `2026-07-19T00:00:0${expiry + 1}.000Z`,
      });
      expect(processing).toMatchObject({ attempts: expiry });
      await expect(queue.getCounts()).resolves.toEqual({
        pending: 0,
        processing: 1,
        delayed: 0,
        deadLetter: 0,
      });
    }

    await expect(claim(queue, {
      workerId: "worker-5",
      now: "2026-07-19T00:00:05.000Z",
      leaseUntil: "2026-07-19T00:00:06.000Z",
    })).resolves.toEqual([]);
    await expect(queue.getCounts()).resolves.toEqual({
      pending: 0,
      processing: 0,
      delayed: 0,
      deadLetter: 1,
    });

    const [deadLetter] = await queue.listDeadLetters({ limit: 1 });
    expect(deadLetter).toEqual({
      id: leaseExpiredDeadLetterId(queued.idempotencyKey),
      attempts: 5,
      errorCode: "lease_expired",
      failedAt: new Date("2026-07-19T00:00:05.000Z"),
      replayable: false,
    });
    expect(JSON.stringify(deadLetter)).not.toContain("private revision reason");
    await expect(queue.replayDeadLetter(deadLetter!.id)).resolves.toBe("not_found");
  });

  it("counts one lease expiry and one normal failure as exactly two attempts", async () => {
    const client = new StatefulRedisClient();
    const queue = createQueue(client);
    await queue.enqueue(jobFixture({ eventId: "event-lease-then-failure" }));
    await claim(queue, {
      workerId: "worker-a",
      now: "2026-07-19T00:00:00.000Z",
      leaseUntil: "2026-07-19T00:00:01.000Z",
    });
    const [recovered] = await claim(queue, {
      workerId: "worker-b",
      now: "2026-07-19T00:00:01.000Z",
      leaseUntil: "2026-07-19T00:00:02.000Z",
    });
    expect(recovered).toMatchObject({ attempts: 1 });

    await expect(queue.handleFailure({
      job: recovered!,
      workerId: "worker-b",
      errorCode: "repository_unavailable",
      at: new Date("2026-07-19T00:00:01.000Z"),
    })).resolves.toEqual({ action: "delayed" });
    await expect(claim(queue, {
      workerId: "worker-c",
      now: "2026-07-19T00:00:06.000Z",
      leaseUntil: "2026-07-19T00:00:07.000Z",
    })).resolves.toEqual([expect.objectContaining({ attempts: 2 })]);
  });

  it("uses the exact retry delays and consistent attempt numbering", async () => {
    const client = new StatefulRedisClient();
    const queue = createQueue(client, { maxAttempts: 6 });
    let job = jobFixture();
    await queue.enqueue(job);
    const delays = [1_000, 5_000, 30_000, 120_000, 600_000];
    let atMs = Date.parse("2026-07-19T01:00:00.000Z");

    for (let index = 0; index < delays.length; index += 1) {
      const [claimed] = await claim(queue, {
        now: new Date(atMs).toISOString(),
        leaseUntil: new Date(atMs + 60_000).toISOString(),
      });
      expect(claimed?.attempts).toBe(index);
      await expect(queue.handleFailure({
        job: claimed!,
        workerId: "worker-a",
        errorCode: "repository_unavailable",
        at: new Date(atMs),
      })).resolves.toEqual({ action: "delayed" });
      await expect(claim(queue, {
        now: new Date(atMs + delays[index]! - 1).toISOString(),
        leaseUntil: new Date(atMs + delays[index]! + 60_000).toISOString(),
      })).resolves.toEqual([]);
      atMs += delays[index]!;
      if (index === delays.length - 1) {
        const [retried] = await claim(queue, {
          now: new Date(atMs).toISOString(),
          leaseUntil: new Date(atMs + 60_000).toISOString(),
        });
        expect(retried?.attempts).toBe(index + 1);
        job = retried!;
      }
    }
    expect(job.attempts).toBe(5);
  });

  it("dead-letters the fifth failed attempt and bounds error codes", async () => {
    const client = new StatefulRedisClient();
    const queue = createQueue(client, { idGenerator: () => "terminal-id" });
    let nowMs = Date.parse("2026-07-19T02:00:00.000Z");
    await queue.enqueue(jobFixture());

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const [job] = await claim(queue, {
        now: new Date(nowMs).toISOString(),
        leaseUntil: new Date(nowMs + 60_000).toISOString(),
      });
      const result = await queue.handleFailure({
        job: job!,
        workerId: "worker-a",
        errorCode: attempt === 5
          ? `bad error ${"secret".repeat(1000)}`
          : "retryable_remote_failure",
        at: new Date(nowMs),
      });
      expect(result.action).toBe(attempt === 5 ? "dead_lettered" : "delayed");
      nowMs += [1_000, 5_000, 30_000, 120_000][attempt - 1] ?? 0;
    }

    await expect(queue.getCounts()).resolves.toEqual({
      pending: 0,
      processing: 0,
      delayed: 0,
      deadLetter: 1,
    });
    const [deadLetter] = await queue.listDeadLetters({ limit: 1 });
    expect(deadLetter).toMatchObject({
      id: expect.stringMatching(/^dlq:[a-f0-9]{64}$/u),
      job: { attempts: 5 },
      errorCode: "internal_error",
      replayable: true,
    });
    expect(JSON.stringify(deadLetter)).not.toContain("secret");
  });

  it.each([
    "sk_live_123456",
    "550e8400-e29b-41d4-a716-446655440000",
    "ou_actor_secret",
    "draft_content",
  ])("maps short code-shaped caller text to internal_error: %s", async (errorCode) => {
    const client = new StatefulRedisClient();
    const queue = createQueue(client, { maxAttempts: 1 });
    await queue.enqueue(jobFixture());
    const [claimed] = await claim(queue);

    await queue.handleFailure({
      job: claimed!,
      workerId: "worker-a",
      errorCode,
      at: claimed!.receivedAt,
    });

    const [deadLetter] = await queue.listDeadLetters({ limit: 1 });
    expect(deadLetter).toMatchObject({ errorCode: "internal_error" });
    expect(JSON.stringify(deadLetter)).not.toContain(errorCode);
  });

  it("preserves a finite public worker classification", async () => {
    const client = new StatefulRedisClient();
    const queue = createQueue(client, { maxAttempts: 1 });
    await queue.enqueue(jobFixture());
    const [claimed] = await claim(queue);

    await queue.handleFailure({
      job: claimed!,
      workerId: "worker-a",
      errorCode: "membership_unavailable",
      at: claimed!.receivedAt,
    });

    await expect(queue.listDeadLetters({ limit: 1 })).resolves.toEqual([
      expect.objectContaining({ errorCode: "membership_unavailable" }),
    ]);
  });

  it("quarantines malformed payloads without retaining their contents", async () => {
    const client = new StatefulRedisClient();
    const prefix = `${BASE_PREFIX}:malformed`;
    const payload = JSON.stringify({ content: "private draft body", attempts: 0 });
    client.injectReady(prefix, "malformed-job", payload, Date.parse("2026-07-19T00:00:00.000Z"));
    const queue = createQueue(client, { prefix, idGenerator: () => "malformed-id" });

    await expect(claim(queue)).resolves.toEqual([]);
    await expect(queue.getCounts()).resolves.toEqual({
      pending: 0,
      processing: 0,
      delayed: 0,
      deadLetter: 1,
    });
    const [deadLetter] = await queue.listDeadLetters({ limit: 1 });
    expect(deadLetter).toEqual({
      id: generatedDeadLetterId("malformed-id"),
      payloadDigest: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
      payloadBytes: Buffer.byteLength(payload),
      errorCode: "invalid_queue_payload",
      failedAt: new Date("2026-07-19T00:00:00.000Z"),
      replayable: false,
    });
    expect(client.allStoredValues().join("\n")).not.toContain("private draft body");
  });

  it("replays once, collapses duplicate active replay, and deletes dead letters", async () => {
    const replayClient = new StatefulRedisClient();
    const replayQueue = createQueue(replayClient, { maxAttempts: 1, idGenerator: () => "replay-id" });
    const replayJob = jobFixture({ eventId: "event-replay" });
    await replayQueue.enqueue(replayJob);
    const [claimed] = await claim(replayQueue);
    await replayQueue.handleFailure({
      job: claimed!, workerId: "worker-a", errorCode: "repository_unavailable", at: claimed!.receivedAt,
    });
    const [deadLetter] = await replayQueue.listDeadLetters({ limit: 1 });

    await replayQueue.enqueue(replayJob);
    await expect(replayQueue.replayDeadLetter(deadLetter!.id)).resolves.toBe("replayed");
    await expect(replayQueue.replayDeadLetter(deadLetter!.id)).resolves.toBe("replayed");
    await expect(replayQueue.getCounts()).resolves.toMatchObject({ pending: 1, deadLetter: 0 });

    const deleteClient = new StatefulRedisClient();
    const deleteQueue = createQueue(deleteClient, { maxAttempts: 1, idGenerator: () => "delete-id" });
    await deleteQueue.enqueue(jobFixture({ eventId: "event-delete" }));
    const [deleteClaim] = await claim(deleteQueue);
    await deleteQueue.handleFailure({
      job: deleteClaim!, workerId: "worker-a", errorCode: "repository_unavailable", at: deleteClaim!.receivedAt,
    });
    const [toDelete] = await deleteQueue.listDeadLetters({ limit: 1 });
    await expect(deleteQueue.deleteDeadLetter(toDelete!.id)).resolves.toBe("deleted");
    await expect(deleteQueue.deleteDeadLetter(toDelete!.id)).resolves.toBe("deleted");
    await expect(deleteQueue.getCounts()).resolves.toMatchObject({ pending: 0, deadLetter: 0 });
  });

  it("preserves authoritative state when a Redis transition fails", async () => {
    const client = new StatefulRedisClient();
    const queue = createQueue(client);
    const job = jobFixture();
    await queue.enqueue(job);
    const [claimed] = await claim(queue);
    client.failNext("approval-interaction:ack");

    await expect(queue.acknowledge({ job: claimed!, workerId: "worker-a" })).rejects.toThrow(
      "injected Redis failure",
    );
    await expect(queue.getCounts()).resolves.toEqual({
      pending: 0,
      processing: 1,
      delayed: 0,
      deadLetter: 0,
    });
  });

  it.each([
    ["enqueue", "approval-interaction:enqueue", 2],
    ["enqueue string", "approval-interaction:enqueue", "1"],
  ] as const)("rejects malformed %s replies", async (_label, marker, reply) => {
    const client = new StatefulRedisClient();
    const queue = createQueue(client);
    client.replyNext(marker, reply);

    await expectInvalidRedisReply(queue.enqueue(jobFixture()));
    await expect(queue.getCounts()).resolves.toMatchObject({ pending: 0 });
  });

  it.each([
    ["null", null],
    ["odd array", ["feishu-card:cli_a:event-1"]],
    ["non-string pair", [1, "payload"]],
  ] as const)("rejects malformed claim replies: %s", async (_label, reply) => {
    const client = new StatefulRedisClient();
    const queue = createQueue(client);
    await queue.enqueue(jobFixture());
    client.replyNext("approval-interaction:claim", reply);

    await expectInvalidRedisReply(claim(queue));
    await expect(queue.getCounts()).resolves.toMatchObject({ pending: 1, processing: 0 });
  });

  it("rejects malformed acknowledge and failure mutation replies", async () => {
    const ackClient = new StatefulRedisClient();
    const ackQueue = createQueue(ackClient);
    await ackQueue.enqueue(jobFixture());
    const [ackClaim] = await claim(ackQueue);
    ackClient.replyNext("approval-interaction:ack", 2);
    await expectInvalidRedisReply(
      ackQueue.acknowledge({ job: ackClaim!, workerId: "worker-a" }),
    );
    await expect(ackQueue.getCounts()).resolves.toMatchObject({ processing: 1 });

    const failureClient = new StatefulRedisClient();
    const failureQueue = createQueue(failureClient);
    await failureQueue.enqueue(jobFixture());
    const [failureClaim] = await claim(failureQueue);
    failureClient.replyNext("approval-interaction:fail", 3);
    await expectInvalidRedisReply(failureQueue.handleFailure({
      job: failureClaim!,
      workerId: "worker-a",
      errorCode: "repository_unavailable",
      at: failureClaim!.receivedAt,
    }));
    await expect(failureQueue.getCounts()).resolves.toMatchObject({ processing: 1 });
  });

  it("rejects malformed quarantine and count replies", async () => {
    const quarantineClient = new StatefulRedisClient();
    const prefix = `${BASE_PREFIX}:invalid-replies`;
    quarantineClient.injectReady(
      prefix,
      "malformed-job",
      JSON.stringify({ content: "private draft body" }),
      Date.parse("2026-07-19T00:00:00.000Z"),
    );
    const quarantineQueue = createQueue(quarantineClient, { prefix });
    quarantineClient.replyNext("approval-interaction:ack-invalid", 2);
    await expectInvalidRedisReply(claim(quarantineQueue));
    await expect(quarantineQueue.getCounts()).resolves.toMatchObject({ processing: 1 });

    const countClient = new StatefulRedisClient();
    const countQueue = createQueue(countClient);
    countClient.replyNext("approval-interaction:get-counts", [0, 0, 0, "0"]);
    await expectInvalidRedisReply(countQueue.getCounts());
  });

  it.each([
    ["non-array", null],
    ["odd array", [generatedDeadLetterId("listed")]],
    ["non-string pair", [1, "payload"]],
  ] as const)("rejects malformed DLQ list replies: %s", async (_label, reply) => {
    const client = new StatefulRedisClient();
    const queue = createQueue(client);
    client.replyNext("approval-interaction:list-dlq", reply);

    await expectInvalidRedisReply(queue.listDeadLetters({ limit: 1 }));
  });

  it("rejects a noncanonical DLQ id returned by the list script", async () => {
    const client = new StatefulRedisClient();
    const queue = createQueue(client);
    const id = "not-a-canonical-dlq-id";
    client.replyNext("approval-interaction:list-dlq", [id, deadLetterPayloadFixture(id)]);

    await expectInvalidRedisReply(queue.listDeadLetters({ limit: 1 }));
  });

  it("rejects malformed DLQ find replies for replay and delete", async () => {
    const replayClient = new StatefulRedisClient();
    const replayQueue = createQueue(replayClient);
    replayClient.replyNext("approval-interaction:find-dlq", ["unexpected"]);
    await expectInvalidRedisReply(replayQueue.replayDeadLetter(generatedDeadLetterId("replay")));

    const deleteClient = new StatefulRedisClient();
    const deleteQueue = createQueue(deleteClient);
    deleteClient.replyNext("approval-interaction:find-dlq", ["unexpected"]);
    await expectInvalidRedisReply(deleteQueue.deleteDeadLetter(generatedDeadLetterId("delete")));
  });

  it("rejects a corrupt authoritative DLQ payload during replay", async () => {
    const client = new StatefulRedisClient();
    const prefix = `${BASE_PREFIX}:corrupt-dlq`;
    const id = generatedDeadLetterId("corrupt-authoritative");
    client.injectDeadLetter(prefix, id, JSON.stringify({ content: "private draft body" }));
    const queue = createQueue(client, { prefix });

    await expectInvalidRedisReply(queue.replayDeadLetter(id));
  });

  it("rejects malformed replay and delete mutation replies without changing DLQ authority", async () => {
    const replayClient = new StatefulRedisClient();
    const replayQueue = createQueue(replayClient, { maxAttempts: 1 });
    const replayDeadLetter = await createDeadLetter(replayQueue, jobFixture({ eventId: "bad-replay" }));
    replayClient.replyNext("approval-interaction:replay-dlq", 3);
    await expectInvalidRedisReply(replayQueue.replayDeadLetter(replayDeadLetter.id));
    await expect(replayQueue.getCounts()).resolves.toMatchObject({ pending: 0, deadLetter: 1 });

    const deleteClient = new StatefulRedisClient();
    const deleteQueue = createQueue(deleteClient, { maxAttempts: 1 });
    const deleteDeadLetter = await createDeadLetter(deleteQueue, jobFixture({ eventId: "bad-delete" }));
    deleteClient.replyNext("approval-interaction:delete-dlq", 3);
    await expectInvalidRedisReply(deleteQueue.deleteDeadLetter(deleteDeadLetter.id));
    await expect(deleteQueue.getCounts()).resolves.toMatchObject({ pending: 0, deadLetter: 1 });
  });

  it("retries a terminal failure safely after the Redis reply is lost", async () => {
    const client = new StatefulRedisClient();
    const queue = createQueue(client, { maxAttempts: 1 });
    await queue.enqueue(jobFixture());
    const [claimed] = await claim(queue);
    const failure = {
      job: claimed!,
      workerId: "worker-a",
      errorCode: "repository_unavailable",
      at: claimed!.receivedAt,
    };
    client.loseReplyNext("approval-interaction:fail");

    await expect(queue.handleFailure(failure)).rejects.toThrow("injected Redis response loss");
    await expect(queue.handleFailure(failure)).resolves.toEqual({ action: "dead_lettered" });
    await expect(queue.getCounts()).resolves.toEqual({
      pending: 0,
      processing: 0,
      delayed: 0,
      deadLetter: 1,
    });
    await expect(queue.listDeadLetters({ limit: 10 })).resolves.toHaveLength(1);
  });

  it("retries replay and delete safely after their Redis replies are lost", async () => {
    const replayClient = new StatefulRedisClient();
    const replayQueue = createQueue(replayClient, { maxAttempts: 1 });
    const replayDeadLetter = await createDeadLetter(
      replayQueue,
      jobFixture({ eventId: "lost-replay" }),
    );
    replayClient.loseReplyNext("approval-interaction:replay-dlq");
    await expect(replayQueue.replayDeadLetter(replayDeadLetter.id)).rejects.toThrow(
      "injected Redis response loss",
    );
    await expect(replayQueue.replayDeadLetter(replayDeadLetter.id)).resolves.toBe("replayed");
    await expect(replayQueue.getCounts()).resolves.toEqual({
      pending: 1,
      processing: 0,
      delayed: 0,
      deadLetter: 0,
    });
    await expect(claim(replayQueue, { limit: 10 })).resolves.toHaveLength(1);

    const deleteClient = new StatefulRedisClient();
    const deleteQueue = createQueue(deleteClient, { maxAttempts: 1 });
    const deleteDeadLetter = await createDeadLetter(
      deleteQueue,
      jobFixture({ eventId: "lost-delete" }),
    );
    deleteClient.loseReplyNext("approval-interaction:delete-dlq");
    await expect(deleteQueue.deleteDeadLetter(deleteDeadLetter.id)).rejects.toThrow(
      "injected Redis response loss",
    );
    await expect(deleteQueue.deleteDeadLetter(deleteDeadLetter.id)).resolves.toBe("deleted");
    await expect(deleteQueue.getCounts()).resolves.toEqual({
      pending: 0,
      processing: 0,
      delayed: 0,
      deadLetter: 0,
    });
  });

  it("expires replay and delete outcomes after the bounded retry horizon", async () => {
    const replayClient = new StatefulRedisClient();
    const replayPrefix = `${BASE_PREFIX}:bounded-replay`;
    const replayQueue = createQueue(replayClient, { prefix: replayPrefix, maxAttempts: 1 });
    const replayDeadLetter = await createDeadLetter(
      replayQueue,
      jobFixture({ eventId: "bounded-replay" }),
    );
    const replayMarker = outcomeMarkerKey(replayPrefix, replayDeadLetter.id);

    await expect(replayQueue.replayDeadLetter(replayDeadLetter.id)).resolves.toBe("replayed");
    expect(replayClient.stringValue(replayMarker)).toBe("replayed");
    expect(replayClient.ttlSeconds(replayMarker)).toBeGreaterThan(0);
    expect(replayClient.ttlSeconds(replayMarker)).toBeLessThanOrEqual(OUTCOME_RETENTION_SECONDS);

    replayClient.advanceSeconds(OUTCOME_RETENTION_SECONDS);
    expect(replayClient.ttlSeconds(replayMarker)).toBe(-2);
    await expect(replayQueue.replayDeadLetter(replayDeadLetter.id)).resolves.toBe("not_found");

    const deleteClient = new StatefulRedisClient();
    const deletePrefix = `${BASE_PREFIX}:bounded-delete`;
    const deleteQueue = createQueue(deleteClient, { prefix: deletePrefix, maxAttempts: 1 });
    const deleteDeadLetter = await createDeadLetter(
      deleteQueue,
      jobFixture({ eventId: "bounded-delete" }),
    );
    const deleteMarker = outcomeMarkerKey(deletePrefix, deleteDeadLetter.id);

    await expect(deleteQueue.deleteDeadLetter(deleteDeadLetter.id)).resolves.toBe("deleted");
    expect(deleteClient.stringValue(deleteMarker)).toBe("deleted");
    expect(deleteClient.ttlSeconds(deleteMarker)).toBeGreaterThan(0);
    expect(deleteClient.ttlSeconds(deleteMarker)).toBeLessThanOrEqual(OUTCOME_RETENTION_SECONDS);

    deleteClient.advanceSeconds(OUTCOME_RETENTION_SECONDS);
    expect(deleteClient.ttlSeconds(deleteMarker)).toBe(-2);
    await expect(deleteQueue.deleteDeadLetter(deleteDeadLetter.id)).resolves.toBe("not_found");
  });

  it("clears a stale outcome when the exact DLQ identity is recreated", async () => {
    const client = new StatefulRedisClient();
    const prefix = `${BASE_PREFIX}:recreated-outcome`;
    const queue = createQueue(client, { prefix, maxAttempts: 1 });
    const job = jobFixture({ eventId: "recreated-outcome" });
    const firstDeadLetter = await createDeadLetter(queue, job);
    const marker = outcomeMarkerKey(prefix, firstDeadLetter.id);

    await expect(queue.replayDeadLetter(firstDeadLetter.id)).resolves.toBe("replayed");
    expect(client.stringValue(marker)).toBe("replayed");
    const [replayed] = await claim(queue);
    await expect(queue.handleFailure({
      job: replayed!,
      workerId: "worker-a",
      errorCode: "repository_unavailable",
      at: replayed!.receivedAt,
    })).resolves.toEqual({ action: "dead_lettered" });

    expect(client.stringValue(marker)).toBeUndefined();
    expect(client.ttlSeconds(marker)).toBe(-2);
    await expect(queue.listDeadLetters({ limit: 10 })).resolves.toEqual([
      expect.objectContaining({ id: firstDeadLetter.id }),
    ]);
  });

  it.each([
    "repository_unavailable",
    "sha256:ABCDEF",
    `sha256:${"A".repeat(64)}`,
    `md5:${"a".repeat(64)}`,
  ])("rejects text-shaped invalid-payload digests: %s", async (payloadDigest) => {
    const client = new StatefulRedisClient();
    const prefix = `${BASE_PREFIX}:invalid-digest:${client.id}`;
    const id = generatedDeadLetterId(payloadDigest);
    client.injectDeadLetter(prefix, id, invalidPayloadDeadLetterFixture(id, { payloadDigest }));
    const queue = createQueue(client, { prefix });

    await expectInvalidRedisReply(queue.listDeadLetters({ limit: 1 }));
    await expectInvalidRedisReply(queue.replayDeadLetter(id));
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe invalid-payload byte counts: %s",
    async (payloadBytes) => {
      const client = new StatefulRedisClient();
      const prefix = `${BASE_PREFIX}:invalid-bytes:${client.id}`;
      const id = generatedDeadLetterId(String(payloadBytes));
      client.injectDeadLetter(prefix, id, invalidPayloadDeadLetterFixture(id, { payloadBytes }));
      const queue = createQueue(client, { prefix });

      await expectInvalidRedisReply(queue.listDeadLetters({ limit: 1 }));
      await expectInvalidRedisReply(queue.deleteDeadLetter(id));
    },
  );

  it("preserves processing authority when the wrong worker reports failure", async () => {
    const client = new StatefulRedisClient();
    const queue = createQueue(client);
    await queue.enqueue(jobFixture());
    const [claimed] = await claim(queue);

    await expect(queue.handleFailure({
      job: claimed!,
      workerId: "worker-b",
      errorCode: "repository_unavailable",
      at: claimed!.receivedAt,
    })).rejects.toThrow("failure transition did not match processing job");
    await expect(queue.getCounts()).resolves.toEqual({
      pending: 0,
      processing: 1,
      delayed: 0,
      deadLetter: 0,
    });
    await queue.acknowledge({ job: claimed!, workerId: "worker-a" });
  });

  it("serializes dates as ISO and parses only normalized safe jobs", () => {
    const job = jobFixture();
    const payload = serializeApprovalInteractionJob(job);
    expect(JSON.parse(payload)).toMatchObject({ receivedAt: job.receivedAt.toISOString() });
    expect(parseApprovalInteractionJob(payload)).toEqual(job);
    expect(() => parseApprovalInteractionJob(JSON.stringify({ ...JSON.parse(payload), content: "draft" })))
      .toThrow("Invalid approval interaction job payload");
  });

  it("round-trips a content-free action proposal approval job", () => {
    const job = normalizeApprovalInteractionJob({
      kind: "action_proposal_approval",
      idempotencyKey: "feishu-card:cli_a:event-proposal",
      eventId: "event-proposal",
      appId: "cli_a",
      actorOpenId: "ou_owner",
      chatId: "oc_group",
      messageId: "om_proposal",
      presentationId: "proposal-presentation-1",
      proposalId: "proposal-1",
      requirementId: "requirement-1",
      proposalVersion: 4,
      subjectRevision: 2,
      subjectVersion: 7,
      targetPolicyVersion: 3,
      action: "approve",
      receivedAt: new Date("2026-07-19T00:00:00.000Z"),
      attempts: 0,
    });

    expect(parseApprovalInteractionJob(serializeApprovalInteractionJob(job))).toEqual(job);
    expect(JSON.stringify(job)).not.toMatch(/draft body|knowledge content|evidence text/iu);
  });

  it("round-trips a content-free proactive feedback job", () => {
    const job = normalizeApprovalInteractionJob({
      kind: "proactive_signal_feedback",
      idempotencyKey: "feishu-card:cli_feedback:event-feedback",
      eventId: "event-feedback",
      appId: "cli_feedback",
      actorOpenId: "ou_member",
      chatId: "oc_group",
      messageId: "om_reminder",
      presentationId: "delivery-1",
      deliveryId: "delivery-1",
      candidateIdempotencyKey: "quiet_open_thread:thread-1:2",
      entityVersion: 2,
      action: "irrelevant",
      receivedAt: new Date("2026-07-27T00:00:00.000Z"),
      attempts: 0,
    });

    expect(parseApprovalInteractionJob(serializeApprovalInteractionJob(job))).toEqual(job);
    expect(JSON.stringify(job)).not.toMatch(/reason|intentId|evidence text/iu);
  });

  it("serializes a sensitive action and its replayable DLQ record with only an opaque intent id", async () => {
    const sampleReason = "Private sample reason that must remain in PostgreSQL.";
    const durableIntent = { reason: sampleReason };
    const client = new StatefulRedisClient();
    const queue = createQueue(client, { maxAttempts: 1 });
    const queued = normalizeApprovalInteractionJob({
      ...jobFixture({ eventId: "event-opaque-intent" }),
      action: "request_revision",
      intentId: "0fe3bdb1-b1d1-48f7-8a79-afd2c17e2bf0",
    });

    const serializedJob = serializeApprovalInteractionJob(queued);
    expect(serializedJob).toContain(durableIntent.reason === sampleReason ? queued.intentId! : "unreachable");
    expect(serializedJob).not.toContain(sampleReason);
    expect(serializedJob).not.toContain("rejectionConfirmed");

    await queue.enqueue(queued);
    const [claimed] = await claim(queue);
    await expect(queue.handleFailure({
      job: claimed!,
      workerId: "worker-a",
      errorCode: "repository_unavailable",
      at: new Date("2026-07-19T00:00:01.000Z"),
    })).resolves.toEqual({ action: "dead_lettered" });
    const [deadLetter] = await queue.listDeadLetters({ limit: 1 });
    const serializedDeadLetter = JSON.stringify(deadLetter);
    expect(serializedDeadLetter).toContain(queued.intentId!);
    expect(serializedDeadLetter).not.toContain(sampleReason);
    expect(serializedDeadLetter).not.toContain("rejectionConfirmed");
  });
});

type QueueOptions = {
  prefix?: string;
  maxAttempts?: number;
  idGenerator?: () => string;
};

function createQueue(client: StatefulRedisClient, options: QueueOptions = {}) {
  return createRedisApprovalInteractionQueue({
    client,
    prefix: options.prefix ?? `${BASE_PREFIX}:unit:${client.id}`,
    maxAttempts: options.maxAttempts,
    idGenerator: options.idGenerator,
  });
}

function claim(
  queue: ReturnType<typeof createRedisApprovalInteractionQueue>,
  input: {
    limit?: number;
    workerId?: string;
    now?: string;
    leaseUntil?: string;
  } = {},
) {
  return queue.claimBatch({
    limit: input.limit ?? 1,
    workerId: input.workerId ?? "worker-a",
    now: new Date(input.now ?? "2026-07-19T00:00:00.000Z"),
    leaseUntil: new Date(input.leaseUntil ?? "2026-07-19T00:01:00.000Z"),
  });
}

function jobFixture(input: { eventId?: string; receivedAt?: string } = {}) {
  const eventId = input.eventId ?? "event-1";
  return normalizeApprovalInteractionJob({
    kind: "knowledge_draft_confirmation",
    idempotencyKey: `feishu-card:cli_a:${eventId}`,
    eventId,
    appId: "cli_a",
    actorOpenId: "ou_actor",
    chatId: "oc_group",
    messageId: "om_message",
    presentationId: "presentation-1",
    draftId: "draft-1",
    revisionNumber: 2,
    draftVersion: 3,
    action: "confirm",
    receivedAt: new Date(input.receivedAt ?? "2026-07-19T00:00:00.000Z"),
    attempts: 0,
  });
}

function generatedDeadLetterId(seed: string): string {
  return `dlq:${createHash("sha256").update(seed).digest("hex")}`;
}

function leaseExpiredDeadLetterId(idempotencyKey: string): string {
  return `dlq:lease-expired:${createHash("sha1").update(idempotencyKey).digest("hex")}`;
}

function deadLetterPayloadFixture(id: string): string {
  const job = jobFixture();
  return JSON.stringify({
    id,
    job: JSON.parse(serializeApprovalInteractionJob(job)),
    errorCode: "internal_error",
    failedAt: job.receivedAt.toISOString(),
    replayable: true,
  });
}

function invalidPayloadDeadLetterFixture(
  id: string,
  overrides: { payloadDigest?: string; payloadBytes?: number } = {},
): string {
  return JSON.stringify({
    id,
    payloadDigest: overrides.payloadDigest ?? `sha256:${"a".repeat(64)}`,
    payloadBytes: overrides.payloadBytes ?? 128,
    errorCode: "invalid_queue_payload",
    failedAt: "2026-07-19T00:00:00.000Z",
    replayable: false,
  });
}

function outcomeMarkerKey(prefix: string, id: string): string {
  return `${prefix}:dlq:outcome:${id}`;
}

async function createDeadLetter(
  queue: ReturnType<typeof createRedisApprovalInteractionQueue>,
  job: ReturnType<typeof jobFixture>,
) {
  await queue.enqueue(job);
  const [claimed] = await claim(queue);
  await queue.handleFailure({
    job: claimed!,
    workerId: "worker-a",
    errorCode: "repository_unavailable",
    at: claimed!.receivedAt,
  });
  const [deadLetter] = await queue.listDeadLetters({ limit: 1 });
  if (deadLetter === undefined) throw new Error("expected approval interaction dead letter");
  return deadLetter;
}

async function expectInvalidRedisReply(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "ApprovalInteractionQueueError",
    code: "invalid_redis_reply",
  });
}

class StatefulRedisClient implements RedisApprovalInteractionQueueClient {
  static nextId = 1;
  readonly id = StatefulRedisClient.nextId++;
  readonly eval = vi.fn(this.runEval.bind(this));
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly sortedSets = new Map<string, Map<string, number>>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly strings = new Map<string, { value: string; expiresAt: number }>();
  private nowSeconds = 0;
  private failureMarker: string | undefined;
  private replyMarker: string | undefined;
  private replyValue: number | string | Array<number | string> | null = null;
  private responseLossMarker: string | undefined;

  async zCard(key: string): Promise<number> {
    return this.sortedSet(key).size;
  }

  async sCard(key: string): Promise<number> {
    return this.set(key).size;
  }

  failNext(marker: string): void {
    this.failureMarker = marker;
  }

  replyNext(
    marker: string,
    value: number | string | ReadonlyArray<number | string> | null,
  ): void {
    this.replyMarker = marker;
    this.replyValue = Array.isArray(value)
      ? [...value]
      : value as number | string | null;
  }

  loseReplyNext(marker: string): void {
    this.responseLossMarker = marker;
  }

  injectReady(prefix: string, id: string, payload: string, receivedAt: number): void {
    this.hash(`${prefix}:members`).set(id, payload);
    this.hash(`${prefix}:member:received-at`).set(id, String(receivedAt));
    this.hash(`${prefix}:state`).set(id, "ready");
    this.sortedSet(`${prefix}:ready`).set(id, receivedAt);
  }

  injectDeadLetter(prefix: string, id: string, payload: string): void {
    this.hash(`${prefix}:dlq:index`).set(id, payload);
    this.sortedSet(`${prefix}:dlq:order`).set(id, 1);
    this.set(`${prefix}:dlq:members`).add(id);
  }

  advanceSeconds(seconds: number): void {
    this.nowSeconds += seconds;
  }

  stringValue(key: string): string | undefined {
    return this.string(key)?.value;
  }

  ttlSeconds(key: string): number {
    const value = this.string(key);
    return value === undefined ? -2 : value.expiresAt - this.nowSeconds;
  }

  allStoredValues(): string[] {
    return [
      ...[...this.hashes.values()].flatMap((hash) => [...hash.values()]),
      ...[...this.sortedSets.values()].flatMap((set) => [...set.keys()]),
      ...[...this.sets.values()].flatMap((set) => [...set]),
      ...[...this.strings.keys()].flatMap((key) => {
        const value = this.string(key);
        return value === undefined ? [] : [value.value];
      }),
    ];
  }

  private async runEval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<number | string | Array<number | string> | null> {
    if (this.failureMarker !== undefined && script.includes(this.failureMarker)) {
      this.failureMarker = undefined;
      throw new Error("injected Redis failure");
    }
    if (this.replyMarker !== undefined && script.includes(this.replyMarker)) {
      const reply = this.replyValue;
      this.replyMarker = undefined;
      this.replyValue = null;
      return reply;
    }
    let result: number | string | Array<number | string> | null;
    if (script.includes("approval-interaction:enqueue")) {
      result = this.enqueue(options.keys, options.arguments);
    } else if (script.includes("approval-interaction:claim")) {
      result = this.claimJobs(options.keys, options.arguments);
    } else if (script.includes("approval-interaction:ack-invalid")) {
      result = this.ackInvalid(options.keys, options.arguments);
    } else if (script.includes("approval-interaction:ack")) {
      result = this.ack(options.keys, options.arguments);
    } else if (script.includes("approval-interaction:fail")) {
      result = this.fail(options.keys, options.arguments);
    } else if (script.includes("approval-interaction:get-counts")) {
      result = [
        this.sortedSet(options.keys[0]!).size,
        this.sortedSet(options.keys[1]!).size,
        this.sortedSet(options.keys[2]!).size,
        this.set(options.keys[3]!).size,
      ];
    } else if (script.includes("approval-interaction:list-dlq")) {
      result = this.listDlq(options.keys, options.arguments);
    } else if (script.includes("approval-interaction:find-dlq")) {
      result = this.findDlq(options.keys, options.arguments);
    } else if (script.includes("approval-interaction:replay-dlq")) {
      result = this.replayDlq(options.keys, options.arguments);
    } else if (script.includes("approval-interaction:delete-dlq")) {
      result = this.deleteDlq(options.keys, options.arguments);
    } else {
      throw new Error("unknown approval interaction script");
    }
    if (this.responseLossMarker !== undefined && script.includes(this.responseLossMarker)) {
      this.responseLossMarker = undefined;
      throw new Error("injected Redis response loss");
    }
    return result;
  }

  private enqueue(keys: string[], args: string[]): number {
    const [ready, delayed, processing, members, memberReceivedAt, state] = keys;
    const [id, payload, score] = args;
    if (this.isActive(id!, keys)) return 0;
    this.removeActive(id!, keys);
    this.hash(members!).set(id!, payload!);
    this.hash(memberReceivedAt!).set(id!, score!);
    this.hash(state!).set(id!, "ready");
    this.sortedSet(ready!).set(id!, Number(score));
    this.sortedSet(delayed!).delete(id!);
    this.sortedSet(processing!).delete(id!);
    return 1;
  }

  private claimJobs(keys: string[], args: string[]): string[] {
    const [
      ready,
      delayed,
      processing,
      members,
      memberReceivedAt,
      state,
      owners,
      dlqIndex,
      dlqOrder,
      dlqMembers,
    ] = keys;
    const [limitRaw, workerId, nowRaw, leaseRaw, maxAttemptsRaw, nowIso] = args;
    const now = Number(nowRaw);
    for (const id of this.sortedIds(processing!, Number.POSITIVE_INFINITY).filter(
      (id) => this.sortedSet(processing!).get(id)! <= now,
    )) {
      const payload = this.hash(members!).get(id);
      if (this.hash(state!).get(id) === "processing" && payload !== undefined) {
        this.sortedSet(processing!).delete(id);
        this.hash(owners!).delete(id);
        let parsed: Record<string, unknown> | undefined;
        try {
          const value: unknown = JSON.parse(payload);
          if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            parsed = value as Record<string, unknown>;
          }
        } catch {
          // Invalid payloads are requeued so the normal quarantine path handles them.
        }
        const attempts = parsed?.attempts;
        const maxAttempts = Number(maxAttemptsRaw);
        if (
          typeof attempts === "number" &&
          Number.isInteger(attempts) &&
          attempts >= 0 &&
          attempts < maxAttempts
        ) {
          const nextAttempts = attempts + 1;
          if (nextAttempts >= maxAttempts) {
            this.removeActive(id, keys);
            const deadLetterId = leaseExpiredDeadLetterId(id);
            this.hash(dlqIndex!).set(deadLetterId, JSON.stringify({
              id: deadLetterId,
              attempts: nextAttempts,
              errorCode: "lease_expired",
              failedAt: nowIso,
              replayable: false,
            }));
            this.sortedSet(dlqOrder!).set(deadLetterId, now);
            this.set(dlqMembers!).add(deadLetterId);
          } else {
            this.hash(members!).set(id, JSON.stringify({ ...parsed, attempts: nextAttempts }));
            this.hash(state!).set(id, "ready");
            this.sortedSet(ready!).set(id, Number(this.hash(memberReceivedAt!).get(id)));
          }
        } else {
          this.hash(state!).set(id, "ready");
          this.sortedSet(ready!).set(id, Number(this.hash(memberReceivedAt!).get(id)));
        }
      } else {
        this.removeActive(id, keys);
      }
    }
    for (const id of this.sortedIds(delayed!, now)) {
      this.sortedSet(delayed!).delete(id);
      if (this.hash(state!).get(id) === "delayed" && this.hash(members!).has(id)) {
        this.hash(state!).set(id, "ready");
        this.sortedSet(ready!).set(id, Number(this.hash(memberReceivedAt!).get(id)));
      } else {
        this.removeActive(id, keys);
      }
    }
    const result: string[] = [];
    for (const id of this.sortedIds(ready!, Number.POSITIVE_INFINITY).slice(0, Number(limitRaw))) {
      const payload = this.hash(members!).get(id);
      if (payload === undefined || this.hash(state!).get(id) !== "ready") {
        this.removeActive(id, keys);
        continue;
      }
      this.sortedSet(ready!).delete(id);
      this.sortedSet(processing!).set(id, Number(leaseRaw));
      this.hash(state!).set(id, "processing");
      this.hash(owners!).set(id, workerId!);
      result.push(id, payload);
    }
    return result;
  }

  private ack(keys: string[], args: string[]): number {
    const [ready, delayed, processing, members, , state, owners] = keys;
    const [id, payload, workerId] = args;
    if (this.hash(state!).get(id!) !== "processing" ||
        this.hash(owners!).get(id!) !== workerId ||
        this.hash(members!).get(id!) !== payload ||
        !this.sortedSet(processing!).has(id!)) return 0;
    this.removeActive(id!, keys);
    this.sortedSet(ready!).delete(id!);
    this.sortedSet(delayed!).delete(id!);
    return 1;
  }

  private ackInvalid(keys: string[], args: string[]): number {
    const [ready, delayed, processing, members, , state, owners, dlqIndex, dlqOrder, dlqMembers, outcome] = keys;
    const [id, payload, workerId, dlqId, dlqPayload, order] = args;
    if (this.hash(state!).get(id!) !== "processing" ||
        this.hash(owners!).get(id!) !== workerId ||
        this.hash(members!).get(id!) !== payload ||
        !this.sortedSet(processing!).has(id!)) return 0;
    this.removeActive(id!, keys);
    this.sortedSet(ready!).delete(id!);
    this.sortedSet(delayed!).delete(id!);
    this.hash(dlqIndex!).set(dlqId!, dlqPayload!);
    this.sortedSet(dlqOrder!).set(dlqId!, Number(order));
    this.set(dlqMembers!).add(dlqId!);
    this.strings.delete(outcome!);
    return 1;
  }

  private fail(keys: string[], args: string[]): number {
    const [ready, delayed, processing, members, memberReceivedAt, state, owners, dlqIndex, dlqOrder, dlqMembers, outcome] = keys;
    const [id, originalPayload, workerId, failedPayload, destination, dueAt, dlqId, dlqPayload, order] = args;
    const exact = this.hash(state!).get(id!) === "processing" &&
      this.hash(owners!).get(id!) === workerId &&
      this.hash(members!).get(id!) === originalPayload &&
      this.sortedSet(processing!).has(id!);
    if (exact) {
      this.sortedSet(processing!).delete(id!);
      this.hash(owners!).delete(id!);
      if (destination === "delayed") {
        this.hash(members!).set(id!, failedPayload!);
        this.hash(state!).set(id!, "delayed");
        this.sortedSet(delayed!).set(id!, Number(dueAt));
      } else {
        this.hash(members!).delete(id!);
        this.hash(memberReceivedAt!).delete(id!);
        this.hash(state!).delete(id!);
        this.hash(dlqIndex!).set(dlqId!, dlqPayload!);
        this.sortedSet(dlqOrder!).set(dlqId!, Number(order));
        this.set(dlqMembers!).add(dlqId!);
        this.strings.delete(outcome!);
      }
      this.sortedSet(ready!).delete(id!);
      return 1;
    }
    if (destination === "delayed" &&
        this.hash(state!).get(id!) === "delayed" &&
        this.hash(members!).get(id!) === failedPayload &&
        this.sortedSet(delayed!).has(id!)) return 2;
    if (destination === "dead_letter" &&
        this.set(dlqMembers!).has(dlqId!) &&
        this.hash(dlqIndex!).get(dlqId!) === dlqPayload &&
        this.sortedSet(dlqOrder!).has(dlqId!)) return 2;
    return 0;
  }

  private listDlq(keys: string[], args: string[]): string[] {
    const [index, order, members] = keys;
    const result: string[] = [];
    for (const id of this.sortedIds(order!, Number.POSITIVE_INFINITY)) {
      const payload = this.hash(index!).get(id);
      if (payload !== undefined && this.set(members!).has(id)) {
        result.push(id, payload);
        if (result.length / 2 >= Number(args[0])) break;
      }
    }
    return result;
  }

  private findDlq(keys: string[], args: string[]): Array<number | string> {
    const [index, order, members, outcomeKey] = keys;
    const id = args[0]!;
    if (this.set(members!).has(id) && this.sortedSet(order!).has(id)) {
      const payload = this.hash(index!).get(id);
      if (payload !== undefined) return [1, payload];
    }
    const outcome = this.string(outcomeKey!)?.value;
    if (outcome === "replayed") return [2];
    if (outcome === "deleted") return [3];
    return [0];
  }

  private replayDlq(keys: string[], args: string[]): number {
    const [ready, delayed, processing, members, memberReceivedAt, state, owners, dlqIndex, dlqOrder, dlqMembers, outcomeKey] = keys;
    const [id, payload, score, dlqId, dlqPayload, retentionSeconds] = args;
    if (!this.set(dlqMembers!).has(dlqId!) ||
        !this.sortedSet(dlqOrder!).has(dlqId!) ||
        this.hash(dlqIndex!).get(dlqId!) !== dlqPayload) {
      return this.string(outcomeKey!)?.value === "replayed" ? 2 : 0;
    }
    if (!this.isActive(id!, keys)) {
      this.removeActive(id!, keys);
      this.hash(members!).set(id!, payload!);
      this.hash(memberReceivedAt!).set(id!, score!);
      this.hash(state!).set(id!, "ready");
      this.sortedSet(ready!).set(id!, Number(score));
      this.sortedSet(delayed!).delete(id!);
      this.sortedSet(processing!).delete(id!);
      this.hash(owners!).delete(id!);
    }
    this.hash(dlqIndex!).delete(dlqId!);
    this.sortedSet(dlqOrder!).delete(dlqId!);
    this.set(dlqMembers!).delete(dlqId!);
    this.strings.set(outcomeKey!, {
      value: "replayed",
      expiresAt: this.nowSeconds + Number(retentionSeconds),
    });
    return 1;
  }

  private deleteDlq(keys: string[], args: string[]): number {
    const [index, order, members, outcomeKey] = keys;
    const [id, payload, retentionSeconds] = args;
    if (!this.set(members!).has(id!) ||
        !this.sortedSet(order!).has(id!) ||
        this.hash(index!).get(id!) !== payload) {
      return this.string(outcomeKey!)?.value === "deleted" ? 2 : 0;
    }
    this.hash(index!).delete(id!);
    this.sortedSet(order!).delete(id!);
    this.set(members!).delete(id!);
    this.strings.set(outcomeKey!, {
      value: "deleted",
      expiresAt: this.nowSeconds + Number(retentionSeconds),
    });
    return 1;
  }

  private isActive(id: string, keys: string[]): boolean {
    const [ready, delayed, processing, members, , state] = keys;
    const current = this.hash(state!).get(id);
    return this.hash(members!).has(id) && (
      (current === "ready" && this.sortedSet(ready!).has(id)) ||
      (current === "delayed" && this.sortedSet(delayed!).has(id)) ||
      (current === "processing" && this.sortedSet(processing!).has(id))
    );
  }

  private removeActive(id: string, keys: string[]): void {
    const [ready, delayed, processing, members, memberReceivedAt, state, owners] = keys;
    this.sortedSet(ready!).delete(id);
    this.sortedSet(delayed!).delete(id);
    this.sortedSet(processing!).delete(id);
    this.hash(members!).delete(id);
    this.hash(memberReceivedAt!).delete(id);
    this.hash(state!).delete(id);
    this.hash(owners!).delete(id);
  }

  private sortedIds(key: string, maxScore: number): string[] {
    return [...this.sortedSet(key).entries()]
      .filter(([, score]) => score <= maxScore)
      .sort((left, right) => left[1] - right[1] ||
        Buffer.compare(Buffer.from(left[0], "utf8"), Buffer.from(right[0], "utf8")))
      .map(([id]) => id);
  }

  private hash(key: string): Map<string, string> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    return this.hashes.get(key)!;
  }

  private sortedSet(key: string): Map<string, number> {
    if (!this.sortedSets.has(key)) this.sortedSets.set(key, new Map());
    return this.sortedSets.get(key)!;
  }

  private set(key: string): Set<string> {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    return this.sets.get(key)!;
  }

  private string(key: string): { value: string; expiresAt: number } | undefined {
    const value = this.strings.get(key);
    if (value !== undefined && value.expiresAt <= this.nowSeconds) {
      this.strings.delete(key);
      return undefined;
    }
    return value;
  }
}

class ExecuteThenThrowRedisClient implements RedisApprovalInteractionQueueClient {
  private responseLossMarker: string | undefined;

  constructor(private readonly delegate: RedisApprovalInteractionQueueClient) {}

  loseReplyNext(marker: string): void {
    this.responseLossMarker = marker;
  }

  async eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<number | string | Array<number | string> | null> {
    const result = await this.delegate.eval(script, options);
    if (this.responseLossMarker !== undefined && script.includes(this.responseLossMarker)) {
      this.responseLossMarker = undefined;
      throw new Error("injected Redis response loss");
    }
    return result;
  }
}

const redisUrl = process.env.IRIS_TEST_REDIS_URL?.trim();
const runIfRedis = redisUrl ? describe : describe.skip;

runIfRedis("Redis approval interaction queue with live Redis", () => {
  const prefix = `${BASE_PREFIX}:live:${process.pid}:${Date.now()}`;
  let client: ReturnType<typeof createClient> | undefined;

  beforeAll(async () => {
    client = createClient({ url: redisUrl });
    await client.connect();
  });

  afterAll(async () => {
    if (client === undefined) return;
    const keys: string[] = [];
    for await (const page of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) {
      keys.push(...page);
    }
    if (keys.length > 0) await client.del(keys);
    await client.quit();
  });

  it("executes claim, retry, recovery, and DLQ transitions atomically", async () => {
    const queue = createRedisApprovalInteractionQueue({
      client: client as unknown as RedisApprovalInteractionQueueClient,
      prefix,
      maxAttempts: 2,
      idGenerator: () => "live-dlq",
    });
    const job = jobFixture({ eventId: "event-live" });
    await queue.enqueue(job);
    const [first] = await claim(queue);
    await queue.handleFailure({
      job: first!, workerId: "worker-a", errorCode: "retryable_remote_failure", at: first!.receivedAt,
    });
    const [second] = await claim(queue, {
      now: "2026-07-19T00:00:01.000Z",
      leaseUntil: "2026-07-19T00:01:01.000Z",
    });
    await queue.handleFailure({
      job: second!, workerId: "worker-a", errorCode: "retryable_remote_failure", at: second!.receivedAt,
    });

    expect(await queue.getCounts()).toEqual({ pending: 0, processing: 0, delayed: 0, deadLetter: 1 });
    const [deadLetter] = await queue.listDeadLetters({ limit: 1 });
    expect(deadLetter).toMatchObject({ job: { attempts: 2 }, replayable: true });
    await expect(queue.replayDeadLetter(deadLetter!.id)).resolves.toBe("replayed");
    await expect(queue.getCounts()).resolves.toMatchObject({ pending: 1, deadLetter: 0 });

    const [replayedClaim] = await claim(queue, {
      workerId: "worker-b",
      now: "2026-07-19T00:00:02.000Z",
      leaseUntil: "2026-07-19T00:00:03.000Z",
    });
    expect(replayedClaim).toMatchObject({ attempts: 0 });
    const [recoveredClaim] = await claim(queue, {
      workerId: "worker-c",
      now: "2026-07-19T00:00:03.000Z",
      leaseUntil: "2026-07-19T00:00:04.000Z",
    });
    expect(recoveredClaim).toEqual({ ...replayedClaim, attempts: 1 });
    await queue.acknowledge({ job: recoveredClaim!, workerId: "worker-c" });

    const malformedPayload = JSON.stringify({ content: "private draft body", attempts: 0 });
    await client!.hSet(`${prefix}:members`, "malformed-live", malformedPayload);
    await client!.hSet(
      `${prefix}:member:received-at`,
      "malformed-live",
      String(Date.parse("2026-07-19T00:00:04.000Z")),
    );
    await client!.hSet(`${prefix}:state`, "malformed-live", "ready");
    await client!.zAdd(`${prefix}:ready`, {
      score: Date.parse("2026-07-19T00:00:04.000Z"),
      value: "malformed-live",
    });
    await expect(claim(queue, {
      workerId: "worker-c",
      now: "2026-07-19T00:00:04.000Z",
      leaseUntil: "2026-07-19T00:00:05.000Z",
    })).resolves.toEqual([]);
    const [invalidDeadLetter] = await queue.listDeadLetters({ limit: 1 });
    expect(invalidDeadLetter).toMatchObject({
      errorCode: "invalid_queue_payload",
      replayable: false,
    });
    expect(JSON.stringify(invalidDeadLetter)).not.toContain("private draft body");
    await expect(queue.deleteDeadLetter(invalidDeadLetter!.id)).resolves.toBe("deleted");
    await expect(queue.getCounts()).resolves.toEqual({
      pending: 0,
      processing: 0,
      delayed: 0,
      deadLetter: 0,
    });
  });

  it("consumes five consecutive expired leases and atomically reaches a content-free DLQ", async () => {
    const leasePrefix = `${prefix}:lease-expiry`;
    const queue = createRedisApprovalInteractionQueue({
      client: client as unknown as RedisApprovalInteractionQueueClient,
      prefix: leasePrefix,
    });
    const queued = normalizeApprovalInteractionJob({
      ...jobFixture({ eventId: "event-live-lease-expired" }),
      action: "request_revision",
      reason: "private live revision reason",
    });
    await queue.enqueue(queued);

    let [processing] = await claim(queue, {
      now: "2026-07-19T00:00:00.000Z",
      leaseUntil: "2026-07-19T00:00:01.000Z",
    });
    expect(processing).toMatchObject({ attempts: 0 });

    for (let expiry = 1; expiry < 5; expiry += 1) {
      [processing] = await claim(queue, {
        workerId: `live-worker-${expiry}`,
        now: `2026-07-19T00:00:0${expiry}.000Z`,
        leaseUntil: `2026-07-19T00:00:0${expiry + 1}.000Z`,
      });
      expect(processing).toMatchObject({ attempts: expiry });
      await expect(queue.getCounts()).resolves.toEqual({
        pending: 0,
        processing: 1,
        delayed: 0,
        deadLetter: 0,
      });
    }

    await expect(claim(queue, {
      workerId: "live-worker-5",
      now: "2026-07-19T00:00:05.000Z",
      leaseUntil: "2026-07-19T00:00:06.000Z",
    })).resolves.toEqual([]);
    await expect(queue.getCounts()).resolves.toEqual({
      pending: 0,
      processing: 0,
      delayed: 0,
      deadLetter: 1,
    });
    const [deadLetter] = await queue.listDeadLetters({ limit: 1 });
    expect(deadLetter).toEqual({
      id: leaseExpiredDeadLetterId(queued.idempotencyKey),
      attempts: 5,
      errorCode: "lease_expired",
      failedAt: new Date("2026-07-19T00:00:05.000Z"),
      replayable: false,
    });
    expect(JSON.stringify(deadLetter)).not.toContain("private live revision reason");
  });

  it("retries committed terminal, replay, and delete scripts after response loss", async () => {
    const adapter = new ExecuteThenThrowRedisClient(
      client as unknown as RedisApprovalInteractionQueueClient,
    );
    const responseLossPrefix = `${prefix}:response-loss`;
    const queue = createRedisApprovalInteractionQueue({
      client: adapter,
      prefix: responseLossPrefix,
      maxAttempts: 1,
    });
    const replayJob = jobFixture({ eventId: "event-live-lost-replay" });
    await queue.enqueue(replayJob);
    const [replayClaim] = await claim(queue);
    const terminalFailure = {
      job: replayClaim!,
      workerId: "worker-a",
      errorCode: "repository_unavailable",
      at: replayClaim!.receivedAt,
    };
    adapter.loseReplyNext("approval-interaction:fail");
    await expect(queue.handleFailure(terminalFailure)).rejects.toThrow(
      "injected Redis response loss",
    );
    await expect(queue.handleFailure(terminalFailure)).resolves.toEqual({
      action: "dead_lettered",
    });
    const [replayDeadLetter] = await queue.listDeadLetters({ limit: 1 });
    adapter.loseReplyNext("approval-interaction:replay-dlq");
    await expect(queue.replayDeadLetter(replayDeadLetter!.id)).rejects.toThrow(
      "injected Redis response loss",
    );
    await expect(queue.replayDeadLetter(replayDeadLetter!.id)).resolves.toBe("replayed");
    const replayOutcomeTtl = await client!.ttl(
      outcomeMarkerKey(responseLossPrefix, replayDeadLetter!.id),
    );
    expect(replayOutcomeTtl).toBeGreaterThan(0);
    expect(replayOutcomeTtl).toBeLessThanOrEqual(OUTCOME_RETENTION_SECONDS);
    await expect(queue.getCounts()).resolves.toMatchObject({ pending: 1, deadLetter: 0 });
    const [replayed] = await claim(queue, {
      now: "2026-07-19T00:00:01.000Z",
      leaseUntil: "2026-07-19T00:00:02.000Z",
    });
    await queue.acknowledge({ job: replayed!, workerId: "worker-a" });

    const deleteJob = jobFixture({ eventId: "event-live-lost-delete" });
    await queue.enqueue(deleteJob);
    const [deleteClaim] = await claim(queue);
    await queue.handleFailure({
      job: deleteClaim!,
      workerId: "worker-a",
      errorCode: "repository_unavailable",
      at: deleteClaim!.receivedAt,
    });
    const [deleteDeadLetter] = await queue.listDeadLetters({ limit: 1 });
    adapter.loseReplyNext("approval-interaction:delete-dlq");
    await expect(queue.deleteDeadLetter(deleteDeadLetter!.id)).rejects.toThrow(
      "injected Redis response loss",
    );
    await expect(queue.deleteDeadLetter(deleteDeadLetter!.id)).resolves.toBe("deleted");
    const deleteOutcomeTtl = await client!.ttl(
      outcomeMarkerKey(responseLossPrefix, deleteDeadLetter!.id),
    );
    expect(deleteOutcomeTtl).toBeGreaterThan(0);
    expect(deleteOutcomeTtl).toBeLessThanOrEqual(OUTCOME_RETENTION_SECONDS);
    await expect(queue.getCounts()).resolves.toEqual({
      pending: 0,
      processing: 0,
      delayed: 0,
      deadLetter: 0,
    });
  });
});
