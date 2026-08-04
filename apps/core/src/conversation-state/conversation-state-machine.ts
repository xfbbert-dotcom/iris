import type {
  ActionItemEventType,
  ActionItemStatus,
  DiscussionThreadEventType,
  DiscussionThreadStatus,
} from "./conversation-state-repository.js";

type TransitionResult = { ok: true } | { ok: false; code: string };

const THREAD_TRANSITIONS = new Set([
  "candidate:candidate:corrected",
  "candidate:candidate:evidence_attached",
  "candidate:open:promoted",
  "candidate:merged:merged",
  "open:open:summary_updated",
  "open:open:corrected",
  "open:open:evidence_attached",
  "open:resolved:resolved",
  "open:merged:merged",
  "resolved:resolved:corrected",
  "resolved:open:reopened",
  "resolved:merged:merged",
]);

const ACTION_TRANSITIONS = new Set([
  "open:completed:completed",
  "open:cancelled:cancelled",
  "open:open:corrected",
  "open:open:owner_resolved",
  "completed:open:reopened",
  "completed:completed:corrected",
  "completed:completed:owner_resolved",
  "cancelled:open:reopened",
  "cancelled:cancelled:corrected",
  "cancelled:cancelled:owner_resolved",
]);

const THREAD_STATUS_RANK: Record<DiscussionThreadStatus, number> = {
  open: 0,
  resolved: 1,
  candidate: 2,
  merged: 3,
};

export function validateThreadTransition(input: {
  from: DiscussionThreadStatus;
  to: DiscussionThreadStatus;
  eventType: DiscussionThreadEventType;
}): TransitionResult {
  if (input.from === "merged") {
    return { ok: false, code: "merged_thread_immutable" };
  }
  return THREAD_TRANSITIONS.has(`${input.from}:${input.to}:${input.eventType}`)
    ? { ok: true }
    : { ok: false, code: "invalid_thread_transition" };
}

export function validateActionTransition(input: {
  from: ActionItemStatus;
  to: ActionItemStatus;
  eventType: ActionItemEventType;
  evidenceCount: number;
}): TransitionResult {
  if (input.eventType === "completed" && input.evidenceCount < 1) {
    return { ok: false, code: "completion_evidence_required" };
  }
  return ACTION_TRANSITIONS.has(`${input.from}:${input.to}:${input.eventType}`)
    ? { ok: true }
    : { ok: false, code: "invalid_action_transition" };
}

export function selectCanonicalMergeTarget<T extends {
  id: string;
  status: DiscussionThreadStatus;
  evidenceCount: number;
  createdAt: Date;
}>(threads: readonly T[]): string {
  if (threads.length === 0) {
    throw new Error("merge target candidates must not be empty");
  }
  return [...threads].sort((left, right) => {
    const rankDifference = THREAD_STATUS_RANK[left.status] - THREAD_STATUS_RANK[right.status];
    if (rankDifference !== 0) return rankDifference;
    const evidenceDifference = right.evidenceCount - left.evidenceCount;
    if (evidenceDifference !== 0) return evidenceDifference;
    const creationDifference = left.createdAt.getTime() - right.createdAt.getTime();
    if (creationDifference !== 0) return creationDifference;
    return left.id.localeCompare(right.id);
  })[0]!.id;
}
