export const PROACTIVE_SIGNAL_SOURCE_TYPES = ["thread", "action"] as const;
export const PROACTIVE_SIGNAL_REASONS = [
  "quiet_unresolved_thread",
  "quiet_open_action",
  "overdue_action",
] as const;
export const PROACTIVE_SIGNAL_CANDIDATE_STATUSES = [
  "pending",
  "dismissed",
  "expired",
] as const;

export type ProactiveSignalSourceType = (typeof PROACTIVE_SIGNAL_SOURCE_TYPES)[number];
export type ProactiveSignalReason = (typeof PROACTIVE_SIGNAL_REASONS)[number];
export type ProactiveSignalCandidateStatus =
  (typeof PROACTIVE_SIGNAL_CANDIDATE_STATUSES)[number];

export type ProactiveSignalScoreFactors = {
  base: number;
  confidenceContribution: number;
  ageContribution: number;
  overdueContribution: number;
  quietForMs: number;
  overdueByMs: number;
};

export type ProactiveSignalCandidateProposal = {
  groupId: string;
  sourceType: ProactiveSignalSourceType;
  sourceId: string;
  sourceVersion: number;
  reason: ProactiveSignalReason;
  score: number;
  scoreFactors: ProactiveSignalScoreFactors;
  explanation: string;
  policyVersion: string;
  sourceActivityAt: Date;
  eligibleAt: Date;
  observedAt: Date;
};

export type ProactiveSignalCandidate = ProactiveSignalCandidateProposal & {
  id: string;
  status: ProactiveSignalCandidateStatus;
  version: number;
  dismissedAt?: Date;
  dismissedBy?: string;
  dismissalReason?: string;
  expiredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};
