import { describe, expect, it, vi } from "vitest";

import {
  createChatKnowledgeDraftCommand,
  type ChatKnowledgeDraftCommandDependencies,
} from "../src/knowledge-governance/chat-knowledge-draft-command.js";
import type { PublicationTargetPolicy } from "../src/action-approvals/action-proposal-repository.js";
import type { KnowledgeDraft } from "../src/knowledge-governance/knowledge-draft-repository.js";
import type { KnowledgeDraftPresentation } from "../src/knowledge-cards/knowledge-card-repository.js";
import type { ChatKnowledgeDraftGenerator } from "../src/knowledge-governance/chat-knowledge-draft-generator.js";

const observedAt = new Date("2026-08-02T03:00:00.000Z");

describe("chat knowledge draft command", () => {
  it("creates one governed medium-risk draft and one group presentation", async () => {
    const harness = commandHarness();

    const result = await harness.command.execute(commandInput());

    expect(result).toEqual({
      status: "created",
      draftId: expect.stringMatching(/^chat-knowledge-draft-[a-f0-9]{40}$/u),
      presentationId: "presentation-1",
    });
    expect(harness.generator.generate).toHaveBeenCalledWith({
      chatId: "oc_pilot",
      requesterOpenId: "ou_owner",
      requestText: "把刚才讨论整理成知识草稿",
      observedAt,
    });
    expect(harness.draftRepository.createDraft).toHaveBeenCalledWith({
      id: result.status === "created" ? result.draftId : "unexpected",
      operationKey: expect.stringMatching(/^chat-knowledge-draft-create-[a-f0-9]{64}$/u),
      originKind: "user_requested",
      createdBy: "iris",
      revision: {
        sourceGroupId: "oc_pilot",
        title: "客户反馈看板上线范围",
        content: "本周五先向设计团队开放。",
        riskLevel: "medium",
        reviewer: { type: "feishu_user", ref: "ou_owner" },
        suggestedPublication: {
          spaceId: "space-main",
          parentNodeToken: "parent-main",
        },
        evidence: [
          { type: "conversation_message", id: "feishu:om_1", groupId: "oc_pilot" },
        ],
      },
      at: observedAt,
    });
    expect(harness.present).toHaveBeenCalledWith(expect.objectContaining({
      runtime: harness.cardRuntime,
      draftId: result.status === "created" ? result.draftId : "unexpected",
      expectedVersion: 1,
      operationKey: expect.stringMatching(/^chat-knowledge-draft-present-[a-f0-9]{64}$/u),
      at: observedAt,
    }));
  });

  it.each(["context", "draft", "card", "approval"] as const)(
    "checks the %s runtime gate before policy lookup or model generation",
    async (disabledGate) => {
      const harness = commandHarness({ disabledGate });

      await expect(harness.command.execute(commandInput())).resolves.toEqual({
        status: "runtime_disabled",
      });
      expect(harness.actionRepository.listTargetPolicies).not.toHaveBeenCalled();
      expect(harness.generator.generate).not.toHaveBeenCalled();
      expect(harness.draftRepository.createDraft).not.toHaveBeenCalled();
      expect(harness.present).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "no matching policy", policies: [] },
    { name: "ambiguous policies", policies: [policy(), policy({ id: "policy-duplicate" })] },
    { name: "wrong group", policies: [policy({ allowedGroupIds: ["oc_other"] })] },
    { name: "wrong risk", policies: [policy({ allowedRiskLevels: ["high"] })] },
  ])("fails closed before the model for $name", async ({ policies }) => {
    const harness = commandHarness({ policies });

    await expect(harness.command.execute(commandInput())).resolves.toEqual({
      status: "target_unavailable",
    });
    expect(harness.generator.generate).not.toHaveBeenCalled();
    expect(harness.draftRepository.createDraft).not.toHaveBeenCalled();
    expect(harness.present).not.toHaveBeenCalled();
  });

  it("returns no_context without creating durable facts", async () => {
    const harness = commandHarness();
    vi.mocked(harness.generator.generate).mockResolvedValue({ status: "no_context" });

    await expect(harness.command.execute(commandInput())).resolves.toEqual({
      status: "no_context",
    });
    expect(harness.draftRepository.createDraft).not.toHaveBeenCalled();
    expect(harness.present).not.toHaveBeenCalled();
  });

  it("resumes a pending exact replay without another model call", async () => {
    const existing = draft();
    const harness = commandHarness({ existingDraft: existing });

    await expect(harness.command.execute(commandInput())).resolves.toEqual({
      status: "already_created",
      draftId: existing.id,
      presentationId: "presentation-1",
    });
    expect(harness.generator.generate).not.toHaveBeenCalled();
    expect(harness.draftRepository.createDraft).not.toHaveBeenCalled();
    expect(harness.present).toHaveBeenCalledWith(expect.objectContaining({
      expectedVersion: existing.version,
    }));
  });

  it("resumes a pending exact replay when creation gates or target policies later change", async () => {
    const existing = draft();
    const harness = commandHarness({
      disabledGate: "approval",
      existingDraft: existing,
      policies: [policy(), policy({ id: "policy-duplicate" })],
    });

    await expect(harness.command.execute(commandInput())).resolves.toEqual({
      status: "already_created",
      draftId: existing.id,
      presentationId: "presentation-1",
    });
    expect(harness.canReadGroupContext).not.toHaveBeenCalled();
    expect(harness.actionRepository.listTargetPolicies).not.toHaveBeenCalled();
    expect(harness.generator.generate).not.toHaveBeenCalled();
    expect(harness.present).toHaveBeenCalledOnce();
  });

  it("rechecks runtime gates after model generation before persisting", async () => {
    const harness = commandHarness();
    vi.mocked(harness.draftRuntime.canCreateDraft)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await expect(harness.command.execute(commandInput())).resolves.toEqual({
      status: "runtime_disabled",
    });
    expect(harness.generator.generate).toHaveBeenCalledOnce();
    expect(harness.draftRepository.createDraft).not.toHaveBeenCalled();
    expect(harness.present).not.toHaveBeenCalled();
  });

  it("rechecks the exact publication target after model generation", async () => {
    const harness = commandHarness();
    vi.mocked(harness.actionRepository.listTargetPolicies)
      .mockResolvedValueOnce([policy()])
      .mockResolvedValueOnce([policy({ version: 4, parentNodeToken: "parent-new" })]);

    await expect(harness.command.execute(commandInput())).resolves.toEqual({
      status: "target_unavailable",
    });
    expect(harness.generator.generate).toHaveBeenCalledOnce();
    expect(harness.draftRepository.createDraft).not.toHaveBeenCalled();
    expect(harness.present).not.toHaveBeenCalled();
  });

  it("does not regenerate after a presentation failure", async () => {
    let existing: KnowledgeDraft | undefined;
    const harness = commandHarness();
    vi.mocked(harness.draftRepository.getDraft).mockImplementation(async () => existing);
    vi.mocked(harness.draftRepository.createDraft).mockImplementation(async (input) => {
      existing = draft({
        id: input.id,
        currentRevision: {
          ...draft().currentRevision,
          ...(input.revision as object),
        } as KnowledgeDraft["currentRevision"],
      });
      return { outcome: "applied", draft: existing };
    });
    vi.mocked(harness.present)
      .mockRejectedValueOnce(new Error("temporary presentation failure"))
      .mockResolvedValueOnce({ outcome: "applied", presentation: presentation() });

    await expect(harness.command.execute(commandInput())).rejects.toThrow(
      "temporary presentation failure",
    );
    await expect(harness.command.execute(commandInput())).resolves.toMatchObject({
      status: "already_created",
      presentationId: "presentation-1",
    });
    expect(harness.generator.generate).toHaveBeenCalledTimes(1);
    expect(harness.draftRepository.createDraft).toHaveBeenCalledTimes(1);
    expect(harness.present).toHaveBeenCalledTimes(2);
  });

  it("does not reopen or re-present a draft that already left group confirmation", async () => {
    const existing = draft({ status: "pending_review", version: 2 });
    const harness = commandHarness({ existingDraft: existing });

    await expect(harness.command.execute(commandInput())).resolves.toEqual({
      status: "already_created",
      draftId: existing.id,
    });
    expect(harness.generator.generate).not.toHaveBeenCalled();
    expect(harness.present).not.toHaveBeenCalled();
  });
});

function commandHarness(overrides: {
  disabledGate?: "context" | "draft" | "card" | "approval";
  existingDraft?: KnowledgeDraft;
  policies?: PublicationTargetPolicy[];
} = {}) {
  const generator: ChatKnowledgeDraftGenerator = {
    generate: vi.fn<ChatKnowledgeDraftGenerator["generate"]>(async () => ({
      status: "generated" as const,
      title: "客户反馈看板上线范围",
      content: "本周五先向设计团队开放。",
      evidence: [
        { type: "conversation_message" as const, id: "feishu:om_1", groupId: "oc_pilot" },
      ],
    })),
  };
  const draftRepository = {
    getDraft: vi.fn(async () => overrides.existingDraft),
    createDraft: vi.fn(async (input) => ({
      outcome: "applied" as const,
      draft: draft({ id: input.id }),
    })),
  };
  const actionRepository = {
    listTargetPolicies: vi.fn(async () => overrides.policies ?? [policy()]),
  };
  const cardRuntime = {
    repository: {},
    canUseKnowledgeCards: vi.fn(() => overrides.disabledGate !== "card"),
  } as unknown as ChatKnowledgeDraftCommandDependencies["cardRuntime"];
  const present = vi.fn(async () => ({
    outcome: "applied" as const,
    presentation: presentation(),
  }));
  const canReadGroupContext = vi.fn(() => overrides.disabledGate !== "context");
  const draftRuntime = {
    repository: draftRepository as unknown as ChatKnowledgeDraftCommandDependencies["draftRuntime"]["repository"],
    canCreateDraft: vi.fn(() => overrides.disabledGate !== "draft"),
  };
  const dependencies: ChatKnowledgeDraftCommandDependencies = {
    generator,
    canReadGroupContext,
    draftRuntime,
    cardRuntime,
    actionApprovalRuntime: {
      repository: actionRepository as unknown as ChatKnowledgeDraftCommandDependencies["actionApprovalRuntime"]["repository"],
      canUseActionApprovalsForSourceGroup: vi.fn(() => overrides.disabledGate !== "approval"),
    },
    presentKnowledgeDraft: present,
  };
  return {
    command: createChatKnowledgeDraftCommand(dependencies),
    generator,
    draftRepository,
    actionRepository,
    cardRuntime,
    canReadGroupContext,
    draftRuntime,
    present,
  };
}

function commandInput() {
  return {
    messageId: "om_command",
    chatId: "oc_pilot",
    requesterOpenId: "ou_owner",
    requestText: "把刚才讨论整理成知识草稿",
    observedAt,
  };
}

function policy(overrides: Partial<PublicationTargetPolicy> = {}): PublicationTargetPolicy {
  return {
    id: "policy-main",
    spaceId: "space-main",
    parentNodeToken: "parent-main",
    displayName: "Main wiki",
    allowedGroupIds: ["oc_pilot"],
    allowedRiskLevels: ["medium"],
    enabled: true,
    version: 3,
    createdAt: observedAt,
    updatedAt: observedAt,
    ...overrides,
  };
}

function draft(overrides: Partial<KnowledgeDraft> = {}): KnowledgeDraft {
  const currentRevision: KnowledgeDraft["currentRevision"] = {
    revisionNumber: 1,
    riskLevel: "medium",
    author: "iris",
    createdAt: observedAt,
    evidenceState: { status: "current" },
    title: "客户反馈看板上线范围",
    content: "本周五先向设计团队开放。",
    reviewer: { type: "feishu_user", ref: "ou_owner" },
    suggestedPublication: { spaceId: "space-main", parentNodeToken: "parent-main" },
    evidence: [
      { type: "conversation_message", id: "feishu:om_1", groupId: "oc_pilot" },
    ],
  };
  return {
    id: "chat-knowledge-draft-existing",
    sourceGroupId: "oc_pilot",
    originKind: "user_requested",
    status: "pending_confirmation",
    currentRevisionNumber: 1,
    version: 1,
    createdBy: "iris",
    createdAt: observedAt,
    updatedAt: observedAt,
    currentRevision,
    ...overrides,
  };
}

function presentation(): KnowledgeDraftPresentation {
  return {
    id: "presentation-1",
    draftId: "chat-knowledge-draft-existing",
    revisionNumber: 1,
    draftVersion: 1,
    chatId: "oc_pilot",
    contentHash: "a".repeat(64),
    state: "pending_send",
    createdAt: observedAt,
    version: 1,
  };
}
