import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createPostgresProactiveSignalRepository,
  type PostgresProactiveSignalDataSource,
  type ProactiveSignalTransactionClient,
} from "../src/proactive/postgres-proactive-signal-repository.js";
import type { ProactiveSignalCandidateProposal } from "../src/proactive/proactive-signal-candidate.js";
import {
  defaultMigrationsDir,
  runMigrations,
  type MigrationClient,
} from "../src/database/migrate.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;

describe("createPostgresProactiveSignalRepository", () => {
  it("loads only bounded allowlisted eligible sources and maps exact source types", async () => {
    const queryable = fakeQueryable([
      sourceRow({ source_type: "action", source_id: "action-1", due_at: "2026-07-18T00:00:00.000Z" }),
      sourceRow({
        source_type: "thread",
        source_id: "thread-1",
        source_version: "4",
        status: "open",
        activity_at: "2026-07-16T00:00:00.000Z",
        has_eligible_open_action: false,
      }),
    ]);
    const repository = createPostgresProactiveSignalRepository({ dataSource: queryable });

    await expect(repository.loadEligibleSources({
      groupIds: [" group-b ", "group-a"],
      minConfidence: 0.7,
      threadQuietBefore: new Date("2026-07-17T00:00:00.000Z"),
      actionQuietBefore: new Date("2026-07-17T00:00:00.000Z"),
      overdueBefore: new Date("2026-07-18T11:30:00.000Z"),
      limit: 50,
    })).resolves.toEqual([
      {
        sourceType: "action",
        sourceId: "action-1",
        groupId: "group-1",
        sourceVersion: 2,
        status: "open",
        retrievalVisible: true,
        confidence: 0.9,
        updatedAt: new Date("2026-07-16T00:00:00.000Z"),
        dueAt: new Date("2026-07-18T00:00:00.000Z"),
      },
      {
        sourceType: "thread",
        sourceId: "thread-1",
        groupId: "group-1",
        sourceVersion: 4,
        status: "open",
        retrievalVisible: true,
        confidence: 0.9,
        lastActivityAt: new Date("2026-07-16T00:00:00.000Z"),
        hasEligibleOpenAction: false,
      },
    ]);
    const [sql, params] = queryable.query.mock.calls[0] ?? [];
    expect(String(sql)).toMatch(/not exists[\s\S]+action_items/iu);
    expect(String(sql)).toMatch(/retrieval_state = 'visible'/iu);
    expect(params).toEqual([
      ["group-a", "group-b"],
      0.7,
      new Date("2026-07-17T00:00:00.000Z"),
      new Date("2026-07-17T00:00:00.000Z"),
      new Date("2026-07-18T11:30:00.000Z"),
      50,
    ]);
  });

  it("expires a superseded pending candidate and creates one replacement transactionally", async () => {
    const client = scriptedClient([
      step(/begin/iu),
      step(/pg_advisory_xact_lock/iu),
      step(/from discussion_threads[\s\S]+version = \$3/iu, [{ id: "thread-1" }]),
      step(/from proactive_signal_candidates[\s\S]+source_version = \$4/iu, []),
      step(/update proactive_signal_candidates[\s\S]+status = 'expired'/iu, [{ id: "old" }]),
      step(/insert into proactive_signal_candidates/iu, [candidateRow()]),
      step(/commit/iu),
    ]);
    const repository = createPostgresProactiveSignalRepository({ dataSource: dataSource(client) });

    await expect(repository.observeCandidate(proposal())).resolves.toEqual({
      outcome: "created",
      candidate: mappedCandidate(),
      expiredCandidateCount: 1,
    });
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("returns an exact existing candidate without mutating lifecycle state", async () => {
    const client = scriptedClient([
      step(/begin/iu),
      step(/pg_advisory_xact_lock/iu),
      step(/from discussion_threads[\s\S]+version = \$3/iu, [{ id: "thread-1" }]),
      step(/from proactive_signal_candidates[\s\S]+source_version = \$4/iu, [candidateRow()]),
      step(/commit/iu),
    ]);
    const repository = createPostgresProactiveSignalRepository({ dataSource: dataSource(client) });

    await expect(repository.observeCandidate(proposal())).resolves.toEqual({
      outcome: "already_observed",
      candidate: mappedCandidate(),
      expiredCandidateCount: 0,
    });
    expect(vi.mocked(client.query).mock.calls.map(([sql]) => String(sql))).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/insert into proactive_signal_candidates/iu),
    ]));
  });

  it("skips a candidate when the authoritative source changed after scanning", async () => {
    const client = scriptedClient([
      step(/begin/iu),
      step(/pg_advisory_xact_lock/iu),
      step(/from discussion_threads[\s\S]+version = \$3/iu, []),
      step(/commit/iu),
    ]);
    const repository = createPostgresProactiveSignalRepository({ dataSource: dataSource(client) });

    await expect(repository.observeCandidate(proposal())).resolves.toEqual({
      outcome: "source_changed",
      expiredCandidateCount: 0,
    });
    expect(vi.mocked(client.query).mock.calls.map(([sql]) => String(sql))).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/insert into proactive_signal_candidates/iu),
    ]));
  });

  it("dismisses through an exact group and version compare-and-swap", async () => {
    const queryable = fakeQueryable([candidateRow({
      status: "dismissed",
      version: "2",
      dismissed_at: "2026-07-18T13:00:00.000Z",
      dismissed_by: "operator",
      dismissal_reason: "already handled",
      updated_at: "2026-07-18T13:00:00.000Z",
    })]);
    const repository = createPostgresProactiveSignalRepository({ dataSource: queryable });

    await expect(repository.dismissCandidate({
      id: "candidate-1",
      groupId: "group-1",
      expectedVersion: 1,
      dismissedBy: " operator ",
      dismissalReason: " already handled ",
      at: new Date("2026-07-18T13:00:00.000Z"),
    })).resolves.toMatchObject({ status: "dismissed", version: 2, dismissedBy: "operator" });
    expect(queryable.query.mock.calls[0]?.[1]).toEqual([
      "candidate-1",
      "group-1",
      1,
      "operator",
      "already handled",
      new Date("2026-07-18T13:00:00.000Z"),
    ]);
  });

  it("returns conflict when dismissal cannot update a pending exact version", async () => {
    const repository = createPostgresProactiveSignalRepository({ dataSource: fakeQueryable([]) });

    await expect(repository.dismissCandidate({
      id: "candidate-1",
      groupId: "group-1",
      expectedVersion: 3,
      dismissedBy: "operator",
      at: new Date(),
    })).resolves.toBe("conflict");
  });

  it("lists bounded candidates in exactly one group", async () => {
    const queryable = fakeQueryable([candidateRow()]);
    const repository = createPostgresProactiveSignalRepository({ dataSource: queryable });

    await expect(repository.listCandidates({
      groupId: " group-1 ",
      statuses: ["pending"],
      limit: 20,
    })).resolves.toEqual([mappedCandidate()]);
    expect(queryable.query.mock.calls[0]?.[1]).toEqual(["group-1", ["pending"], 20]);
  });

  it("records a bounded scan run and completes it with counters", async () => {
    const queryable = fakeQueryable(
      [scanRunRow()],
      [scanRunRow({
        status: "completed",
        scanned_source_count: "5",
        created_candidate_count: "2",
        duplicate_candidate_count: "1",
        expired_candidate_count: "1",
        skipped_candidate_count: "1",
        finished_at: "2026-07-18T12:01:00.000Z",
        updated_at: "2026-07-18T12:01:00.000Z",
      })],
    );
    const repository = createPostgresProactiveSignalRepository({ dataSource: queryable });

    const run = await repository.startScanRun({
      id: "scan-1",
      policyVersion: "phase4a-v1",
      requestedGroupIds: ["group-b", "group-a"],
      startedAt: new Date("2026-07-18T12:00:00.000Z"),
    });
    expect(run.requestedGroupIds).toEqual(["group-a", "group-b"]);
    await expect(repository.completeScanRun({
      id: "scan-1",
      scannedSourceCount: 5,
      createdCandidateCount: 2,
      duplicateCandidateCount: 1,
      expiredCandidateCount: 1,
      skippedCandidateCount: 1,
      finishedAt: new Date("2026-07-18T12:01:00.000Z"),
    })).resolves.toMatchObject({ status: "completed", createdCandidateCount: 2 });
  });

  it("rejects malformed bounds before querying", async () => {
    const queryable = fakeQueryable([]);
    const repository = createPostgresProactiveSignalRepository({ dataSource: queryable });

    await expect(repository.loadEligibleSources({
      groupIds: [],
      minConfidence: 0.7,
      threadQuietBefore: new Date(),
      actionQuietBefore: new Date(),
      overdueBefore: new Date(),
      limit: 10,
    })).rejects.toThrow("groupIds");
    await expect(repository.listCandidates({
      groupId: "group-1",
      statuses: ["pending"],
      limit: 0,
    })).rejects.toThrow("limit");
    expect(queryable.query).not.toHaveBeenCalled();
  });
});

runIfDatabase("PostgresProactiveSignalRepository with Postgres", () => {
  const suffix = randomUUID();
  const groupId = `proactive-group-${suffix}`;
  const otherGroupId = `proactive-other-${suffix}`;
  const quietThreadId = `proactive-thread-quiet-${suffix}`;
  const actionThreadId = `proactive-thread-action-${suffix}`;
  const actionId = `proactive-action-${suffix}`;
  const otherThreadId = `proactive-thread-other-${suffix}`;
  const now = new Date("2026-07-18T12:00:00.000Z");
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    await runMigrations({
      client: pool as unknown as MigrationClient,
      migrationsDir: defaultMigrationsDir(),
    });
    await pool.query(
      `
      INSERT INTO discussion_threads (
        id, group_id, title, summary, status, confidence, version,
        first_evidence_at, last_activity_at, created_at, updated_at
      ) VALUES
        ($1, $2, 'Quiet thread', 'Still unresolved', 'open', 0.9, 1, $6, $6, $6, $6),
        ($3, $2, 'Thread with action', 'Represented by action', 'open', 0.9, 1, $6, $6, $6, $6),
        ($4, $5, 'Other group thread', 'Must stay isolated', 'open', 0.9, 1, $6, $6, $6, $6)
      `,
      [
        quietThreadId,
        groupId,
        actionThreadId,
        otherThreadId,
        otherGroupId,
        new Date(now.getTime() - 48 * 60 * 60 * 1_000),
      ],
    );
    await pool.query(
      `
      INSERT INTO action_items (
        id, group_id, thread_id, description, owner_ref_type, owner_ref,
        due_at, status, confidence, version, created_at, updated_at
      ) VALUES ($1, $2, $3, 'Ship the pilot', 'feishu_user', 'ou_owner', $4,
        'open', 0.92, 1, $5, $5)
      `,
      [
        actionId,
        groupId,
        actionThreadId,
        new Date(now.getTime() - 2 * 60 * 60 * 1_000),
        new Date(now.getTime() - 48 * 60 * 60 * 1_000),
      ],
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM proactive_signal_candidates WHERE group_id = ANY($1::TEXT[])", [
      [groupId, otherGroupId],
    ]).catch(() => undefined);
    await pool.query("DELETE FROM proactive_signal_scan_runs WHERE requested_group_ids && $1::TEXT[]", [
      [groupId, otherGroupId],
    ]).catch(() => undefined);
    await pool.query("DELETE FROM action_items WHERE group_id = ANY($1::TEXT[])", [
      [groupId, otherGroupId],
    ]).catch(() => undefined);
    await pool.query("DELETE FROM discussion_threads WHERE group_id = ANY($1::TEXT[])", [
      [groupId, otherGroupId],
    ]).catch(() => undefined);
    await pool.end();
  });

  it("enforces action precedence and exact group isolation in the source query", async () => {
    const repository = createPostgresProactiveSignalRepository({ dataSource: pool });

    const sources = await repository.loadEligibleSources({
      groupIds: [groupId],
      minConfidence: 0.7,
      threadQuietBefore: new Date(now.getTime() - 24 * 60 * 60 * 1_000),
      actionQuietBefore: new Date(now.getTime() - 24 * 60 * 60 * 1_000),
      overdueBefore: new Date(now.getTime() - 30 * 60 * 1_000),
      limit: 20,
    });

    expect(sources.map((source) => source.sourceId).sort()).toEqual([
      actionId,
      quietThreadId,
    ].sort());
    expect(sources).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: actionThreadId }),
      expect.objectContaining({ sourceId: otherThreadId }),
    ]));
  });

  it("suppresses concurrent duplicates and supersedes a pending older source version", async () => {
    const repository = createPostgresProactiveSignalRepository({ dataSource: pool });
    const firstProposal = proposal({
      groupId,
      sourceId: quietThreadId,
      sourceVersion: 1,
    });

    const outcomes = await Promise.all([
      repository.observeCandidate(firstProposal),
      repository.observeCandidate(firstProposal),
    ]);
    expect(outcomes.map((result) => result.outcome).sort()).toEqual([
      "already_observed",
      "created",
    ]);

    await pool.query(
      "UPDATE discussion_threads SET version = 2, updated_at = $3 WHERE id = $1 AND group_id = $2",
      [quietThreadId, groupId, new Date(now.getTime() + 60_000)],
    );
    await expect(repository.observeCandidate(proposal({
      groupId,
      sourceId: quietThreadId,
      sourceVersion: 1,
    }))).resolves.toEqual({ outcome: "source_changed", expiredCandidateCount: 0 });

    const replacement = await repository.observeCandidate(proposal({
      groupId,
      sourceId: quietThreadId,
      sourceVersion: 2,
      observedAt: new Date(now.getTime() + 60_000),
    }));
    expect(replacement).toMatchObject({ outcome: "created", expiredCandidateCount: 1 });
    await expect(repository.listCandidates({
      groupId,
      statuses: ["pending", "expired"],
      limit: 10,
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceVersion: 1, status: "expired" }),
      expect.objectContaining({ sourceVersion: 2, status: "pending" }),
    ]));
  });

  it("does not recreate a dismissed exact candidate", async () => {
    const repository = createPostgresProactiveSignalRepository({ dataSource: pool });
    const current = (await repository.listCandidates({
      groupId,
      statuses: ["pending"],
      limit: 10,
    })).find((candidate) => candidate.sourceId === quietThreadId);
    expect(current).toBeDefined();
    await expect(repository.dismissCandidate({
      id: current!.id,
      groupId,
      expectedVersion: current!.version,
      dismissedBy: "integration-test",
      at: new Date(now.getTime() + 120_000),
    })).resolves.toMatchObject({ status: "dismissed" });

    await expect(repository.observeCandidate(proposal({
      groupId,
      sourceId: quietThreadId,
      sourceVersion: 2,
      observedAt: new Date(now.getTime() + 180_000),
    }))).resolves.toMatchObject({ outcome: "already_observed", candidate: { status: "dismissed" } });
  });
});

function proposal(
  overrides: Partial<ProactiveSignalCandidateProposal> = {},
): ProactiveSignalCandidateProposal {
  return {
    groupId: "group-1",
    sourceType: "thread",
    sourceId: "thread-1",
    sourceVersion: 2,
    reason: "quiet_unresolved_thread",
    score: 0.71,
    scoreFactors: {
      base: 0.55,
      confidenceContribution: 0.1,
      ageContribution: 0.06,
      overdueContribution: 0,
      quietForMs: 172_800_000,
      overdueByMs: 0,
    },
    explanation: "Open thread has been quiet for 48 hours; semantic confidence is 0.90.",
    policyVersion: "phase4a-v1",
    sourceActivityAt: new Date("2026-07-16T12:00:00.000Z"),
    eligibleAt: new Date("2026-07-17T12:00:00.000Z"),
    observedAt: new Date("2026-07-18T12:00:00.000Z"),
    ...overrides,
  };
}

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    source_type: "action",
    source_id: "action-1",
    group_id: "group-1",
    source_version: "2",
    status: "open",
    retrieval_visible: true,
    confidence: 0.9,
    activity_at: "2026-07-16T00:00:00.000Z",
    due_at: null,
    has_eligible_open_action: false,
    ...overrides,
  };
}

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "candidate-1",
    group_id: "group-1",
    source_type: "thread",
    source_id: "thread-1",
    source_version: "2",
    reason: "quiet_unresolved_thread",
    score: 0.71,
    score_factors: proposal().scoreFactors,
    explanation: proposal().explanation,
    policy_version: "phase4a-v1",
    status: "pending",
    version: "1",
    source_activity_at: "2026-07-16T12:00:00.000Z",
    eligible_at: "2026-07-17T12:00:00.000Z",
    observed_at: "2026-07-18T12:00:00.000Z",
    dismissed_at: null,
    dismissed_by: null,
    dismissal_reason: null,
    expired_at: null,
    created_at: "2026-07-18T12:00:00.000Z",
    updated_at: "2026-07-18T12:00:00.000Z",
    ...overrides,
  };
}

function mappedCandidate() {
  return {
    id: "candidate-1",
    ...proposal(),
    status: "pending",
    version: 1,
    createdAt: new Date("2026-07-18T12:00:00.000Z"),
    updatedAt: new Date("2026-07-18T12:00:00.000Z"),
  };
}

function scanRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "scan-1",
    policy_version: "phase4a-v1",
    requested_group_ids: ["group-a", "group-b"],
    status: "processing",
    scanned_source_count: "0",
    created_candidate_count: "0",
    duplicate_candidate_count: "0",
    expired_candidate_count: "0",
    skipped_candidate_count: "0",
    failure_classification: null,
    started_at: "2026-07-18T12:00:00.000Z",
    finished_at: null,
    created_at: "2026-07-18T12:00:00.000Z",
    updated_at: "2026-07-18T12:00:00.000Z",
    ...overrides,
  };
}

function fakeQueryable(...resultSets: Array<Array<Record<string, unknown>>>) {
  const remaining = [...resultSets];
  return {
    query: vi.fn().mockImplementation(async () => ({ rows: remaining.shift() ?? [] })),
  };
}

type ScriptStep = { pattern: RegExp; rows: Array<Record<string, unknown>> };

function step(pattern: RegExp, rows: Array<Record<string, unknown>> = []): ScriptStep {
  return { pattern, rows };
}

function scriptedClient(steps: ScriptStep[]): ProactiveSignalTransactionClient {
  const remaining = [...steps];
  return {
    query: vi.fn().mockImplementation(async (sql: string) => {
      const next = remaining.shift();
      expect(next, `unexpected query: ${sql}`).toBeDefined();
      expect(sql).toMatch(next!.pattern);
      return { rows: next!.rows };
    }),
    release: vi.fn(),
  };
}

function dataSource(client: ProactiveSignalTransactionClient): PostgresProactiveSignalDataSource {
  return {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue(client),
  };
}
