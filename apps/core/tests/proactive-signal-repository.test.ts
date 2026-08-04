import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { defaultMigrationsDir } from "../src/database/migrate.js";
import {
  createPostgresProactiveSignalRepository,
  type ProactiveSignalFeedback,
  type ProactiveSignalDataSource,
  type ProactiveSignalRecordResult,
} from "../src/proactive-signals/proactive-signal-repository.js";
import type { ProactiveSignalCandidate } from "../src/proactive-signals/proactive-signal-planner.js";

describe("proactive signal persistence", () => {
  it("defines immutable feedback events and mutable suppression projections", async () => {
    const sql = await readFile(
      join(defaultMigrationsDir(), "0040_proactive_signal_feedback.sql"),
      "utf8",
    );
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();

    expect(normalized).toContain("create table proactive_signal_feedback_events");
    expect(normalized).toContain("create table proactive_signal_suppressions");
    expect(normalized).toContain("unique (delivery_id, actor_fingerprint)");
    expect(normalized).toContain("check (feedback in ('helpful', 'irrelevant'))");
    expect(normalized).toContain(
      "source_feedback_event_id text not null references proactive_signal_feedback_events(idempotency_key)",
    );
    expect(normalized).toContain("proactive_signal_feedback_events_append_only");
    expect(normalized).toContain("proactive_signal_feedback_events_truncate_guard");
  });

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

  it("records feedback transactionally against an exact sent delivery binding", async () => {
    const client = createClient([
      { rows: [{ kind: "quiet_open_thread", entity_id: "thread-a" }] },
      { rows: [{ idempotency_key: "feishu-card:cli:event-1" }] },
      { rows: [] },
    ]);
    const repository = createPostgresProactiveSignalRepository({
      dataSource: {
        connect: vi.fn(async () => client),
        query: vi.fn(),
      } as unknown as ProactiveSignalDataSource,
    });

    await expect(repository.recordFeedback(feedback())).resolves.toEqual({ status: "applied" });

    expect(client.query).toHaveBeenCalledWith("begin");
    expect(client.query).toHaveBeenCalledWith("commit");
    const sql = client.query.mock.calls.map(([statement]) => String(statement).toLowerCase()).join("\n");
    expect(sql).toContain("from proactive_signal_delivery_outbox delivery");
    expect(sql).toContain("delivery.status = 'sent'");
    expect(sql).toContain("delivery.candidate_idempotency_key = $2");
    expect(sql).toContain("candidate.entity_version = $5");
    expect(sql).toContain("insert into proactive_signal_feedback_events");
    expect(sql).toContain("on conflict do nothing");
    expect(sql).toContain("insert into proactive_signal_suppressions");
    expect(sql).toContain("source_feedback_event_id");
    expect(sql).toContain("excluded.suppress_until > proactive_signal_suppressions.suppress_until");
    expect(sql).not.toContain("message body");
  });

  it("validates the exact sent feedback binding without mutating feedback", async () => {
    const dataSource = {
      query: vi.fn(async (_statement: string, _values?: unknown[]) => ({
        rows: [{ binding_valid: true }],
      })),
      connect: vi.fn(),
    };
    const repository = createPostgresProactiveSignalRepository({
      dataSource: dataSource as unknown as ProactiveSignalDataSource,
    });

    await expect(repository.validateFeedbackBinding({
      deliveryId: "delivery-1",
      candidateIdempotencyKey: "quiet_open_thread:thread-1:2",
      groupId: "oc_pilot",
      messageId: "om_card",
      entityVersion: 2,
    })).resolves.toEqual({ status: "valid" });

    const sql = dataSource.query.mock.calls.map(([statement]) => String(statement).toLowerCase()).join("\n");
    expect(sql).toContain("from proactive_signal_delivery_outbox delivery");
    expect(sql).toContain("delivery.status = 'sent'");
    expect(sql).not.toContain("insert into proactive_signal_feedback_events");
    expect(dataSource.connect).not.toHaveBeenCalled();
  });

  it("returns stale binding before feedback mutation when the sent delivery does not match", async () => {
    const dataSource = {
      query: vi.fn(async (_statement: string, _values?: unknown[]) => ({ rows: [] })),
      connect: vi.fn(),
    };
    const repository = createPostgresProactiveSignalRepository({
      dataSource: dataSource as unknown as ProactiveSignalDataSource,
    });

    await expect(repository.validateFeedbackBinding({
      deliveryId: "delivery-1",
      candidateIdempotencyKey: "quiet_open_thread:thread-1:2",
      groupId: "oc_pilot",
      messageId: "om_wrong",
      entityVersion: 2,
    })).resolves.toEqual({ status: "stale_binding" });
  });

  it("treats duplicate feedback as already applied only after the sent binding matches", async () => {
    const client = createClient([
      { rows: [{ kind: "quiet_open_thread", entity_id: "thread-a" }] },
      { rows: [] },
      { rows: [{ idempotency_key: "feishu-card:cli:event-1" }] },
    ]);
    const repository = createPostgresProactiveSignalRepository({
      dataSource: {
        connect: vi.fn(async () => client),
        query: vi.fn(),
      } as unknown as ProactiveSignalDataSource,
    });

    await expect(repository.recordFeedback(feedback())).resolves.toEqual({ status: "already_applied" });
    expect(client.query.mock.calls.map(([statement]) => statement)).toContain("commit");
  });

  it("fails closed when feedback does not match a sent delivery binding", async () => {
    const client = createClient([{ rows: [] }]);
    const repository = createPostgresProactiveSignalRepository({
      dataSource: {
        connect: vi.fn(async () => client),
        query: vi.fn(),
      } as unknown as ProactiveSignalDataSource,
    });

    await expect(repository.recordFeedback(feedback())).resolves.toEqual({ status: "stale_binding" });
    const sql = client.query.mock.calls.map(([statement]) => String(statement).toLowerCase()).join("\n");
    expect(sql).not.toContain("insert into proactive_signal_feedback_events");
  });

  it("does not create suppressions for helpful feedback and validates actor fingerprints", async () => {
    const client = createClient([
      { rows: [{ kind: "quiet_open_thread", entity_id: "thread-a" }] },
      { rows: [{ idempotency_key: "feishu-card:cli:event-1" }] },
    ]);
    const connect = vi.fn(async () => client);
    const repository = createPostgresProactiveSignalRepository({
      dataSource: { connect, query: vi.fn() } as unknown as ProactiveSignalDataSource,
    });

    await expect(repository.recordFeedback(feedback({
      feedback: "helpful",
      suppressUntil: new Date("2026-07-27T00:00:00.000Z"),
    }))).resolves.toEqual({ status: "applied" });
    const sql = client.query.mock.calls.map(([statement]) => String(statement).toLowerCase()).join("\n");
    expect(sql).not.toContain("insert into proactive_signal_suppressions");
    await expect(repository.recordFeedback(feedback({ actorFingerprint: "A".repeat(64) }))).rejects.toThrow(
      "actorFingerprint is invalid",
    );
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("requires irrelevant suppressions to be within the next 365 days", async () => {
    const at = new Date("2026-07-27T00:00:00.000Z");
    const connect = vi.fn(async () => {
      throw new Error("feedback validation must fail before connecting");
    });
    const repository = createPostgresProactiveSignalRepository({
      dataSource: { connect, query: vi.fn() } as unknown as ProactiveSignalDataSource,
    });

    await expect(repository.recordFeedback(feedback({ at, suppressUntil: at }))).rejects.toThrow(
      "suppressUntil is invalid",
    );
    await expect(repository.recordFeedback(feedback({
      at,
      suppressUntil: new Date(at.getTime() + 365 * 24 * 60 * 60 * 1000 + 1),
    }))).rejects.toThrow("suppressUntil is invalid");
    expect(connect).not.toHaveBeenCalled();
  });

  it("accepts an irrelevant suppression exactly 365 days after feedback", async () => {
    const at = new Date("2026-07-27T00:00:00.000Z");
    const client = createClient([
      { rows: [{ kind: "quiet_open_thread", entity_id: "thread-a" }] },
      { rows: [{ idempotency_key: "feishu-card:cli:event-1" }] },
      { rows: [] },
    ]);
    const repository = createPostgresProactiveSignalRepository({
      dataSource: {
        connect: vi.fn(async () => client),
        query: vi.fn(),
      } as unknown as ProactiveSignalDataSource,
    });

    await expect(repository.recordFeedback(feedback({
      at,
      suppressUntil: new Date(at.getTime() + 365 * 24 * 60 * 60 * 1000),
    }))).resolves.toEqual({ status: "applied" });
  });

  it("summarizes feedback by group without selecting actor fingerprints", async () => {
    const dataSource = {
      query: vi.fn(async (_statement: string, _values?: unknown[]) => ({ rows: [{
        total_count: "3",
        helpful_count: "1",
        irrelevant_count: "2",
        active_suppression_count: "1",
        last_feedback_at: new Date("2026-07-27T00:00:00.000Z"),
      }] })),
      connect: vi.fn(),
    };
    const repository = createPostgresProactiveSignalRepository({
      dataSource: dataSource as unknown as ProactiveSignalDataSource,
    });

    await expect(repository.getFeedbackSummary({
      groupId: "group-a",
      at: new Date("2026-07-27T01:00:00.000Z"),
    })).resolves.toEqual({
      groupId: "group-a",
      totalCount: 3,
      helpfulCount: 1,
      irrelevantCount: 2,
      helpfulRate: 1 / 3,
      activeSuppressionCount: 1,
      lastFeedbackAt: new Date("2026-07-27T00:00:00.000Z"),
    });
    const sql = dataSource.query.mock.calls.map(([statement]) => String(statement).toLowerCase()).join("\n");
    expect(sql).toContain("feedback.group_id = $1");
    expect(sql).toContain("suppression.suppress_until > $2");
    expect(sql).not.toContain("actor_fingerprint");
  });

  it("records only new version-bound candidates and creates append-only creation events", async () => {
    const client = createClient([
      { rows: [{ idempotency_key: "quiet_open_thread:thread-a:1", outcome: "recorded" }] },
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
      suppressedCount: 0,
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
      { idempotency_key: "quiet_open_thread:thread-a:1", outcome: "recorded" },
      { idempotency_key: "overdue_action:action-a:1", outcome: "recorded" },
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
    const client = createClient([{ rows: [{
      idempotency_key: "overdue_action:action-a:2",
      outcome: "existing",
    }] }]);
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
      suppressedCount: 0,
      recordedKeys: [],
    });
    expect(client.query.mock.calls).toHaveLength(4);
    expect(String(client.query.mock.calls[1]?.[0]).toLowerCase()).toContain(
      "pg_advisory_xact_lock",
    );
  });

  it("anchors candidate CTE values to the target Postgres column types", async () => {
    const client = createClient([
      { rows: [{ idempotency_key: "quiet_open_thread:thread-a:1", outcome: "recorded" }] },
      { rows: [] },
      { rows: [] },
    ]);
    const repository = createPostgresProactiveSignalRepository({
      dataSource: {
        connect: vi.fn(async () => client),
        query: vi.fn(),
      } as unknown as ProactiveSignalDataSource,
    });

    await repository.recordCandidates({
      signals: [signal()],
      now: new Date("2026-07-27T00:00:00.000Z"),
    });

    const insertCall = client.query.mock.calls.find(([statement]) =>
      String(statement).toLowerCase().includes("insert into proactive_signal_candidates")
    );
    expect(String(insertCall?.[0])).toContain("$7::bigint");
    expect(String(insertCall?.[0])).toContain("$11::timestamptz");
    expect(String(insertCall?.[0])).toContain("$12::timestamptz");
    expect(String(insertCall?.[0])).toContain("$13::timestamptz");
  });

  it("excludes candidates with active database suppressions and reports them separately", async () => {
    const client = createClient([{ rows: [{ idempotency_key: "quiet_open_thread:thread-a:1", outcome: "suppressed" }] }]);
    const repository = createPostgresProactiveSignalRepository({
      dataSource: {
        connect: vi.fn(async () => client),
        query: vi.fn(),
      } as unknown as ProactiveSignalDataSource,
    });

    await expect(repository.recordCandidates({
      signals: [signal()],
      now: new Date("2026-07-27T00:00:00.000Z"),
    })).resolves.toEqual({
      recordedCount: 0,
      existingCount: 0,
      suppressedCount: 1,
      recordedKeys: [],
    });
    const sql = client.query.mock.calls.map(([statement]) => String(statement).toLowerCase()).join("\n");
    expect(sql).toContain("from proactive_signal_suppressions");
    expect(sql).toContain("suppression.suppress_until > $");
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
    expect(sql).toContain("not exists");
    expect(sql).toContain("from proactive_signal_delivery_outbox delivery");
    expect(sql).toContain("delivery.delivery_channel = 'feishu_group_card'");
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
    expect(sql).toContain("from proactive_signal_suppressions");
    expect(sql).toContain("suppression.suppress_until > $4");
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
    expect(sql).toContain("from proactive_signal_suppressions");
    expect(sql).toContain("suppression.suppress_until > $2");
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
          subject_label: "Iris PR#22 acceptance discussion",
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
      subjectLabel: "Iris PR#22 acceptance discussion",
    }));
    const sql = dataSource.query.mock.calls.map(([statement]) => String(statement).toLowerCase()).join("\n");
    expect(sql).toContain("left join discussion_threads");
    expect(sql).toContain("left join action_items");
    expect(sql).toContain("thread_state.group_id = candidate.group_id");
    expect(sql).toContain("thread_state.version = candidate.entity_version");
    expect(sql).toContain("action_state.group_id = candidate.group_id");
    expect(sql).toContain("action_state.version = candidate.entity_version");
    expect(sql).not.toContain("conversation_messages.text");
    expect(sql).not.toContain("message_body");
  });

  it.each([
    "authorized",
    "suppressed",
    "stale",
  ] as const)("atomically returns %s from the final delivery authorization", async (status) => {
    const dataSource = {
      query: vi.fn(async (_statement: string, _values?: unknown[]) => ({
        rows: [{ authorization_status: status }],
      })),
      connect: vi.fn(),
    };
    const repository = createPostgresProactiveSignalRepository({
      dataSource: dataSource as unknown as ProactiveSignalDataSource,
    });

    await expect(repository.beginProactiveSignalDeliveryAttempt({
      deliveryId: "delivery-a",
      workerId: "worker-a",
      at: new Date("2026-07-23T10:00:00.000Z"),
    })).resolves.toEqual({ status });

    const sql = String(dataSource.query.mock.calls[0]?.[0]).toLowerCase();
    expect(sql).toContain("from proactive_signal_suppressions");
    expect(sql).toContain("suppression.suppress_until > $3");
    expect(sql).toContain("delivery.lease_until > $3");
    expect(sql).toContain("for update of delivery");
    expect(sql).toContain("status = 'cancelled'");
    expect(sql).toContain("failure_classification = 'feedback_suppressed'");
    expect(sql).toContain("'cancelled', 'cancelled'");
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

function feedback(
  overrides: Partial<Parameters<ReturnType<typeof createPostgresProactiveSignalRepository>["recordFeedback"]>[0]> = {},
): Parameters<ReturnType<typeof createPostgresProactiveSignalRepository>["recordFeedback"]>[0] {
  return {
    idempotencyKey: "feishu-card:cli:event-1",
    deliveryId: "delivery-1",
    candidateIdempotencyKey: "quiet_open_thread:thread-1:2",
    groupId: "oc_pilot",
    messageId: "om_card",
    entityVersion: 2,
    actorFingerprint: "a".repeat(64),
    feedback: "irrelevant" as ProactiveSignalFeedback,
    suppressUntil: new Date("2026-08-26T00:00:00.000Z"),
    at: new Date("2026-07-27T00:00:00.000Z"),
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
      if (statement.toLowerCase().includes("pg_advisory_xact_lock")) {
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

// @ts-expect-error ProactiveSignalRecordResult requires complete accounting.
const recordResultMissingSuppressedCount: ProactiveSignalRecordResult = {
  recordedCount: 0,
  existingCount: 0,
  recordedKeys: [],
};

void recordResultMissingSuppressedCount;
