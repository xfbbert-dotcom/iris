import { randomUUID } from "node:crypto";

import { evaluateProactiveSignal, type ProactiveSignalPolicy } from "./proactive-signal-evaluator.js";
import type { ProactiveSignalRepository } from "./proactive-signal-repository.js";

export type ProactiveSignalRuntimeGate = {
  canProactivelySpeak(groupId: string): boolean;
};

type ScanCounters = {
  scannedSourceCount: number;
  createdCandidateCount: number;
  duplicateCandidateCount: number;
  expiredCandidateCount: number;
  skippedCandidateCount: number;
};

export type ProactiveSignalScanResult =
  | (ScanCounters & {
      status: "skipped";
      reason: "empty_allowlist" | "runtime_disabled" | "scan_in_progress";
    })
  | (ScanCounters & {
      status: "completed";
      runId: string;
    });

export type ProactiveSignalScanner = {
  scan(): Promise<ProactiveSignalScanResult>;
};

export function createProactiveSignalScanner({
  repository,
  runtimeGate,
  groupIds: rawGroupIds,
  batchLimit,
  policy,
  now = () => new Date(),
  createRunId = randomUUID,
}: {
  repository: ProactiveSignalRepository;
  runtimeGate: ProactiveSignalRuntimeGate;
  groupIds: string[];
  batchLimit: number;
  policy: ProactiveSignalPolicy;
  now?: () => Date;
  createRunId?: () => string;
}): ProactiveSignalScanner {
  const groupIds = [...rawGroupIds];
  let activeScan: Promise<ProactiveSignalScanResult> | undefined;

  return {
    scan() {
      if (activeScan !== undefined) {
        return Promise.resolve(skipped("scan_in_progress"));
      }
      const scan = performScan({
        repository,
        runtimeGate,
        groupIds,
        batchLimit,
        policy,
        now,
        createRunId,
      });
      activeScan = scan;
      return scan.finally(() => {
        if (activeScan === scan) activeScan = undefined;
      });
    },
  };
}

async function performScan({
  repository,
  runtimeGate,
  groupIds,
  batchLimit,
  policy,
  now,
  createRunId,
}: {
  repository: ProactiveSignalRepository;
  runtimeGate: ProactiveSignalRuntimeGate;
  groupIds: string[];
  batchLimit: number;
  policy: ProactiveSignalPolicy;
  now: () => Date;
  createRunId: () => string;
}): Promise<ProactiveSignalScanResult> {
  if (groupIds.length === 0) return skipped("empty_allowlist");
  const enabledGroupIds = groupIds.filter((groupId) => runtimeGate.canProactivelySpeak(groupId));
  if (enabledGroupIds.length === 0) return skipped("runtime_disabled");

  const observedAt = requireDate(now());
  const runId = requireId(createRunId());
  let runStarted = false;
  try {
    await repository.startScanRun({
      id: runId,
      policyVersion: policy.policyVersion,
      requestedGroupIds: enabledGroupIds,
      startedAt: observedAt,
    });
    runStarted = true;
    const sources = await repository.loadEligibleSources({
      groupIds: enabledGroupIds,
      minConfidence: policy.minConfidence,
      threadQuietBefore: new Date(observedAt.getTime() - policy.quietThreadMs),
      actionQuietBefore: new Date(observedAt.getTime() - policy.quietActionMs),
      overdueBefore: new Date(observedAt.getTime() - policy.overdueGraceMs),
      limit: batchLimit,
    });
    const proposals = sources
      .map((source) => evaluateProactiveSignal({ source, policy, now: observedAt }))
      .filter((proposal) => proposal !== undefined)
      .sort((left, right) =>
        right.score - left.score ||
        left.eligibleAt.getTime() - right.eligibleAt.getTime() ||
        left.sourceId.localeCompare(right.sourceId));

    const counters: ScanCounters = {
      scannedSourceCount: sources.length,
      createdCandidateCount: 0,
      duplicateCandidateCount: 0,
      expiredCandidateCount: 0,
      skippedCandidateCount: sources.length - proposals.length,
    };
    for (const proposal of proposals) {
      if (!runtimeGate.canProactivelySpeak(proposal.groupId)) {
        counters.skippedCandidateCount += 1;
        continue;
      }
      const result = await repository.observeCandidate(proposal);
      counters.expiredCandidateCount += result.expiredCandidateCount;
      if (result.outcome === "created") counters.createdCandidateCount += 1;
      else if (result.outcome === "already_observed") counters.duplicateCandidateCount += 1;
      else counters.skippedCandidateCount += 1;
    }
    await repository.completeScanRun({ id: runId, ...counters, finishedAt: requireDate(now()) });
    return { status: "completed", runId, ...counters };
  } catch (error) {
    if (runStarted) {
      await repository.failScanRun({
        id: runId,
        failureClassification: "proactive_scan_failed",
        finishedAt: requireDate(now()),
      }).catch(() => undefined);
    }
    throw error;
  }
}

function skipped(
  reason: Extract<ProactiveSignalScanResult, { status: "skipped" }>['reason'],
): ProactiveSignalScanResult {
  return {
    status: "skipped",
    reason,
    scannedSourceCount: 0,
    createdCandidateCount: 0,
    duplicateCandidateCount: 0,
    expiredCandidateCount: 0,
    skippedCandidateCount: 0,
  };
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("proactive scan time is invalid");
  }
  return new Date(value);
}

function requireId(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 512) {
    throw new Error("proactive scan ID is invalid");
  }
  return normalized;
}
