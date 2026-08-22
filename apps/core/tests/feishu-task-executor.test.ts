import { describe, expect, it, vi } from "vitest";

import { createFeishuTaskExecutor } from
  "../src/formal-tasks/feishu-task-executor.js";

const at = new Date("2026-08-22T12:00:00.000Z");

describe("FeishuTaskExecutor", () => {
  it("does not claim while the durable task capability is disabled", async () => {
    const fixture = createFixture({ createFeishuTasks: false });

    await expect(fixture.executor.processBatch({ limit: 10 })).resolves.toEqual([]);
    expect(fixture.repository.claimNextCreation).not.toHaveBeenCalled();
  });

  it("does not claim while external tool calls are disabled", async () => {
    const fixture = createFixture({ callExternalTools: false });

    await expect(fixture.executor.processBatch({ limit: 10 })).resolves.toEqual([]);
    expect(fixture.repository.claimNextCreation).not.toHaveBeenCalled();
  });

  it("checks current assignee membership, commits dispatch, and records one exact success", async () => {
    const fixture = createFixture();

    await expect(fixture.executor.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "created",
      proposalId: "proposal-1",
      executionId: "execution-1",
      code: "task_created",
    }]);

    expect(fixture.membershipChecker.isCurrentMember).toHaveBeenCalledWith({
      chatId: "oc_pilot",
      openId: "ou_assignee",
    });
    expect(fixture.repository.markExternalAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.creator.createTask.mock.invocationCallOrder[0]!,
    );
    expect(fixture.creator.createTask).toHaveBeenCalledWith({
      title: "Archive pilot evidence",
      description: "Verify and archive the exact acceptance evidence.",
      assigneeOpenId: "ou_assignee",
      dueAt: new Date("2026-08-24T06:00:00.123Z"),
      reminderMinutes: 30,
      clientToken: "iris-task-79f4f7eb74d74bea9ec08f4a",
    });
    expect(fixture.repository.completeCreation).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "execution-1",
      expectedExecutionVersion: 2,
      proposalId: "proposal-1",
      expectedProposalVersion: 4,
      expectedDraftVersion: 2,
      expectedDraftRevision: 1,
      taskSpecHash: "a".repeat(64),
      remoteTaskGuid: "task-guid-1",
      remoteTaskId: "t123456",
      remoteTaskUrl: "https://applink.feishu.cn/client/todo/detail?guid=task-guid-1",
      operationKey: expect.stringMatching(/^formal-task-complete:/u),
      at,
    }));
  });

  it("fails closed before dispatch when the assignee is no longer a group member", async () => {
    const fixture = createFixture({ isMember: false });

    await expect(fixture.executor.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "failed",
      proposalId: "proposal-1",
      executionId: "execution-1",
      code: "assignee_not_current_member",
    }]);
    expect(fixture.repository.markExternalAttempt).not.toHaveBeenCalled();
    expect(fixture.creator.createTask).not.toHaveBeenCalled();
    expect(fixture.repository.recordCreationFailure).toHaveBeenCalledWith(expect.objectContaining({
      classification: "failed",
      responseClassification: "assignee_not_current_member",
      expectedExecutionVersion: 1,
    }));
  });

  it("treats unavailable membership as a pre-dispatch terminal failure", async () => {
    const fixture = createFixture({ membershipError: true });

    await expect(fixture.executor.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "failed",
      proposalId: "proposal-1",
      executionId: "execution-1",
      code: "membership_unavailable",
    }]);
    expect(fixture.creator.createTask).not.toHaveBeenCalled();
  });

  it("schedules bounded retryable failures with the same durable request binding", async () => {
    const fixture = createFixture({
      createOutcome: { kind: "retryable", code: "rate_limited" },
    });

    await expect(fixture.executor.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "retrying",
      proposalId: "proposal-1",
      executionId: "execution-1",
      code: "rate_limited",
    }]);
    expect(fixture.repository.recordCreationFailure).toHaveBeenCalledWith(expect.objectContaining({
      classification: "retryable",
      retryAt: new Date(at.getTime() + 60_000),
      responseClassification: "rate_limited",
    }));
    expect(fixture.creator.createTask).toHaveBeenCalledWith(expect.objectContaining({
      clientToken: claim.clientToken,
    }));
  });

  it("stops retrying after the bounded external-attempt budget", async () => {
    const fixture = createFixture({
      claim: { ...claim, execution: { ...claim.execution, attemptNumber: 5 } },
      createOutcome: { kind: "retryable", code: "server_error" },
    });

    await expect(fixture.executor.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "failed",
      proposalId: "proposal-1",
      executionId: "execution-1",
      code: "retry_budget_exhausted",
    }]);
    expect(fixture.repository.recordCreationFailure).toHaveBeenCalledWith(expect.objectContaining({
      classification: "failed",
      responseClassification: "retry_budget_exhausted",
    }));
  });

  it("records timeout and connection-loss outcomes as unknown for reconciliation", async () => {
    const fixture = createFixture({
      createOutcome: { kind: "unknown", code: "timeout" },
    });

    await expect(fixture.executor.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "outcome_unknown",
      proposalId: "proposal-1",
      executionId: "execution-1",
      code: "timeout",
    }]);
    expect(fixture.repository.recordCreationFailure).toHaveBeenCalledWith(expect.objectContaining({
      classification: "outcome_unknown",
      retryAt: new Date(at.getTime() + 300_000),
      responseClassification: "timeout",
    }));
  });

  it("stops automation when a successful response does not match the approved task projection", async () => {
    const fixture = createFixture({
      createOutcome: {
        kind: "created",
        task: { ...remoteTask, members: [{ id: "ou_other", type: "user", role: "assignee" }] },
      },
    });

    await expect(fixture.executor.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "reconciliation_required",
      proposalId: "proposal-1",
      executionId: "execution-1",
      code: "remote_projection_mismatch",
    }]);
    expect(fixture.repository.completeCreation).not.toHaveBeenCalled();
    expect(fixture.repository.recordCreationFailure).toHaveBeenCalledWith(expect.objectContaining({
      classification: "reconciliation_required",
      responseClassification: "remote_projection_mismatch",
    }));
  });

  it("preserves a remotely-created result as outcome unknown if local completion fails", async () => {
    const fixture = createFixture({ completeError: true });

    await expect(fixture.executor.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "outcome_unknown",
      proposalId: "proposal-1",
      executionId: "execution-1",
      code: "completion_failed",
    }]);
    expect(fixture.repository.recordCreationFailure).toHaveBeenCalledWith(expect.objectContaining({
      classification: "outcome_unknown",
      responseClassification: "completion_failed",
      retryAt: new Date(at.getTime() + 300_000),
      remoteTaskGuid: "task-guid-1",
      remoteTaskId: "t123456",
      remoteTaskUrl: remoteTask.url,
    }));
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
    state: "claimed" as const,
    attemptNumber: 1,
    version: 1,
    requestFingerprint: "b".repeat(64),
    clientTokenHash: "c".repeat(64),
  },
  draft: {
    id: "draft-1",
    revision: 1,
    version: 2,
    sourceGroupId: "oc_pilot",
    title: "Archive pilot evidence",
    description: "Verify and archive the exact acceptance evidence.",
    assigneeOpenId: "ou_assignee",
    dueAt: new Date("2026-08-24T06:00:00.123Z"),
    reminderMinutes: 30 as const,
    taskSpecHash: "a".repeat(64),
  },
  policy: { id: "policy-1", version: 1 },
  clientToken: "iris-task-79f4f7eb74d74bea9ec08f4a",
};

function createFixture(overrides: {
  createFeishuTasks?: boolean;
  callExternalTools?: boolean;
  isMember?: boolean;
  membershipError?: boolean;
  claim?: typeof claim;
  createOutcome?: unknown;
  completeError?: boolean;
} = {}) {
  const selectedClaim = overrides.claim ?? claim;
  const repository = {
    claimNextCreation: vi.fn()
      .mockResolvedValueOnce(selectedClaim)
      .mockResolvedValue(undefined),
    markExternalAttempt: vi.fn(async () => ({
      ...selectedClaim,
      execution: {
        ...selectedClaim.execution,
        state: "external_attempting" as const,
        version: 2,
      },
    })),
    completeCreation: overrides.completeError
      ? vi.fn(async () => { throw new Error("database unavailable"); })
      : vi.fn(async () => undefined),
    recordCreationFailure: vi.fn(async () => undefined),
  };
  const creator = {
    createTask: vi.fn(async () => overrides.createOutcome ?? ({ kind: "created", task: remoteTask })),
  };
  const membershipChecker = {
    isCurrentMember: vi.fn(async () => {
      if (overrides.membershipError) throw new Error("private token detail");
      return overrides.isMember ?? true;
    }),
  };
  const executor = createFeishuTaskExecutor({
    repository,
    creator: creator as never,
    membershipChecker,
    runtimeSnapshot: () => ({
      deploymentEnabled: true,
      globalEnabled: true,
      groupAllowlist: ["oc_pilot"],
      disabledGroupIds: [],
      capabilities: {
        createFeishuTasks: overrides.createFeishuTasks ?? true,
        callExternalTools: overrides.callExternalTools ?? true,
      },
    }),
    workerId: "task-worker-1",
    leaseMs: 30_000,
    retryDelayMs: 60_000,
    reconciliationDelayMs: 300_000,
    maxAttempts: 5,
    now: () => new Date(at),
  });
  return { executor, repository, creator, membershipChecker };
}
