import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { PublicationTargetPolicy } from
  "../src/action-approvals/action-proposal-repository.js";
import type { ApprovalInteractionJob } from "../src/knowledge-cards/knowledge-card.js";
import { createKnowledgeConflictCallbackNonce } from
  "../src/knowledge-conflicts/knowledge-conflict-card-renderer.js";
import { createKnowledgeConflictInteractionWorker } from
  "../src/knowledge-conflicts/knowledge-conflict-interaction-worker.js";
import type { KnowledgeConflictCurrentValidationResult } from
  "../src/knowledge-conflicts/knowledge-conflict-current-validator.js";
import {
  KnowledgeConflictOperationConflictError,
  type KnowledgeConflictDelivery,
} from "../src/knowledge-conflicts/knowledge-conflict-repository.js";
import type { KnowledgeConflictCandidate } from "../src/knowledge-conflicts/knowledge-conflict.js";

const at = new Date("2026-08-13T04:00:00.000Z");

describe("KnowledgeConflictInteractionWorker", () => {
  it.each([
    ["bot_actor", { actorOpenId: "ou_bot" }],
    ["not_current_member", { isCurrentMember: async () => false }],
    ["runtime_disabled", { canProcessKnowledgeConflicts: () => false }],
  ] as const)("denies stable actor/runtime condition %s before mutation", async (code, overrides) => {
    const harness = createHarness(overrides);

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "denied",
      code,
    });
    expect(harness.drafts.createDraft).not.toHaveBeenCalled();
    expect(harness.repository.applyInteraction).not.toHaveBeenCalled();
  });

  it("rechecks live runtime after membership before any mutation", async () => {
    const gate = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const harness = createHarness({ canProcessKnowledgeConflicts: gate });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "denied",
      code: "runtime_disabled",
    });
    expect(gate).toHaveBeenCalledTimes(2);
    expect(harness.validator.validate).not.toHaveBeenCalled();
    expect(harness.drafts.createDraft).not.toHaveBeenCalled();
  });

  it("retries a membership outage without mutating", async () => {
    const harness = createHarness({
      isCurrentMember: async () => { throw new Error("tenant token and private diagnostics"); },
    });

    const result = await harness.worker.processInteraction(harness.job);

    expect(result).toEqual({ status: "retryable", code: "membership_unavailable" });
    expect(JSON.stringify(result)).not.toMatch(/tenant token|private diagnostics|ou_member/iu);
    expect(harness.repository.applyInteraction).not.toHaveBeenCalled();
  });

  it.each([
    ["missing delivery", { delivery: undefined }, "stale_delivery"],
    ["unsent delivery", { delivery: delivery({ status: "processing", sentMessageId: undefined }) }, "stale_delivery"],
    ["wrong callback message", { messageId: "om_other" }, "stale_delivery"],
    ["wrong group", { groupId: "oc_other", chatId: "oc_other" }, "stale_candidate"],
    ["wrong nonce", { nonce: "wrong-nonce" }, "stale_delivery"],
  ] as const)("rejects stale delivery binding: %s", async (_label, overrides, code) => {
    const harness = createHarness(overrides);

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "denied",
      code,
    });
    expect(harness.membershipChecker.isCurrentMember).not.toHaveBeenCalled();
    expect(harness.repository.applyInteraction).not.toHaveBeenCalled();
  });

  it.each([
    ["missing candidate", { candidate: undefined }, "stale_candidate"],
    ["version changed", { candidate: candidate({ version: 4 }) }, "stale_candidate"],
    ["evidence superseded", {
      validation: { status: "superseded", candidate: candidate(), reason: "source_stale" },
    }, "evidence_invalidated"],
    ["permission revoked", {
      validation: { status: "permission_blocked", candidate: candidate() },
    }, "permission_blocked"],
  ] as const)("fails closed for %s", async (_label, overrides, code) => {
    const harness = createHarness(overrides as HarnessOverrides);

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "denied",
      code,
    });
    expect(harness.drafts.createDraft).not.toHaveBeenCalled();
    expect(harness.repository.applyInteraction).not.toHaveBeenCalled();
  });

  it("retries current-evidence validation outages without content in the result", async () => {
    const harness = createHarness({
      validation: { status: "validation_unavailable", candidate: candidate() },
    });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "retryable",
      code: "validation_unavailable",
    });
    expect(harness.drafts.createDraft).not.toHaveBeenCalled();
  });

  it("dismisses only the exact candidate for not_a_conflict", async () => {
    const harness = createHarness({ action: "not_a_conflict" });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "applied",
      code: "conflict_dismissed",
    });
    expect(harness.repository.applyInteraction).toHaveBeenCalledWith({
      id: expect.stringMatching(/^knowledge-conflict-interaction-/u),
      candidateId: "candidate-1",
      expectedVersion: 3,
      callbackOperationKey: "feishu-card:cli_conflict:event-1",
      actorRef: "ou_member",
      action: "dismiss",
      reasonCode: "member_not_a_conflict",
      permissionAttestedAt: at,
      at,
    });
    expect(harness.drafts.createDraft).not.toHaveBeenCalled();
    expect(harness.presentKnowledgeDraft).not.toHaveBeenCalled();
  });

  it("rejects a conflicting intent under the same callback operation key", async () => {
    const harness = createHarness({
      action: "not_a_conflict",
      applyInteraction: async () => { throw new KnowledgeConflictOperationConflictError(); },
    });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "denied",
      code: "immutable_intent_conflict",
    });
  });

  it("creates one exact medium-risk governed draft before committing the candidate interaction", async () => {
    const order: string[] = [];
    const harness = createHarness({
      createDraft: async (input) => {
        order.push("draft");
        return draftMutation(input.id, "applied");
      },
      applyInteraction: async () => {
        order.push("interaction");
        return interactionMutation("applied");
      },
      presentKnowledgeDraft: async () => {
        order.push("presentation");
        return { outcome: "applied" as const, presentation: { id: "knowledge-card-1" } as never };
      },
    });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "applied",
      code: "draft_created",
      draftId: expect.stringMatching(/^knowledge-conflict-draft-/u),
      presentationId: "knowledge-card-1",
    });
    expect(order).toEqual(["draft", "interaction", "presentation"]);
    expect(harness.drafts.createDraft).toHaveBeenCalledWith({
      id: expect.stringMatching(/^knowledge-conflict-draft-[0-9a-f]{40}$/u),
      operationKey: expect.stringMatching(/^knowledge-conflict-draft-create-[0-9a-f]{64}$/u),
      originKind: "knowledge_conflict",
      createdBy: "iris",
      revision: {
        sourceGroupId: "oc_group",
        title: "Knowledge update: Deployment window",
        content: [
          "Current synchronized knowledge:",
          "Deployments happen on Tuesdays.",
          "",
          "Newer group conclusion:",
          "Deployments now happen on Thursdays.",
          "",
          "Material difference:",
          "The deployment day changed from Tuesday to Thursday.",
          "",
          "Proposed update:",
          "Replace Tuesday with Thursday.",
        ].join("\n"),
        riskLevel: "medium",
        reviewer: { type: "feishu_user", ref: "ou_member" },
        suggestedPublication: { spaceId: "space-main", parentNodeToken: "parent-main" },
        evidence: [
          { type: "conversation_message", id: "message-1", groupId: "oc_group" },
          { type: "conversation_message", id: "message-2", groupId: "oc_group" },
          {
            type: "group_memory",
            id: "memory-1",
            groupId: "oc_group",
            expectedUpdatedAt: new Date("2026-08-12T01:00:00.000Z"),
          },
          {
            type: "document_source",
            id: "source-1",
            expectedUpdatedAt: new Date("2026-08-12T02:00:00.000Z"),
          },
        ],
      },
      at,
    });
    const draftId = harness.drafts.createDraft.mock.calls[0]?.[0].id;
    expect(harness.repository.applyInteraction).toHaveBeenCalledWith(expect.objectContaining({
      candidateId: "candidate-1",
      expectedVersion: 3,
      callbackOperationKey: "feishu-card:cli_conflict:event-1",
      actorRef: "ou_member",
      action: "create_draft",
      draftId,
      reasonCode: "member_requested_update_draft",
    }));
    expect(harness.presentKnowledgeDraft).toHaveBeenCalledWith({
      runtime: harness.cardRuntime,
      draftId,
      expectedVersion: 1,
      operationKey: expect.stringMatching(/^knowledge-conflict-draft-present-[0-9a-f]{64}$/u),
      at,
    });
  });

  it("uses stable draft and operation identities across callback event retries", async () => {
    const first = createHarness();
    const second = createHarness({ eventId: "event-2" });

    await first.worker.processInteraction(first.job);
    await second.worker.processInteraction(second.job);

    expect(first.drafts.createDraft.mock.calls[0]?.[0].id)
      .toBe(second.drafts.createDraft.mock.calls[0]?.[0].id);
    expect(first.drafts.createDraft.mock.calls[0]?.[0].operationKey)
      .toBe(second.drafts.createDraft.mock.calls[0]?.[0].operationKey);
    expect(first.presentKnowledgeDraft.mock.calls[0]?.[0].operationKey)
      .toBe(second.presentKnowledgeDraft.mock.calls[0]?.[0].operationKey);
  });

  it("retries presentation after a committed draft without creating a second draft", async () => {
    const existingCandidate = candidate({ status: "draft_created", version: 4 });
    const expectedDraftId = stableDraftId("candidate-1");
    const harness = createHarness({
      candidate: existingCandidate,
      validation: { status: "current", candidate: existingCandidate },
      existingDraft: draftMutation(expectedDraftId, "already_applied").draft,
      applyInteraction: async () => interactionMutation("already_applied", existingCandidate),
    });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "already_applied",
      code: "duplicate_callback",
      draftId: expectedDraftId,
      presentationId: "knowledge-card-1",
    });
    expect(harness.drafts.createDraft).not.toHaveBeenCalled();
    expect(harness.presentKnowledgeDraft).toHaveBeenCalledOnce();
  });

  it("returns a retryable presentation result only after draft and interaction commit", async () => {
    const harness = createHarness({
      presentKnowledgeDraft: async () => { throw new Error("remote card failure with draft body"); },
    });

    const result = await harness.worker.processInteraction(harness.job);

    expect(result).toEqual({ status: "retryable", code: "presentation_unavailable" });
    expect(harness.drafts.createDraft).toHaveBeenCalledOnce();
    expect(harness.repository.applyInteraction).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/draft body|remote card failure|ou_member/iu);
  });

  it("requires exactly one current medium-risk group publication target", async () => {
    const harness = createHarness({ policies: [] });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "denied",
      code: "target_unavailable",
    });
    expect(harness.drafts.createDraft).not.toHaveBeenCalled();
  });

  it("reads the current target before the final evidence and permission validation", async () => {
    const order: string[] = [];
    const harness = createHarness({
      listTargetPolicies: async () => {
        order.push("target");
        return [policy()];
      },
      validate: async () => {
        order.push("validation");
        return { status: "current" as const, candidate: candidate() };
      },
      createDraft: async (input) => {
        order.push("draft");
        return draftMutation(input.id, "applied");
      },
    });

    await harness.worker.processInteraction(harness.job);

    expect(order).toEqual(["target", "validation", "draft"]);
  });
});

type ConflictJob = Extract<ApprovalInteractionJob, { kind: "knowledge_conflict_confirmation" }>;
type Validation = KnowledgeConflictCurrentValidationResult;

type HarnessOverrides = {
  action?: ConflictJob["action"];
  actorOpenId?: string;
  chatId?: string;
  groupId?: string;
  messageId?: string;
  nonce?: string;
  eventId?: string;
  candidate?: KnowledgeConflictCandidate;
  delivery?: KnowledgeConflictDelivery;
  validation?: Validation;
  existingDraft?: ReturnType<typeof draftMutation>["draft"];
  policies?: PublicationTargetPolicy[];
  listTargetPolicies?: (...args: any[]) => Promise<PublicationTargetPolicy[]>;
  validate?: (...args: any[]) => Promise<Validation>;
  canProcessKnowledgeConflicts?: (groupId: string) => boolean;
  isCurrentMember?: () => Promise<boolean>;
  createDraft?: (...args: any[]) => Promise<any>;
  applyInteraction?: (...args: any[]) => Promise<any>;
  presentKnowledgeDraft?: (...args: any[]) => Promise<any>;
};

function createHarness(overrides: HarnessOverrides = {}) {
  const currentCandidate = "candidate" in overrides ? overrides.candidate : candidate();
  const currentDelivery = "delivery" in overrides ? overrides.delivery : delivery();
  const eventId = overrides.eventId ?? "event-1";
  const action = overrides.action ?? "create_update_draft";
  const job: ConflictJob = {
    kind: "knowledge_conflict_confirmation",
    idempotencyKey: `feishu-card:cli_conflict:${eventId}`,
    eventId,
    appId: "cli_conflict",
    actorOpenId: overrides.actorOpenId ?? "ou_member",
    chatId: overrides.chatId ?? "oc_group",
    messageId: overrides.messageId ?? "om_conflict_card",
    presentationId: "candidate-1",
    candidateId: "candidate-1",
    candidateVersion: 3,
    groupId: overrides.groupId ?? "oc_group",
    nonce: overrides.nonce ?? createKnowledgeConflictCallbackNonce("delivery-1"),
    action,
    receivedAt: new Date(at.getTime() - 1_000),
    attempts: 0,
  };
  const repository = {
    getCandidate: vi.fn(async () => currentCandidate),
    getDeliveryForCandidate: vi.fn(async () => currentDelivery),
    applyInteraction: vi.fn(overrides.applyInteraction ?? (async () => interactionMutation("applied"))),
  };
  const validator = {
    validate: vi.fn(overrides.validate ?? (async () => overrides.validation ?? {
      status: "current" as const,
      candidate: currentCandidate!,
    })),
  };
  const membershipChecker = {
    isCurrentMember: vi.fn(overrides.isCurrentMember ?? (async () => true)),
  };
  const drafts = {
    getDraft: vi.fn(async () => overrides.existingDraft),
    createDraft: vi.fn(overrides.createDraft ?? (async (input) => draftMutation(input.id, "applied"))),
  };
  const publicationTargets = {
    listTargetPolicies: vi.fn(overrides.listTargetPolicies ?? (async () => overrides.policies ?? [policy()])),
  };
  const cardRuntime = {
    repository: {
      getDraft: drafts.getDraft,
      getPresentation: vi.fn(),
      createPresentation: vi.fn(),
    },
    canUseKnowledgeCards: vi.fn(() => true),
  } as never;
  const presentKnowledgeDraft = vi.fn(overrides.presentKnowledgeDraft ?? (async () => ({
    outcome: "applied" as const,
    presentation: { id: "knowledge-card-1" },
  })));
  const worker = createKnowledgeConflictInteractionWorker({
    repository,
    currentValidator: validator,
    membershipChecker,
    drafts,
    publicationTargets,
    cardRuntime,
    presentKnowledgeDraft,
    canProcessKnowledgeConflicts: overrides.canProcessKnowledgeConflicts ?? (() => true),
    botOpenId: "ou_bot",
    now: () => new Date(at),
  });
  return {
    worker,
    job,
    repository,
    validator,
    membershipChecker,
    drafts,
    publicationTargets,
    cardRuntime,
    presentKnowledgeDraft,
  };
}

function candidate(overrides: Partial<KnowledgeConflictCandidate> = {}): KnowledgeConflictCandidate {
  return {
    id: "candidate-1",
    idempotencyKey: "candidate-key-1",
    groupId: "oc_group",
    groupMemoryId: "memory-1",
    memoryUpdatedAt: new Date("2026-08-12T01:00:00.000Z"),
    sourceMessageId: "message-1",
    targetDocumentSourceId: "source-1",
    targetSourceUpdatedAt: new Date("2026-08-12T02:00:00.000Z"),
    targetSourceVersion: "v7",
    targetSnapshotId: "snapshot-1",
    targetContentHash: "a".repeat(64),
    detectorContractVersion: "knowledge-conflict-v1",
    status: "delivered",
    plan: {
      outcome: "conflict",
      subject: "Deployment window",
      knowledgeBaseStatement: "Deployments happen on Tuesdays.",
      knowledgeBaseCitationRefs: ["D1"],
      groupConclusionStatement: "Deployments now happen on Thursdays.",
      groupCitationRefs: ["C1", "C2", "M1"],
      difference: "The deployment day changed from Tuesday to Thursday.",
      suggestedUpdate: "Replace Tuesday with Thursday.",
      targetDocumentRef: "D1",
      missingEvidence: [],
      confidence: "high",
    },
    evidence: [
      { type: "conversation_message", referenceId: "C1", groupId: "oc_group", conversationMessageId: "message-1" },
      { type: "conversation_message", referenceId: "C2", groupId: "oc_group", conversationMessageId: "message-2" },
      { type: "group_memory", referenceId: "M1", groupId: "oc_group", groupMemoryId: "memory-1", expectedUpdatedAt: new Date("2026-08-12T01:00:00.000Z") },
      { type: "document_source", referenceId: "D1", documentSourceId: "source-1", expectedUpdatedAt: new Date("2026-08-12T02:00:00.000Z") },
      { type: "document_snapshot", referenceId: "D1", documentSourceId: "source-1", documentSnapshotId: "snapshot-1", contentHash: "a".repeat(64) },
    ],
    version: 3,
    createdAt: new Date("2026-08-12T03:00:00.000Z"),
    updatedAt: new Date("2026-08-12T04:00:00.000Z"),
    ...overrides,
  };
}

function delivery(overrides: Partial<KnowledgeConflictDelivery> = {}): KnowledgeConflictDelivery {
  return {
    id: "delivery-1",
    candidateId: "candidate-1",
    groupId: "oc_group",
    status: "sent",
    retryable: false,
    attemptCount: 1,
    nextAttemptAt: at,
    sentMessageId: "om_conflict_card",
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function policy(overrides: Partial<PublicationTargetPolicy> = {}): PublicationTargetPolicy {
  return {
    id: "policy-1",
    spaceId: "space-main",
    parentNodeToken: "parent-main",
    displayName: "Main knowledge",
    allowedGroupIds: ["oc_group"],
    allowedRiskLevels: ["medium"],
    enabled: true,
    version: 7,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function draftMutation(id: string, outcome: "applied" | "already_applied") {
  return {
    outcome,
    draft: {
      id,
      sourceGroupId: "oc_group",
      originKind: "knowledge_conflict" as const,
      status: "pending_confirmation" as const,
      currentRevisionNumber: 1,
      version: 1,
      createdBy: "iris",
      createdAt: at,
      updatedAt: at,
      currentRevision: {
        revisionNumber: 1,
        riskLevel: "medium" as const,
        author: "iris",
        createdAt: at,
        evidenceState: { status: "current" as const },
        title: "Knowledge update: Deployment window",
        content: "draft content",
        evidence: [],
      },
    },
  };
}

function interactionMutation(
  outcome: "applied" | "already_applied",
  currentCandidate = candidate({ status: "draft_created", version: 4 }),
) {
  return {
    outcome,
    interaction: {
      id: "interaction-1",
      candidateId: "candidate-1",
      callbackOperationKey: "feishu-card:cli_conflict:event-1",
      actorRef: "ou_member",
      action: "create_draft" as const,
      result: "applied" as const,
      draftId: "draft-1",
      reasonCode: "member_requested_update_draft",
      createdAt: at,
    },
    candidate: currentCandidate,
  };
}

function stableDraftId(candidateId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ kind: "knowledge_conflict", candidateId }))
    .digest("hex");
  return `knowledge-conflict-draft-${digest.slice(0, 40)}`;
}
