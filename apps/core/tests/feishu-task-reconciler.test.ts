import { describe, expect, it, vi } from "vitest";

import { createFeishuTaskReconciler } from
  "../src/formal-tasks/feishu-task-reconciler.js";

const at = new Date("2026-08-22T12:10:00.000Z");

describe("FeishuTaskReconciler", () => {
  it("does not claim unknown outcomes while task creation is disabled", async () => {
    const fixture = createFixture({ createFeishuTasks: false });
    await expect(fixture.reconciler.processBatch({ limit: 10 })).resolves.toEqual([]);
    expect(fixture.repository.claimReconciliationAttempt).not.toHaveBeenCalled();
  });

  it("repeats the exact request with the same token and completes an identical task", async () => {
    const fixture = createFixture();

    await expect(fixture.reconciler.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "reconciled",
      executionId: "execution-1",
      code: "task_created",
    }]);
    expect(fixture.membershipChecker.isCurrentMember).toHaveBeenCalledWith({
      chatId: "oc_pilot",
      openId: "ou_assignee",
    });
    expect(fixture.creator.createTask).toHaveBeenCalledWith({
      title: claim.draft.title,
      description: claim.draft.description,
      assigneeOpenId: claim.draft.assigneeOpenId,
      dueAt: claim.draft.dueAt,
      reminderMinutes: 30,
      clientToken: claim.clientToken,
    });
    expect(fixture.repository.completeCreation).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "execution-1",
      expectedExecutionVersion: 4,
      expectedProposalVersion: 4,
      remoteTaskGuid: "task-guid-1",
      operationKey: expect.stringMatching(/^formal-task-reconcile-complete:/u),
    }));
  });

  it("stops when the replayed task identity or projection differs", async () => {
    const fixture = createFixture({
      createOutcome: { kind: "created", task: { ...remoteTask, guid: "other-guid" } },
    });

    await expect(fixture.reconciler.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "reconciliation_required",
      executionId: "execution-1",
      code: "remote_identity_mismatch",
    }]);
    expect(fixture.repository.recordCreationFailure).toHaveBeenCalledWith(expect.objectContaining({
      classification: "reconciliation_required",
      responseClassification: "remote_identity_mismatch",
    }));
  });

  it("keeps retryable replay outcomes unknown with bounded delay and the same execution", async () => {
    const fixture = createFixture({
      createOutcome: { kind: "retryable", code: "rate_limited" },
    });

    await expect(fixture.reconciler.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "outcome_unknown",
      executionId: "execution-1",
      code: "rate_limited",
    }]);
    expect(fixture.repository.recordCreationFailure).toHaveBeenCalledWith(expect.objectContaining({
      classification: "outcome_unknown",
      responseClassification: "rate_limited",
      retryAt: new Date(at.getTime() + 300_000),
    }));
  });

  it("stops after the reconciliation attempt budget", async () => {
    const fixture = createFixture({
      claim: { ...claim, execution: { ...claim.execution, attemptNumber: 5 } },
      createOutcome: { kind: "unknown", code: "timeout" },
    });

    await expect(fixture.reconciler.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "reconciliation_required",
      executionId: "execution-1",
      code: "reconciliation_budget_exhausted",
    }]);
    expect(fixture.repository.recordCreationFailure).toHaveBeenCalledWith(expect.objectContaining({
      classification: "reconciliation_required",
      responseClassification: "reconciliation_budget_exhausted",
    }));
  });

  it.each([
    [{ kind: "rejected", code: "forbidden" }, "forbidden"],
    [{ kind: "rejected", code: "invalid_request" }, "invalid_request"],
  ] as const)("stops on a permanent replay outcome: %j", async (createOutcome, code) => {
    const fixture = createFixture({ createOutcome });
    await expect(fixture.reconciler.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "reconciliation_required",
      executionId: "execution-1",
      code,
    }]);
  });

  it("requires current assignee membership before an idempotent replay", async () => {
    const fixture = createFixture({ isMember: false });
    await expect(fixture.reconciler.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "reconciliation_required",
      executionId: "execution-1",
      code: "assignee_not_current_member",
    }]);
    expect(fixture.creator.createTask).not.toHaveBeenCalled();
  });
});

const remoteTask = {
  guid: "task-guid-1",
  taskId: "t123456",
  url: "https://applink.feishu.cn/client/todo/detail?guid=task-guid-1",
  title: "Archive pilot evidence",
  description: "Verify and archive the exact acceptance evidence.",
  dueAt: new Date("2026-08-24T06:00:00.123Z"),
  dueIsAllDay: false,
  members: [{ id: "ou_assignee", type: "user" as const, role: "assignee" as const }],
  reminderMinutes: 30,
};

const claim = {
  proposal: { id: "proposal-1", version: 4 },
  approvalId: "approval-1",
  execution: {
    id: "execution-1",
    proposalId: "proposal-1",
    state: "external_attempting" as const,
    attemptNumber: 2,
    version: 4,
    requestFingerprint: "b".repeat(64),
    clientTokenHash: "c".repeat(64),
    remoteTaskGuid: "task-guid-1",
    remoteTaskId: "t123456",
    remoteTaskUrl: remoteTask.url,
  },
  draft: {
    id: "draft-1",
    revision: 1,
    version: 2,
    sourceGroupId: "oc_pilot",
    title: remoteTask.title,
    description: remoteTask.description,
    assigneeOpenId: "ou_assignee",
    dueAt: remoteTask.dueAt,
    reminderMinutes: 30 as const,
    taskSpecHash: "a".repeat(64),
  },
  policy: { id: "policy-1", version: 1 },
  clientToken: "iris-task-79f4f7eb74d74bea9ec08f4a",
};

function createFixture(overrides: {
  createFeishuTasks?: boolean;
  isMember?: boolean;
  claim?: typeof claim;
  createOutcome?: unknown;
} = {}) {
  const selectedClaim = overrides.claim ?? claim;
  const repository = {
    claimReconciliationAttempt: vi.fn()
      .mockResolvedValueOnce(selectedClaim)
      .mockResolvedValue(undefined),
    completeCreation: vi.fn(async () => undefined),
    recordCreationFailure: vi.fn(async () => undefined),
  };
  const creator = {
    createTask: vi.fn(async () => overrides.createOutcome ?? ({ kind: "created", task: remoteTask })),
  };
  const membershipChecker = {
    isCurrentMember: vi.fn(async () => overrides.isMember ?? true),
  };
  const reconciler = createFeishuTaskReconciler({
    repository,
    creator: creator as never,
    membershipChecker,
    runtimeSnapshot: () => ({
      deploymentEnabled: true,
      globalEnabled: true,
      groupAllowlist: ["oc_pilot"],
      disabledGroupIds: [],
      capabilities: { createFeishuTasks: overrides.createFeishuTasks ?? true },
    }),
    workerId: "task-reconciler-1",
    leaseMs: 30_000,
    reconciliationDelayMs: 300_000,
    maxAttempts: 5,
    now: () => new Date(at),
  });
  return { reconciler, repository, creator, membershipChecker };
}
