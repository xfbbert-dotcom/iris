import type { FeishuGroupMembershipChecker } from "../feishu/feishu-group-membership-checker.js";
import type { FeishuInteractiveCardClient } from "../feishu/feishu-interactive-card-client.js";
import { KnowledgeDraftEvidenceError } from "../knowledge-governance/postgres-knowledge-draft-evidence.js";
import type { ActionProposalApprovalInteractionJob } from "../knowledge-cards/knowledge-card.js";

import type {
  ActionApprovalDeliveryContext,
  ActionProposalRepository,
  ApplyActionProposalActionResult,
} from "./action-proposal-repository.js";
import {
  ActionProposalAuthorizationError,
  ActionProposalIneligibleError,
  ActionProposalOperationConflictError,
  ActionProposalPersistenceConflictError,
  ActionProposalVersionConflictError,
} from "./postgres-action-proposal-repository.js";

export type ActionApprovalWorkerCode =
  | "action_approval_applied"
  | "duplicate_callback"
  | "runtime_disabled"
  | "bot_actor"
  | "not_current_member"
  | "not_authorized"
  | "stale_presentation"
  | "evidence_or_policy_invalid"
  | "immutable_intent_conflict"
  | "membership_unavailable"
  | "repository_unavailable"
  | "internal_error";

export type ActionApprovalWorkerResult = {
  status: "applied" | "already_applied" | "denied" | "retryable";
  code: ActionApprovalWorkerCode;
};

export function createActionApprovalWorker({
  repository,
  membershipChecker,
  cardClient,
  isActionApprovalRuntimeEnabled,
  canUseActionApprovalsForSourceGroup,
  botOpenId,
  now = () => new Date(),
}: {
  repository: Pick<ActionProposalRepository,
    | "getApprovalDeliveryContext"
    | "preflightApprovalAction"
    | "applyApprovalAction"
    | "listApprovalPresentations"
  >;
  membershipChecker: FeishuGroupMembershipChecker;
  cardClient: Pick<FeishuInteractiveCardClient, "updateCard">;
  isActionApprovalRuntimeEnabled(): boolean;
  canUseActionApprovalsForSourceGroup(groupId?: string): boolean;
  botOpenId: string;
  now?: () => Date;
}) {
  const safeBotOpenId = requireIdentifier("botOpenId", botOpenId);
  return {
    async processActionApproval(
      job: ActionProposalApprovalInteractionJob,
    ): Promise<ActionApprovalWorkerResult> {
      if (!readGate(isActionApprovalRuntimeEnabled)) return denied("runtime_disabled");
      if (job.actorOpenId === safeBotOpenId) return denied("bot_actor");
      let context: ActionApprovalDeliveryContext | undefined;
      try {
        context = await repository.getApprovalDeliveryContext(job.presentationId);
      } catch {
        return retryable("repository_unavailable");
      }
      if (!isExactContext(job, context)) return denied("stale_presentation");

      let sourceGroupId: string | undefined;
      try {
        const preflight = await repository.preflightApprovalAction(toPreflightInput(job));
        sourceGroupId = preflight.sourceGroupId;
      } catch (error) {
        return classifyStableOrRetryable(error);
      }
      if (!readGroupGate(canUseActionApprovalsForSourceGroup, sourceGroupId)) {
        return denied("runtime_disabled");
      }
      if (sourceGroupId !== undefined) {
        try {
          if (!await membershipChecker.isCurrentMember({
            chatId: sourceGroupId,
            openId: job.actorOpenId,
          })) return denied("not_current_member");
        } catch {
          return retryable("membership_unavailable");
        }
      }
      if (
        !readGate(isActionApprovalRuntimeEnabled) ||
        !readGroupGate(canUseActionApprovalsForSourceGroup, sourceGroupId)
      ) return denied("runtime_disabled");

      let mutation: ApplyActionProposalActionResult;
      try {
        mutation = await repository.applyApprovalAction(toMutationInput(job, requireDate(now())));
      } catch (error) {
        return classifyStableOrRetryable(error);
      }
      await updateProposalCards(repository, cardClient, mutation);
      return mutation.outcome === "already_applied"
        ? { status: "already_applied", code: "duplicate_callback" }
        : { status: "applied", code: "action_approval_applied" };
    },
  };
}

function isExactContext(
  job: ActionProposalApprovalInteractionJob,
  value: ActionApprovalDeliveryContext | undefined,
): value is ActionApprovalDeliveryContext {
  if (value === undefined) return false;
  const { proposal } = value.context;
  const { presentation, requirement, policy } = value;
  return proposal.id === job.proposalId &&
    proposal.status === "pending_approval" &&
    proposal.version === job.proposalVersion &&
    proposal.subjectRevision === job.subjectRevision &&
    proposal.subjectVersion === job.subjectVersion &&
    proposal.targetPolicyVersion === job.targetPolicyVersion &&
    policy.id === proposal.targetPolicyId &&
    policy.version === job.targetPolicyVersion &&
    policy.enabled &&
    requirement.id === job.requirementId &&
    requirement.proposalId === proposal.id &&
    requirement.state === "pending" &&
    presentation.id === job.presentationId &&
    presentation.proposalId === proposal.id &&
    presentation.requirementId === requirement.id &&
    presentation.proposalVersion === proposal.version &&
    presentation.recipientOpenId === job.actorOpenId &&
    presentation.state === "active" &&
    presentation.messageId !== undefined &&
    (job.messageId === undefined || job.messageId === presentation.messageId);
}

function toPreflightInput(job: ActionProposalApprovalInteractionJob) {
  return {
    proposalId: job.proposalId,
    requirementId: job.requirementId,
    expectedProposalVersion: job.proposalVersion,
    expectedSubjectRevision: job.subjectRevision,
    expectedSubjectVersion: job.subjectVersion,
    expectedTargetPolicyVersion: job.targetPolicyVersion,
    sourcePresentationId: job.presentationId,
    actorOpenId: job.actorOpenId,
  };
}

function toMutationInput(job: ActionProposalApprovalInteractionJob, at: Date) {
  const common = {
    ...toPreflightInput(job),
    callbackEventId: job.eventId,
    operationKey: `action-approval:${job.appId}:${job.eventId}`,
    at,
  };
  const { expectedTargetPolicyVersion: _policyVersion, ...mutationCommon } = common;
  if (job.action === "approve") return { ...mutationCommon, action: "approve" as const };
  if (job.action === "request_revision") {
    return { ...mutationCommon, action: "request_revision" as const, reason: requireReason(job.reason) };
  }
  return {
    ...mutationCommon,
    action: "reject" as const,
    reason: requireReason(job.reason),
    rejectionConfirmed: true,
  };
}

async function updateProposalCards(
  repository: Pick<ActionProposalRepository, "listApprovalPresentations">,
  cardClient: Pick<FeishuInteractiveCardClient, "updateCard">,
  mutation: ApplyActionProposalActionResult,
): Promise<void> {
  let presentations;
  try {
    presentations = await repository.listApprovalPresentations({
      proposalId: mutation.proposal.id,
      limit: 100,
    });
  } catch {
    return;
  }
  const cardJson = renderCommittedResult(mutation);
  for (const presentation of presentations) {
    if (presentation.messageId === undefined) continue;
    try {
      await cardClient.updateCard({ messageId: presentation.messageId, cardJson });
    } catch {
      // PostgreSQL approval facts are authoritative; display repair can run separately.
    }
  }
}

function renderCommittedResult(result: ApplyActionProposalActionResult): string {
  const marker = result.action === "approve"
    ? "publication_approved"
    : result.action === "request_revision" ? "revision_requested" : "publication_rejected";
  return JSON.stringify({
    schema: "2.0",
    header: {
      template: result.action === "approve" ? "green" : result.action === "reject" ? "red" : "orange",
      title: { tag: "plain_text", content: "Knowledge publication review" },
    },
    body: {
      elements: [{
        tag: "markdown",
        content: [
          `Iris / ${marker}`,
          `Proposal status: ${result.proposal.status}`,
          `Draft status: ${result.draftStatus}`,
          `Draft version: ${result.draftVersion}`,
        ].join("\n"),
      }],
    },
  });
}

function classifyStableOrRetryable(error: unknown): ActionApprovalWorkerResult {
  if (error instanceof ActionProposalAuthorizationError) return denied("not_authorized");
  if (error instanceof ActionProposalIneligibleError || error instanceof KnowledgeDraftEvidenceError) {
    return denied("evidence_or_policy_invalid");
  }
  if (error instanceof ActionProposalVersionConflictError || error instanceof ActionProposalPersistenceConflictError) {
    return denied("stale_presentation");
  }
  if (error instanceof ActionProposalOperationConflictError) return denied("immutable_intent_conflict");
  return retryable("repository_unavailable");
}

function denied(code: Extract<ActionApprovalWorkerCode,
  "runtime_disabled" | "bot_actor" | "not_current_member" | "not_authorized" |
  "stale_presentation" | "evidence_or_policy_invalid" | "immutable_intent_conflict"
>): ActionApprovalWorkerResult {
  return { status: "denied", code };
}

function retryable(code: Extract<ActionApprovalWorkerCode,
  "membership_unavailable" | "repository_unavailable" | "internal_error"
>): ActionApprovalWorkerResult {
  return { status: "retryable", code };
}

function readGate(gate: () => boolean): boolean {
  try { return gate(); } catch { return false; }
}

function readGroupGate(gate: (groupId?: string) => boolean, groupId?: string): boolean {
  try { return gate(groupId); } catch { return false; }
}

function requireIdentifier(name: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 512) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireReason(value: string | undefined): string {
  if (value === undefined) throw new Error("action approval reason is missing");
  return value;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("action approval time is invalid");
  return new Date(value);
}
