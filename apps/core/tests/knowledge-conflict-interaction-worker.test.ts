import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { PublicationTargetPolicy } from
  "../src/action-approvals/action-proposal-repository.js";
import type { AuthenticatedKnowledgeConflictConfirmationInteraction } from
  "../src/knowledge-conflicts/knowledge-conflict-callback-identity-store.js";
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
import { KnowledgeDraftOperationConflictError } from
  "../src/knowledge-governance/postgres-knowledge-draft-repository.js";

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

  it("does not dismiss when membership is revoked during the final permission validation", async () => {
    let currentMember = true;
    let validations = 0;
    const harness = createHarness({
      action: "not_a_conflict",
      isCurrentMember: async () => currentMember,
      validate: async () => {
        validations += 1;
        if (validations === 2) currentMember = false;
        return { status: "current", candidate: candidate(), permissionAttestedAt: at };
      },
    });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "denied",
      code: "not_current_member",
    });
    expect(harness.repository.applyInteraction).not.toHaveBeenCalled();
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
      knowledgeConflictGovernance: {
        permission: { documentSourceIds: ["source-1"], attestedAt: at },
        publicationTarget: { id: "policy-1", version: 7 },
      },
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
      permissionAttestedAt: at,
      targetPolicyId: "policy-1",
      targetPolicyVersion: 7,
    }));
    expect(harness.presentKnowledgeDraft).toHaveBeenCalledWith({
      runtime: harness.cardRuntime,
      draftId,
      expectedVersion: 1,
      operationKey: expect.stringMatching(/^knowledge-conflict-draft-present-[0-9a-f]{64}$/u),
      at,
    });
  });

  it("attests only the target source included in the governed draft", async () => {
    const withContextSource = candidate({
      evidence: [
        ...candidate().evidence,
        {
          type: "document_source",
          referenceId: "D2",
          documentSourceId: "source-context",
          expectedUpdatedAt: new Date("2026-08-12T02:00:00.000Z"),
        },
      ],
    });
    const harness = createHarness({ candidate: withContextSource });

    await harness.worker.processInteraction(harness.job);

    expect(harness.drafts.createDraft).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeConflictGovernance: expect.objectContaining({
        permission: { documentSourceIds: ["source-1"], attestedAt: at },
      }),
    }));
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
    const laterAt = new Date(at.getTime() + 120_000);
    const harness = createHarness({
      candidate: existingCandidate,
      now: () => new Date(laterAt),
      validation: { status: "current", candidate: existingCandidate, permissionAttestedAt: laterAt },
      existingDraft: draftMutation(expectedDraftId, "already_applied").draft,
      createDraft: async (input) => draftMutation(input.id, "already_applied"),
      applyInteraction: async () => interactionMutation("already_applied", existingCandidate),
    });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "already_applied",
      code: "duplicate_callback",
      draftId: expectedDraftId,
      presentationId: "knowledge-card-1",
    });
    expect(harness.drafts.createDraft).toHaveBeenCalledWith(expect.objectContaining({
      id: expectedDraftId,
      knowledgeConflictGovernance: expect.objectContaining({
        permission: { documentSourceIds: ["source-1"], attestedAt: laterAt },
      }),
    }));
    expect(harness.presentKnowledgeDraft).toHaveBeenCalledOnce();
  });

  it("reattests an old committed draft before the real presentation validator loads it", async () => {
    const existingCandidate = candidate({ status: "draft_created", version: 4 });
    const expectedDraftId = stableDraftId("candidate-1");
    const laterAt = new Date(at.getTime() + 120_000);
    let visibleDraft: any = {
      ...draftMutation(expectedDraftId, "already_applied").draft,
      currentRevision: {
        revisionNumber: 1,
        riskLevel: "medium",
        author: "iris",
        createdAt: at,
        evidenceState: { status: "invalidated", reason: "document_permission_unavailable" },
      },
    };
    const harness = createHarness({
      candidate: existingCandidate,
      now: () => new Date(laterAt),
      validation: { status: "current", candidate: existingCandidate, permissionAttestedAt: laterAt },
      getDraft: async () => visibleDraft,
      createDraft: async (input) => {
        visibleDraft = draftMutation(input.id, "already_applied").draft;
        return { outcome: "already_applied" as const, draft: visibleDraft };
      },
      applyInteraction: async () => interactionMutation("already_applied", existingCandidate),
      useDefaultPresentation: true,
    });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toMatchObject({
      status: "already_applied",
      code: "duplicate_callback",
      draftId: expectedDraftId,
      presentationId: expect.stringMatching(/^knowledge-card-/u),
    });
    expect(harness.drafts.createDraft).toHaveBeenCalledOnce();
    expect(harness.cardRuntime.repository.createPresentation).toHaveBeenCalledOnce();
  });

  it("rejects a revised or semantically changed committed conflict draft before presentation", async () => {
    const existingCandidate = candidate({ status: "draft_created", version: 4 });
    const expectedDraftId = stableDraftId("candidate-1");
    const changedDraft = {
      ...draftMutation(expectedDraftId, "already_applied").draft,
      version: 2,
      currentRevisionNumber: 2,
      currentRevision: {
        ...draftMutation(expectedDraftId, "already_applied").draft.currentRevision,
        revisionNumber: 2,
        content: "Changed after the conflict interaction.",
      },
    };
    const harness = createHarness({
      candidate: existingCandidate,
      existingDraft: changedDraft,
      createDraft: async () => { throw new KnowledgeDraftOperationConflictError(); },
      applyInteraction: async () => interactionMutation("already_applied", existingCandidate),
    });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "denied",
      code: "immutable_intent_conflict",
    });
    expect(harness.repository.applyInteraction).not.toHaveBeenCalled();
    expect(harness.presentKnowledgeDraft).not.toHaveBeenCalled();
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

  it("recovers after draft commit and interaction failure using later fresh proof without a second draft", async () => {
    let clock = new Date("2026-08-13T04:00:00.000Z");
    let storedSemanticIntent: string | undefined;
    let appliedDraftCreates = 0;
    let interactionAttempts = 0;
    const createDraft = vi.fn(async (input: any) => {
      const semanticIntent = JSON.stringify({
        ...input,
        at: undefined,
        knowledgeConflictGovernance: {
          ...input.knowledgeConflictGovernance,
          permission: {
            ...input.knowledgeConflictGovernance.permission,
            attestedAt: undefined,
          },
        },
      });
      if (storedSemanticIntent === undefined) {
        storedSemanticIntent = semanticIntent;
        appliedDraftCreates += 1;
        return draftMutation(input.id, "applied");
      }
      if (semanticIntent !== storedSemanticIntent) throw new Error("immutable draft intent changed");
      return draftMutation(input.id, "already_applied");
    });
    const harness = createHarness({
      now: () => new Date(clock),
      validate: async () => ({
        status: "current",
        candidate: candidate(),
        permissionAttestedAt: new Date(clock),
      }),
      createDraft,
      applyInteraction: async () => {
        interactionAttempts += 1;
        if (interactionAttempts === 1) throw new Error("crash after draft commit");
        return interactionMutation("applied");
      },
    });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "retryable",
      code: "repository_unavailable",
    });
    clock = new Date("2026-08-13T04:02:00.000Z");
    await expect(harness.worker.processInteraction(harness.job)).resolves.toMatchObject({
      status: "applied",
      code: "draft_created",
    });
    expect(createDraft).toHaveBeenCalledTimes(2);
    expect(appliedDraftCreates).toBe(1);
    expect(harness.repository.applyInteraction).toHaveBeenCalledTimes(2);
    expect(harness.presentKnowledgeDraft).toHaveBeenCalledOnce();
  });

  it("requires exactly one current medium-risk group publication target", async () => {
    const harness = createHarness({ policies: [] });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "denied",
      code: "target_unavailable",
    });
    expect(harness.drafts.createDraft).not.toHaveBeenCalled();
  });

  it("rechecks membership after initial validation and before draft mutation", async () => {
    let membershipChecks = 0;
    const harness = createHarness({
      isCurrentMember: async () => ++membershipChecks === 1,
    });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "denied",
      code: "not_current_member",
    });
    expect(harness.validator.validate).toHaveBeenCalledOnce();
    expect(harness.drafts.createDraft).not.toHaveBeenCalled();
  });

  it("rechecks live permission after initial validation and before draft mutation", async () => {
    let validations = 0;
    const harness = createHarness({
      validate: async () => ++validations === 1
        ? { status: "current" as const, candidate: candidate(), permissionAttestedAt: at }
        : { status: "permission_blocked" as const, candidate: candidate() },
    });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "denied",
      code: "permission_blocked",
    });
    expect(harness.drafts.createDraft).not.toHaveBeenCalled();
  });

  it("does not create a draft when membership is revoked during pre-draft permission validation", async () => {
    let currentMember = true;
    let validations = 0;
    const harness = createHarness({
      isCurrentMember: async () => currentMember,
      validate: async () => {
        validations += 1;
        if (validations === 2) currentMember = false;
        return { status: "current", candidate: candidate(), permissionAttestedAt: at };
      },
    });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "denied",
      code: "not_current_member",
    });
    expect(harness.drafts.createDraft).not.toHaveBeenCalled();
    expect(harness.repository.applyInteraction).not.toHaveBeenCalled();
  });

  it("rejects a selected publication policy whose exact version changed after initial validation", async () => {
    const harness = createHarness({
      getTargetPolicy: async () => policy({ version: 8 }),
    });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "denied",
      code: "target_unavailable",
    });
    expect(harness.drafts.createDraft).not.toHaveBeenCalled();
  });

  it("uses the second live attestation for draft creation and the post-draft attestation for commit", async () => {
    const attestations = [
      new Date("2026-08-13T03:59:57.000Z"),
      new Date("2026-08-13T03:59:58.000Z"),
      new Date("2026-08-13T03:59:59.000Z"),
    ];
    let validationIndex = 0;
    const harness = createHarness({
      validate: async () => ({
        status: "current" as const,
        candidate: candidate(),
        permissionAttestedAt: attestations[validationIndex++]!,
      }),
    });

    await harness.worker.processInteraction(harness.job);

    expect(harness.drafts.createDraft).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeConflictGovernance: expect.objectContaining({
        permission: { documentSourceIds: ["source-1"], attestedAt: attestations[1] },
      }),
    }));
    expect(harness.repository.applyInteraction).toHaveBeenCalledWith(expect.objectContaining({
      permissionAttestedAt: attestations[2],
    }));
  });

  it("does not commit the candidate when membership changes while draft creation is in flight", async () => {
    let membershipChecks = 0;
    const harness = createHarness({
      isCurrentMember: async () => ++membershipChecks < 4,
    });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "denied",
      code: "not_current_member",
    });
    expect(harness.drafts.createDraft).toHaveBeenCalledOnce();
    expect(harness.repository.applyInteraction).not.toHaveBeenCalled();
  });

  it("does not commit the candidate when permission changes while draft creation is in flight", async () => {
    let validations = 0;
    const harness = createHarness({
      validate: async () => ++validations < 3
        ? { status: "current" as const, candidate: candidate(), permissionAttestedAt: at }
        : { status: "permission_blocked" as const, candidate: candidate() },
    });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "denied",
      code: "permission_blocked",
    });
    expect(harness.drafts.createDraft).toHaveBeenCalledOnce();
    expect(harness.repository.applyInteraction).not.toHaveBeenCalled();
  });

  it("does not commit draft_created when membership is revoked during final permission validation", async () => {
    let currentMember = true;
    let validations = 0;
    const harness = createHarness({
      isCurrentMember: async () => currentMember,
      validate: async () => {
        validations += 1;
        if (validations === 3) currentMember = false;
        return { status: "current", candidate: candidate(), permissionAttestedAt: at };
      },
    });

    await expect(harness.worker.processInteraction(harness.job)).resolves.toEqual({
      status: "denied",
      code: "not_current_member",
    });
    expect(harness.drafts.createDraft).toHaveBeenCalledOnce();
    expect(harness.repository.applyInteraction).not.toHaveBeenCalled();
  });

  it("reads and binds the exact target around the final evidence and permission validation", async () => {
    const order: string[] = [];
    const harness = createHarness({
      listTargetPolicies: async () => {
        order.push("target-list");
        return [policy()];
      },
      getTargetPolicy: async () => {
        order.push("target-exact");
        return policy();
      },
      validate: async () => {
        order.push("validation");
        return { status: "current" as const, candidate: candidate(), permissionAttestedAt: at };
      },
      createDraft: async (input) => {
        order.push("draft");
        return draftMutation(input.id, "applied");
      },
    });

    await harness.worker.processInteraction(harness.job);

    expect(order).toEqual([
      "target-list",
      "validation",
      "target-exact",
      "validation",
      "draft",
      "validation",
    ]);
  });
});

type ConflictJob = AuthenticatedKnowledgeConflictConfirmationInteraction;
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
  getDraft?: (...args: any[]) => Promise<any>;
  policies?: PublicationTargetPolicy[];
  listTargetPolicies?: (...args: any[]) => Promise<PublicationTargetPolicy[]>;
  getTargetPolicy?: (...args: any[]) => Promise<PublicationTargetPolicy | undefined>;
  validate?: (...args: any[]) => Promise<Validation>;
  canProcessKnowledgeConflicts?: (groupId: string) => boolean;
  isCurrentMember?: () => Promise<boolean>;
  createDraft?: (...args: any[]) => Promise<any>;
  applyInteraction?: (...args: any[]) => Promise<any>;
  presentKnowledgeDraft?: (...args: any[]) => Promise<any>;
  now?: () => Date;
  useDefaultPresentation?: boolean;
};

function createHarness(overrides: HarnessOverrides = {}) {
  const currentCandidate = "candidate" in overrides ? overrides.candidate : candidate();
  const currentDelivery = "delivery" in overrides ? overrides.delivery : delivery();
  const eventId = overrides.eventId ?? "event-1";
  const action = overrides.action ?? "create_update_draft";
  const job: ConflictJob = {
    kind: "knowledge_conflict_confirmation",
    idempotencyKey: `feishu-card:cli_conflict:${eventId}`,
    callbackIdentityId: "callback-identity-1",
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
      permissionAttestedAt: at,
    })),
  };
  const membershipChecker = {
    isCurrentMember: vi.fn(overrides.isCurrentMember ?? (async () => true)),
  };
  const drafts = {
    getDraft: vi.fn(overrides.getDraft ?? (async () => overrides.existingDraft)),
    createDraft: vi.fn(overrides.createDraft ?? (async (input) => draftMutation(input.id, "applied"))),
  };
  const publicationTargets = {
    listTargetPolicies: vi.fn(overrides.listTargetPolicies ?? (async () => overrides.policies ?? [policy()])),
    getTargetPolicy: vi.fn(overrides.getTargetPolicy ?? (async () => policy())),
  };
  const cardRuntime = {
    repository: {
      getDraft: drafts.getDraft,
      getPresentation: vi.fn(async () => undefined),
      createPresentation: vi.fn(async (input) => ({
        outcome: "applied" as const,
        presentation: {
          id: input.id,
          draftId: input.draftId,
          revisionNumber: input.expectedRevisionNumber,
          draftVersion: input.expectedDraftVersion,
          chatId: input.chatId,
          contentHash: input.contentHash,
          state: "pending_send" as const,
          createdAt: input.at,
          version: 1,
        },
      })),
    },
    canUseKnowledgeCards: vi.fn(() => true),
  };
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
    cardRuntime: cardRuntime as never,
    ...(overrides.useDefaultPresentation ? {} : { presentKnowledgeDraft }),
    canProcessKnowledgeConflicts: overrides.canProcessKnowledgeConflicts ?? (() => true),
    botOpenId: "ou_bot",
    now: overrides.now ?? (() => new Date(at)),
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
        reviewer: { type: "feishu_user" as const, ref: "ou_member" },
        suggestedPublication: { spaceId: "space-main", parentNodeToken: "parent-main" },
        evidence: [
          { type: "conversation_message" as const, id: "message-1", groupId: "oc_group" },
          { type: "conversation_message" as const, id: "message-2", groupId: "oc_group" },
          {
            type: "group_memory" as const,
            id: "memory-1",
            groupId: "oc_group",
            expectedUpdatedAt: new Date("2026-08-12T01:00:00.000Z"),
          },
          {
            type: "document_source" as const,
            id: "source-1",
            expectedUpdatedAt: new Date("2026-08-12T02:00:00.000Z"),
          },
        ],
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
