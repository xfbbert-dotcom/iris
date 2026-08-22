import { createHash } from "node:crypto";

import type {
  FormalTaskCardRepository,
  FormalTaskDraftPresentation,
} from "./formal-task-card-repository.js";
import { renderFormalTaskDraftCard } from "./formal-task-card-renderer.js";
import type { FormalTaskRepository } from "./formal-task-repository.js";

export const FORMAL_TASK_DRAFT_PRESENTATION_ERROR_CODES = [
  "formal_task_draft_not_found",
  "iris_runtime_disabled",
  "formal_task_card_conflict",
  "formal_task_evidence_invalid",
  "formal_task_policy_unavailable",
  "review_surface_required",
] as const;

export type FormalTaskDraftPresentationErrorCode =
  (typeof FORMAL_TASK_DRAFT_PRESENTATION_ERROR_CODES)[number];

export class FormalTaskDraftPresentationServiceError extends Error {
  constructor(public readonly code: FormalTaskDraftPresentationErrorCode) {
    super(code);
    this.name = "FormalTaskDraftPresentationServiceError";
  }
}

export type FormalTaskDraftPresentationRuntime = {
  repository: Pick<FormalTaskRepository, "getDraft" | "getTargetPolicy">;
  cardRepository: Pick<FormalTaskCardRepository, "getPresentation" | "createPresentation">;
  canUseFormalTaskCards(groupId: string): boolean;
};

export async function presentFormalTaskDraft(input: {
  runtime: FormalTaskDraftPresentationRuntime;
  draftId: string;
  expectedVersion: number;
  operationKey: string;
  at: Date;
}): Promise<{
  outcome: "applied" | "already_applied";
  presentation: FormalTaskDraftPresentation;
}> {
  const at = requireDate(input.at);
  const draft = await input.runtime.repository.getDraft(requireReference("draftId", input.draftId));
  if (draft === undefined) throw serviceError("formal_task_draft_not_found");
  if (!readRuntimeGate(input.runtime, draft.sourceGroupId)) {
    throw serviceError("iris_runtime_disabled");
  }
  if (
    draft.status !== "pending_confirmation" ||
    draft.version !== requirePositiveInteger("expectedVersion", input.expectedVersion) ||
    draft.currentRevision.revisionNumber !== draft.currentRevisionNumber
  ) throw serviceError("formal_task_card_conflict");
  const revision = draft.currentRevision;
  if (!("taskSpec" in revision)) throw serviceError("formal_task_evidence_invalid");
  const taskSpec = revision.taskSpec;
  const policy = await input.runtime.repository.getTargetPolicy(taskSpec.targetPolicyId);
  if (
    policy === undefined ||
    !policy.enabled ||
    policy.id !== taskSpec.targetPolicyId ||
    policy.sourceGroupId !== draft.sourceGroupId ||
    policy.version !== taskSpec.targetPolicyVersion ||
    !policy.allowedAssigneeOpenIds.includes(taskSpec.assigneeOpenId) ||
    !dueWithinPolicy(taskSpec.dueAtUtc, policy.maxDueHorizonDays, at)
  ) throw serviceError("formal_task_policy_unavailable");

  const operationKey = requireReference("operationKey", input.operationKey);
  const presentationId = stablePresentationId({
    draftId: draft.id,
    draftRevision: draft.currentRevisionNumber,
    operationKey,
  });
  const pendingPresentation: FormalTaskDraftPresentation = {
    id: presentationId,
    draftId: draft.id,
    draftRevision: draft.currentRevisionNumber,
    draftVersion: draft.version,
    taskSpecHash: draft.currentTaskSpecHash,
    groupId: draft.sourceGroupId,
    state: "pending_send",
    createdAt: at,
    version: 1,
  };
  const rendered = renderFormalTaskDraftCard({
    draft,
    presentation: pendingPresentation,
    targetDisplayName: policy.displayName,
  });
  if (rendered.status === "review_required") throw serviceError("review_surface_required");

  const existing = await input.runtime.cardRepository.getPresentation(presentationId);
  if (existing !== undefined) {
    if (!matchesPresentation(existing, pendingPresentation)) {
      throw serviceError("formal_task_card_conflict");
    }
    return { outcome: "already_applied", presentation: existing };
  }
  try {
    const result = await input.runtime.cardRepository.createPresentation({
      id: presentationId,
      draftId: draft.id,
      expectedDraftVersion: draft.version,
      expectedDraftRevision: draft.currentRevisionNumber,
      taskSpecHash: draft.currentTaskSpecHash,
      groupId: draft.sourceGroupId,
      operationKey,
      at,
    });
    return { outcome: result.outcome, presentation: result.presentation };
  } catch {
    const concurrent = await input.runtime.cardRepository.getPresentation(presentationId);
    if (concurrent !== undefined && matchesPresentation(concurrent, pendingPresentation)) {
      return { outcome: "already_applied", presentation: concurrent };
    }
    throw serviceError("formal_task_card_conflict");
  }
}

function matchesPresentation(
  presentation: FormalTaskDraftPresentation,
  expected: FormalTaskDraftPresentation,
): boolean {
  return presentation.id === expected.id &&
    presentation.draftId === expected.draftId &&
    presentation.draftRevision === expected.draftRevision &&
    presentation.draftVersion === expected.draftVersion &&
    presentation.taskSpecHash === expected.taskSpecHash &&
    presentation.groupId === expected.groupId;
}

function stablePresentationId(input: {
  draftId: string;
  draftRevision: number;
  operationKey: string;
}): string {
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 40);
  return `formal-task-card-${digest}`;
}

function dueWithinPolicy(
  dueAtUtc: string | undefined,
  maximumDays: number,
  at: Date,
): boolean {
  if (dueAtUtc === undefined) return true;
  const dueAt = new Date(dueAtUtc);
  return dueAt.getTime() >= at.getTime() &&
    dueAt.getTime() <= at.getTime() + maximumDays * 86_400_000;
}

function readRuntimeGate(runtime: FormalTaskDraftPresentationRuntime, groupId: string): boolean {
  try {
    return runtime.canUseFormalTaskCards(groupId);
  } catch {
    return false;
  }
}

function requireReference(name: string, value: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 512) throw new Error(`${name} is invalid`);
  return normalized;
}

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} is invalid`);
  return value;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("formal task presentation time must be valid");
  }
  return new Date(value);
}

function serviceError(
  code: FormalTaskDraftPresentationErrorCode,
): FormalTaskDraftPresentationServiceError {
  return new FormalTaskDraftPresentationServiceError(code);
}
