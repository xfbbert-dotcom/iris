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

export type FeishuTaskExecutorResult = {
  status: "created" | "retrying" | "failed" | "outcome_unknown" |
    "reconciliation_required" | "skipped";
  proposalId: string;
  executionId?: string;
  code: string;
};

export type FeishuTaskExecutorDependencies = {
  repository: Pick<FormalTaskExecutionRepository,
    "claimNextCreation" | "markExternalAttempt" | "completeCreation" |
    "recordCreationFailure">;
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
  retryDelayMs: number;
  reconciliationDelayMs: number;
  maxAttempts: number;
  now?: () => Date;
};

export function createFeishuTaskExecutor({
  repository,
  creator,
  membershipChecker,
  runtimeSnapshot,
  workerId,
  leaseMs,
  retryDelayMs,
  reconciliationDelayMs,
  maxAttempts,
  now = () => new Date(),
}: FeishuTaskExecutorDependencies) {
  const safeWorkerId = requireIdentifier("workerId", workerId);
  const safeLeaseMs = requirePositiveInteger("leaseMs", leaseMs, MAX_TIMER_DELAY_MS);
  const safeRetryDelayMs = requirePositiveInteger(
    "retryDelayMs",
    retryDelayMs,
    MAX_TIMER_DELAY_MS,
  );
  const safeReconciliationDelayMs = requirePositiveInteger(
    "reconciliationDelayMs",
    reconciliationDelayMs,
    MAX_TIMER_DELAY_MS,
  );
  const safeMaxAttempts = requirePositiveInteger("maxAttempts", maxAttempts, 20);

  return {
    async processBatch({ limit }: { limit: number }): Promise<FeishuTaskExecutorResult[]> {
      const safeLimit = requirePositiveInteger("limit", limit, MAX_BATCH_LIMIT);
      const initialGate = normalizeRuntime(runtimeSnapshot());
      if (!canCreate(initialGate)) return [];
      const results: FeishuTaskExecutorResult[] = [];
      for (let index = 0; index < safeLimit; index += 1) {
        const gate = normalizeRuntime(runtimeSnapshot());
        if (!canCreate(gate)) break;
        const claimedAt = requireDate(now());
        let claim: ClaimedFeishuTaskCreation | undefined;
        try {
          claim = await repository.claimNextCreation({
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
            operationKey: operationKey("formal-task-claim", [safeWorkerId, claimedAt.toISOString()]),
            at: claimedAt,
          });
        } catch {
          break;
        }
        if (claim === undefined) break;
        results.push(await executeClaim({
          claim,
          repository,
          creator,
          membershipChecker,
          runtimeSnapshot,
          workerId: safeWorkerId,
          retryDelayMs: safeRetryDelayMs,
          reconciliationDelayMs: safeReconciliationDelayMs,
          maxAttempts: safeMaxAttempts,
          now,
        }));
      }
      return results;
    },
  };
}

async function executeClaim(input: {
  claim: ClaimedFeishuTaskCreation;
  repository: FeishuTaskExecutorDependencies["repository"];
  creator: FeishuTaskExecutorDependencies["creator"];
  membershipChecker: FeishuGroupMembershipChecker;
  runtimeSnapshot: FeishuTaskExecutorDependencies["runtimeSnapshot"];
  workerId: string;
  retryDelayMs: number;
  reconciliationDelayMs: number;
  maxAttempts: number;
  now: () => Date;
}): Promise<FeishuTaskExecutorResult> {
  const base = {
    proposalId: input.claim.proposal.id,
    executionId: input.claim.execution.id,
  };
  let currentMember: boolean;
  try {
    currentMember = await input.membershipChecker.isCurrentMember({
      chatId: input.claim.draft.sourceGroupId,
      openId: input.claim.draft.assigneeOpenId,
    });
  } catch {
    await recordFailure(input, input.claim, "failed", "membership_unavailable");
    return { ...base, status: "failed", code: "membership_unavailable" };
  }
  if (!currentMember) {
    await recordFailure(input, input.claim, "failed", "assignee_not_current_member");
    return { ...base, status: "failed", code: "assignee_not_current_member" };
  }
  const gate = normalizeRuntime(input.runtimeSnapshot());
  if (!canCreateForGroup(gate, input.claim.draft.sourceGroupId)) {
    await recordFailure(input, input.claim, "failed", "runtime_disabled");
    return { ...base, status: "skipped", code: "runtime_disabled" };
  }

  let dispatched: ClaimedFeishuTaskCreation;
  try {
    dispatched = await input.repository.markExternalAttempt({
      executionId: input.claim.execution.id,
      expectedExecutionVersion: input.claim.execution.version,
      workerId: input.workerId,
      operationKey: operationKey("formal-task-dispatch", [input.claim.execution.id]),
      at: requireDate(input.now()),
    });
  } catch {
    return { ...base, status: "reconciliation_required", code: "dispatch_commit_failed" };
  }

  let outcome: FeishuTaskCreateOutcome;
  try {
    outcome = await input.creator.createTask({
      title: dispatched.draft.title,
      description: dispatched.draft.description,
      assigneeOpenId: dispatched.draft.assigneeOpenId,
      ...(dispatched.draft.dueAt === undefined
        ? {}
        : { dueAt: new Date(dispatched.draft.dueAt) }),
      ...(dispatched.draft.reminderMinutes === undefined
        ? {}
        : { reminderMinutes: dispatched.draft.reminderMinutes }),
      clientToken: dispatched.clientToken,
    });
  } catch {
    outcome = { kind: "unknown", code: "connection_lost" };
  }
  if (outcome.kind === "created") {
    if (!matchesApprovedTaskProjection(dispatched, outcome.task)) {
      await recordFailure(
        input,
        dispatched,
        "reconciliation_required",
        "remote_projection_mismatch",
        outcome.task,
      );
      return { ...base, status: "reconciliation_required", code: "remote_projection_mismatch" };
    }
    try {
      await input.repository.completeCreation({
        proposalId: dispatched.proposal.id,
        executionId: dispatched.execution.id,
        expectedProposalVersion: dispatched.proposal.version,
        expectedExecutionVersion: dispatched.execution.version,
        expectedDraftVersion: dispatched.draft.version,
        expectedDraftRevision: dispatched.draft.revision,
        taskSpecHash: dispatched.draft.taskSpecHash,
        remoteTaskGuid: outcome.task.guid,
        remoteTaskId: outcome.task.taskId,
        remoteTaskUrl: outcome.task.url,
        operationKey: operationKey("formal-task-complete", [dispatched.proposal.id]),
        at: requireDate(input.now()),
      });
      return { ...base, status: "created", code: "task_created" };
    } catch {
      await recordFailure(
        input,
        dispatched,
        "outcome_unknown",
        "completion_failed",
        outcome.task,
      );
      return { ...base, status: "outcome_unknown", code: "completion_failed" };
    }
  }
  if (outcome.kind === "retryable") {
    if (dispatched.execution.attemptNumber >= input.maxAttempts) {
      await recordFailure(input, dispatched, "failed", "retry_budget_exhausted");
      return { ...base, status: "failed", code: "retry_budget_exhausted" };
    }
    await recordFailure(input, dispatched, "retryable", outcome.code);
    return { ...base, status: "retrying", code: outcome.code };
  }
  if (outcome.kind === "rejected") {
    await recordFailure(input, dispatched, "failed", outcome.code);
    return { ...base, status: "failed", code: outcome.code };
  }
  await recordFailure(input, dispatched, "outcome_unknown", outcome.code);
  return { ...base, status: "outcome_unknown", code: outcome.code };
}

async function recordFailure(
  input: Parameters<typeof executeClaim>[0],
  claim: ClaimedFeishuTaskCreation,
  classification: RecordFeishuTaskCreationFailureInput["classification"],
  responseClassification: string,
  remote?: { guid: string; taskId: string; url: string },
): Promise<void> {
  const recordedAt = requireDate(input.now());
  try {
    await input.repository.recordCreationFailure({
      proposalId: claim.proposal.id,
      executionId: claim.execution.id,
      expectedProposalVersion: claim.proposal.version,
      expectedExecutionVersion: claim.execution.version,
      classification,
      responseClassification,
      ...(classification === "retryable"
        ? { retryAt: new Date(recordedAt.getTime() + input.retryDelayMs) }
        : classification === "outcome_unknown"
          ? { retryAt: new Date(recordedAt.getTime() + input.reconciliationDelayMs) }
          : {}),
      ...(remote === undefined
        ? {}
        : {
            remoteTaskGuid: remote.guid,
            remoteTaskId: remote.taskId,
            remoteTaskUrl: remote.url,
          }),
      operationKey: operationKey(`formal-task-${classification}`, [
        claim.execution.id,
        claim.execution.attemptNumber,
        responseClassification,
      ]),
      at: recordedAt,
    });
  } catch {
    // Durable external-attempt facts remain available for operator reconciliation.
  }
}

function normalizeRuntime(value: ReturnType<FeishuTaskExecutorDependencies["runtimeSnapshot"]>) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("formal task runtime snapshot is invalid");
  }
  if (
    typeof value.deploymentEnabled !== "boolean" ||
    typeof value.globalEnabled !== "boolean" ||
    typeof value.capabilities !== "object" ||
    value.capabilities === null ||
    typeof value.capabilities.createFeishuTasks !== "boolean" ||
    typeof value.capabilities.callExternalTools !== "boolean"
  ) throw new Error("formal task runtime snapshot is invalid");
  const groupAllowlist = requireIdentifierList("groupAllowlist", value.groupAllowlist);
  const disabledGroupIds = requireIdentifierList("disabledGroupIds", value.disabledGroupIds);
  return {
    deploymentEnabled: value.deploymentEnabled,
    globalEnabled: value.globalEnabled,
    groupAllowlist,
    disabledGroupIds,
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
    throw new Error("formal task executor time is invalid");
  }
  return new Date(value);
}
