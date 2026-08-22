import type { FeishuGroupMembershipChecker } from "../feishu/feishu-group-membership-checker.js";
import type { FeishuInteractiveCardClient } from "../feishu/feishu-interactive-card-client.js";
import type { ApprovalInteractionIntent } from
  "../knowledge-cards/approval-interaction-intent-store.js";
import type { FormalTaskDraftConfirmationInteractionJob } from
  "../knowledge-cards/knowledge-card.js";

import {
  renderFormalTaskCardCommittedResult,
} from "./formal-task-card-renderer.js";
import type {
  ApplyFormalTaskCardInteractionInput,
  FormalTaskCardPresentationContext,
  FormalTaskCardRepository,
} from "./formal-task-card-repository.js";
import {
  FormalTaskCardMembershipProofError,
  FormalTaskCardOperationConflictError,
  FormalTaskCardPersistenceConflictError,
  FormalTaskCardPresentationNotFoundError,
} from "./postgres-formal-task-card-repository.js";
import {
  FormalTaskEvidenceError,
  FormalTaskOperationConflictError,
  FormalTaskPolicyConflictError,
  FormalTaskTransitionError,
  FormalTaskVersionConflictError,
} from "./postgres-formal-task-repository.js";

export type FormalTaskCardInteractionWorkerCode =
  | "formal_task_action_applied"
  | "duplicate_callback"
  | "immutable_intent_conflict"
  | "runtime_disabled"
  | "bot_actor"
  | "not_current_member"
  | "stale_presentation"
  | "invalid_membership_evidence"
  | "evidence_or_policy_invalid"
  | "membership_unavailable"
  | "repository_unavailable"
  | "internal_error";

export type FormalTaskCardInteractionWorkerResult = {
  status: "applied" | "already_applied" | "denied" | "retryable";
  code: FormalTaskCardInteractionWorkerCode;
};

export function createFormalTaskCardInteractionWorker({
  repository,
  membershipChecker,
  cardClient,
  canUseFormalTaskCards,
  botOpenId,
  now = () => new Date(),
}: {
  repository: Pick<FormalTaskCardRepository, "getPresentationContext" | "applyInteraction">;
  membershipChecker: FeishuGroupMembershipChecker;
  cardClient: Pick<FeishuInteractiveCardClient, "updateCard">;
  canUseFormalTaskCards(groupId: string): boolean;
  botOpenId: string;
  now?: () => Date;
}) {
  const safeBotOpenId = requireIdentifier("botOpenId", botOpenId);
  return {
    async processInteraction(
      job: FormalTaskDraftConfirmationInteractionJob,
      intent?: ApprovalInteractionIntent,
    ): Promise<FormalTaskCardInteractionWorkerResult> {
      const initiallyEnabled = readGate(canUseFormalTaskCards, job.chatId);
      if (initiallyEnabled === undefined) return retryable("internal_error");
      if (!initiallyEnabled) return denied("runtime_disabled");
      if (job.actorOpenId === safeBotOpenId) return denied("bot_actor");
      if (!hasRequiredIntent(job, intent)) return denied("immutable_intent_conflict");

      let context: FormalTaskCardPresentationContext | undefined;
      try {
        context = await repository.getPresentationContext(job.presentationId);
      } catch {
        return retryable("repository_unavailable");
      }
      if (!isExactContext(job, context)) return denied("stale_presentation");

      try {
        if (!await membershipChecker.isCurrentMember({ chatId: job.chatId, openId: job.actorOpenId })) {
          return denied("not_current_member");
        }
      } catch {
        return retryable("membership_unavailable");
      }

      const enabledBeforeMutation = readGate(canUseFormalTaskCards, job.chatId);
      if (enabledBeforeMutation === undefined) return retryable("internal_error");
      if (!enabledBeforeMutation) return denied("runtime_disabled");

      let result;
      try {
        const membershipCheckedAt = requireDate(now());
        result = await repository.applyInteraction(toRepositoryInput(
          job,
          intent,
          membershipCheckedAt,
          requireDate(now()),
        ));
      } catch (error) {
        return classifyError(error);
      }

      if (result.presentation.messageId !== undefined) {
        try {
          await cardClient.updateCard({
            messageId: result.presentation.messageId,
            cardJson: renderFormalTaskCardCommittedResult({
              presentation: result.presentation,
              draft: result.draft,
              result: result.committedResult,
            }),
          });
        } catch {
          // The durable presentation outbox remains authoritative for display repair.
        }
      }
      return result.outcome === "already_applied"
        ? { status: "already_applied", code: "duplicate_callback" }
        : { status: "applied", code: "formal_task_action_applied" };
    },
  };
}

function isExactContext(
  job: FormalTaskDraftConfirmationInteractionJob,
  context: FormalTaskCardPresentationContext | undefined,
): context is FormalTaskCardPresentationContext {
  if (context === undefined) return false;
  const { presentation, draft, targetPolicy } = context;
  const revision = draft.currentRevision;
  if (!("taskSpec" in revision) || revision.evidenceState.status !== "current") return false;
  const taskSpec = revision.taskSpec;
  return (presentation.state === "active" || presentation.state === "closed") &&
    presentation.id === job.presentationId &&
    presentation.draftId === job.draftId &&
    presentation.draftRevision === job.revisionNumber &&
    presentation.draftVersion === job.draftVersion &&
    presentation.taskSpecHash === job.taskSpecHash &&
    presentation.groupId === job.chatId &&
    presentation.messageId !== undefined &&
    (job.messageId === undefined || presentation.messageId === job.messageId) &&
    draft.id === job.draftId &&
    draft.sourceGroupId === job.chatId &&
    draft.currentRevisionNumber === job.revisionNumber &&
    draft.currentTaskSpecHash === job.taskSpecHash &&
    revision.taskSpecHash === job.taskSpecHash &&
    taskSpec.sourceGroupId === job.chatId &&
    taskSpec.targetPolicyId === job.targetPolicyId &&
    taskSpec.targetPolicyVersion === job.targetPolicyVersion &&
    targetPolicy.id === job.targetPolicyId &&
    targetPolicy.sourceGroupId === job.chatId &&
    targetPolicy.version === job.targetPolicyVersion &&
    targetPolicy.enabled &&
    (presentation.state === "closed" || (
      draft.status === "pending_confirmation" && draft.version === job.draftVersion
    ));
}

function toRepositoryInput(
  job: FormalTaskDraftConfirmationInteractionJob,
  intent: ApprovalInteractionIntent | undefined,
  membershipCheckedAt: Date,
  at: Date,
): ApplyFormalTaskCardInteractionInput {
  const common = {
    presentationId: job.presentationId,
    draftId: job.draftId,
    draftRevision: job.revisionNumber,
    draftVersion: job.draftVersion,
    taskSpecHash: job.taskSpecHash,
    targetPolicyId: job.targetPolicyId,
    targetPolicyVersion: job.targetPolicyVersion,
    groupId: job.chatId,
    eventId: job.eventId,
    actorOpenId: job.actorOpenId,
    membershipCheckedAt,
    at,
  };
  if (job.action === "confirm") return { ...common, action: "confirm" };
  if (job.action === "request_revision") {
    return { ...common, action: "request_revision", reason: requireReason(intent) };
  }
  return {
    ...common,
    action: "reject",
    reason: requireReason(intent),
    rejectionConfirmed: requireRejectionConfirmation(intent),
  };
}

function hasRequiredIntent(
  job: FormalTaskDraftConfirmationInteractionJob,
  intent: ApprovalInteractionIntent | undefined,
): boolean {
  if (job.action === "confirm") return intent === undefined;
  if (intent === undefined || intent.reason.trim().length === 0) return false;
  return job.action !== "reject" || intent.rejectionConfirmed === true;
}

function classifyError(error: unknown): FormalTaskCardInteractionWorkerResult {
  if (error instanceof FormalTaskCardOperationConflictError || error instanceof FormalTaskOperationConflictError) {
    return denied("immutable_intent_conflict");
  }
  if (error instanceof FormalTaskCardMembershipProofError) return denied("invalid_membership_evidence");
  if (error instanceof FormalTaskEvidenceError || error instanceof FormalTaskPolicyConflictError) {
    return denied("evidence_or_policy_invalid");
  }
  if (
    error instanceof FormalTaskCardPersistenceConflictError ||
    error instanceof FormalTaskCardPresentationNotFoundError ||
    error instanceof FormalTaskVersionConflictError ||
    error instanceof FormalTaskTransitionError
  ) return denied("stale_presentation");
  return retryable("repository_unavailable");
}

function denied(
  code: Extract<FormalTaskCardInteractionWorkerCode,
    | "immutable_intent_conflict"
    | "runtime_disabled"
    | "bot_actor"
    | "not_current_member"
    | "stale_presentation"
    | "invalid_membership_evidence"
    | "evidence_or_policy_invalid"
  >,
): FormalTaskCardInteractionWorkerResult {
  return { status: "denied", code };
}

function retryable(
  code: Extract<FormalTaskCardInteractionWorkerCode,
    "membership_unavailable" | "repository_unavailable" | "internal_error"
  >,
): FormalTaskCardInteractionWorkerResult {
  return { status: "retryable", code };
}

function readGate(gate: (groupId: string) => boolean, groupId: string): boolean | undefined {
  try {
    return gate(groupId);
  } catch {
    return undefined;
  }
}

function requireIdentifier(name: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 512) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireReason(intent: ApprovalInteractionIntent | undefined): string {
  if (intent === undefined || intent.reason.trim().length === 0) {
    throw new Error("formal task interaction reason is missing");
  }
  return intent.reason;
}

function requireRejectionConfirmation(intent: ApprovalInteractionIntent | undefined): true {
  if (intent?.rejectionConfirmed !== true) {
    throw new Error("formal task rejection confirmation is missing");
  }
  return true;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("formal task interaction time is invalid");
  }
  return new Date(value);
}
