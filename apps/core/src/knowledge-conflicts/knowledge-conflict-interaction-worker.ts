import { createHash } from "node:crypto";

import type {
  ActionProposalRepository,
  PublicationTargetPolicy,
} from "../action-approvals/action-proposal-repository.js";
import type { FeishuGroupMembershipChecker } from
  "../feishu/feishu-group-membership-checker.js";
import type { KnowledgeConflictConfirmationInteractionJob } from
  "../knowledge-cards/knowledge-card.js";
import {
  presentKnowledgeDraft as defaultPresentKnowledgeDraft,
  type KnowledgeDraftPresentationRuntime,
} from "../knowledge-cards/knowledge-draft-presentation-service.js";
import type { KnowledgeDraftRevisionInput } from "../knowledge-governance/knowledge-draft.js";
import type { KnowledgeDraftRepository } from
  "../knowledge-governance/knowledge-draft-repository.js";
import { createKnowledgeConflictCallbackNonce } from "./knowledge-conflict-card-renderer.js";
import type { KnowledgeConflictCurrentValidator } from
  "./knowledge-conflict-current-validator.js";
import {
  KnowledgeConflictDeliveryConflictError,
  KnowledgeConflictNotFoundError,
  KnowledgeConflictOperationConflictError,
  KnowledgeConflictStaleEvidenceError,
  KnowledgeConflictVersionConflictError,
  type KnowledgeConflictDelivery,
  type KnowledgeConflictRepository,
} from "./knowledge-conflict-repository.js";
import type { KnowledgeConflictCandidate } from "./knowledge-conflict.js";

const POLICY_LIMIT = 100;

export type KnowledgeConflictInteractionWorkerCode =
  | "draft_created"
  | "conflict_dismissed"
  | "duplicate_callback"
  | "runtime_disabled"
  | "bot_actor"
  | "not_current_member"
  | "membership_unavailable"
  | "stale_delivery"
  | "stale_candidate"
  | "evidence_invalidated"
  | "permission_blocked"
  | "validation_unavailable"
  | "target_unavailable"
  | "immutable_intent_conflict"
  | "repository_unavailable"
  | "presentation_unavailable"
  | "internal_error";

export type KnowledgeConflictInteractionWorkerResult =
  | {
      status: "applied" | "already_applied";
      code: "draft_created" | "duplicate_callback";
      draftId: string;
      presentationId: string;
    }
  | {
      status: "applied" | "already_applied";
      code: "conflict_dismissed" | "duplicate_callback";
    }
  | {
      status: "denied";
      code: Extract<KnowledgeConflictInteractionWorkerCode,
        | "runtime_disabled"
        | "bot_actor"
        | "not_current_member"
        | "stale_delivery"
        | "stale_candidate"
        | "evidence_invalidated"
        | "permission_blocked"
        | "target_unavailable"
        | "immutable_intent_conflict"
      >;
    }
  | {
      status: "retryable";
      code: Extract<KnowledgeConflictInteractionWorkerCode,
        | "membership_unavailable"
        | "validation_unavailable"
        | "repository_unavailable"
        | "presentation_unavailable"
        | "internal_error"
      >;
    };

export type KnowledgeConflictInteractionWorkerDependencies = {
  repository: Pick<
    KnowledgeConflictRepository,
    "getCandidate" | "getDeliveryForCandidate" | "applyInteraction"
  >;
  currentValidator: KnowledgeConflictCurrentValidator;
  membershipChecker: FeishuGroupMembershipChecker;
  drafts: Pick<KnowledgeDraftRepository, "getDraft" | "createDraft">;
  publicationTargets: Pick<ActionProposalRepository, "listTargetPolicies">;
  cardRuntime: KnowledgeDraftPresentationRuntime;
  canProcessKnowledgeConflicts(groupId: string): boolean;
  botOpenId: string;
  now?: () => Date;
  presentKnowledgeDraft?: typeof defaultPresentKnowledgeDraft;
};

export function createKnowledgeConflictInteractionWorker(
  dependencies: KnowledgeConflictInteractionWorkerDependencies,
) {
  const botOpenId = requireReference("botOpenId", dependencies.botOpenId);
  const now = dependencies.now ?? (() => new Date());
  const presentKnowledgeDraft = dependencies.presentKnowledgeDraft ?? defaultPresentKnowledgeDraft;

  return {
    async processInteraction(
      job: KnowledgeConflictConfirmationInteractionJob,
    ): Promise<KnowledgeConflictInteractionWorkerResult> {
      if (!readGate(dependencies.canProcessKnowledgeConflicts, job.groupId)) {
        return denied("runtime_disabled");
      }

      let candidate: KnowledgeConflictCandidate | undefined;
      let delivery: KnowledgeConflictDelivery | undefined;
      try {
        [candidate, delivery] = await Promise.all([
          dependencies.repository.getCandidate(job.candidateId),
          dependencies.repository.getDeliveryForCandidate(job.candidateId),
        ]);
      } catch {
        return retryable("repository_unavailable");
      }
      if (!isExactCandidateBinding(candidate, job)) return denied("stale_candidate");
      if (!isExactDeliveryBinding(delivery, job)) return denied("stale_delivery");
      if (job.actorOpenId === botOpenId) return denied("bot_actor");

      let currentMember: boolean;
      try {
        currentMember = await dependencies.membershipChecker.isCurrentMember({
          chatId: job.groupId,
          openId: job.actorOpenId,
        });
      } catch {
        return retryable("membership_unavailable");
      }
      if (!currentMember) return denied("not_current_member");
      if (!readGate(dependencies.canProcessKnowledgeConflicts, job.groupId)) {
        return denied("runtime_disabled");
      }

      let targetPolicy: PublicationTargetPolicy | undefined;
      if (job.action === "create_update_draft") {
        try {
          targetPolicy = selectTargetPolicy(
            await dependencies.publicationTargets.listTargetPolicies({
              enabled: true,
              limit: POLICY_LIMIT,
            }),
            job.groupId,
          );
        } catch {
          return retryable("repository_unavailable");
        }
        if (targetPolicy === undefined) return denied("target_unavailable");
      }

      let validation: Awaited<ReturnType<KnowledgeConflictCurrentValidator["validate"]>>;
      try {
        validation = await dependencies.currentValidator.validate({
          candidate,
          expectedVersion: candidate.version,
        });
      } catch (error) {
        return error instanceof KnowledgeConflictVersionConflictError
          ? denied("stale_candidate")
          : retryable("validation_unavailable");
      }
      if (validation.status === "superseded") return denied("evidence_invalidated");
      if (validation.status === "permission_blocked") return denied("permission_blocked");
      if (validation.status === "validation_unavailable") return retryable("validation_unavailable");
      if (!sameCandidateState(candidate, validation.candidate)) return denied("stale_candidate");

      if (job.action === "not_a_conflict") {
        if (!readGate(dependencies.canProcessKnowledgeConflicts, job.groupId)) {
          return denied("runtime_disabled");
        }
        const interactionAt = requireDate(now());
        try {
          const mutation = await dependencies.repository.applyInteraction({
            id: interactionIdentity(job.idempotencyKey),
            candidateId: candidate.id,
            expectedVersion: job.candidateVersion,
            callbackOperationKey: job.idempotencyKey,
            actorRef: job.actorOpenId,
            action: "dismiss",
            reasonCode: "member_not_a_conflict",
            permissionAttestedAt: interactionAt,
            at: interactionAt,
          });
          return {
            status: mutation.outcome,
            code: mutation.outcome === "already_applied"
              ? "duplicate_callback"
              : "conflict_dismissed",
          };
        } catch (error) {
          return classifyMutationError(error);
        }
      }

      if (targetPolicy === undefined) return denied("target_unavailable");
      if (!readGate(dependencies.canProcessKnowledgeConflicts, job.groupId)) {
        return denied("runtime_disabled");
      }

      const identity = draftIdentity(candidate.id);
      let draft;
      if (candidate.status === "draft_created") {
        try {
          draft = await dependencies.drafts.getDraft(identity.draftId);
        } catch {
          return retryable("repository_unavailable");
        }
        if (!isExactConflictDraft(draft, identity.draftId, candidate.groupId)) {
          return denied("immutable_intent_conflict");
        }
      } else {
        const revision = conflictRevision(candidate, job.actorOpenId, targetPolicy);
        const draftAt = requireDate(now());
        try {
          const creation = await dependencies.drafts.createDraft({
            id: identity.draftId,
            operationKey: identity.creationOperationKey,
            originKind: "knowledge_conflict",
            createdBy: "iris",
            revision,
            at: draftAt,
          });
          draft = creation.draft;
        } catch {
          return retryable("repository_unavailable");
        }
        if (!isExactConflictDraft(draft, identity.draftId, candidate.groupId)) {
          return denied("immutable_intent_conflict");
        }
      }

      if (!readGate(dependencies.canProcessKnowledgeConflicts, job.groupId)) {
        return denied("runtime_disabled");
      }
      const interactionAt = requireDate(now());
      let interaction;
      try {
        interaction = await dependencies.repository.applyInteraction({
          id: interactionIdentity(job.idempotencyKey),
          candidateId: candidate.id,
          expectedVersion: job.candidateVersion,
          callbackOperationKey: job.idempotencyKey,
          actorRef: job.actorOpenId,
          action: "create_draft",
          draftId: identity.draftId,
          reasonCode: "member_requested_update_draft",
          permissionAttestedAt: interactionAt,
          at: interactionAt,
        });
      } catch (error) {
        return classifyMutationError(error);
      }

      try {
        const presentation = await presentKnowledgeDraft({
          runtime: dependencies.cardRuntime,
          draftId: draft.id,
          expectedVersion: draft.version,
          operationKey: identity.presentationOperationKey,
          at: requireDate(now()),
        });
        return {
          status: interaction.outcome,
          code: interaction.outcome === "already_applied" ? "duplicate_callback" : "draft_created",
          draftId: draft.id,
          presentationId: presentation.presentation.id,
        };
      } catch {
        return retryable("presentation_unavailable");
      }
    },
  };
}

function conflictRevision(
  candidate: KnowledgeConflictCandidate,
  actorOpenId: string,
  targetPolicy: PublicationTargetPolicy,
): KnowledgeDraftRevisionInput {
  const messageIds = candidate.evidence
    .filter((evidence) => evidence.type === "conversation_message")
    .map((evidence) => evidence.conversationMessageId)
    .sort();
  return {
    sourceGroupId: candidate.groupId,
    title: `Knowledge update: ${candidate.plan.subject}`,
    content: renderConflictDraftBody(candidate),
    riskLevel: "medium",
    reviewer: { type: "feishu_user", ref: actorOpenId },
    suggestedPublication: {
      spaceId: targetPolicy.spaceId,
      ...(targetPolicy.parentNodeToken === undefined
        ? {}
        : { parentNodeToken: targetPolicy.parentNodeToken }),
    },
    evidence: [
      ...messageIds.map((id) => ({
        type: "conversation_message" as const,
        id,
        groupId: candidate.groupId,
      })),
      {
        type: "group_memory",
        id: candidate.groupMemoryId,
        groupId: candidate.groupId,
        expectedUpdatedAt: new Date(candidate.memoryUpdatedAt),
      },
      {
        type: "document_source",
        id: candidate.targetDocumentSourceId,
        expectedUpdatedAt: new Date(candidate.targetSourceUpdatedAt),
      },
    ],
  };
}

export function renderConflictDraftBody(candidate: KnowledgeConflictCandidate): string {
  return [
    "Current synchronized knowledge:",
    candidate.plan.knowledgeBaseStatement,
    "",
    "Newer group conclusion:",
    candidate.plan.groupConclusionStatement,
    "",
    "Material difference:",
    candidate.plan.difference,
    "",
    "Proposed update:",
    candidate.plan.suggestedUpdate,
  ].join("\n");
}

function selectTargetPolicy(
  policies: readonly PublicationTargetPolicy[],
  groupId: string,
): PublicationTargetPolicy | undefined {
  const matching = policies.filter((policy) =>
    policy.enabled &&
    policy.allowedGroupIds.includes(groupId) &&
    policy.allowedRiskLevels.includes("medium"));
  return matching.length === 1 ? matching[0] : undefined;
}

function isExactCandidateBinding(
  candidate: KnowledgeConflictCandidate | undefined,
  job: KnowledgeConflictConfirmationInteractionJob,
): candidate is KnowledgeConflictCandidate {
  if (candidate === undefined || candidate.id !== job.candidateId || candidate.groupId !== job.groupId) {
    return false;
  }
  if (candidate.status === "delivered") return candidate.version === job.candidateVersion;
  const replayStatus = job.action === "create_update_draft" ? "draft_created" : "dismissed";
  return candidate.status === replayStatus &&
    job.candidateVersion < Number.MAX_SAFE_INTEGER &&
    candidate.version === job.candidateVersion + 1;
}

function isExactDeliveryBinding(
  delivery: KnowledgeConflictDelivery | undefined,
  job: KnowledgeConflictConfirmationInteractionJob,
): delivery is KnowledgeConflictDelivery & { sentMessageId: string } {
  return delivery !== undefined &&
    delivery.candidateId === job.candidateId &&
    delivery.groupId === job.groupId &&
    delivery.status === "sent" &&
    delivery.sentMessageId !== undefined &&
    delivery.sentMessageId === job.messageId &&
    createKnowledgeConflictCallbackNonce(delivery.id) === job.nonce;
}

function sameCandidateState(
  expected: KnowledgeConflictCandidate,
  actual: KnowledgeConflictCandidate,
): boolean {
  return actual.id === expected.id &&
    actual.groupId === expected.groupId &&
    actual.version === expected.version &&
    actual.status === expected.status &&
    actual.groupMemoryId === expected.groupMemoryId &&
    actual.memoryUpdatedAt.getTime() === expected.memoryUpdatedAt.getTime() &&
    actual.targetDocumentSourceId === expected.targetDocumentSourceId &&
    actual.targetSourceUpdatedAt.getTime() === expected.targetSourceUpdatedAt.getTime();
}

function isExactConflictDraft(
  draft: Awaited<ReturnType<KnowledgeDraftRepository["getDraft"]>>,
  draftId: string,
  groupId: string,
): draft is NonNullable<typeof draft> {
  return draft !== undefined &&
    draft.id === draftId &&
    draft.sourceGroupId === groupId &&
    draft.originKind === "knowledge_conflict";
}

function draftIdentity(candidateId: string) {
  const digest = createHash("sha256")
    .update(JSON.stringify({ kind: "knowledge_conflict", candidateId }))
    .digest("hex");
  return {
    draftId: `knowledge-conflict-draft-${digest.slice(0, 40)}`,
    creationOperationKey: `knowledge-conflict-draft-create-${digest}`,
    presentationOperationKey: `knowledge-conflict-draft-present-${digest}`,
  };
}

function interactionIdentity(callbackOperationKey: string): string {
  return `knowledge-conflict-interaction-${createHash("sha256")
    .update(callbackOperationKey)
    .digest("hex")
    .slice(0, 40)}`;
}

function classifyMutationError(error: unknown): KnowledgeConflictInteractionWorkerResult {
  if (error instanceof KnowledgeConflictOperationConflictError) {
    return denied("immutable_intent_conflict");
  }
  if (
    error instanceof KnowledgeConflictVersionConflictError ||
    error instanceof KnowledgeConflictNotFoundError ||
    error instanceof KnowledgeConflictDeliveryConflictError
  ) return denied("stale_candidate");
  if (error instanceof KnowledgeConflictStaleEvidenceError) return denied("evidence_invalidated");
  return retryable("repository_unavailable");
}

function denied(
  code: Extract<KnowledgeConflictInteractionWorkerResult, { status: "denied" }>["code"],
): KnowledgeConflictInteractionWorkerResult {
  return { status: "denied", code };
}

function retryable(
  code: Extract<KnowledgeConflictInteractionWorkerResult, { status: "retryable" }>["code"],
): KnowledgeConflictInteractionWorkerResult {
  return { status: "retryable", code };
}

function readGate(read: (groupId: string) => boolean, groupId: string): boolean {
  try {
    return read(groupId) === true;
  } catch {
    return false;
  }
}

function requireReference(name: string, value: string): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 512) {
    throw new Error(`${name} is invalid`);
  }
  return value.trim();
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("knowledge conflict interaction time is invalid");
  }
  return new Date(value);
}
