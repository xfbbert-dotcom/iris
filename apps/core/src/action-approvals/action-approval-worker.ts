import { createHash } from "node:crypto";

import type { AgentExecutionObserver } from "../agent-runtime/agent-execution-observer.js";
import type { FeishuGroupMembershipChecker } from "../feishu/feishu-group-membership-checker.js";
import type { FeishuInteractiveCardClient } from "../feishu/feishu-interactive-card-client.js";
import { KnowledgeDraftEvidenceError } from "../knowledge-governance/postgres-knowledge-draft-evidence.js";
import type { ActionProposalApprovalInteractionJob } from "../knowledge-cards/knowledge-card.js";
import type { ApprovalInteractionIntent } from "../knowledge-cards/approval-interaction-intent-store.js";

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
  ActionProposalReviewRequiredError,
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
  | "review_required"
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
  requireReviewAttestation,
  botOpenId,
  now = () => new Date(),
  agentExecutionObserver,
}: {
  repository: Pick<ActionProposalRepository,
    | "getApprovalDeliveryContext"
    | "inspectApprovalActionReplay"
    | "preflightApprovalAction"
    | "applyApprovalAction"
    | "listApprovalPresentations"
  >;
  membershipChecker: FeishuGroupMembershipChecker;
  cardClient: Pick<FeishuInteractiveCardClient, "updateCard">;
  isActionApprovalRuntimeEnabled(): boolean;
  canUseActionApprovalsForSourceGroup(groupId?: string): boolean;
  requireReviewAttestation: boolean;
  botOpenId: string;
  now?: () => Date;
  agentExecutionObserver?: AgentExecutionObserver;
}) {
  const safeBotOpenId = requireIdentifier("botOpenId", botOpenId);
  return {
    async processActionApproval(
      job: ActionProposalApprovalInteractionJob,
      intent?: ApprovalInteractionIntent,
    ): Promise<ActionApprovalWorkerResult> {
      let observationGroupId: string | undefined;
      const process = async (): Promise<ActionApprovalWorkerResult> => {
        if (!readGate(isActionApprovalRuntimeEnabled)) return denied("runtime_disabled");
        if (job.actorOpenId === safeBotOpenId) return denied("bot_actor");

        let replay;
        try {
          replay = await repository.inspectApprovalActionReplay(
            toMutationInput(job, intent, requireReviewAttestation),
          );
        } catch (error) {
          return classifyStableOrRetryable(error);
        }
        if (replay !== undefined) {
          observationGroupId = replay.sourceGroupId;
          if (!readGroupGate(canUseActionApprovalsForSourceGroup, replay.sourceGroupId)) {
            return denied("runtime_disabled");
          }
          if (replay.sourceGroupId !== undefined) {
            try {
              if (!await membershipChecker.isCurrentMember({
                chatId: replay.sourceGroupId,
                openId: job.actorOpenId,
              })) return denied("not_current_member");
            } catch {
              return retryable("membership_unavailable");
            }
          }
          if (
            !readGate(isActionApprovalRuntimeEnabled) ||
            !readGroupGate(canUseActionApprovalsForSourceGroup, replay.sourceGroupId)
          ) return denied("runtime_disabled");
          await updateProposalCards(repository, cardClient, replay.result);
          return { status: "already_applied", code: "duplicate_callback" };
        }

        let context: ActionApprovalDeliveryContext | undefined;
        try {
          context = await repository.getApprovalDeliveryContext(job.presentationId);
        } catch {
          return retryable("repository_unavailable");
        }
        if (!isExactContext(job, context)) return denied("stale_presentation");

        try {
          const preflight = await repository.preflightApprovalAction(
            toPreflightInput(job, requireReviewAttestation),
          );
          observationGroupId = preflight.sourceGroupId;
        } catch (error) {
          return classifyStableOrRetryable(error);
        }
        if (!readGroupGate(canUseActionApprovalsForSourceGroup, observationGroupId)) {
          return denied("runtime_disabled");
        }
        if (observationGroupId !== undefined) {
          try {
            if (!await membershipChecker.isCurrentMember({
              chatId: observationGroupId,
              openId: job.actorOpenId,
            })) return denied("not_current_member");
          } catch {
            return retryable("membership_unavailable");
          }
        }
        if (
          !readGate(isActionApprovalRuntimeEnabled) ||
          !readGroupGate(canUseActionApprovalsForSourceGroup, observationGroupId)
        ) return denied("runtime_disabled");

        let mutation: ApplyActionProposalActionResult;
        try {
          mutation = await repository.applyApprovalAction(
            toMutationInput(job, intent, requireReviewAttestation),
          );
        } catch (error) {
          return classifyStableOrRetryable(error);
        }
        await updateProposalCards(repository, cardClient, mutation);
        return mutation.outcome === "already_applied"
          ? { status: "already_applied", code: "duplicate_callback" }
          : { status: "applied", code: "action_approval_applied" };
      };

      const result = await process();
      await observeActionApprovalResult({
        observer: agentExecutionObserver,
        job,
        result,
        sourceGroupId: observationGroupId,
      });
      return result;
    },
  };
}

async function observeActionApprovalResult(input: {
  observer: AgentExecutionObserver | undefined;
  job: ActionProposalApprovalInteractionJob;
  result: ActionApprovalWorkerResult;
  sourceGroupId: string | undefined;
}): Promise<void> {
  if (input.observer === undefined || input.result.status === "already_applied") {
    return;
  }

  const operationDigest = createHash("sha256")
    .update(`${input.job.appId}:${input.job.eventId}`)
    .digest("hex");
  const common = {
    ...(input.sourceGroupId === undefined ? {} : { groupId: input.sourceGroupId }),
    actorOpenId: input.job.actorOpenId,
    subjectId: input.job.proposalId,
    operationKey: `action-approval:${operationDigest}:${input.result.code}`,
    metadata: {
      presentationId: input.job.presentationId,
      proposalVersion: input.job.proposalVersion,
      subjectRevision: input.job.subjectRevision,
      subjectVersion: input.job.subjectVersion,
      targetPolicyVersion: input.job.targetPolicyVersion,
      action: input.job.action,
    },
    at: input.job.receivedAt,
  } as const;

  try {
    if (input.result.status === "applied") {
      const approved = input.job.action === "approve";
      await input.observer.observe({
        ...common,
        subjectType: "action_proposal",
        eventType: approved ? "action_approved" : "action_rejected",
        phase: "approval_wait",
        outcome: approved ? "success" : "denied",
        decisionReason: approved
          ? "publication_approved"
          : input.job.action === "request_revision"
            ? "revision_requested"
            : "publication_rejected",
      });
      return;
    }

    await input.observer.observe({
      ...common,
      subjectType: "permission_decision",
      eventType: input.result.status === "denied"
        ? "permission_denied"
        : "permission_error",
      phase: "permission_prompt",
      outcome: input.result.status === "denied" ? "denied" : "error",
      decisionReason: input.result.code,
    });
  } catch {
    // Approval facts remain authoritative when execution observation is unavailable.
  }
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

function toPreflightInput(
  job: ActionProposalApprovalInteractionJob,
  requireReviewAttestation: boolean,
) {
  return {
    proposalId: job.proposalId,
    requirementId: job.requirementId,
    expectedProposalVersion: job.proposalVersion,
    expectedSubjectRevision: job.subjectRevision,
    expectedSubjectVersion: job.subjectVersion,
    expectedTargetPolicyVersion: job.targetPolicyVersion,
    sourcePresentationId: job.presentationId,
    actorOpenId: job.actorOpenId,
    action: job.action,
    requireReviewAttestation,
  };
}

function toMutationInput(
  job: ActionProposalApprovalInteractionJob,
  intent?: ApprovalInteractionIntent,
  requireReviewAttestation = false,
) {
  const common = {
    ...toPreflightInput(job, requireReviewAttestation),
    callbackEventId: job.eventId,
    operationKey: `action-approval:${job.appId}:${job.eventId}`,
    at: requireDate(job.receivedAt),
  };
  if (job.action === "approve") return { ...common, action: "approve" as const };
  if (job.action === "request_revision") {
    return { ...common, action: "request_revision" as const, reason: requireReason(intent?.reason) };
  }
  return {
    ...common,
    action: "reject" as const,
    reason: requireReason(intent?.reason),
    rejectionConfirmed: requireRejectionConfirmation(intent),
  };
}

async function updateProposalCards(
  repository: Pick<ActionProposalRepository, "listApprovalPresentations">,
  cardClient: Pick<FeishuInteractiveCardClient, "updateCard">,
  mutation: ApplyActionProposalActionResult,
): Promise<void> {
  const cardJson = renderCommittedResult(mutation);
  let afterId: string | undefined;
  while (true) {
    let presentations;
    try {
      presentations = await repository.listApprovalPresentations({
        proposalId: mutation.proposal.id,
        ...(afterId === undefined ? {} : { afterId }),
        limit: 100,
      });
    } catch {
      return;
    }
    for (const presentation of presentations) {
      if (presentation.messageId === undefined) continue;
      try {
        await cardClient.updateCard({ messageId: presentation.messageId, cardJson });
      } catch {
        // PostgreSQL approval facts are authoritative; display repair can run separately.
      }
    }
    if (presentations.length < 100) return;
    const nextAfterId = presentations.at(-1)?.id;
    if (nextAfterId === undefined || nextAfterId === afterId) return;
    afterId = nextAfterId;
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
  if (error instanceof ActionProposalReviewRequiredError) return denied("review_required");
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
  "stale_presentation" | "evidence_or_policy_invalid" | "review_required" | "immutable_intent_conflict"
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

function requireRejectionConfirmation(value: ApprovalInteractionIntent | undefined): true {
  if (value?.rejectionConfirmed !== true) throw new Error("action approval rejection confirmation is missing");
  return true;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("action approval time is invalid");
  return new Date(value);
}
