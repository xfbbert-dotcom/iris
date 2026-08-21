import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ManagedKnowledgePage } from
  "../src/action-approvals/managed-knowledge-page.js";
import type { DocumentSource } from "../src/documents/document-source-registry.js";
import {
  FeishuInteractiveCardClientError,
} from "../src/feishu/feishu-interactive-card-client.js";
import type { KnowledgeConflictCandidate } from "../src/knowledge-conflicts/knowledge-conflict.js";
import type {
  KnowledgeConflictDelivery,
  KnowledgeConflictDeliveryClaim,
  KnowledgeConflictRepository,
} from "../src/knowledge-conflicts/knowledge-conflict-repository.js";
import {
  KnowledgeConflictDeliveryConflictError,
  KnowledgeConflictVersionConflictError,
} from
  "../src/knowledge-conflicts/knowledge-conflict-repository.js";
import {
  createKnowledgeConflictDispatcher,
} from "../src/knowledge-conflicts/knowledge-conflict-dispatcher.js";

const at = new Date("2026-08-15T02:00:00.000Z");

describe("KnowledgeConflictDispatcher", () => {
  it("does not send before operator approval or after a sent delivery leaves the claim set", async () => {
    const harness = createHarness({ claims: [undefined] });

    await expect(harness.dispatcher.processBatch({ limit: 10 })).resolves.toEqual([]);
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
    expect(harness.repository.beginDeliveryAttempt).not.toHaveBeenCalled();
  });

  it("renders replace-existing metadata when the exact managed page is eligible", async () => {
    const harness = createHarness({
      findEligiblePage: async () => managedPage(),
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "sent",
      deliveryId: "delivery-1",
      code: "send_succeeded",
    }]);
    expect(harness.managedPages.findEligiblePageForConflict).toHaveBeenCalledWith({
      documentSourceId: "source-1",
      authorizationGroupId: "oc_group",
    });
    const cardJson = harness.cardClient.sendCard.mock.calls[0]?.[0].cardJson ?? "";
    expect(cardJson).toMatch(/replace existing managed page/iu);
    expect(cardJson).toContain("managed\\\\-1");
    expect(cardJson).toContain("12");
    expect(cardJson).not.toMatch(/publish a new managed page/iu);
  });

  it("renders publish-new only after a completed managed-page lookup returns no match", async () => {
    const harness = createHarness({ findEligiblePage: async () => undefined });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "sent",
      deliveryId: "delivery-1",
      code: "send_succeeded",
    }]);
    const cardJson = harness.cardClient.sendCard.mock.calls[0]?.[0].cardJson ?? "";
    expect(cardJson).toMatch(/publish a new managed page/iu);
    expect(cardJson).not.toMatch(/replace existing managed page/iu);
  });

  it.each([
    ["resolver failure", async () => { throw new Error("database unavailable"); }],
    ["indeterminate result", async () => managedPage({ linkedDocumentSourceId: "other-source" })],
  ])("fails closed without sending a misleading card on %s", async (_label, findEligiblePage) => {
    const harness = createHarness({ findEligiblePage });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "retrying",
      deliveryId: "delivery-1",
      code: "managed_target_unavailable",
    }]);
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
    expect(harness.repository.beginDeliveryAttempt).not.toHaveBeenCalled();
    expect(harness.repository.failDelivery).toHaveBeenCalledWith(expect.objectContaining({
      classification: "retryable",
      errorCode: "managed_target_unavailable",
    }));
  });

  it("rechecks gates, bot membership, and exact live evidence before the external-attempt boundary", async () => {
    const order: string[] = [];
    const harness = createHarness({
      gates: () => { order.push("gates"); return openGates(); },
      botMember: async () => { order.push("bot"); return true; },
      findSource: async () => { order.push("source"); return source(); },
      validate: async () => {
        order.push("validate");
        return { status: "current", candidate: candidate(), permissionAttestedAt: at };
      },
      begin: async () => { order.push("begin"); },
      send: async (input) => {
        order.push("send");
        expect(input.chatId).toBe("oc_group");
        expect(input.cardJson).toContain("No winner has been selected");
        expect(input.uuid).toBe(stableUuid("delivery-1"));
        return { messageId: "om_conflict" };
      },
      complete: async () => { order.push("complete"); },
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "sent",
      deliveryId: "delivery-1",
      code: "send_succeeded",
    }]);
    expect(order).toEqual([
      "gates", "bot", "source", "gates", "bot", "validate", "gates", "bot", "gates",
      "begin", "send", "complete",
    ]);
    expect(harness.currentValidator.validate).toHaveBeenCalledWith({
      candidate: expect.objectContaining({ id: "candidate-1", version: 2 }),
      expectedVersion: 2,
    });
    expect(harness.repository.beginDeliveryAttempt).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      candidateId: "candidate-1",
      expectedCandidateVersion: 2,
      expectedAttemptCount: 1,
      workerId: "conflict-dispatcher-1",
      at,
    });
    expect(harness.repository.completeDelivery).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      workerId: "conflict-dispatcher-1",
      messageId: "om_conflict",
      at,
    });
  });

  it.each([
    "featureEnabled",
    "groupAllowed",
    "proactiveSpeech",
    "retrieveKnowledgeBase",
    "generateKnowledgeDrafts",
  ] as const)("blocks delivery when the %s gate is disabled", async (gate) => {
    const harness = createHarness({ gates: () => ({ ...openGates(), [gate]: false }) });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      deliveryId: "delivery-1",
      code: "runtime_disabled",
    }]);
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
    expect(harness.repository.beginDeliveryAttempt).not.toHaveBeenCalled();
    expect(harness.repository.failDelivery).toHaveBeenCalledWith(expect.objectContaining({
      classification: "permanent",
      errorCode: "runtime_disabled",
    }));
  });

  it("fails closed when a gate changes during preparation", async () => {
    let reads = 0;
    const harness = createHarness({
      gates: () => (++reads === 1 ? openGates() : { ...openGates(), proactiveSpeech: false }),
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toMatchObject([{
      status: "permanent_failure",
      code: "runtime_disabled",
    }]);
    expect(harness.currentValidator.validate).not.toHaveBeenCalled();
    expect(harness.repository.beginDeliveryAttempt).not.toHaveBeenCalled();
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
  });

  it("does not begin or send when delivery is disabled during current validation", async () => {
    let enabled = true;
    const harness = createHarness({
      gates: () => ({ ...openGates(), featureEnabled: enabled }),
      validate: async () => {
        enabled = false;
        return { status: "current", candidate: candidate(), permissionAttestedAt: at };
      },
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      deliveryId: "delivery-1",
      code: "runtime_disabled",
    }]);
    expect(harness.repository.beginDeliveryAttempt).not.toHaveBeenCalled();
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
  });

  it("performs a final local gate read after post-validation membership", async () => {
    let enabled = true;
    let membershipReads = 0;
    const harness = createHarness({
      gates: () => ({ ...openGates(), groupAllowed: enabled }),
      botMember: async () => {
        membershipReads += 1;
        if (membershipReads === 3) enabled = false;
        return true;
      },
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toMatchObject([{
      status: "permanent_failure",
      code: "runtime_disabled",
    }]);
    expect(membershipReads).toBe(3);
    expect(harness.repository.beginDeliveryAttempt).not.toHaveBeenCalled();
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
  });

  it.each([
    ["superseded", { status: "superseded" as const, candidate: candidate({ status: "superseded", version: 3 }), reason: "snapshot_stale" }, "stale_candidate"],
    ["permission denied", { status: "permission_blocked" as const, candidate: candidate() }, "permission_blocked"],
  ] as const)("does not send when current validation reports %s", async (_label, validation, code) => {
    const harness = createHarness({ validate: async () => validation });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      deliveryId: "delivery-1",
      code,
    }]);
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
    expect(harness.repository.failDelivery).toHaveBeenCalledWith(expect.objectContaining({
      classification: "permanent",
      errorCode: code,
    }));
  });

  it("permanently settles a missing-source supersession that did not mutate the approved candidate", async () => {
    const harness = createHarness({
      claims: [claim(), undefined],
      validate: async () => ({
        status: "superseded",
        candidate: candidate(),
        reason: "source_stale",
      }),
    });

    await expect(harness.dispatcher.processBatch({ limit: 2 })).resolves.toEqual([{
      status: "permanent_failure",
      deliveryId: "delivery-1",
      code: "stale_candidate",
    }]);
    expect(harness.repository.failDelivery).toHaveBeenCalledWith(expect.objectContaining({
      classification: "permanent",
      errorCode: "stale_candidate",
    }));
    expect(harness.repository.claimNextDelivery).toHaveBeenCalledTimes(2);
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
  });

  it("treats an atomically cancelled superseded delivery as already settled", async () => {
    const harness = createHarness({
      validate: async () => ({
        status: "superseded",
        candidate: candidate({ status: "superseded", version: 3 }),
        reason: "snapshot_stale",
      }),
      fail: async () => { throw new KnowledgeConflictDeliveryConflictError(); },
      getDelivery: async () => ({ ...claim().delivery, status: "cancelled", retryable: false }),
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      deliveryId: "delivery-1",
      code: "stale_candidate",
    }]);
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
  });

  it("does not send when dismissal wins before the exact begin transaction", async () => {
    const harness = createHarness({
      begin: async () => { throw new KnowledgeConflictVersionConflictError(); },
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      deliveryId: "delivery-1",
      code: "stale_candidate",
    }]);
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
    expect(harness.repository.failDelivery).toHaveBeenCalledWith(expect.objectContaining({
      classification: "permanent",
      errorCode: "stale_candidate",
    }));
  });

  it("retries unavailable validation with deterministic exponential backoff", async () => {
    const harness = createHarness({
      claim: claim({ delivery: { ...claim().delivery, attemptCount: 3 } }),
      validate: async () => ({ status: "validation_unavailable", candidate: candidate() }),
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "retrying",
      deliveryId: "delivery-1",
      code: "validation_unavailable",
    }]);
    expect(harness.repository.failDelivery).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      workerId: "conflict-dispatcher-1",
      classification: "retryable",
      errorCode: "validation_unavailable",
      retryAt: new Date(at.getTime() + 4 * 60_000),
      at,
    });
  });

  it.each([
    ["not currently in the group", async (): Promise<boolean> => false, "permanent_failure", "bot_not_in_group", "permanent"],
    ["membership unavailable", async (): Promise<boolean> => { throw new Error("raw membership detail ou_secret"); }, "retrying", "membership_unavailable", "retryable"],
  ] as const)("handles bot %s without sending or exposing details", async (
    _label,
    botMember,
    status,
    code,
    classification,
  ) => {
    const harness = createHarness({ botMember });

    const result = await harness.dispatcher.processBatch({ limit: 1 });
    expect(result).toEqual([{ status, deliveryId: "delivery-1", code }]);
    expect(JSON.stringify(result)).not.toMatch(/ou_secret|raw membership detail/u);
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
    expect(harness.repository.failDelivery).toHaveBeenCalledWith(expect.objectContaining({
      classification,
      errorCode: code,
    }));
  });

  it.each([
    ["request_not_sent", "retrying", "retryable"],
    ["retryable_remote_failure", "retrying", "retryable"],
    ["remote_rejected", "permanent_failure", "permanent"],
    ["outcome_unknown", "outcome_unknown", "outcome_unknown"],
  ] as const)("classifies %s at the external boundary", async (failure, status, classification) => {
    const harness = createHarness({
      send: async () => { throw new FeishuInteractiveCardClientError(failure, "raw_remote_secret"); },
    });

    const result = await harness.dispatcher.processBatch({ limit: 1 });
    expect(result).toEqual([{ status, deliveryId: "delivery-1", code: failure }]);
    expect(JSON.stringify(result)).not.toContain("raw_remote_secret");
    expect(harness.repository.failDelivery).toHaveBeenCalledWith(expect.objectContaining({
      classification,
      errorCode: failure,
      ...(classification === "retryable"
        ? { retryAt: new Date(at.getTime() + 60_000) }
        : classification === "outcome_unknown"
          ? { reconciliationDueAt: new Date(at.getTime() + 5 * 60_000) }
          : {}),
    }));
  });

  it("quarantines a successful remote send whose sent completion is unknown", async () => {
    const harness = createHarness({ complete: async () => { throw new Error("postgres unavailable"); } });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "outcome_unknown",
      deliveryId: "delivery-1",
      code: "outcome_unknown",
    }]);
    expect(harness.cardClient.sendCard).toHaveBeenCalledOnce();
    expect(harness.repository.failDelivery).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      workerId: "conflict-dispatcher-1",
      classification: "outcome_unknown",
      errorCode: "outcome_unknown",
      reconciliationDueAt: new Date(at.getTime() + 5 * 60_000),
      at,
    });
  });

  it("uses one deterministic UUID and callback nonce across a safe request-not-sent retry", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new FeishuInteractiveCardClientError("request_not_sent", "network"))
      .mockResolvedValueOnce({ messageId: "om_retry" });
    const harness = createHarness({
      claims: [
        claim(),
        claim({ delivery: { ...claim().delivery, attemptCount: 2 } }),
        undefined,
      ],
      send,
    });

    await expect(harness.dispatcher.processBatch({ limit: 2 })).resolves.toEqual([
      { status: "retrying", deliveryId: "delivery-1", code: "request_not_sent" },
      { status: "sent", deliveryId: "delivery-1", code: "send_succeeded" },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0].uuid).toBe(stableUuid("delivery-1"));
    expect(send.mock.calls[1]?.[0].uuid).toBe(send.mock.calls[0]?.[0].uuid);
    const firstValue = firstCallbackValue(send.mock.calls[0]?.[0].cardJson);
    const secondValue = firstCallbackValue(send.mock.calls[1]?.[0].cardJson);
    expect(secondValue).toEqual(firstValue);
  });

  it("stops retrying at the bounded external-attempt limit", async () => {
    const harness = createHarness({
      claim: claim({ delivery: { ...claim().delivery, attemptCount: 5 } }),
      send: async () => { throw new FeishuInteractiveCardClientError("request_not_sent", "network"); },
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      deliveryId: "delivery-1",
      code: "max_attempts_exhausted",
    }]);
    expect(harness.repository.failDelivery).toHaveBeenCalledWith(expect.objectContaining({
      classification: "permanent",
      errorCode: "max_attempts_exhausted",
    }));
  });

  it("bounds preparation retries before the repository attempt counter can be exhausted", async () => {
    const harness = createHarness({
      claim: claim({ delivery: { ...claim().delivery, attemptCount: 5 } }),
      validate: async () => ({ status: "validation_unavailable", candidate: candidate() }),
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      deliveryId: "delivery-1",
      code: "max_attempts_exhausted",
    }]);
    expect(harness.repository.failDelivery).toHaveBeenCalledWith(expect.objectContaining({
      classification: "permanent",
      errorCode: "max_attempts_exhausted",
    }));
  });

  it("bounds batches and rejects unsafe controls", async () => {
    const harness = createHarness({ claims: [undefined] });
    await harness.dispatcher.processBatch({ limit: 1_000 });
    expect(harness.repository.claimNextDelivery).toHaveBeenCalledWith({
      workerId: "conflict-dispatcher-1",
      at,
      leaseUntil: new Date(at.getTime() + 30_000),
    });
    await expect(harness.dispatcher.processBatch({ limit: Number.POSITIVE_INFINITY }))
      .rejects.toThrow("batch limit");
  });
});

type GateState = {
  featureEnabled: boolean;
  groupAllowed: boolean;
  proactiveSpeech: boolean;
  retrieveKnowledgeBase: boolean;
  generateKnowledgeDrafts: boolean;
};

type HarnessOverrides = {
  claim?: KnowledgeConflictDeliveryClaim;
  claims?: Array<KnowledgeConflictDeliveryClaim | undefined>;
  gates?: (groupId: string) => GateState;
  botMember?: (groupId: string) => Promise<boolean>;
  findSource?: (id: string) => Promise<DocumentSource | undefined>;
  findEligiblePage?: (...args: any[]) => Promise<ManagedKnowledgePage | undefined>;
  validate?: () => Promise<
    | { status: "current"; candidate: KnowledgeConflictCandidate; permissionAttestedAt: Date }
    | { status: "superseded"; candidate: KnowledgeConflictCandidate; reason: string }
    | { status: "permission_blocked"; candidate: KnowledgeConflictCandidate }
    | { status: "validation_unavailable"; candidate: KnowledgeConflictCandidate }
  >;
  begin?: () => Promise<void>;
  send?: (input: { chatId: string; cardJson: string; uuid: string }) => Promise<{ messageId: string }>;
  complete?: () => Promise<void>;
  fail?: () => Promise<void>;
  getDelivery?: () => Promise<KnowledgeConflictDelivery | undefined>;
};

function createHarness(overrides: HarnessOverrides = {}) {
  const claims = [...(overrides.claims ?? [
    Object.hasOwn(overrides, "claim") ? overrides.claim : claim(),
    undefined,
  ])];
  const repository = {
    claimNextDelivery: vi.fn(async () => claims.shift()),
    beginDeliveryAttempt: vi.fn(async () => {
      await overrides.begin?.();
      return { ...claim().delivery, status: "external_attempting" as const };
    }),
    completeDelivery: vi.fn(async () => {
      await overrides.complete?.();
      return {
        delivery: { ...claim().delivery, status: "sent" as const },
        candidate: candidate({ status: "delivered", version: 3 }),
      };
    }),
    failDelivery: vi.fn(async () => {
      await overrides.fail?.();
      return claim().delivery;
    }),
    getDelivery: vi.fn(overrides.getDelivery ?? (async () => claim().delivery)),
  } satisfies Pick<KnowledgeConflictRepository,
    | "claimNextDelivery"
    | "beginDeliveryAttempt"
    | "completeDelivery"
    | "failDelivery"
    | "getDelivery"
  >;
  const currentValidator = {
    validate: vi.fn(overrides.validate ?? (async () => ({
      status: "current" as const,
      candidate: candidate(),
      permissionAttestedAt: at,
    }))),
  };
  const cardClient = {
    sendCard: vi.fn(overrides.send ?? (async () => ({ messageId: "om_conflict" }))),
  };
  const managedPages = {
    findEligiblePageForConflict: vi.fn(
      overrides.findEligiblePage ?? (async () => undefined),
    ),
  };
  return {
    repository,
    currentValidator,
    cardClient,
    managedPages,
    dispatcher: createKnowledgeConflictDispatcher({
      repository,
      currentValidator,
      documentSources: {
        findSourceById: vi.fn(overrides.findSource ?? (async () => source())),
      },
      managedPages,
      cardClient,
      readDeliveryGates: overrides.gates ?? (() => openGates()),
      isBotCurrentMember: overrides.botMember ?? (async () => true),
      workerId: "conflict-dispatcher-1",
      leaseMs: 30_000,
      retryBaseDelayMs: 60_000,
      retryMaxDelayMs: 10 * 60_000,
      reconciliationDelayMs: 5 * 60_000,
      now: () => new Date(at),
    }),
  };
}

function claim(overrides: Partial<KnowledgeConflictDeliveryClaim> = {}): KnowledgeConflictDeliveryClaim {
  return {
    delivery: {
      id: "delivery-1",
      candidateId: "candidate-1",
      groupId: "oc_group",
      status: "processing",
      retryable: true,
      attemptCount: 1,
      nextAttemptAt: at,
      leaseWorkerId: "conflict-dispatcher-1",
      leaseUntil: new Date(at.getTime() + 30_000),
      createdAt: at,
      updatedAt: at,
    },
    candidate: candidate(),
    ...overrides,
  };
}

function candidate(overrides: Partial<KnowledgeConflictCandidate> = {}): KnowledgeConflictCandidate {
  return {
    id: "candidate-1",
    idempotencyKey: "candidate-operation-1",
    groupId: "oc_group",
    groupMemoryId: "memory-1",
    memoryUpdatedAt: at,
    sourceMessageId: "message-1",
    targetDocumentSourceId: "source-1",
    targetSourceUpdatedAt: at,
    targetSourceVersion: "revision-7",
    targetSnapshotId: "snapshot-1",
    targetContentHash: "a".repeat(64),
    detectorContractVersion: "knowledge-conflict-v1",
    status: "approved_for_delivery",
    plan: {
      outcome: "conflict",
      subject: "Expense approval threshold",
      knowledgeBaseStatement: "Director approval starts at CNY 5,000.",
      knowledgeBaseCitationRefs: ["D1"],
      groupConclusionStatement: "Director approval now starts at CNY 10,000.",
      groupCitationRefs: ["M1", "C1"],
      difference: "The approval threshold differs.",
      suggestedUpdate: "Replace CNY 5,000 with CNY 10,000.",
      targetDocumentRef: "D1",
      missingEvidence: [],
      confidence: "high",
    },
    evidence: [
      { type: "conversation_message", referenceId: "C1", groupId: "oc_group", conversationMessageId: "message-1" },
      { type: "group_memory", referenceId: "M1", groupId: "oc_group", groupMemoryId: "memory-1", expectedUpdatedAt: at },
      { type: "document_source", referenceId: "D1", documentSourceId: "source-1", expectedUpdatedAt: at },
      { type: "document_snapshot", referenceId: "D1", documentSourceId: "source-1", documentSnapshotId: "snapshot-1", contentHash: "a".repeat(64) },
    ],
    version: 2,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function source(): DocumentSource {
  return {
    id: "source-1",
    sourceType: "authorized_wiki_document",
    sourceUri: "https://example.feishu.cn/wiki/expense-policy",
    title: "Expense policy",
    authorizedSpaceId: "space-1",
    permissionState: "readable",
    syncState: "synced",
    canUseForAnswering: true,
    canUseForKnowledgeDrafts: true,
    createdAt: at,
    updatedAt: at,
    evidence: [],
  };
}

function managedPage(overrides: Partial<ManagedKnowledgePage> = {}): ManagedKnowledgePage {
  return {
    id: "managed-1",
    originKnowledgePublicationId: "publication-1",
    targetPolicyId: "policy-1",
    targetPolicyVersion: 3,
    authorizationGroupId: "oc_group",
    remoteNodeToken: "node-managed-1",
    remoteDocumentToken: "doc-managed-1",
    managedBodyBlockId: "block-managed-1",
    linkedDocumentSourceId: "source-1",
    currentRemoteRevisionId: "12",
    currentBodyContentHash: "b".repeat(64),
    state: "active",
    version: 4,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function openGates(): GateState {
  return {
    featureEnabled: true,
    groupAllowed: true,
    proactiveSpeech: true,
    retrieveKnowledgeBase: true,
    generateKnowledgeDrafts: true,
  };
}

function stableUuid(deliveryId: string): string {
  return createHash("sha256")
    .update(`knowledge-conflict-card:${deliveryId}`)
    .digest("hex")
    .slice(0, 50);
}

function firstCallbackValue(cardJson: string): unknown {
  const values: unknown[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    if (record.type === "callback") values.push(record.value);
    Object.values(record).forEach(visit);
  };
  visit(JSON.parse(cardJson));
  return values[0];
}
