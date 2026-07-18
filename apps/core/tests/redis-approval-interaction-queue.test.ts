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

  it("recovers expired leases without reclaiming active work", async () => {
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
    })).resolves.toEqual([expired, active]);
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
        errorCode: "transient_failure",
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
        errorCode: attempt === 5 ? `bad error ${"secret".repeat(1000)}` : "provider_timeout",
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
      job: claimed!, workerId: "worker-a", errorCode: "provider_timeout", at: claimed!.receivedAt,
    });
    const [deadLetter] = await replayQueue.listDeadLetters({ limit: 1 });

    await replayQueue.enqueue(replayJob);
    await expect(replayQueue.replayDeadLetter(deadLetter!.id)).resolves.toBe("replayed");
    await expect(replayQueue.replayDeadLetter(deadLetter!.id)).resolves.toBe("not_found");
    await expect(replayQueue.getCounts()).resolves.toMatchObject({ pending: 1, deadLetter: 0 });

    const deleteClient = new StatefulRedisClient();
    const deleteQueue = createQueue(deleteClient, { maxAttempts: 1, idGenerator: () => "delete-id" });
    await deleteQueue.enqueue(jobFixture({ eventId: "event-delete" }));
    const [deleteClaim] = await claim(deleteQueue);
    await deleteQueue.handleFailure({
      job: deleteClaim!, workerId: "worker-a", errorCode: "provider_timeout", at: deleteClaim!.receivedAt,
    });
    const [toDelete] = await deleteQueue.listDeadLetters({ limit: 1 });
    await expect(deleteQueue.deleteDeadLetter(toDelete!.id)).resolves.toBe("deleted");
    await expect(deleteQueue.deleteDeadLetter(toDelete!.id)).resolves.toBe("not_found");
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

  it("serializes dates as ISO and parses only normalized safe jobs", () => {
    const job = jobFixture();
    const payload = serializeApprovalInteractionJob(job);
    expect(JSON.parse(payload)).toMatchObject({ receivedAt: job.receivedAt.toISOString() });
    expect(parseApprovalInteractionJob(payload)).toEqual(job);
    expect(() => parseApprovalInteractionJob(JSON.stringify({ ...JSON.parse(payload), content: "draft" })))
      .toThrow("Invalid approval interaction job payload");
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

class StatefulRedisClient implements RedisApprovalInteractionQueueClient {
  static nextId = 1;
  readonly id = StatefulRedisClient.nextId++;
  readonly eval = vi.fn(this.runEval.bind(this));
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly sortedSets = new Map<string, Map<string, number>>();
  private readonly sets = new Map<string, Set<string>>();
  private failureMarker: string | undefined;

  async zCard(key: string): Promise<number> {
    return this.sortedSet(key).size;
  }

  async sCard(key: string): Promise<number> {
    return this.set(key).size;
  }

  failNext(marker: string): void {
    this.failureMarker = marker;
  }

  injectReady(prefix: string, id: string, payload: string, receivedAt: number): void {
    this.hash(`${prefix}:members`).set(id, payload);
    this.hash(`${prefix}:member:received-at`).set(id, String(receivedAt));
    this.hash(`${prefix}:state`).set(id, "ready");
    this.sortedSet(`${prefix}:ready`).set(id, receivedAt);
  }

  allStoredValues(): string[] {
    return [
      ...[...this.hashes.values()].flatMap((hash) => [...hash.values()]),
      ...[...this.sortedSets.values()].flatMap((set) => [...set.keys()]),
      ...[...this.sets.values()].flatMap((set) => [...set]),
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
    if (script.includes("approval-interaction:enqueue")) return this.enqueue(options.keys, options.arguments);
    if (script.includes("approval-interaction:claim")) return this.claimJobs(options.keys, options.arguments);
    if (script.includes("approval-interaction:ack-invalid")) return this.ackInvalid(options.keys, options.arguments);
    if (script.includes("approval-interaction:ack")) return this.ack(options.keys, options.arguments);
    if (script.includes("approval-interaction:fail")) return this.fail(options.keys, options.arguments);
    if (script.includes("approval-interaction:get-counts")) {
      return [
        this.sortedSet(options.keys[0]!).size,
        this.sortedSet(options.keys[1]!).size,
        this.sortedSet(options.keys[2]!).size,
        this.set(options.keys[3]!).size,
      ];
    }
    if (script.includes("approval-interaction:list-dlq")) return this.listDlq(options.keys, options.arguments);
    if (script.includes("approval-interaction:find-dlq")) return this.findDlq(options.keys, options.arguments);
    if (script.includes("approval-interaction:replay-dlq")) return this.replayDlq(options.keys, options.arguments);
    if (script.includes("approval-interaction:delete-dlq")) return this.deleteDlq(options.keys, options.arguments);
    throw new Error("unknown approval interaction script");
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
    const [ready, delayed, processing, members, memberReceivedAt, state, owners] = keys;
    const [limitRaw, workerId, nowRaw, leaseRaw] = args;
    const now = Number(nowRaw);
    for (const id of this.sortedIds(processing!, Number.POSITIVE_INFINITY).filter(
      (id) => this.sortedSet(processing!).get(id)! <= now,
    )) {
      if (this.hash(state!).get(id) === "processing" && this.hash(members!).has(id)) {
        this.sortedSet(processing!).delete(id);
        this.hash(owners!).delete(id);
        this.hash(state!).set(id, "ready");
        this.sortedSet(ready!).set(id, Number(this.hash(memberReceivedAt!).get(id)));
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
    const [ready, delayed, processing, members, , state, owners, dlqIndex, dlqOrder, dlqMembers] = keys;
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
    return 1;
  }

  private fail(keys: string[], args: string[]): number {
    const [ready, delayed, processing, members, memberReceivedAt, state, owners, dlqIndex, dlqOrder, dlqMembers] = keys;
    const [id, originalPayload, workerId, failedPayload, destination, dueAt, dlqId, dlqPayload, order] = args;
    if (this.hash(state!).get(id!) !== "processing" ||
        this.hash(owners!).get(id!) !== workerId ||
        this.hash(members!).get(id!) !== originalPayload ||
        !this.sortedSet(processing!).has(id!)) return 0;
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
    }
    this.sortedSet(ready!).delete(id!);
    return 1;
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

  private findDlq(keys: string[], args: string[]): string | null {
    const [index, order, members] = keys;
    const id = args[0]!;
    if (!this.set(members!).has(id) || !this.sortedSet(order!).has(id)) return null;
    return this.hash(index!).get(id) ?? null;
  }

  private replayDlq(keys: string[], args: string[]): number {
    const [ready, delayed, processing, members, memberReceivedAt, state, owners, dlqIndex, dlqOrder, dlqMembers] = keys;
    const [id, payload, score, dlqId, dlqPayload] = args;
    if (!this.set(dlqMembers!).has(dlqId!) ||
        !this.sortedSet(dlqOrder!).has(dlqId!) ||
        this.hash(dlqIndex!).get(dlqId!) !== dlqPayload) return 0;
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
    return 1;
  }

  private deleteDlq(keys: string[], args: string[]): number {
    const [index, order, members] = keys;
    const [id, payload] = args;
    if (!this.set(members!).has(id!) ||
        !this.sortedSet(order!).has(id!) ||
        this.hash(index!).get(id!) !== payload) return 0;
    this.hash(index!).delete(id!);
    this.sortedSet(order!).delete(id!);
    this.set(members!).delete(id!);
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
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
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
      job: first!, workerId: "worker-a", errorCode: "provider_timeout", at: first!.receivedAt,
    });
    const [second] = await claim(queue, {
      now: "2026-07-19T00:00:01.000Z",
      leaseUntil: "2026-07-19T00:01:01.000Z",
    });
    await queue.handleFailure({
      job: second!, workerId: "worker-a", errorCode: "provider_timeout", at: second!.receivedAt,
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
    expect(recoveredClaim).toEqual(replayedClaim);
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
});
