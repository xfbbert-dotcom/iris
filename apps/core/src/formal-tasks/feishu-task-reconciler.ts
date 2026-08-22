import { createHash } from "node:crypto";

import type { FeishuGroupMembershipChecker } from
  "../feishu/feishu-group-membership-checker.js";

import type { FeishuTaskCreator, FeishuTaskCreateOutcome } from "./feishu-task-creator.js";
import {
  matchesApprovedTaskProjection,
  type ClaimedFeishuTaskCreation,
  type FormalTaskExecutionRepository,
  type RecordFeishuTaskCreationFailureInput,
} from "./formal-task-execution-repository.js";

const MAX_BATCH_LIMIT = 100;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type FeishuTaskReconciliationResult = {
  status: "reconciled" | "outcome_unknown" | "reconciliation_required";
  executionId: string;
  code: string;
};

export type FeishuTaskReconcilerDependencies = {
  repository: Pick<FormalTaskExecutionRepository,
    "claimReconciliationAttempt" | "completeCreation" | "recordCreationFailure">;
  creator: Pick<FeishuTaskCreator, "createTask">;
  membershipChecker: FeishuGroupMembershipChecker;
  runtimeSnapshot(): {
    deploymentEnabled: boolean;
    globalEnabled: boolean;
    groupAllowlist: string[];
    disabledGroupIds: string[];
    capabilities: { createFeishuTasks: boolean; callExternalTools: boolean };
  };
  workerId: string;
  leaseMs: number;
  reconciliationDelayMs: number;
  maxAttempts: number;
  now?: () => Date;
};

export function createFeishuTaskReconciler({
  repository,
  creator,
  membershipChecker,
  runtimeSnapshot,
  workerId,
  leaseMs,
  reconciliationDelayMs,
  maxAttempts,
  now = () => new Date(),
}: FeishuTaskReconcilerDependencies) {
  const safeWorkerId = requireIdentifier("workerId", workerId);
  const safeLeaseMs = requirePositiveInteger("leaseMs", leaseMs, MAX_TIMER_DELAY_MS);
  const safeDelayMs = requirePositiveInteger(
    "reconciliationDelayMs",
    reconciliationDelayMs,
    MAX_TIMER_DELAY_MS,
  );
  const safeMaxAttempts = requirePositiveInteger("maxAttempts", maxAttempts, 20);
  return {
    async processBatch({ limit }: { limit: number }): Promise<FeishuTaskReconciliationResult[]> {
      const safeLimit = requirePositiveInteger("limit", limit, MAX_BATCH_LIMIT);
      const initialGate = normalizeRuntime(runtimeSnapshot());
      if (!canCreate(initialGate)) return [];
      const results: FeishuTaskReconciliationResult[] = [];
      for (let index = 0; index < safeLimit; index += 1) {
        const gate = normalizeRuntime(runtimeSnapshot());
        if (!canCreate(gate)) break;
        const claimedAt = requireDate(now());
        let claim: ClaimedFeishuTaskCreation | undefined;
        try {
          claim = await repository.claimReconciliationAttempt({
            runtimeGate: {
              deploymentEnabled: gate.deploymentEnabled,
              globalEnabled: gate.globalEnabled,
              createFeishuTasks: gate.capabilities.createFeishuTasks,
              callExternalTools: gate.capabilities.callExternalTools,
              disabledGroupIds: gate.disabledGroupIds,
              allowedGroupIds: gate.groupAllowlist,
            },
            workerId: safeWorkerId,
            leaseUntil: new Date(claimedAt.getTime() + safeLeaseMs),
            operationKey: operationKey("formal-task-reconcile-claim", [
              safeWorkerId,
              claimedAt.toISOString(),
            ]),
            at: claimedAt,
          });
        } catch {
          break;
        }
        if (claim === undefined) break;
        results.push(await reconcileClaim({
          claim,
          repository,
          creator,
          membershipChecker,
          runtimeSnapshot,
          reconciliationDelayMs: safeDelayMs,
          maxAttempts: safeMaxAttempts,
          now,
        }));
      }
      return results;
    },
  };
}

async function reconcileClaim(input: {
  claim: ClaimedFeishuTaskCreation;
  repository: FeishuTaskReconcilerDependencies["repository"];
  creator: FeishuTaskReconcilerDependencies["creator"];
  membershipChecker: FeishuGroupMembershipChecker;
  runtimeSnapshot: FeishuTaskReconcilerDependencies["runtimeSnapshot"];
  reconciliationDelayMs: number;
  maxAttempts: number;
  now: () => Date;
}): Promise<FeishuTaskReconciliationResult> {
  let currentMember: boolean;
  try {
    currentMember = await input.membershipChecker.isCurrentMember({
      chatId: input.claim.draft.sourceGroupId,
      openId: input.claim.draft.assigneeOpenId,
    });
  } catch {
    return requireReconciliation(input, "membership_unavailable");
  }
  if (!currentMember) return requireReconciliation(input, "assignee_not_current_member");
  const gate = normalizeRuntime(input.runtimeSnapshot());
  if (!canCreateForGroup(gate, input.claim.draft.sourceGroupId)) {
    return requireReconciliation(input, "runtime_disabled_after_claim");
  }

  let outcome: FeishuTaskCreateOutcome;
  try {
    outcome = await input.creator.createTask({
      title: input.claim.draft.title,
      description: input.claim.draft.description,
      assigneeOpenId: input.claim.draft.assigneeOpenId,
      ...(input.claim.draft.dueAt === undefined
        ? {}
        : { dueAt: new Date(input.claim.draft.dueAt) }),
      ...(input.claim.draft.reminderMinutes === undefined
        ? {}
        : { reminderMinutes: input.claim.draft.reminderMinutes }),
      clientToken: input.claim.clientToken,
    });
  } catch {
    outcome = { kind: "unknown", code: "connection_lost" };
  }
  if (outcome.kind === "created") {
    if (
      !matchesApprovedTaskProjection(input.claim, outcome.task) ||
      !matchesStoredIdentity(input.claim, outcome.task)
    ) return requireReconciliation(input, "remote_identity_mismatch", outcome.task);
    try {
      await input.repository.completeCreation({
        proposalId: input.claim.proposal.id,
        executionId: input.claim.execution.id,
        expectedProposalVersion: input.claim.proposal.version,
        expectedExecutionVersion: input.claim.execution.version,
        expectedDraftVersion: input.claim.draft.version,
        expectedDraftRevision: input.claim.draft.revision,
        taskSpecHash: input.claim.draft.taskSpecHash,
        remoteTaskGuid: outcome.task.guid,
        remoteTaskId: outcome.task.taskId,
        remoteTaskUrl: outcome.task.url,
        operationKey: operationKey("formal-task-reconcile-complete", [
          input.claim.execution.id,
          outcome.task.guid,
        ]),
        at: requireDate(input.now()),
      });
      return { status: "reconciled", executionId: input.claim.execution.id, code: "task_created" };
    } catch {
      return continueUnknownOrStop(input, "completion_failed", outcome.task);
    }
  }
  if (outcome.kind === "rejected") {
    return requireReconciliation(input, outcome.code);
  }
  return continueUnknownOrStop(input, outcome.code);
}

async function continueUnknownOrStop(
  input: Parameters<typeof reconcileClaim>[0],
  code: string,
  remote?: { guid: string; taskId: string; url: string },
): Promise<FeishuTaskReconciliationResult> {
  if (input.claim.execution.attemptNumber >= input.maxAttempts) {
    return requireReconciliation(input, "reconciliation_budget_exhausted", remote);
  }
  const recordedAt = requireDate(input.now());
  await recordFailure(input, "outcome_unknown", code, {
    retryAt: new Date(recordedAt.getTime() + input.reconciliationDelayMs),
    ...(remote === undefined ? {} : { remote }),
    at: recordedAt,
  });
  return { status: "outcome_unknown", executionId: input.claim.execution.id, code };
}

async function requireReconciliation(
  input: Parameters<typeof reconcileClaim>[0],
  code: string,
  remote?: { guid: string; taskId: string; url: string },
): Promise<FeishuTaskReconciliationResult> {
  await recordFailure(input, "reconciliation_required", code, {
    ...(remote === undefined ? {} : { remote }),
    at: requireDate(input.now()),
  });
  return { status: "reconciliation_required", executionId: input.claim.execution.id, code };
}

async function recordFailure(
  input: Parameters<typeof reconcileClaim>[0],
  classification: RecordFeishuTaskCreationFailureInput["classification"],
  responseClassification: string,
  options: {
    retryAt?: Date;
    remote?: { guid: string; taskId: string; url: string };
    at: Date;
  },
): Promise<void> {
  try {
    await input.repository.recordCreationFailure({
      proposalId: input.claim.proposal.id,
      executionId: input.claim.execution.id,
      expectedProposalVersion: input.claim.proposal.version,
      expectedExecutionVersion: input.claim.execution.version,
      classification,
      responseClassification,
      ...(options.retryAt === undefined ? {} : { retryAt: options.retryAt }),
      ...(options.remote === undefined
        ? {}
        : {
            remoteTaskGuid: options.remote.guid,
            remoteTaskId: options.remote.taskId,
            remoteTaskUrl: options.remote.url,
          }),
      operationKey: operationKey(`formal-task-reconcile-${classification}`, [
        input.claim.execution.id,
        input.claim.execution.attemptNumber,
        responseClassification,
      ]),
      at: options.at,
    });
  } catch {
    // The external-attempt fact remains visible for operator recovery.
  }
}

function matchesStoredIdentity(
  claim: ClaimedFeishuTaskCreation,
  task: { guid: string; taskId: string; url: string },
): boolean {
  const stored = [
    claim.execution.remoteTaskGuid,
    claim.execution.remoteTaskId,
    claim.execution.remoteTaskUrl,
  ];
  if (stored.every((value) => value === undefined)) return true;
  return task.guid === claim.execution.remoteTaskGuid &&
    task.taskId === claim.execution.remoteTaskId &&
    task.url === claim.execution.remoteTaskUrl;
}

function normalizeRuntime(value: ReturnType<FeishuTaskReconcilerDependencies["runtimeSnapshot"]>) {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    typeof value.deploymentEnabled !== "boolean" ||
    typeof value.globalEnabled !== "boolean" ||
    typeof value.capabilities !== "object" || value.capabilities === null ||
    typeof value.capabilities.createFeishuTasks !== "boolean" ||
    typeof value.capabilities.callExternalTools !== "boolean"
  ) throw new Error("formal task reconciliation runtime snapshot is invalid");
  return {
    deploymentEnabled: value.deploymentEnabled,
    globalEnabled: value.globalEnabled,
    groupAllowlist: requireIdentifierList("groupAllowlist", value.groupAllowlist),
    disabledGroupIds: requireIdentifierList("disabledGroupIds", value.disabledGroupIds),
    capabilities: {
      createFeishuTasks: value.capabilities.createFeishuTasks,
      callExternalTools: value.capabilities.callExternalTools,
    },
  };
}

function canCreate(value: ReturnType<typeof normalizeRuntime>): boolean {
  return value.deploymentEnabled && value.globalEnabled &&
    value.capabilities.createFeishuTasks && value.capabilities.callExternalTools &&
    value.groupAllowlist.length > 0;
}

function canCreateForGroup(value: ReturnType<typeof normalizeRuntime>, groupId: string): boolean {
  return canCreate(value) && value.groupAllowlist.includes(groupId) &&
    !value.disabledGroupIds.includes(groupId);
}

function operationKey(prefix: string, values: unknown[]): string {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(values)).digest("hex")}`;
}

function requireIdentifierList(name: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error(`${name} is invalid`);
  const result = value.map((item) => requireIdentifier(name, item)).sort();
  if (new Set(result).size !== result.length) throw new Error(`${name} is invalid`);
  return result;
}

function requireIdentifier(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 512) throw new Error(`${name} is invalid`);
  return normalized;
}

function requirePositiveInteger(name: string, value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return Number(value);
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("formal task reconciliation time is invalid");
  }
  return new Date(value);
}
