import { describe, expect, it, vi } from "vitest";

import {
  createProactiveSignalScanner,
  type ProactiveSignalRuntimeGate,
} from "../src/proactive/proactive-signal-scanner.js";
import type { ProactiveSignalRepository } from "../src/proactive/proactive-signal-repository.js";

const hour = 60 * 60 * 1_000;
const now = new Date("2026-07-18T12:00:00.000Z");

describe("createProactiveSignalScanner", () => {
  it("stays idle without an allowlisted group and touches no repository state", async () => {
    const repository = fakeRepository();
    const scanner = createScanner({ repository, groupIds: [] });

    await expect(scanner.scan()).resolves.toEqual({
      status: "skipped",
      reason: "empty_allowlist",
      scannedSourceCount: 0,
      createdCandidateCount: 0,
      duplicateCandidateCount: 0,
      expiredCandidateCount: 0,
      skippedCandidateCount: 0,
    });
    expect(repository.startScanRun).not.toHaveBeenCalled();
    expect(repository.loadEligibleSources).not.toHaveBeenCalled();
  });

  it("stays idle when every allowlisted group is paused by runtime policy", async () => {
    const repository = fakeRepository();
    const gate = { canProactivelySpeak: vi.fn(() => false) };
    const scanner = createScanner({ repository, gate, groupIds: ["group-a", "group-b"] });

    await expect(scanner.scan()).resolves.toMatchObject({
      status: "skipped",
      reason: "runtime_disabled",
    });
    expect(gate.canProactivelySpeak).toHaveBeenCalledTimes(2);
    expect(repository.startScanRun).not.toHaveBeenCalled();
  });

  it("ranks proposals deterministically and persists one candidate at a time", async () => {
    const repository = fakeRepository({
      sources: [
        quietThreadSource(),
        overdueActionSource(),
      ],
      outcomes: [
        { outcome: "created", candidate: candidate("action-1", 0.9), expiredCandidateCount: 0 },
        { outcome: "already_observed", candidate: candidate("thread-1", 0.7), expiredCandidateCount: 0 },
      ],
    });
    const scanner = createScanner({ repository });

    await expect(scanner.scan()).resolves.toEqual({
      status: "completed",
      runId: "scan-1",
      scannedSourceCount: 2,
      createdCandidateCount: 1,
      duplicateCandidateCount: 1,
      expiredCandidateCount: 0,
      skippedCandidateCount: 0,
    });
    expect(repository.loadEligibleSources).toHaveBeenCalledWith({
      groupIds: ["group-1"],
      minConfidence: 0.7,
      threadQuietBefore: new Date(now.getTime() - 24 * hour),
      actionQuietBefore: new Date(now.getTime() - 24 * hour),
      overdueBefore: new Date(now.getTime() - 30 * 60 * 1_000),
      limit: 50,
    });
    expect(repository.observeCandidate).toHaveBeenCalledTimes(2);
    expect(repository.observeCandidate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sourceId: "action-1", reason: "overdue_action",
    }));
    expect(repository.observeCandidate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sourceId: "thread-1", reason: "quiet_unresolved_thread",
    }));
    expect(repository.completeScanRun).toHaveBeenCalledWith(expect.objectContaining({
      id: "scan-1",
      scannedSourceCount: 2,
      createdCandidateCount: 1,
      duplicateCandidateCount: 1,
    }));
  });

  it("rechecks runtime policy before every candidate persistence", async () => {
    let checks = 0;
    const gate = {
      canProactivelySpeak: vi.fn(() => {
        checks += 1;
        return checks === 1;
      }),
    };
    const repository = fakeRepository({ sources: [quietThreadSource()] });
    const scanner = createScanner({ repository, gate });

    await expect(scanner.scan()).resolves.toMatchObject({
      status: "completed",
      skippedCandidateCount: 1,
      createdCandidateCount: 0,
    });
    expect(repository.observeCandidate).not.toHaveBeenCalled();
  });

  it("counts a source-version race as a safe skip", async () => {
    const repository = fakeRepository({
      sources: [quietThreadSource()],
      outcomes: [{ outcome: "source_changed", expiredCandidateCount: 0 }],
    });
    const scanner = createScanner({ repository });

    await expect(scanner.scan()).resolves.toMatchObject({
      status: "completed",
      skippedCandidateCount: 1,
    });
  });

  it("records a bounded failed run before propagating a scanner failure", async () => {
    const repository = fakeRepository();
    vi.mocked(repository.loadEligibleSources).mockRejectedValueOnce(new Error("database contains secret"));
    const scanner = createScanner({ repository });

    await expect(scanner.scan()).rejects.toThrow("database contains secret");
    expect(repository.failScanRun).toHaveBeenCalledWith({
      id: "scan-1",
      failureClassification: "proactive_scan_failed",
      finishedAt: now,
    });
  });
});

function createScanner({
  repository = fakeRepository(),
  gate = { canProactivelySpeak: vi.fn(() => true) },
  groupIds = ["group-1"],
}: {
  repository?: ReturnType<typeof fakeRepository>;
  gate?: ProactiveSignalRuntimeGate;
  groupIds?: string[];
} = {}) {
  return createProactiveSignalScanner({
    repository,
    runtimeGate: gate,
    groupIds,
    batchLimit: 50,
    policy: {
      policyVersion: "phase4a-v1",
      minConfidence: 0.7,
      quietThreadMs: 24 * hour,
      quietActionMs: 24 * hour,
      overdueGraceMs: 30 * 60 * 1_000,
    },
    now: () => now,
    createRunId: () => "scan-1",
  });
}

function fakeRepository({
  sources = [],
  outcomes = [],
}: {
  sources?: Awaited<ReturnType<ProactiveSignalRepository["loadEligibleSources"]>>;
  outcomes?: Array<Awaited<ReturnType<ProactiveSignalRepository["observeCandidate"]>>>;
} = {}) {
  return {
    loadEligibleSources: vi.fn(async () => sources),
    observeCandidate: vi.fn(async () => outcomes.shift() ?? {
      outcome: "created" as const,
      candidate: candidate("thread-1", 0.7),
      expiredCandidateCount: 0,
    }),
    listCandidates: vi.fn(async () => []),
    getCandidate: vi.fn(async () => undefined),
    dismissCandidate: vi.fn(async () => "conflict" as const),
    startScanRun: vi.fn(async (input) => scanRun({
      id: input.id,
      policyVersion: input.policyVersion,
      requestedGroupIds: input.requestedGroupIds,
      startedAt: input.startedAt,
    })),
    completeScanRun: vi.fn(async (input) => scanRun({
      id: input.id,
      status: "completed",
      scannedSourceCount: input.scannedSourceCount,
      createdCandidateCount: input.createdCandidateCount,
      duplicateCandidateCount: input.duplicateCandidateCount,
      expiredCandidateCount: input.expiredCandidateCount,
      skippedCandidateCount: input.skippedCandidateCount,
      finishedAt: input.finishedAt,
      updatedAt: input.finishedAt,
    })),
    failScanRun: vi.fn(async (input) => scanRun({
      id: input.id,
      status: "failed",
      failureClassification: input.failureClassification,
      finishedAt: input.finishedAt,
      updatedAt: input.finishedAt,
    })),
    getStatusCounts: vi.fn(async () => ({
      candidates: { pending: 0, dismissed: 0, expired: 0 },
      scans: { processing: 0, completed: 0, failed: 0 },
    })),
  } satisfies ProactiveSignalRepository;
}

function quietThreadSource() {
  return {
    sourceType: "thread" as const,
    sourceId: "thread-1",
    groupId: "group-1",
    sourceVersion: 1,
    status: "open" as const,
    retrievalVisible: true,
    confidence: 0.9,
    lastActivityAt: new Date(now.getTime() - 48 * hour),
    hasEligibleOpenAction: false,
  };
}

function overdueActionSource() {
  return {
    sourceType: "action" as const,
    sourceId: "action-1",
    groupId: "group-1",
    sourceVersion: 1,
    status: "open" as const,
    retrievalVisible: true,
    confidence: 0.95,
    updatedAt: new Date(now.getTime() - 48 * hour),
    dueAt: new Date(now.getTime() - 24 * hour),
  };
}

function candidate(sourceId: string, score: number) {
  return {
    id: `candidate-${sourceId}`,
    groupId: "group-1",
    sourceType: sourceId.startsWith("action") ? "action" as const : "thread" as const,
    sourceId,
    sourceVersion: 1,
    reason: sourceId.startsWith("action") ? "overdue_action" as const : "quiet_unresolved_thread" as const,
    score,
    scoreFactors: {
      base: 0.55,
      confidenceContribution: 0.1,
      ageContribution: 0.05,
      overdueContribution: 0,
      quietForMs: 48 * hour,
      overdueByMs: 0,
    },
    explanation: "explanation",
    policyVersion: "phase4a-v1",
    status: "pending" as const,
    version: 1,
    sourceActivityAt: new Date(now.getTime() - 48 * hour),
    eligibleAt: new Date(now.getTime() - 24 * hour),
    observedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function scanRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "scan-1",
    policyVersion: "phase4a-v1",
    requestedGroupIds: ["group-1"],
    status: "processing" as const,
    scannedSourceCount: 0,
    createdCandidateCount: 0,
    duplicateCandidateCount: 0,
    expiredCandidateCount: 0,
    skippedCandidateCount: 0,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as never;
}
