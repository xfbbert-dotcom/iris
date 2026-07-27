import { createHash } from "node:crypto";

import type { AgentExecutionObserver } from "../agent-runtime/agent-execution-observer.js";
import type {
  ActionProposalRepository,
  ClaimApprovedPublicationExecutionResult,
  CompletePublicationExecutionInput,
} from "./action-proposal-repository.js";

const MAX_BATCH_LIMIT = 100;

export type KnowledgePublicationExecutorResult = {
  status: "published" | "skipped" | "failed";
  proposalId: string;
  code:
    | "publication_succeeded"
    | "runtime_disabled"
    | "claim_rejected"
    | "publisher_failed"
    | "completion_failed";
};

export type KnowledgePublicationPublisherResult = Pick<
  CompletePublicationExecutionInput,
  | "remoteNodeToken"
  | "remoteDocumentToken"
  | "remoteDocumentType"
  | "remoteDocumentVersion"
  | "contentHash"
  | "permissionCheckSummary"
>;

export type KnowledgePublicationPublisher = {
  publish(input: {
    proposal: ClaimApprovedPublicationExecutionResult["proposal"];
    execution: ClaimApprovedPublicationExecutionResult["execution"];
    draft: ClaimApprovedPublicationExecutionResult["draft"];
    policy: ClaimApprovedPublicationExecutionResult["policy"];
  }): Promise<KnowledgePublicationPublisherResult>;
};

export type KnowledgePublicationExecutorDependencies = {
  repository: Pick<ActionProposalRepository,
    | "listProposals"
    | "claimApprovedPublicationExecution"
    | "completePublicationExecution"
    | "failPublicationExecution"
  >;
  publisher: KnowledgePublicationPublisher;
  runtimeSnapshot(): {
    globalEnabled: boolean;
    disabledGroupIds: string[];
    capabilities: { writeKnowledgeBase: boolean };
  };
  workerId: string;
  now?: () => Date;
  agentExecutionObserver?: AgentExecutionObserver;
};

export function createKnowledgePublicationExecutor({
  repository,
  publisher,
  runtimeSnapshot,
  workerId,
  now = () => new Date(),
  agentExecutionObserver,
}: KnowledgePublicationExecutorDependencies) {
  const safeWorkerId = requireIdentifier("workerId", workerId);
  return {
    async processBatch({ limit }: { limit: number }): Promise<KnowledgePublicationExecutorResult[]> {
      const safeLimit = sanitizeLimit(limit);
      const initialGate = normalizeRuntimeSnapshot(runtimeSnapshot());
      if (!initialGate.globalEnabled || !initialGate.capabilities.writeKnowledgeBase) return [];
      const proposals = await repository.listProposals({ statuses: ["approved"], limit: safeLimit });
      const results: KnowledgePublicationExecutorResult[] = [];
      for (const proposal of proposals) {
        const gate = normalizeRuntimeSnapshot(runtimeSnapshot());
        if (!gate.globalEnabled || !gate.capabilities.writeKnowledgeBase) {
          results.push({ status: "skipped", proposalId: proposal.id, code: "runtime_disabled" });
          continue;
        }
        let claim: ClaimApprovedPublicationExecutionResult;
        try {
          claim = await repository.claimApprovedPublicationExecution({
            proposalId: proposal.id,
            expectedProposalVersion: proposal.version,
            runtimeGate: {
              globalEnabled: gate.globalEnabled,
              writeKnowledgeBase: gate.capabilities.writeKnowledgeBase,
              disabledGroupIds: gate.disabledGroupIds,
            },
            workerId: safeWorkerId,
            operationKey: stableOperationKey("publication-claim", proposal.id, proposal.version),
            at: requireDate(now()),
          });
        } catch {
          results.push({ status: "skipped", proposalId: proposal.id, code: "claim_rejected" });
          continue;
        }
        results.push(await publishClaim({
          repository,
          publisher,
          claim,
          proposalId: proposal.id,
          now,
          agentExecutionObserver,
        }));
      }
      return results;
    },
  };
}

async function publishClaim(input: {
  repository: KnowledgePublicationExecutorDependencies["repository"];
  publisher: KnowledgePublicationPublisher;
  claim: ClaimApprovedPublicationExecutionResult;
  proposalId: string;
  now: () => Date;
  agentExecutionObserver: AgentExecutionObserver | undefined;
}): Promise<KnowledgePublicationExecutorResult> {
  await observePublicationExecution(
    input,
    "action_execution_started",
  );
  let published: KnowledgePublicationPublisherResult;
  try {
    published = await input.publisher.publish({
      proposal: input.claim.proposal,
      execution: input.claim.execution,
      draft: input.claim.draft,
      policy: input.claim.policy,
    });
  } catch {
    await markExecutionFailed(input, "failed", "publisher_failed");
    await observePublicationExecution(
      input,
      "action_execution_failed",
      "publisher_failed",
    );
    return { status: "failed", proposalId: input.proposalId, code: "publisher_failed" };
  }
  try {
    await input.repository.completePublicationExecution({
      proposalId: input.claim.proposal.id,
      executionId: input.claim.execution.id,
      expectedProposalVersion: input.claim.proposal.version,
      expectedExecutionVersion: input.claim.execution.version,
      expectedDraftVersion: input.claim.draft.version,
      expectedSubjectRevision: input.claim.draft.revisionNumber,
      ...published,
      operationKey: stableOperationKey(
        "publication-complete",
        input.claim.proposal.id,
        input.claim.proposal.version,
      ),
      at: requireDate(input.now()),
    });
  } catch {
    await markExecutionFailed(input, "reconciliation_required", "completion_failed");
    await observePublicationExecution(
      input,
      "action_execution_reconciliation_required",
      "completion_failed",
    );
    return { status: "failed", proposalId: input.proposalId, code: "completion_failed" };
  }
  await observePublicationExecution(
    input,
    "action_execution_completed",
    "publication_succeeded",
  );
  return { status: "published", proposalId: input.proposalId, code: "publication_succeeded" };
}

async function observePublicationExecution(
  input: {
    claim: ClaimApprovedPublicationExecutionResult;
    now: () => Date;
    agentExecutionObserver: AgentExecutionObserver | undefined;
  },
  eventType:
    | "action_execution_started"
    | "action_execution_completed"
    | "action_execution_failed"
    | "action_execution_reconciliation_required",
  decisionReason?: "publication_succeeded" | "publisher_failed" | "completion_failed",
): Promise<void> {
  if (input.agentExecutionObserver === undefined) {
    return;
  }

  const execution = input.claim.execution;
  try {
    await input.agentExecutionObserver.observe({
      ...(input.claim.draft.sourceGroupId === undefined
        ? {}
        : { groupId: input.claim.draft.sourceGroupId }),
      subjectType: "action_execution",
      subjectId: execution.id,
      eventType,
      phase: eventType === "action_execution_completed" ? "completed" : "external_call",
      toolCallId: execution.id,
      toolName: "iris.knowledge.publishDraft",
      ...(eventType === "action_execution_started"
        ? {}
        : {
            outcome: eventType === "action_execution_completed"
              ? "success" as const
              : eventType === "action_execution_reconciliation_required"
                ? "unknown" as const
                : "error" as const,
          }),
      ...(decisionReason === undefined ? {} : { decisionReason }),
      operationKey: `publication-execution:${createHash("sha256")
        .update(`${execution.id}:${eventType}`)
        .digest("hex")}`,
      metadata: {
        proposalId: input.claim.proposal.id,
        proposalVersion: input.claim.proposal.version,
        executionVersion: execution.version,
        draftVersion: input.claim.draft.version,
        draftRevision: input.claim.draft.revisionNumber,
        targetPolicyVersion: input.claim.policy.version,
        attemptNumber: execution.attemptNumber,
      },
      at: requireDate(input.now()),
    });
  } catch {
    // Publication facts remain authoritative when execution observation is unavailable.
  }
}

async function markExecutionFailed(
  input: {
    repository: KnowledgePublicationExecutorDependencies["repository"];
    claim: ClaimApprovedPublicationExecutionResult;
    now: () => Date;
  },
  classification: "failed" | "reconciliation_required",
  responseClassification: "publisher_failed" | "completion_failed",
): Promise<void> {
  try {
    await input.repository.failPublicationExecution({
      proposalId: input.claim.proposal.id,
      executionId: input.claim.execution.id,
      expectedProposalVersion: input.claim.proposal.version,
      expectedExecutionVersion: input.claim.execution.version,
      classification,
      responseClassification,
      operationKey: stableOperationKey(
        classification === "failed" ? "publication-failed" : "publication-reconciliation",
        input.claim.proposal.id,
        input.claim.proposal.version,
      ),
      at: requireDate(input.now()),
    });
  } catch {
    // The result remains content-free; reconciliation can inspect durable executing facts.
  }
}

function stableOperationKey(prefix: string, proposalId: string, proposalVersion: number): string {
  return `${prefix}:${createHash("sha256")
    .update(JSON.stringify({ proposalId, proposalVersion }))
    .digest("hex")}`;
}

function normalizeRuntimeSnapshot(
  value: ReturnType<KnowledgePublicationExecutorDependencies["runtimeSnapshot"]>,
) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("runtime snapshot is invalid");
  }
  if (typeof value.globalEnabled !== "boolean") throw new Error("runtime globalEnabled is invalid");
  if (!Array.isArray(value.disabledGroupIds)) throw new Error("runtime disabledGroupIds is invalid");
  if (
    typeof value.capabilities !== "object" ||
    value.capabilities === null ||
    typeof value.capabilities.writeKnowledgeBase !== "boolean"
  ) throw new Error("runtime capabilities are invalid");
  return {
    globalEnabled: value.globalEnabled,
    disabledGroupIds: value.disabledGroupIds.map((item) => requireIdentifier("disabledGroupId", item)).sort(),
    capabilities: { writeKnowledgeBase: value.capabilities.writeKnowledgeBase },
  };
}

function sanitizeLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > MAX_BATCH_LIMIT) {
    throw new Error("batch limit is invalid");
  }
  return Number(value);
}

function requireIdentifier(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 512) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("date is invalid");
  return new Date(value);
}
