import { describe, expect, it, vi } from "vitest";

import { FeishuInteractiveCardClientError } from
  "../src/feishu/feishu-interactive-card-client.js";
import { createFeishuTaskResultDispatcher } from
  "../src/formal-tasks/feishu-task-result-dispatcher.js";

const at = new Date("2026-08-22T12:20:00.000Z");

describe("FeishuTaskResultDispatcher", () => {
  it("does not claim or send while result delivery is disabled", async () => {
    const fixture = createFixture({ enabled: false });
    await expect(fixture.dispatcher.processBatch({ limit: 10 })).resolves.toEqual([]);
    expect(fixture.repository.claimResultPresentationSend).not.toHaveBeenCalled();
    expect(fixture.cardClient.sendCard).not.toHaveBeenCalled();
  });

  it("renders, commits the external attempt, and sends one idempotent group card", async () => {
    const fixture = createFixture();

    await expect(fixture.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "sent",
      presentationId: "result-presentation-1",
      code: "send_succeeded",
    }]);
    expect(fixture.repository.beginResultPresentationAttempt.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.cardClient.sendCard.mock.invocationCallOrder[0]!);
    expect(fixture.cardClient.sendCard).toHaveBeenCalledWith({
      chatId: "oc_pilot",
      cardJson: expect.stringContaining("Formal task created"),
      uuid: expect.stringMatching(/^[0-9a-f]{50}$/u),
    });
    expect(fixture.repository.completeResultPresentationSend).toHaveBeenCalledWith({
      presentationId: "result-presentation-1",
      workerId: "result-worker-1",
      messageId: "om_result_1",
      at,
    });
  });

  it("fails preparation without a send when the durable context is stale", async () => {
    const fixture = createFixture({
      context: {
        ...context,
        presentation: { ...context.presentation, version: 2 },
      },
    });
    await expect(fixture.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      presentationId: "result-presentation-1",
      code: "stale_presentation",
    }]);
    expect(fixture.cardClient.sendCard).not.toHaveBeenCalled();
    expect(fixture.repository.failResultPresentationPreparation).toHaveBeenCalledWith({
      presentationId: "result-presentation-1",
      workerId: "result-worker-1",
      errorCode: "stale_presentation",
      at,
    });
  });

  it("defers result delivery without consuming an attempt when the runtime pauses after claim", async () => {
    const fixture = createFixture({ enabledSequence: [true, true, false] });

    await expect(fixture.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "retrying",
      presentationId: "result-presentation-1",
      code: "runtime_disabled",
    }]);
    expect(fixture.repository.beginResultPresentationAttempt).not.toHaveBeenCalled();
    expect(fixture.cardClient.sendCard).not.toHaveBeenCalled();
    expect(fixture.repository.deferResultPresentationSend).toHaveBeenCalledWith({
      presentationId: "result-presentation-1",
      workerId: "result-worker-1",
      retryAt: new Date(at.getTime() + 60_000),
      errorCode: "runtime_disabled",
      at,
    });
  });

  it("defers result delivery when the runtime pauses immediately before transmission", async () => {
    const fixture = createFixture({ enabledSequence: [true, true, true, false] });

    await expect(fixture.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "retrying",
      presentationId: "result-presentation-1",
      code: "runtime_disabled",
    }]);
    expect(fixture.repository.beginResultPresentationAttempt).toHaveBeenCalledOnce();
    expect(fixture.cardClient.sendCard).not.toHaveBeenCalled();
    expect(fixture.repository.deferResultPresentationSend).toHaveBeenCalledWith({
      presentationId: "result-presentation-1",
      workerId: "result-worker-1",
      retryAt: new Date(at.getTime() + 60_000),
      errorCode: "runtime_disabled",
      at,
    });
  });

  it.each([
    ["request_not_sent", "retrying", "request_not_sent"],
    ["retryable_remote_failure", "retrying", "retryable_remote_failure"],
    ["remote_rejected", "permanent_failure", "remote_rejected"],
    ["outcome_unknown", "outcome_unknown", "outcome_unknown"],
  ] as const)("persists a %s card delivery failure", async (classification, status, code) => {
    const fixture = createFixture({
      sendError: new FeishuInteractiveCardClientError(classification, "private_remote_code"),
    });
    await expect(fixture.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status,
      presentationId: "result-presentation-1",
      code,
    }]);
    expect(fixture.repository.failResultPresentationSend).toHaveBeenCalledWith({
      presentationId: "result-presentation-1",
      workerId: "result-worker-1",
      classification: status === "retrying"
        ? "retryable"
        : status === "permanent_failure" ? "permanent" : "outcome_unknown",
      errorCode: code,
      ...(status === "retrying" ? { retryAt: new Date(at.getTime() + 60_000) } : {}),
      at,
    });
    expect(JSON.stringify(fixture.repository.failResultPresentationSend.mock.calls))
      .not.toContain("private_remote_code");
  });

  it("terminalizes the fifth retryable send failure", async () => {
    const fixture = createFixture({
      claim: { ...claim, attempts: 5 },
      sendError: new FeishuInteractiveCardClientError("request_not_sent", "network"),
    });
    await expect(fixture.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      presentationId: "result-presentation-1",
      code: "max_attempts_exhausted",
    }]);
    expect(fixture.repository.failResultPresentationSend).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: "permanent",
        errorCode: "max_attempts_exhausted",
      }),
    );
  });
});

const context = {
  presentation: {
    id: "result-presentation-1",
    creationId: "creation-1",
    proposalId: "proposal-1",
    groupId: "oc_pilot",
    state: "pending_send" as const,
    version: 1,
    createdAt: new Date("2026-08-22T12:00:02.000Z"),
  },
  creation: {
    id: "creation-1",
    proposalId: "proposal-1",
    executionId: "execution-1",
    draftId: "draft-1",
    draftRevision: 1,
    draftVersion: 2,
    sourceGroupId: "oc_pilot",
    title: "Archive pilot evidence",
    assigneeOpenId: "ou_assignee",
    dueAt: new Date("2026-08-24T06:00:00.123Z"),
    reminderMinutes: 30 as const,
    remoteTaskGuid: "task-guid-1",
    remoteTaskId: "t123456",
    remoteTaskUrl: "https://applink.feishu.cn/client/todo/detail?guid=task-guid-1",
    taskSpecHash: "a".repeat(64),
    completedAt: new Date("2026-08-22T12:00:02.000Z"),
  },
};

const claim = {
  presentation: context.presentation,
  workerId: "result-worker-1",
  leaseUntil: new Date(at.getTime() + 30_000),
  attempts: 1,
};

function createFixture(overrides: {
  enabled?: boolean;
  enabledSequence?: boolean[];
  context?: typeof context;
  claim?: typeof claim;
  sendError?: Error;
} = {}) {
  const selectedClaim = overrides.claim ?? claim;
  const repository = {
    claimResultPresentationSend: vi.fn()
      .mockResolvedValueOnce(selectedClaim)
      .mockResolvedValue(undefined),
    getResultPresentationContext: vi.fn(async () => overrides.context ?? context),
    beginResultPresentationAttempt: vi.fn(async () => undefined),
    deferResultPresentationSend: vi.fn(async () => undefined),
    failResultPresentationPreparation: vi.fn(async () => undefined),
    completeResultPresentationSend: vi.fn(async () => undefined),
    failResultPresentationSend: vi.fn(async () => undefined),
  };
  const cardClient = {
    sendCard: overrides.sendError === undefined
      ? vi.fn(async () => ({ messageId: "om_result_1" }))
      : vi.fn(async () => { throw overrides.sendError; }),
  };
  const enabledSequence = [...(overrides.enabledSequence ?? [])];
  const dispatcher = createFeishuTaskResultDispatcher({
    repository,
    cardClient,
    canSendResultCards: () => enabledSequence.shift() ?? overrides.enabled ?? true,
    workerId: "result-worker-1",
    leaseMs: 30_000,
    retryDelayMs: 60_000,
    now: () => new Date(at),
  });
  return { dispatcher, repository, cardClient };
}
