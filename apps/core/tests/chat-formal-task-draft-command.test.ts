import { describe, expect, it, vi } from "vitest";

import {
  createChatFormalTaskDraftCommand,
  type ChatFormalTaskDraftCommandDependencies,
} from "../src/formal-tasks/chat-formal-task-draft-command.js";
import type { ChatFormalTaskDraftGenerator } from
  "../src/formal-tasks/chat-formal-task-draft-generator.js";
import type {
  FeishuTaskTargetPolicy,
  FormalTaskDraftView,
} from "../src/formal-tasks/formal-task-repository.js";

const observedAt = new Date("2026-08-22T06:00:00.000Z");

describe("chat formal task draft command", () => {
  it("creates one high-risk draft for one explicitly mentioned allowed assignee", async () => {
    const harness = commandHarness();

    const result = await harness.command.execute(commandInput());

    expect(result).toEqual({
      status: "created",
      draftId: expect.stringMatching(/^chat-formal-task-draft-[a-f0-9]{40}$/u),
      presentationId: "task-presentation-1",
    });
    expect(harness.presentDraft).toHaveBeenCalledWith({
      draftId: result.status === "created" ? result.draftId : "unexpected",
      expectedVersion: 1,
      operationKey: expect.stringMatching(/^chat-formal-task-card-[a-f0-9]{64}$/u),
      at: observedAt,
    });
    expect(harness.generator.generate).toHaveBeenCalledWith({
      messageId: "om_task",
      chatId: "oc_pilot",
      requesterOpenId: "ou_requester",
      requestText: "请给同事创建飞书任务草稿",
      observedAt,
    });
    expect(harness.repository.createDraft).toHaveBeenCalledWith({
      id: result.status === "created" ? result.draftId : "unexpected",
      operationKey: expect.stringMatching(/^chat-formal-task-draft-create-[a-f0-9]{64}$/u),
      createdBy: "iris",
      revision: {
        taskSpec: {
          title: "提交验收报告",
          description: "汇总试点证据并提交验收报告。",
          assigneeOpenId: "ou_assignee",
          dueAt: new Date("2026-08-24T09:30:00.000Z"),
          reminderMinutes: 30,
          sourceGroupId: "oc_pilot",
          targetPolicyId: "task-policy-1",
          targetPolicyVersion: 3,
        },
        riskLevel: "high",
        author: "iris",
        evidence: [{ type: "conversation_message", id: "feishu:om_task" }],
      },
      at: observedAt,
    });
  });

  it.each([[[]], [["ou_first", "ou_second"]]] as Array<[string[]]>)(
    "requires exactly one mentioned Feishu assignee before model generation: %j",
    async (assigneeOpenIds) => {
      const harness = commandHarness();

      await expect(harness.command.execute({
        ...commandInput(),
        assigneeOpenIds,
      })).resolves.toEqual({ status: "assignee_clarification_required" });
      expect(harness.generator.generate).not.toHaveBeenCalled();
      expect(harness.repository.createDraft).not.toHaveBeenCalled();
    },
  );

  it.each(["context", "draft"] as const)(
    "checks the %s runtime gate before policy lookup and model generation",
    async (disabledGate) => {
      const harness = commandHarness({ disabledGate });

      await expect(harness.command.execute(commandInput())).resolves.toEqual({
        status: "runtime_disabled",
      });
      expect(harness.repository.getTargetPolicyForGroup).not.toHaveBeenCalled();
      expect(harness.generator.generate).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "missing", policy: undefined },
    { name: "disabled", policy: policy({ enabled: false }) },
    { name: "wrong group", policy: policy({ sourceGroupId: "oc_other" }) },
    { name: "assignee not allowed", policy: policy({ allowedAssigneeOpenIds: ["ou_other"] }) },
  ])("fails closed before the model for a $name task policy", async ({ policy: target }) => {
    const harness = commandHarness({ policy: target });

    await expect(harness.command.execute(commandInput())).resolves.toEqual({
      status: "target_unavailable",
    });
    expect(harness.generator.generate).not.toHaveBeenCalled();
    expect(harness.repository.createDraft).not.toHaveBeenCalled();
  });

  it("rechecks the exact target policy after model generation", async () => {
    const harness = commandHarness();
    vi.mocked(harness.repository.getTargetPolicyForGroup)
      .mockResolvedValueOnce(policy())
      .mockResolvedValueOnce(policy({ version: 4 }));

    await expect(harness.command.execute(commandInput())).resolves.toEqual({
      status: "target_unavailable",
    });
    expect(harness.generator.generate).toHaveBeenCalledOnce();
    expect(harness.repository.createDraft).not.toHaveBeenCalled();
  });

  it("returns no_context without creating a durable draft", async () => {
    const harness = commandHarness();
    vi.mocked(harness.generator.generate).mockResolvedValue({ status: "no_context" });

    await expect(harness.command.execute(commandInput())).resolves.toEqual({
      status: "no_context",
    });
    expect(harness.repository.createDraft).not.toHaveBeenCalled();
  });

  it("replays an existing exact command without another model call", async () => {
    const existing = draft();
    const harness = commandHarness({ existingDraft: existing });

    await expect(harness.command.execute(commandInput())).resolves.toEqual({
      status: "already_created",
      draftId: existing.id,
      presentationId: "task-presentation-1",
    });
    expect(harness.repository.getTargetPolicyForGroup).not.toHaveBeenCalled();
    expect(harness.generator.generate).not.toHaveBeenCalled();
    expect(harness.repository.createDraft).not.toHaveBeenCalled();
    expect(harness.presentDraft).toHaveBeenCalledOnce();
  });
});

function commandHarness(overrides: {
  disabledGate?: "context" | "draft";
  policy?: FeishuTaskTargetPolicy;
  existingDraft?: FormalTaskDraftView;
} = {}) {
  const generator: ChatFormalTaskDraftGenerator = {
    generate: vi.fn(async () => ({
      status: "generated" as const,
      title: "提交验收报告",
      description: "汇总试点证据并提交验收报告。",
      dueAt: new Date("2026-08-24T09:30:00.000Z"),
      reminderMinutes: 30 as const,
      evidence: [{ type: "conversation_message" as const, id: "feishu:om_task" }],
    })),
  };
  const target = Object.prototype.hasOwnProperty.call(overrides, "policy")
    ? overrides.policy
    : policy();
  const repository = {
    getDraft: vi.fn(async () => overrides.existingDraft),
    getTargetPolicyForGroup: vi.fn(async () => target),
    createDraft: vi.fn(async (input) => ({
      outcome: "applied" as const,
      draft: draft({ id: input.id }),
    })),
  };
  const presentDraft = vi.fn(async (input: { draftId: string; expectedVersion: number }) => ({
    outcome: "applied" as const,
    presentation: {
      id: "task-presentation-1",
      draftId: input.draftId,
      draftRevision: 1,
      draftVersion: input.expectedVersion,
      taskSpecHash: "a".repeat(64),
      groupId: "oc_pilot",
      state: "pending_send" as const,
      createdAt: observedAt,
      version: 1,
    },
  }));
  const dependencies: ChatFormalTaskDraftCommandDependencies = {
    generator,
    canReadGroupContext: vi.fn(() => overrides.disabledGate !== "context"),
    runtime: {
      repository: repository as unknown as ChatFormalTaskDraftCommandDependencies["runtime"]["repository"],
      canCreateDraft: vi.fn(() => overrides.disabledGate !== "draft"),
      canUseFormalTaskCards: vi.fn(() => true),
      presentDraft,
    },
  };
  return {
    command: createChatFormalTaskDraftCommand(dependencies),
    generator,
    repository,
    presentDraft,
  };
}

function commandInput() {
  return {
    messageId: "om_task",
    chatId: "oc_pilot",
    requesterOpenId: "ou_requester",
    requestText: "请给同事创建飞书任务草稿",
    assigneeOpenIds: ["ou_assignee"],
    observedAt,
  };
}

function policy(overrides: Partial<FeishuTaskTargetPolicy> = {}): FeishuTaskTargetPolicy {
  return {
    id: "task-policy-1",
    sourceGroupId: "oc_pilot",
    displayName: "Pilot tasks",
    allowedAssigneeOpenIds: ["ou_assignee"],
    maxDueHorizonDays: 30,
    enabled: true,
    version: 3,
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    updatedAt: new Date("2026-08-21T00:00:00.000Z"),
    ...overrides,
  };
}

function draft(overrides: Partial<FormalTaskDraftView> = {}): FormalTaskDraftView {
  return {
    id: "chat-formal-task-draft-existing",
    sourceGroupId: "oc_pilot",
    status: "pending_confirmation",
    currentRevisionNumber: 1,
    version: 1,
    createdBy: "iris",
    currentTaskSpecHash: "a".repeat(64),
    createdAt: observedAt,
    updatedAt: observedAt,
    currentRevision: {
      revisionNumber: 1,
      riskLevel: "high",
      author: "iris",
      taskSpecHash: "a".repeat(64),
      createdAt: observedAt,
      evidenceState: { status: "current" },
      taskSpec: {
        title: "提交验收报告",
        description: "汇总试点证据并提交验收报告。",
        assigneeOpenId: "ou_assignee",
        sourceGroupId: "oc_pilot",
        targetPolicyId: "task-policy-1",
        targetPolicyVersion: 3,
      },
      evidence: [{ type: "conversation_message", id: "feishu:om_task" }],
    },
    ...overrides,
  };
}
