import type {
  ProactiveSignalCandidate,
  ProactiveSignalCandidateProposal,
  ProactiveSignalCandidateStatus,
} from "./proactive-signal-candidate.js";
import type { ProactiveSignalSourceSnapshot } from "./proactive-signal-evaluator.js";

export const PROACTIVE_SIGNAL_SCAN_STATUSES = ["processing", "completed", "failed"] as const;
export type ProactiveSignalScanStatus = (typeof PROACTIVE_SIGNAL_SCAN_STATUSES)[number];

export type ProactiveSignalScanRun = {
  id: string;
  policyVersion: string;
  requestedGroupIds: string[];
  status: ProactiveSignalScanStatus;
  scannedSourceCount: number;
  createdCandidateCount: number;
  duplicateCandidateCount: number;
  expiredCandidateCount: number;
  skippedCandidateCount: number;
  failureClassification?: string;
  startedAt: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type ProactiveSignalStatusCounts = {
  candidates: Record<ProactiveSignalCandidateStatus, number>;
  scans: Record<ProactiveSignalScanStatus, number>;
};

export interface ProactiveSignalRepository {
  loadEligibleSources(input: {
    groupIds: string[];
    minConfidence: number;
    threadQuietBefore: Date;
    actionQuietBefore: Date;
    overdueBefore: Date;
    limit: number;
  }): Promise<ProactiveSignalSourceSnapshot[]>;
  observeCandidate(proposal: ProactiveSignalCandidateProposal): Promise<{
    outcome: "created" | "already_observed";
    candidate: ProactiveSignalCandidate;
    expiredCandidateCount: number;
  } | {
    outcome: "source_changed";
    expiredCandidateCount: 0;
  }>;
  listCandidates(input: {
    groupId: string;
    statuses?: ProactiveSignalCandidateStatus[];
    limit: number;
  }): Promise<ProactiveSignalCandidate[]>;
  getCandidate(input: { id: string; groupId: string }): Promise<ProactiveSignalCandidate | undefined>;
  dismissCandidate(input: {
    id: string;
    groupId: string;
    expectedVersion: number;
    dismissedBy: string;
    dismissalReason?: string;
    at: Date;
  }): Promise<ProactiveSignalCandidate | "conflict">;
  startScanRun(input: {
    id: string;
    policyVersion: string;
    requestedGroupIds: string[];
    startedAt: Date;
  }): Promise<ProactiveSignalScanRun>;
  completeScanRun(input: {
    id: string;
    scannedSourceCount: number;
    createdCandidateCount: number;
    duplicateCandidateCount: number;
    expiredCandidateCount: number;
    skippedCandidateCount: number;
    finishedAt: Date;
  }): Promise<ProactiveSignalScanRun>;
  failScanRun(input: {
    id: string;
    failureClassification: string;
    finishedAt: Date;
  }): Promise<ProactiveSignalScanRun>;
  getStatusCounts(): Promise<ProactiveSignalStatusCounts>;
}
