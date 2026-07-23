import type {
  InspectedActionItem,
  InspectedDiscussionThread,
} from "../conversation-state/conversation-state-api.js";

export type ProactiveSignalKind = "quiet_open_thread" | "overdue_action";
export type ProactiveSignalPriority = "medium" | "high";
export type ProactiveSignalSuggestedMode = "ask_for_thread_update" | "ask_for_status";

export type ProactiveSignalCandidate = {
  idempotencyKey: string;
  kind: ProactiveSignalKind;
  priority: ProactiveSignalPriority;
  groupId: string;
  entityId: string;
  entityVersion: number;
  reasonCode: "thread_quiet_threshold_elapsed" | "action_due_at_elapsed";
  suggestedMode: ProactiveSignalSuggestedMode;
  lastRelevantAt: Date;
  evidenceMessageIds: string[];
};

export type PlanProactiveSignalsInput = {
  groupId: string;
  now: Date;
  threads: InspectedDiscussionThread[];
  actions: InspectedActionItem[];
  quietThreadAfterMs: number;
  overdueActionGraceMs: number;
  limit: number;
  alreadySurfacedKeys?: ReadonlySet<string>;
};

const MAX_LIMIT = 50;
const MAX_EVIDENCE_IDS = 20;

export function planProactiveSignals(input: PlanProactiveSignalsInput): ProactiveSignalCandidate[] {
  const groupId = requireNonBlank(input.groupId, "groupId");
  const now = requireDate(input.now, "now");
  const quietThreadAfterMs = requireNonNegativeMs(input.quietThreadAfterMs, "quietThreadAfterMs");
  const overdueActionGraceMs = requireNonNegativeMs(input.overdueActionGraceMs, "overdueActionGraceMs");
  const limit = sanitizeLimit(input.limit);
  const alreadySurfacedKeys = input.alreadySurfacedKeys ?? new Set<string>();

  const quietCutoff = now.getTime() - quietThreadAfterMs;
  const overdueCutoff = now.getTime() - overdueActionGraceMs;
  const signals: ProactiveSignalCandidate[] = [];

  for (const action of input.actions) {
    if (action.groupId !== groupId || action.status !== "open" || action.dueAt === undefined) continue;
    const dueAt = requireDate(action.dueAt, "action dueAt");
    if (dueAt.getTime() > overdueCutoff) continue;
    signals.push({
      idempotencyKey: buildKey("overdue_action", action.id, action.version),
      kind: "overdue_action",
      priority: "high",
      groupId,
      entityId: action.id,
      entityVersion: action.version,
      reasonCode: "action_due_at_elapsed",
      suggestedMode: "ask_for_status",
      lastRelevantAt: dueAt,
      evidenceMessageIds: boundedEvidenceIds(action.evidenceMessageIds),
    });
  }

  for (const thread of input.threads) {
    if (thread.groupId !== groupId || thread.status !== "open") continue;
    const lastActivityAt = requireDate(thread.lastActivityAt, "thread lastActivityAt");
    if (lastActivityAt.getTime() > quietCutoff) continue;
    signals.push({
      idempotencyKey: buildKey("quiet_open_thread", thread.id, thread.version),
      kind: "quiet_open_thread",
      priority: "medium",
      groupId,
      entityId: thread.id,
      entityVersion: thread.version,
      reasonCode: "thread_quiet_threshold_elapsed",
      suggestedMode: "ask_for_thread_update",
      lastRelevantAt: lastActivityAt,
      evidenceMessageIds: boundedEvidenceIds(thread.evidenceMessageIds),
    });
  }

  return signals
    .filter((signal) => !alreadySurfacedKeys.has(signal.idempotencyKey))
    .sort(compareSignals)
    .slice(0, limit);
}

function compareSignals(left: ProactiveSignalCandidate, right: ProactiveSignalCandidate): number {
  const priority = priorityWeight(right.priority) - priorityWeight(left.priority);
  if (priority !== 0) return priority;
  const time = left.lastRelevantAt.getTime() - right.lastRelevantAt.getTime();
  if (time !== 0) return time;
  return left.idempotencyKey.localeCompare(right.idempotencyKey);
}

function priorityWeight(priority: ProactiveSignalPriority): number {
  return priority === "high" ? 2 : 1;
}

function buildKey(kind: ProactiveSignalKind, entityId: string, entityVersion: number): string {
  return `${kind}:${requireNonBlank(entityId, "entityId")}:${requirePositiveVersion(entityVersion)}`;
}

function boundedEvidenceIds(ids: string[]): string[] {
  return ids
    .filter((id) => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim())
    .slice(0, MAX_EVIDENCE_IDS);
}

function sanitizeLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("limit is invalid");
  return Math.min(value, MAX_LIMIT);
}

function requireNonBlank(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is invalid`);
  return value.trim();
}

function requirePositiveVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("entity version is invalid");
  return value;
}

function requireNonNegativeMs(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function requireDate(value: Date, label: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}
