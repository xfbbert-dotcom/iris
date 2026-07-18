import type {
  ProactiveSignalCandidateProposal,
  ProactiveSignalReason,
  ProactiveSignalScoreFactors,
} from "./proactive-signal-candidate.js";

const MAX_IDENTIFIER_CHARS = 512;
const MAX_POLICY_VERSION_CHARS = 128;
const MAX_EXPLANATION_CHARS = 512;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export type ProactiveSignalPolicy = {
  policyVersion: string;
  minConfidence: number;
  quietThreadMs: number;
  quietActionMs: number;
  overdueGraceMs: number;
};

type SourceBase = {
  sourceId: string;
  groupId: string;
  sourceVersion: number;
  retrievalVisible: boolean;
  confidence: number;
};

export type ProactiveSignalSourceSnapshot =
  | (SourceBase & {
      sourceType: "thread";
      status: "candidate" | "open" | "resolved" | "merged";
      lastActivityAt: Date;
      hasEligibleOpenAction: boolean;
    })
  | (SourceBase & {
      sourceType: "action";
      status: "open" | "completed" | "cancelled";
      updatedAt: Date;
      dueAt?: Date;
    });

export function evaluateProactiveSignal({
  source,
  policy: rawPolicy,
  now: rawNow,
}: {
  source: ProactiveSignalSourceSnapshot;
  policy: ProactiveSignalPolicy;
  now: Date;
}): ProactiveSignalCandidateProposal | undefined {
  const policy = validatePolicy(rawPolicy);
  const now = requireDate("observation time", rawNow);
  validateSource(source);

  if (!source.retrievalVisible || source.confidence < policy.minConfidence) {
    return undefined;
  }

  if (source.sourceType === "thread") {
    if (source.status !== "open" || source.hasEligibleOpenAction) {
      return undefined;
    }
    return evaluateQuietSource({
      source,
      sourceActivityAt: source.lastActivityAt,
      reason: "quiet_unresolved_thread",
      thresholdMs: policy.quietThreadMs,
      base: 0.55,
      policy,
      now,
    });
  }

  if (source.status !== "open") {
    return undefined;
  }

  if (source.dueAt !== undefined) {
    const overdueByMs = now.getTime() - source.dueAt.getTime();
    if (overdueByMs >= policy.overdueGraceMs) {
      return buildProposal({
        source,
        sourceActivityAt: source.updatedAt,
        eligibleAt: new Date(source.dueAt.getTime() + policy.overdueGraceMs),
        reason: "overdue_action",
        thresholdMs: policy.quietActionMs,
        base: 0.75,
        quietForMs: now.getTime() - source.updatedAt.getTime(),
        overdueByMs,
        policy,
        now,
      });
    }
  }

  return evaluateQuietSource({
    source,
    sourceActivityAt: source.updatedAt,
    reason: "quiet_open_action",
    thresholdMs: policy.quietActionMs,
    base: 0.6,
    policy,
    now,
  });
}

function evaluateQuietSource({
  source,
  sourceActivityAt,
  reason,
  thresholdMs,
  base,
  policy,
  now,
}: {
  source: ProactiveSignalSourceSnapshot;
  sourceActivityAt: Date;
  reason: "quiet_unresolved_thread" | "quiet_open_action";
  thresholdMs: number;
  base: number;
  policy: ProactiveSignalPolicy;
  now: Date;
}): ProactiveSignalCandidateProposal | undefined {
  const quietForMs = now.getTime() - sourceActivityAt.getTime();
  if (quietForMs < thresholdMs) {
    return undefined;
  }
  return buildProposal({
    source,
    sourceActivityAt,
    eligibleAt: new Date(sourceActivityAt.getTime() + thresholdMs),
    reason,
    thresholdMs,
    base,
    quietForMs,
    overdueByMs: 0,
    policy,
    now,
  });
}

function buildProposal({
  source,
  sourceActivityAt,
  eligibleAt,
  reason,
  thresholdMs,
  base,
  quietForMs,
  overdueByMs,
  policy,
  now,
}: {
  source: ProactiveSignalSourceSnapshot;
  sourceActivityAt: Date;
  eligibleAt: Date;
  reason: ProactiveSignalReason;
  thresholdMs: number;
  base: number;
  quietForMs: number;
  overdueByMs: number;
  policy: ProactiveSignalPolicy;
  now: Date;
}): ProactiveSignalCandidateProposal {
  const confidenceContribution = round(
    Math.min(1, Math.max(0, (source.confidence - policy.minConfidence) / (1 - policy.minConfidence))) * 0.15,
  );
  const ageContribution = round(
    Math.min(1, Math.max(0, quietForMs - thresholdMs) / (thresholdMs * 7)) * 0.15,
  );
  const overdueContribution = round(
    reason === "overdue_action" ? Math.min(1, Math.max(0, overdueByMs) / (7 * DAY_MS)) * 0.1 : 0,
  );
  const scoreFactors: ProactiveSignalScoreFactors = {
    base,
    confidenceContribution,
    ageContribution,
    overdueContribution,
    quietForMs: Math.max(0, quietForMs),
    overdueByMs: Math.max(0, overdueByMs),
  };
  const score = round(Math.min(0.99, base + confidenceContribution + ageContribution + overdueContribution));
  const explanation = buildExplanation({
    reason,
    quietForMs: scoreFactors.quietForMs,
    overdueByMs: scoreFactors.overdueByMs,
    confidence: source.confidence,
  });
  if (explanation.length > MAX_EXPLANATION_CHARS) {
    throw new Error("proactive signal explanation exceeds its bound");
  }

  return {
    groupId: source.groupId,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    sourceVersion: source.sourceVersion,
    reason,
    score,
    scoreFactors,
    explanation,
    policyVersion: policy.policyVersion,
    sourceActivityAt: new Date(sourceActivityAt),
    eligibleAt: new Date(eligibleAt),
    observedAt: new Date(now),
  };
}

function buildExplanation({
  reason,
  quietForMs,
  overdueByMs,
  confidence,
}: {
  reason: ProactiveSignalReason;
  quietForMs: number;
  overdueByMs: number;
  confidence: number;
}): string {
  const subject = reason === "quiet_unresolved_thread" ? "Open thread" : "Open action";
  const quiet = `${subject} has been quiet for ${formatDuration(quietForMs)}`;
  const overdue = reason === "overdue_action"
    ? ` and is overdue by ${formatDuration(overdueByMs)}`
    : "";
  return `${quiet}${overdue}; semantic confidence is ${confidence.toFixed(2)}.`;
}

function formatDuration(durationMs: number): string {
  if (durationMs >= DAY_MS && durationMs % DAY_MS === 0) {
    return `${durationMs / DAY_MS * 24} hours`;
  }
  if (durationMs >= HOUR_MS) {
    return `${Math.floor(durationMs / HOUR_MS)} hours`;
  }
  return `${Math.floor(durationMs / (60 * 1_000))} minutes`;
}

function validatePolicy(policy: ProactiveSignalPolicy): ProactiveSignalPolicy {
  if (
    !isBoundedString(policy.policyVersion, MAX_POLICY_VERSION_CHARS) ||
    !Number.isFinite(policy.minConfidence) ||
    policy.minConfidence < 0 ||
    policy.minConfidence >= 1 ||
    !isPositiveSafeInteger(policy.quietThreadMs) ||
    !isPositiveSafeInteger(policy.quietActionMs) ||
    !isPositiveSafeInteger(policy.overdueGraceMs)
  ) {
    throw new Error("proactive signal policy is invalid");
  }
  return policy;
}

function validateSource(source: ProactiveSignalSourceSnapshot): void {
  if (
    !isBoundedString(source.sourceId, MAX_IDENTIFIER_CHARS) ||
    !isBoundedString(source.groupId, MAX_IDENTIFIER_CHARS) ||
    !Number.isSafeInteger(source.sourceVersion) ||
    source.sourceVersion < 1 ||
    !Number.isFinite(source.confidence) ||
    source.confidence < 0 ||
    source.confidence > 1
  ) {
    throw new Error("proactive signal source is invalid");
  }
  if (source.sourceType === "thread") {
    requireDate("source activity", source.lastActivityAt);
    return;
  }
  requireDate("source activity", source.updatedAt);
  if (source.dueAt !== undefined) {
    requireDate("source due time", source.dueAt);
  }
}

function isBoundedString(value: string, maxLength: number): boolean {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function requireDate(label: string, value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
