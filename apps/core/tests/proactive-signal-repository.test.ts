import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { defaultMigrationsDir } from "../src/database/migrate.js";
import {
  createPostgresProactiveSignalRepository,
  type ProactiveSignalDataSource,
} from "../src/proactive-signals/proactive-signal-repository.js";
import type { ProactiveSignalCandidate } from "../src/proactive-signals/proactive-signal-planner.js";

describe("proactive signal persistence", () => {
  it("defines version-bound candidate facts, evidence, events, and append-only event guards", async () => {
    const sql = await readFile(
      join(defaultMigrationsDir(), "0037_proactive_signal_candidates.sql"),
      "utf8",
    );
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();

    expect(normalized).toContain("create table proactive_signal_candidates");
    expect(normalized).toContain("idempotency_key text primary key");
    expect(normalized).toContain("entity_version bigint not null check (entity_version >= 1)");
    expect(normalized).toContain("status text not null check (status in ('pending', 'dismissed', 'superseded'))");
    expect(normalized).toContain("create table proactive_signal_candidate_evidence");
    expect(normalized).toContain("conversation_message_id text not null");
    expect(normalized).toContain("create table proactive_signal_candidate_events");
    expect(normalized).toContain("proactive_signal_candidate_events_append_only");
    expect(normalized).not.toMatch(/raw_(message|payload|response)|message_text/u);
  });

  it("defines a default-off proactive delivery outbox without message content", async () => {
    const sql = await readFile(
      join(defaultMigrationsDir(), "0038_proactive_signal_delivery_outbox.sql"),
      "utf8",
    );
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();

    expect(normalized).toContain("create table proactive_signal_delivery_outbox");
    expect(normalized).toContain("candidate_idempotency_key text not null");
    expect(normalized).toContain("delivery_channel text not null check (delivery_channel in ('feishu_group_card'))");
    expect(normalized).toContain("status text not null check (status in ('pending', 'processing', 'sent', 'failed', 'cancelled'))");
    expect(normalized).toContain("lease_worker_id text");
    expect(normalized).toContain("lease_until timestamptz");
    expect(normalized).toContain("sent_message_id text");
    expect(normalized).toContain("unique (candidate_idempotency_key, delivery_channel)");
    expect(normalized).toContain("proactive_signal_delivery_events_append_only");
    expect(normalized).not.toMatch(/message_body|raw_(message|payload|response)|card_json/u);
  });

  it("records only new version-bound candidates and creates append-only creation events", async () => {
    const client = createClient([
      { rows: [{ idempotency_key: "quiet_open_thread:thread-a:1" }] },
      { rows: [] },
      { rows: [] },
    ]);
    const dataSource = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
    };
    const repository = createPostgresProactiveSignalRepository({
      dataSource: dataSource as unknown as ProactiveSignalDataSource,
    });

    const result = await repository.recordCandidates({
      signals: [signal({ idempotencyKey: "quiet_open_thread:thread-a:1" })],
      now: new Date("2026-07-23T10:00:00.000Z"),
    });

    expect(result).toEqual({
      recordedCount: 1,
      existingCount: 0,
      recordedKeys: ["quiet_open_thread:thread-a:1"],
    });
    expect(client.query).toHaveBeenCalledWith("begin");
    expect(client.query).toHaveBeenCalledWith("commit");
    const sql = client.query.mock.calls.map(([statement]) => String(statement).toLowerCase()).join("\n");
    expect(sql).toContain("insert into proactive_signal_candidates");
    expect(sql).toContain("on conflict (idempotency_key) do nothing");
    expect(sql).toContain("insert into proactive_signal_candidate_events");
    expect(sql).toContain("insert into proactive_signal_candidate_evidence");
    expect(sql).not.toContain("raw message text");
  });

  it("uses non-overlapping SQL placeholders when recording multiple new candidates", async () => {
    const client = createClient([{ rows: [
      { idempotency_key: "quiet_open_thread:thread-a:1" },
      { idempotency_key: "overdue_action:action-a:1" },
    ] }, { rows: [] }, { rows: [] }]);
    const repository = createPostgresProactiveSignalRepository({
      dataSource: {
        connect: vi.fn(async () => client),
        query: vi.fn(),
      } as unknown as ProactiveSignalDataSource,
    });

    await repository.recordCandidates({
      signals: [
        signal({ idempotencyKey: "quiet_open_thread:thread-a:1" }),
        signal({
          idempotencyKey: "overdue_action:action-a:1",
          kind: "overdue_action",
          priority: "high",
          entityId: "action-a",
          reasonCode: "action_due_at_elapsed",
          suggestedMode: "ask_for_status",
          evidenceMessageIds: ["message-c"],
        }),
      ],
      now: new Date("2026-07-23T10:00:00.000Z"),
    });

    for (const [statement, values] of client.query.mock.calls) {
      if (String(statement).toLowerCase().includes("insert into proactive_signal")) {
        expectPlaceholdersToBeUnique(String(statement), values as unknown[]);
      }
    }
  });

  it("reports existing candidates without duplicating evidence or events", async () => {
    const client = createClient([{ rows: [] }]);
    const repository = createPostgresProactiveSignalRepository({
      dataSource: {
        connect: vi.fn(async () => client),
        query: vi.fn(),
      } as unknown as ProactiveSignalDataSource,
    });

    const result = await repository.recordCandidates({
      signals: [signal({ idempotencyKey: "overdue_action:action-a:2" })],
      now: new Date("2026-07-23T10:00:00.000Z"),
    });

    expect(result).toEqual({
      recordedCount: 0,
      existingCount: 1,
      recordedKeys: [],
    });
    expect(client.query.mock.calls).toHaveLength(3);
  });

  it("lists pending candidates for one group without selecting raw message content", async () => {
    const dataSource = {
      query: vi.fn(async (_statement: string, _values?: unknown[]) => ({ rows: [
        {
          idempotency_key: "quiet_open_thread:thread-a:1",
          group_id: "group-a",
          kind: "quiet_open_thread",
          priority: "medium",
          entity_type: "thread",
          entity_id: "thread-a",
          entity_version: "1",
          reason_code: "thread_quiet_threshold_elapsed",
          suggested_mode: "ask_for_thread_update",
          status: "pending",
          last_relevant_at: new Date("2026-07-23T08:00:00.000Z"),
          created_at: new Date("2026-07-23T10:00:00.000Z"),
          updated_at: new Date("2026-07-23T10:00:00.000Z"),
          evidence_message_ids: ["message-a"],
        },
      ] })),
      connect: vi.fn(),
    };
    const repository = createPostgresProactiveSignalRepository({
      dataSource: dataSource as unknown as ProactiveSignalDataSource,
    });

    const candidates = await repository.listPendingCandidates({ groupId: "group-a", limit: 10 });

    expect(candidates).toEqual([
      expect.objectContaining({
        idempotencyKey: "quiet_open_thread:thread-a:1",
        entityId: "thread-a",
        evidenceMessageIds: ["message-a"],
      }),
    ]);
    const sql = dataSource.query.mock.calls.map(([statement]) => String(statement).toLowerCase()).join("\n");
    expect(sql).toContain("candidate.group_id = $1");
    expect(sql).toContain("candidate.status = 'pending'");
    expect(sql).not.toContain("conversation_messages.text");
  });

  it("dismisses a pending candidate with an append-only event and no content payload", async () => {
    const client = createClient([{ rows: [{ idempotency_key: "quiet_open_thread:thread-a:1" }] }, { rows: [] }]);
    const repository = createPostgresProactiveSignalRepository({
      dataSource: {
        connect: vi.fn(async () => client),
        query: vi.fn(),
      } as unknown as ProactiveSignalDataSource,
    });

    const result = await repository.dismissCandidate({
      idempotencyKey: "quiet_open_thread:thread-a:1",
      groupId: "group-a",
      operatorHint: "operator-a",
      now: new Date("2026-07-23T10:00:00.000Z"),
    });

    expect(result).toEqual({ status: "dismissed" });
    const sql = client.query.mock.calls.map(([statement]) => String(statement).toLowerCase()).join("\n");
    expect(sql).toContain("update proactive_signal_candidates");
    expect(sql).toContain("status = 'dismissed'");
    expect(sql).toContain("insert into proactive_signal_candidate_events");
    expect(sql).not.toContain("operator-a");
  });

  it("approves one pending candidate into the delivery outbox idempotently", async () => {
    const client = createClient([{ rows: [{ id: "delivery-a" }] }, { rows: [] }]);
    const repository = createPostgresProactiveSignalRepository({
      dataSource: {
        connect: vi.fn(async () => client),
        query: vi.fn(),
      } as unknown as ProactiveSignalDataSource,
    });

    const result = await repository.approveCandidateForDelivery({
      idempotencyKey: "quiet_open_thread:thread-a:1",
      groupId: "group-a",
      operatorHint: "operator-a",
      now: new Date("2026-07-23T10:00:00.000Z"),
    });

    expect(result).toEqual({ status: "queued", deliveryId: "delivery-a" });
    const sql = client.query.mock.calls.map(([statement]) => String(statement).toLowerCase()).join("\n");
    expect(sql).toContain("insert into proactive_signal_delivery_outbox");
    expect(sql).toContain("on conflict (candidate_idempotency_key, delivery_channel) do nothing");
    expect(sql).toContain("insert into proactive_signal_delivery_events");
    expect(sql).not.toContain("operator-a");
  });

  it("derives bounded delivery ids from long candidate keys", async () => {
    const longKey = "quiet_open_thread:" + "x".repeat(480) + ":1";
    const client = createClient([{ rows: [{ id: "proactive-delivery-expected" }] }, { rows: [] }]);
    const repository = createPostgresProactiveSignalRepository({
      dataSource: {
        connect: vi.fn(async () => client),
        query: vi.fn(),
      } as unknown as ProactiveSignalDataSource,
    });

    await repository.approveCandidateForDelivery({
      idempotencyKey: longKey,
      groupId: "group-a",
      operatorHint: "operator-a",
      now: new Date("2026-07-23T10:00:00.000Z"),
    });

    const insertCall = client.query.mock.calls.find(([statement]) =>
      String(statement).toLowerCase().includes("insert into proactive_signal_delivery_outbox")
    );
    expect(String((insertCall?.[1] as unknown[])[2])).toMatch(/^proactive-delivery:[0-9a-f]{64}$/u);
  });

  it("claims one ready delivery with a bounded lease and candidate join", async () => {
    const dataSource = {
      query: vi.fn(async (_statement: string, _values?: unknown[]) => ({ rows: [
        {
          id: "delivery-a",
          candidate_idempotency_key: "quiet_open_thread:thread-a:1",
          group_id: "group-a",
          status: "processing",
          attempt_count: 2,
        },
      ] })),
      connect: vi.fn(),
    };
    const repository = createPostgresProactiveSignalRepository({
      dataSource: dataSource as unknown as ProactiveSignalDataSource,
    });

    const claim = await repository.claimProactiveSignalDelivery({
      workerId: "worker-a",
      at: new Date("2026-07-23T10:00:00.000Z"),
      leaseUntil: new Date("2026-07-23T10:00:30.000Z"),
    });

    expect(claim).toEqual({
      delivery: {
        id: "delivery-a",
        candidateIdempotencyKey: "quiet_open_thread:thread-a:1",
        groupId: "group-a",
        status: "processing",
        attemptCount: 2,
      },
      workerId: "worker-a",
      leaseUntil: new Date("2026-07-23T10:00:30.000Z"),
      attempts: 2,
    });
    const sql = dataSource.query.mock.calls.map(([statement]) => String(statement).toLowerCase()).join("\n");
    expect(sql).toContain("for update skip locked");
    expect(sql).toContain("candidate.status = 'pending'");
    expect(sql).toContain("lease_worker_id = $1");
  });

  it("loads delivery context without selecting raw message text", async () => {
    const dataSource = {
      query: vi.fn(async (_statement: string, _values?: unknown[]) => ({ rows: [
        {
          id: "delivery-a",
          candidate_idempotency_key: "quiet_open_thread:thread-a:1",
          delivery_group_id: "group-a",
          delivery_status: "processing",
          attempt_count: 1,
          idempotency_key: "quiet_open_thread:thread-a:1",
          group_id: "group-a",
          kind: "quiet_open_thread",
          priority: "medium",
          entity_type: "thread",
          entity_id: "thread-a",
          entity_version: "1",
          reason_code: "thread_quiet_threshold_elapsed",
          suggested_mode: "ask_for_thread_update",
          status: "pending",
          last_relevant_at: new Date("2026-07-23T08:00:00.000Z"),
          created_at: new Date("2026-07-23T10:00:00.000Z"),
          updated_at: new Date("2026-07-23T10:00:00.000Z"),
          evidence_message_ids: ["message-a"],
        },
      ] })),
      connect: vi.fn(),
    };
    const repository = createPostgresProactiveSignalRepository({
      dataSource: dataSource as unknown as ProactiveSignalDataSource,
    });

    const context = await repository.getProactiveSignalDeliveryContext("delivery-a");

    expect(context).toEqual(expect.objectContaining({
      delivery: expect.objectContaining({ id: "delivery-a", status: "processing" }),
      candidate: expect.objectContaining({ idempotencyKey: "quiet_open_thread:thread-a:1" }),
    }));
    const sql = dataSource.query.mock.calls.map(([statement]) => String(statement).toLowerCase()).join("\n");
    expect(sql).not.toContain("conversation_messages.text");
    expect(sql).not.toContain("message_body");
  });

  it("completes a processing delivery with Feishu message id and append-only sent event", async () => {
    const dataSource = {
      query: vi.fn(async (_statement: string, _values?: unknown[]) => ({ rows: [] })),
      connect: vi.fn(),
    };
    const repository = createPostgresProactiveSignalRepository({
      dataSource: dataSource as unknown as ProactiveSignalDataSource,
    });

    await repository.completeProactiveSignalDelivery({
      deliveryId: "delivery-a",
      workerId: "worker-a",
      messageId: "om_proactive",
      at: new Date("2026-07-23T10:00:00.000Z"),
    });

    const sql = dataSource.query.mock.calls.map(([statement]) => String(statement).toLowerCase()).join("\n");
    expect(sql).toContain("status = 'sent'");
    expect(sql).toContain("sent_message_id = $3");
    expect(sql).toContain("'sent', 'sent'");
    expect(sql).not.toContain("card_json");
  });

  it("returns retryable failures to pending and permanent failures to failed", async () => {
    const dataSource = {
      query: vi.fn(async (_statement: string, _values?: unknown[]) => ({ rows: [] })),
      connect: vi.fn(),
    };
    const repository = createPostgresProactiveSignalRepository({
      dataSource: dataSource as unknown as ProactiveSignalDataSource,
    });

    await repository.failProactiveSignalDelivery({
      deliveryId: "delivery-a",
      workerId: "worker-a",
      classification: "retryable",
      errorCode: "retryable_remote_failure",
      retryAt: new Date("2026-07-23T10:01:00.000Z"),
      at: new Date("2026-07-23T10:00:00.000Z"),
    });
    await repository.failProactiveSignalDelivery({
      deliveryId: "delivery-b",
      workerId: "worker-a",
      classification: "permanent",
      errorCode: "remote_rejected",
      at: new Date("2026-07-23T10:00:00.000Z"),
    });

    const retryValues = dataSource.query.mock.calls[0]?.[1] as unknown[] | undefined;
    const permanentValues = dataSource.query.mock.calls[1]?.[1] as unknown[] | undefined;
    expect(retryValues).toBeDefined();
    expect(permanentValues).toBeDefined();
    expect(retryValues![2]).toBe("pending");
    expect(permanentValues![2]).toBe("failed");
  });
});

function signal(overrides: Partial<ProactiveSignalCandidate> = {}): ProactiveSignalCandidate {
  return {
    idempotencyKey: "quiet_open_thread:thread-a:1",
    kind: "quiet_open_thread",
    priority: "medium",
    groupId: "group-a",
    entityId: "thread-a",
    entityVersion: 1,
    reasonCode: "thread_quiet_threshold_elapsed",
    suggestedMode: "ask_for_thread_update",
    lastRelevantAt: new Date("2026-07-23T08:00:00.000Z"),
    evidenceMessageIds: ["message-a", "message-b"],
    ...overrides,
  };
}

function createClient(results: Array<{ rows: Array<Record<string, unknown>> }>) {
  let index = 0;
  return {
    query: vi.fn(async (statement: string, _values?: unknown[]) => {
      if (statement === "begin" || statement === "commit" || statement === "rollback") {
        return { rows: [] };
      }
      return results[index++] ?? { rows: [] };
    }),
    release: vi.fn(),
  };
}

function expectPlaceholdersToBeUnique(statement: string, values: unknown[]) {
  const placeholders = Array.from(statement.matchAll(/\$(\d+)/gu), (match) => Number(match[1]));
  expect(new Set(placeholders).size).toBe(placeholders.length);
  expect(Math.max(...placeholders)).toBe(values.length);
}
