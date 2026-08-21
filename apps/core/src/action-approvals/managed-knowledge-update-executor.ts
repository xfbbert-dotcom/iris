import { createHash } from "node:crypto";

import type { AgentExecutionObserver } from "../agent-runtime/agent-execution-observer.js";
import {
  createDocumentSyncIdempotencyKey,
  type DocumentSyncQueue,
} from "../documents/document-sync-queue.js";

import type { ActionProposalRepository } from "./action-proposal-repository.js";
import type {
  ManagedKnowledgeBlockObservation,
  ManagedKnowledgeUpdater,
  ManagedUpdateOutcome,
} from "./feishu-managed-knowledge-updater.js";
import { canonicalManagedBodyHash } from "./managed-knowledge-page.js";
import type {
  ClaimedManagedKnowledgeUpdate,
  ManagedKnowledgePageRepository,
  ManagedKnowledgeUpdateClaimResult,
} from "./managed-knowledge-page-repository.js";

const MAX_BATCH_LIMIT = 100;

export type ManagedKnowledgeUpdateExecutorResult = {
  status: "resync_required" | "reconciliation_required" | "failed" | "skipped";
  proposalId: string;
  executionId?: string;
  code: string;
};

export type ManagedKnowledgeUpdateRuntimeSnapshot = {
  deploymentEnabled: boolean;
  globalEnabled: boolean;
  disabledGroupIds: string[];
  groupAllowlist: string[];
  capabilities: {
    writeKnowledgeBase: boolean;
    updateManagedKnowledge: boolean;
  };
};

export type ManagedKnowledgeUpdateExecutorDependencies = {
  proposals: Pick<ActionProposalRepository, "listProposals">;
  managedPages: Pick<
    ManagedKnowledgePageRepository,
    | "claimApprovedUpdate"
    | "markRemoteRequestDispatched"
    | "claimRemoteRetry"
    | "recordRemoteOutcome"
  >;
  updater: ManagedKnowledgeUpdater;
  syncQueue: Pick<DocumentSyncQueue, "enqueue">;
  runtimeSnapshot(): ManagedKnowledgeUpdateRuntimeSnapshot;
  workerId: string;
  now?: () => Date;
  agentExecutionObserver?: AgentExecutionObserver;
};

export function createManagedKnowledgeUpdateExecutor({
  proposals,
  managedPages,
  updater,
  syncQueue,
  runtimeSnapshot,
  workerId,
  now = () => new Date(),
  agentExecutionObserver,
}: ManagedKnowledgeUpdateExecutorDependencies) {
  const safeWorkerId = requireIdentifier("workerId", workerId);
  return {
    async processBatch({ limit }: { limit: number }): Promise<ManagedKnowledgeUpdateExecutorResult[]> {
      const safeLimit = sanitizeLimit(limit);
      const initialGate = normalizeRuntimeSnapshot(runtimeSnapshot());
      const allowedGroupIds = enabledGroups(initialGate);
      if (!canClaim(initialGate) || allowedGroupIds.length === 0) return [];
      const candidates = await proposals.listProposals({
        statuses: ["approved"],
        actionTypes: ["update_knowledge_publication"],
        authorizationGroupIds: allowedGroupIds,
        limit: safeLimit,
      });
      const results: ManagedKnowledgeUpdateExecutorResult[] = [];
      for (const proposal of candidates) {
        const gate = normalizeRuntimeSnapshot(runtimeSnapshot());
        const currentAllowedGroups = enabledGroups(gate);
        if (!canClaim(gate) || currentAllowedGroups.length === 0) {
          results.push({ status: "skipped", proposalId: proposal.id, code: "runtime_disabled" });
          continue;
        }
        let claimResult: ManagedKnowledgeUpdateClaimResult;
        try {
          claimResult = await managedPages.claimApprovedUpdate({
            proposalId: proposal.id,
            expectedProposalVersion: proposal.version,
            runtimeGate: {
              deploymentEnabled: gate.deploymentEnabled,
              globalEnabled: gate.globalEnabled,
              writeKnowledgeBase: gate.capabilities.writeKnowledgeBase,
              updateManagedKnowledge: gate.capabilities.updateManagedKnowledge,
              disabledGroupIds: gate.disabledGroupIds,
              allowedGroupIds: currentAllowedGroups,
            },
            workerId: safeWorkerId,
            operationKey: stableOperationKey("managed-update-claim", [proposal.id, proposal.version]),
            at: requireDate(now()),
          });
        } catch {
          results.push({ status: "skipped", proposalId: proposal.id, code: "claim_rejected" });
          continue;
        }
        if (claimResult.outcome === "terminal") {
          results.push({
            status: "failed",
            proposalId: claimResult.proposalId,
            code: claimResult.code,
          });
          continue;
        }
        const claim: ClaimedManagedKnowledgeUpdate = claimResult;
        results.push(await executeClaim({
          managedPages,
          updater,
          syncQueue,
          claim,
          workerId: safeWorkerId,
          now,
          agentExecutionObserver,
        }));
      }
      return results;
    },
  };
}

async function executeClaim(input: {
  managedPages: ManagedKnowledgeUpdateExecutorDependencies["managedPages"];
  updater: ManagedKnowledgeUpdater;
  syncQueue: Pick<DocumentSyncQueue, "enqueue">;
  claim: ClaimedManagedKnowledgeUpdate;
  workerId: string;
  now: () => Date;
  agentExecutionObserver?: AgentExecutionObserver;
}): Promise<ManagedKnowledgeUpdateExecutorResult> {
  const base = {
    proposalId: input.claim.proposal.id,
    executionId: input.claim.execution.id,
  };
  const bindingFailure = validateClaimBinding(input.claim, input.workerId);
  if (bindingFailure !== undefined) {
    return persistPreflightFailure(input, bindingFailure);
  }
  let preflight: ManagedKnowledgeBlockObservation;
  try {
    preflight = await input.updater.preflight(remoteIdentity(input.claim));
  } catch {
    return persistPreflightFailure(input, "preflight_unavailable");
  }
  const preflightFailure = validatePreflight(input.claim, preflight);
  if (preflightFailure !== undefined) {
    return persistPreflightFailure(input, preflightFailure);
  }
  let dispatched;
  try {
    dispatched = await input.managedPages.markRemoteRequestDispatched({
      executionId: input.claim.execution.id,
      expectedExecutionVersion: input.claim.execution.version,
      operationKey: stableOperationKey("managed-update-dispatched", [input.claim.execution.id]),
      actor: input.workerId,
      at: requireDate(input.now()),
    });
  } catch {
    return persistPreflightFailure(input, "dispatch_marker_failed");
  }
  let outcome: ManagedUpdateOutcome;
  try {
    outcome = await input.updater.update(updateInput(input.claim));
  } catch {
    const reconciled = await persistOutcome(input, {
      expectedExecutionVersion: dispatched.execution.version,
      classification: "outcome_unknown",
      pageDisposition: "reconciliation_required",
      responseClassification: "update_unavailable",
      reconciliationReasonCode: "update_unavailable",
      operationPrefix: "managed-update-outcome-unknown",
    });
    await observe(input, reconciled.execution.version, "action_execution_reconciliation_required", "update_unavailable");
    return { status: "reconciliation_required", ...base, code: "update_unavailable" };
  }
  if (outcome.kind === "applied") {
    return persistApplied(input, dispatched.execution.version, outcome.resultingRevision);
  }
  if (outcome.kind === "unknown") {
    const reconciled = await persistOutcome(input, {
      expectedExecutionVersion: dispatched.execution.version,
      classification: "outcome_unknown",
      pageDisposition: "reconciliation_required",
      responseClassification: outcome.code,
      reconciliationReasonCode: outcome.code,
      operationPrefix: "managed-update-outcome-unknown",
    });
    await observe(input, reconciled.execution.version, "action_execution_reconciliation_required", outcome.code);
    return { status: "reconciliation_required", ...base, code: outcome.code };
  }
  if (outcome.kind === "rejected") {
    await persistRejected(input, dispatched.execution.version, outcome.code);
    return { status: "failed", ...base, code: outcome.code };
  }
  return handleExplicitTransient(input, dispatched.execution.version, outcome.code);
}

async function handleExplicitTransient(
  input: Parameters<typeof executeClaim>[0],
  executionVersion: number,
  code: Extract<ManagedUpdateOutcome, { kind: "not_applied_retryable" }>["code"],
): Promise<ManagedKnowledgeUpdateExecutorResult> {
  const uncertain = await persistOutcome(input, {
    expectedExecutionVersion: executionVersion,
    classification: "outcome_unknown",
    pageDisposition: "reconciliation_required",
    responseClassification: code,
    reconciliationReasonCode: `explicit_transient_${code}`,
    operationPrefix: "managed-update-explicit-transient",
  });
  let readBack: ManagedKnowledgeBlockObservation;
  try {
    readBack = await input.updater.readBack(remoteIdentity(input.claim));
  } catch {
    return {
      status: "reconciliation_required",
      proposalId: input.claim.proposal.id,
      executionId: input.claim.execution.id,
      code: "transient_readback_unavailable",
    };
  }
  if (isProposedState(input.claim, readBack)) {
    return persistApplied(input, uncertain.execution.version, readBack.revision);
  }
  if (!isExactOldState(input.claim, readBack)) {
    await persistOutcome(input, {
      expectedExecutionVersion: uncertain.execution.version,
      classification: "reconciliation_required",
      pageDisposition: "reconciliation_required",
      responseClassification: "human_edit_or_unexpected_readback",
      reconciliationReasonCode: "human_edit_or_unexpected_readback",
      operationPrefix: "managed-update-readback-ambiguous",
    });
    return {
      status: "reconciliation_required",
      proposalId: input.claim.proposal.id,
      executionId: input.claim.execution.id,
      code: "human_edit_or_unexpected_readback",
    };
  }
  let retry;
  try {
    const retryAt = requireDate(input.now());
    retry = await input.managedPages.claimRemoteRetry({
      executionId: input.claim.execution.id,
      expectedExecutionVersion: uncertain.execution.version,
      operationKey: stableOperationKey("managed-update-safe-retry", [input.claim.execution.id]),
      actor: input.workerId,
      at: retryAt,
      staleDispatchedBefore: retryAt,
    });
  } catch {
    return {
      status: "reconciliation_required",
      proposalId: input.claim.proposal.id,
      executionId: input.claim.execution.id,
      code: "safe_retry_not_claimed",
    };
  }
  let retryOutcome: ManagedUpdateOutcome;
  try {
    retryOutcome = await input.updater.update(updateInput(input.claim));
  } catch {
    retryOutcome = { kind: "unknown", code: "connection_lost" };
  }
  if (retryOutcome.kind === "applied") {
    return persistApplied(input, retry.execution.version, retryOutcome.resultingRevision);
  }
  if (retryOutcome.kind === "rejected") {
    await persistRejected(input, retry.execution.version, retryOutcome.code);
    return {
      status: "failed",
      proposalId: input.claim.proposal.id,
      executionId: input.claim.execution.id,
      code: retryOutcome.code,
    };
  }
  const retryCode = retryOutcome.code;
  await persistOutcome(input, {
    expectedExecutionVersion: retry.execution.version,
    classification: "outcome_unknown",
    pageDisposition: "reconciliation_required",
    responseClassification: retryCode,
    reconciliationReasonCode: "safe_retry_outcome_unresolved",
    operationPrefix: "managed-update-safe-retry-unknown",
  });
  return {
    status: "reconciliation_required",
    proposalId: input.claim.proposal.id,
    executionId: input.claim.execution.id,
    code: retryCode,
  };
}

async function persistApplied(
  input: Parameters<typeof executeClaim>[0],
  expectedExecutionVersion: number,
  resultingRevision: number,
): Promise<ManagedKnowledgeUpdateExecutorResult> {
  const applied = await persistOutcome(input, {
    expectedExecutionVersion,
    classification: "remote_applied",
    pageDisposition: "resync_required",
    responseClassification: "applied",
    responseRevisionId: String(resultingRevision),
    operationPrefix: "managed-update-remote-applied",
  });
  try {
    await input.syncQueue.enqueue({
      idempotencyKey: createDocumentSyncIdempotencyKey({
        documentSourceId: input.claim.target.linkedDocumentSourceId,
      }),
      documentSourceId: input.claim.target.linkedDocumentSourceId,
      reason: "manual_source_sync",
      enqueuedAt: requireDate(input.now()),
      attempts: 0,
    });
  } catch {
    const reconciled = await persistOutcome(input, {
      expectedExecutionVersion: applied.execution.version,
      classification: "reconciliation_required",
      pageDisposition: "reconciliation_required",
      responseClassification: "resync_enqueue_failed",
      responseRevisionId: String(resultingRevision),
      reconciliationReasonCode: "resync_enqueue_failed",
      operationPrefix: "managed-update-resync-enqueue-failed",
    });
    await observe(input, reconciled.execution.version, "action_execution_reconciliation_required", "resync_enqueue_failed");
    return {
      status: "reconciliation_required",
      proposalId: input.claim.proposal.id,
      executionId: input.claim.execution.id,
      code: "resync_enqueue_failed",
    };
  }
  await observe(input, applied.execution.version, "action_execution_completed", "remote_applied");
  return {
    status: "resync_required",
    proposalId: input.claim.proposal.id,
    executionId: input.claim.execution.id,
    code: "remote_applied",
  };
}

async function persistPreflightFailure(
  input: Parameters<typeof executeClaim>[0],
  code: string,
): Promise<ManagedKnowledgeUpdateExecutorResult> {
  const failed = await persistOutcome(input, {
    expectedExecutionVersion: input.claim.execution.version,
    classification: "preflight_failed",
    pageDisposition: "reconciliation_required",
    responseClassification: code,
    reconciliationReasonCode: code,
    operationPrefix: "managed-update-preflight-failed",
  });
  await observe(input, failed.execution.version, "action_execution_failed", code);
  return {
    status: "failed",
    proposalId: input.claim.proposal.id,
    executionId: input.claim.execution.id,
    code,
  };
}

async function persistRejected(
  input: Parameters<typeof executeClaim>[0],
  expectedExecutionVersion: number,
  code: Extract<ManagedUpdateOutcome, { kind: "rejected" }>["code"],
) {
  const pageDisposition = code === "forbidden"
    ? "blocked" as const
    : code === "missing"
      ? "retired" as const
      : "reconciliation_required" as const;
  const result = await persistOutcome(input, {
    expectedExecutionVersion,
    classification: "failed",
    pageDisposition,
    responseClassification: code,
    reconciliationReasonCode: code,
    operationPrefix: "managed-update-rejected",
  });
  await observe(input, result.execution.version, "action_execution_failed", code);
  return result;
}

async function persistOutcome(
  input: Parameters<typeof executeClaim>[0],
  outcome: {
    expectedExecutionVersion: number;
    classification: "preflight_failed" | "outcome_unknown" | "remote_applied" | "failed" | "reconciliation_required";
    pageDisposition: "active" | "resync_required" | "reconciliation_required" | "blocked" | "retired";
    responseClassification?: string;
    responseRevisionId?: string;
    reconciliationReasonCode?: string;
    operationPrefix: string;
  },
) {
  return input.managedPages.recordRemoteOutcome({
    executionId: input.claim.execution.id,
    expectedExecutionVersion: outcome.expectedExecutionVersion,
    classification: outcome.classification,
    pageDisposition: outcome.pageDisposition,
    ...(outcome.responseClassification === undefined
      ? {}
      : { responseClassification: outcome.responseClassification }),
    ...(outcome.responseRevisionId === undefined
      ? {}
      : { responseRevisionId: outcome.responseRevisionId }),
    ...(outcome.reconciliationReasonCode === undefined
      ? {}
      : { reconciliationReasonCode: outcome.reconciliationReasonCode }),
    operationKey: stableOperationKey(outcome.operationPrefix, [input.claim.execution.id]),
    actor: input.workerId,
    at: requireDate(input.now()),
  });
}

function validateClaimBinding(
  claim: ClaimedManagedKnowledgeUpdate,
  workerId: string,
): string | undefined {
  const { page, target, execution, draft, proposal } = claim;
  if (
    proposal.actionType !== "update_knowledge_publication" ||
    proposal.status !== "executing" ||
    proposal.subjectId !== target.draftId ||
    proposal.subjectRevision !== target.draftRevision ||
    proposal.targetPolicyId !== target.targetPolicyId ||
    proposal.targetPolicyVersion !== target.targetPolicyVersion ||
    draft.id !== target.draftId ||
    draft.revisionNumber !== target.draftRevision ||
    draft.version < target.draftVersion ||
    proposal.subjectVersion !== draft.version ||
    canonicalManagedBodyHash(draft.content) !== target.proposedBodyContentHash ||
    page.id !== target.managedPageId ||
    page.state !== "updating" ||
    page.version !== execution.managedPageVersion ||
    page.version !== target.managedPageVersion + 1 ||
    page.authorizationGroupId !== target.authorizationGroupId ||
    page.remoteDocumentToken !== target.remoteDocumentToken ||
    page.managedBodyBlockId !== target.managedBodyBlockId ||
    page.linkedDocumentSourceId !== target.linkedDocumentSourceId ||
    page.currentRemoteRevisionId !== target.expectedRemoteRevisionId ||
    page.currentBodyContentHash !== target.currentBodyContentHash ||
    page.targetPolicyId !== target.targetPolicyId ||
    page.targetPolicyVersion !== target.targetPolicyVersion ||
    execution.proposalId !== proposal.id ||
    execution.approvalId === undefined ||
    execution.executorId !== workerId ||
    execution.updateTargetId !== target.id ||
    execution.managedPageId !== page.id ||
    execution.state !== "claimed" ||
    execution.expectedRemoteRevisionId !== target.expectedRemoteRevisionId ||
    execution.beforeBodyContentHash !== target.currentBodyContentHash ||
    execution.afterBodyContentHash !== target.proposedBodyContentHash ||
    execution.clientToken.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(execution.clientToken)
  ) return "claim_binding_mismatch";
  return parsePositiveRevision(target.expectedRemoteRevisionId) === undefined
    ? "bound_revision_invalid"
    : undefined;
}

function validatePreflight(
  claim: ClaimedManagedKnowledgeUpdate,
  observation: ManagedKnowledgeBlockObservation,
): string | undefined {
  if (!Number.isSafeInteger(observation.revision) || observation.revision < 1) {
    return "preflight_revision_invalid";
  }
  if (observation.blockType !== "text") return "preflight_block_type_mismatch";
  if (observation.revision !== parsePositiveRevision(claim.target.expectedRemoteRevisionId)) {
    return "preflight_revision_mismatch";
  }
  return observation.canonicalBodyHash === claim.target.currentBodyContentHash
    ? undefined
    : "preflight_body_mismatch";
}

function isExactOldState(
  claim: ClaimedManagedKnowledgeUpdate,
  observation: ManagedKnowledgeBlockObservation,
): boolean {
  return observation.blockType === "text" &&
    observation.revision === parsePositiveRevision(claim.target.expectedRemoteRevisionId) &&
    observation.canonicalBodyHash === claim.target.currentBodyContentHash;
}

function isProposedState(
  claim: ClaimedManagedKnowledgeUpdate,
  observation: ManagedKnowledgeBlockObservation,
): boolean {
  const expected = parsePositiveRevision(claim.target.expectedRemoteRevisionId);
  return observation.blockType === "text" &&
    expected !== undefined &&
    observation.revision > expected &&
    observation.canonicalBodyHash === claim.target.proposedBodyContentHash;
}

function remoteIdentity(claim: ClaimedManagedKnowledgeUpdate) {
  return {
    remoteDocumentToken: claim.target.remoteDocumentToken,
    managedBodyBlockId: claim.target.managedBodyBlockId,
  };
}

function updateInput(claim: ClaimedManagedKnowledgeUpdate) {
  return {
    ...remoteIdentity(claim),
    expectedRevision: parsePositiveRevision(claim.target.expectedRemoteRevisionId)!,
    proposedBody: claim.draft.content,
    clientToken: claim.execution.clientToken,
  };
}

async function observe(
  input: Parameters<typeof executeClaim>[0],
  executionVersion: number,
  eventType: "action_execution_completed" | "action_execution_failed" | "action_execution_reconciliation_required",
  reasonCode: string,
): Promise<void> {
  if (input.agentExecutionObserver === undefined) return;
  try {
    await input.agentExecutionObserver.observe({
      groupId: input.claim.target.authorizationGroupId,
      subjectType: "action_execution",
      subjectId: input.claim.execution.id,
      eventType,
      phase: eventType === "action_execution_completed" ? "completed" : "external_call",
      toolCallId: input.claim.execution.id,
      toolName: "iris.knowledge.updateManagedPublication",
      outcome: eventType === "action_execution_completed"
        ? "success"
        : eventType === "action_execution_reconciliation_required"
          ? "unknown"
          : "error",
      decisionReason: reasonCode,
      operationKey: stableOperationKey("managed-update-observation", [
        input.claim.execution.id,
        executionVersion,
        eventType,
      ]),
      metadata: {
        proposalId: input.claim.proposal.id,
        proposalVersion: input.claim.proposal.version,
        managedPageId: input.claim.page.id,
        managedPageVersion: input.claim.page.version,
        executionVersion,
        draftVersion: input.claim.draft.version,
        draftRevision: input.claim.draft.revisionNumber,
        targetPolicyVersion: input.claim.target.targetPolicyVersion,
        attemptNumber: input.claim.execution.attemptNumber,
        state: eventType,
        reasonCode,
      },
      at: requireDate(input.now()),
    });
  } catch {
    // Durable managed update facts remain authoritative when observation is unavailable.
  }
}

function canClaim(snapshot: ReturnType<typeof normalizeRuntimeSnapshot>): boolean {
  return snapshot.deploymentEnabled &&
    snapshot.globalEnabled &&
    snapshot.capabilities.writeKnowledgeBase &&
    snapshot.capabilities.updateManagedKnowledge;
}

function enabledGroups(snapshot: ReturnType<typeof normalizeRuntimeSnapshot>): string[] {
  const disabled = new Set(snapshot.disabledGroupIds);
  return snapshot.groupAllowlist.filter((groupId) => !disabled.has(groupId));
}

function normalizeRuntimeSnapshot(value: ManagedKnowledgeUpdateRuntimeSnapshot) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("managed update runtime snapshot is invalid");
  }
  if (
    typeof value.deploymentEnabled !== "boolean" ||
    typeof value.globalEnabled !== "boolean" ||
    !Array.isArray(value.disabledGroupIds) ||
    !Array.isArray(value.groupAllowlist) ||
    typeof value.capabilities !== "object" ||
    value.capabilities === null ||
    typeof value.capabilities.writeKnowledgeBase !== "boolean" ||
    typeof value.capabilities.updateManagedKnowledge !== "boolean"
  ) throw new Error("managed update runtime snapshot is invalid");
  return {
    deploymentEnabled: value.deploymentEnabled,
    globalEnabled: value.globalEnabled,
    disabledGroupIds: uniqueIdentifiers("disabledGroupId", value.disabledGroupIds),
    groupAllowlist: uniqueIdentifiers("groupAllowlist", value.groupAllowlist),
    capabilities: {
      writeKnowledgeBase: value.capabilities.writeKnowledgeBase,
      updateManagedKnowledge: value.capabilities.updateManagedKnowledge,
    },
  };
}

function uniqueIdentifiers(name: string, values: string[]): string[] {
  return [...new Set(values.map((value) => requireIdentifier(name, value)))].sort();
}

function stableOperationKey(prefix: string, identity: Array<string | number>): string {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function parsePositiveRevision(value: string): number | undefined {
  if (!/^[1-9][0-9]*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
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
  if ([...normalized].length < 1 || [...normalized].length > 512) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("date is invalid");
  return new Date(value);
}
