import { createHash } from "node:crypto";

import type { AgentExecutionObserver } from "../agent-runtime/agent-execution-observer.js";
import type {
  ActionProposalDraftCandidate,
  ActionProposalPlanningCandidate,
  ActionProposalRepository,
  FormalTaskActionProposalDraftCandidate,
  PublicationTargetPolicy,
} from "./action-proposal-repository.js";
import type { FeishuTaskTargetPolicy } from "../formal-tasks/formal-task-repository.js";

export type { ActionProposalDraftCandidate } from "./action-proposal-repository.js";

const MAX_BATCH_LIMIT = 100;
const POLICY_LIMIT = 100;

export type ActionProposalPlanBatchResult = {
  candidateCount: number;
  plannedCount: number;
  alreadyPlannedCount: number;
  ineligibleCount: number;
  failedCount: number;
  cancelledStaleCount: number;
};

export type ActionProposalPlanner = {
  planBatch(input: { limit: number; at: Date }): Promise<ActionProposalPlanBatchResult>;
};

type PlannerRepository = Pick<
  ActionProposalRepository,
  "listEligibleDrafts" | "listTargetPolicies" | "cancelStaleProposals" | "createProposal"
> & Pick<ActionProposalRepository,
  "listEligibleFormalTaskDrafts" | "listFeishuTaskTargetPolicies" |
  "cancelStaleFormalTaskProposals">;

export function createActionProposalPlanner(input: {
  repository: PlannerRepository;
  getAllowedGroupIds: () => string[];
  getAllowedFormalTaskGroupIds?: () => string[];
  agentExecutionObserver?: AgentExecutionObserver;
}): ActionProposalPlanner {
  return {
    async planBatch(request) {
      const limit = requireLimit(request.limit);
      const at = requireDate(request.at);
      const knowledgeGroupIds = normalizeGroupIds(input.getAllowedGroupIds());
      const formalTaskGroupIds = normalizeGroupIds(
        input.getAllowedFormalTaskGroupIds?.() ?? knowledgeGroupIds,
      );
      if (knowledgeGroupIds.length === 0 && formalTaskGroupIds.length === 0) return emptyResult();
      const [knowledgeCandidates, policies, formalTaskCandidates, taskPolicies] = await Promise.all([
        knowledgeGroupIds.length === 0
          ? Promise.resolve([])
          : input.repository.listEligibleDrafts({ groupIds: knowledgeGroupIds, limit }),
        input.repository.listTargetPolicies({ enabled: true, limit: POLICY_LIMIT }),
        formalTaskGroupIds.length === 0
          ? Promise.resolve([])
          : input.repository.listEligibleFormalTaskDrafts?.({
              groupIds: formalTaskGroupIds,
              limit,
            }) ?? Promise.resolve([]),
        input.repository.listFeishuTaskTargetPolicies?.({ enabled: true, limit: POLICY_LIMIT }) ??
          Promise.resolve([]),
      ]);
      const boundedCandidates: ActionProposalPlanningCandidate[] = [
        ...knowledgeCandidates,
        ...formalTaskCandidates,
      ]
        .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime() ||
          left.id.localeCompare(right.id))
        .slice(0, limit);
      const result = emptyResult();
      result.candidateCount = boundedCandidates.length;

      for (const candidate of boundedCandidates) {
        let currentVersion = candidate.version;
        try {
          const cancel = candidate.actionType === "create_feishu_task"
            ? input.repository.cancelStaleFormalTaskProposals
            : input.repository.cancelStaleProposals;
          if (cancel === undefined) throw new Error("formal task proposal cancellation unavailable");
          const cancelled = await cancel({
            draftId: candidate.id,
            currentRevision: candidate.currentRevision,
            currentDraftVersion: candidate.version,
            operationKey: `invalidate-action-proposals:${candidate.id}:${candidate.currentRevision}:${candidate.version}`,
            at,
          });
          currentVersion = cancelled.draftVersion;
          result.cancelledStaleCount += cancelled.cancelledProposalIds.length;
        } catch {
          result.failedCount += 1;
          continue;
        }

        const policy = candidate.actionType === "create_feishu_task"
          ? matchFormalTaskPolicy(candidate, taskPolicies, at)
          : matchPolicy(candidate, policies);
        if (policy === undefined) {
          result.ineligibleCount += 1;
          continue;
        }
        const operationKey = candidate.actionType === "publish_knowledge_draft"
          ? `publish-knowledge:${candidate.id}:${candidate.currentRevision}:${policy.version}`
          : candidate.actionType === "update_knowledge_publication"
            ? `update-knowledge-publication:${candidate.id}:${candidate.currentRevision}:${policy.version}`
            : `create-feishu-task:${candidate.id}:${candidate.currentRevision}:${policy.version}`;
        try {
          const mutation = await input.repository.createProposal({
            proposalId: proposalId(operationKey),
            actionType: candidate.actionType,
            draftId: candidate.id,
            expectedRevision: candidate.currentRevision,
            expectedDraftVersion: currentVersion,
            targetPolicyId: policy.id,
            expectedTargetPolicyVersion: policy.version,
            operationKey,
            at,
          });
          if (mutation.outcome === "applied") {
            result.plannedCount += 1;
            await safelyObserve(input.agentExecutionObserver, {
              ...(candidate.sourceGroupId === undefined
                ? {}
                : { groupId: candidate.sourceGroupId }),
              subjectType: "action_proposal",
              subjectId: mutation.proposal.id,
              eventType: "action_proposed",
              phase: "approval_wait",
              outcome: "success",
              operationKey: `action-proposal:${createHash("sha256")
                .update(operationKey)
                .digest("hex")}:proposed`,
              metadata: {
                proposalVersion: mutation.proposal.version,
                draftRevision: candidate.currentRevision,
                draftVersion: candidate.version,
                targetPolicyVersion: policy.version,
                riskLevel: candidate.riskLevel,
              },
              at,
            });
          } else {
            result.alreadyPlannedCount += 1;
          }
        } catch (error) {
          if (isIneligible(error)) result.ineligibleCount += 1;
          else result.failedCount += 1;
        }
      }
      return result;
    },
  };
}

function matchFormalTaskPolicy(
  candidate: FormalTaskActionProposalDraftCandidate,
  policies: FeishuTaskTargetPolicy[],
  at: Date,
): FeishuTaskTargetPolicy | undefined {
  if (
    candidate.evidenceState.status !== "current" ||
    !candidate.hasCurrentGroupConfirmation
  ) return undefined;
  const matches = policies.filter((policy) => {
    if (
      !policy.enabled ||
      policy.id !== candidate.targetPolicyId ||
      policy.version !== candidate.targetPolicyVersion ||
      policy.sourceGroupId !== candidate.sourceGroupId ||
      !policy.allowedAssigneeOpenIds.includes(candidate.assigneeOpenId)
    ) return false;
    if (candidate.dueAt === undefined) return true;
    const dueAt = candidate.dueAt.getTime();
    return dueAt >= at.getTime() &&
      dueAt <= at.getTime() + policy.maxDueHorizonDays * 24 * 60 * 60 * 1_000;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

async function safelyObserve(
  observer: AgentExecutionObserver | undefined,
  event: Parameters<AgentExecutionObserver["observe"]>[0],
): Promise<void> {
  try {
    await observer?.observe(event);
  } catch {
    // Proposal facts remain authoritative when execution observation is unavailable.
  }
}

function matchPolicy(
  candidate: ActionProposalDraftCandidate,
  policies: PublicationTargetPolicy[],
): PublicationTargetPolicy | undefined {
  if (
    candidate.evidenceState.status !== "current" ||
    (candidate.sourceGroupId !== undefined && !candidate.hasCurrentGroupConfirmation)
  ) return undefined;
  const destination = candidate.suggestedPublication;
  if (destination?.spaceId === undefined) return undefined;
  const matches = policies.filter((policy) =>
    policy.enabled &&
    policy.spaceId === destination.spaceId &&
    (policy.parentNodeToken ?? undefined) === (destination.parentNodeToken ?? undefined) &&
    policy.allowedRiskLevels.includes(candidate.riskLevel) &&
    (candidate.sourceGroupId === undefined
      ? policy.allowedGroupIds.length === 0
      : policy.allowedGroupIds.includes(candidate.sourceGroupId)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function proposalId(operationKey: string): string {
  return `action-proposal-${createHash("sha256").update(operationKey).digest("hex")}`;
}

function emptyResult(): ActionProposalPlanBatchResult {
  return {
    candidateCount: 0,
    plannedCount: 0,
    alreadyPlannedCount: 0,
    ineligibleCount: 0,
    failedCount: 0,
    cancelledStaleCount: 0,
  };
}

function isIneligible(error: unknown): boolean {
  return error instanceof Error && error.name === "ActionProposalIneligibleError";
}

function normalizeGroupIds(value: string[]): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("allowed group IDs are invalid");
  const normalized = [...new Set(value.map((item) => requireReference(item)))].sort();
  return normalized;
}

function requireReference(value: unknown): string {
  if (typeof value !== "string") throw new Error("group ID must be a string");
  const normalized = value.trim();
  if (normalized.length < 1 || [...normalized].length > 512) throw new Error("group ID is invalid");
  return normalized;
}

function requireLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_BATCH_LIMIT}`);
  }
  return value;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("at must be a valid date");
  return new Date(value);
}
