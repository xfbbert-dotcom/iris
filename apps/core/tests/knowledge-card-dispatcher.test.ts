import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createKnowledgeCardDispatcher } from "../src/knowledge-cards/knowledge-card-dispatcher.js";
import {
  FeishuInteractiveCardClientError,
} from "../src/feishu/feishu-interactive-card-client.js";
import type { KnowledgeDraft } from "../src/knowledge-governance/knowledge-draft-repository.js";
import type {
  KnowledgeCardPresentationContext,
  KnowledgeCardSendClaim,
  KnowledgeDraftPresentation,
} from "../src/knowledge-cards/knowledge-card-repository.js";

const at = new Date("2026-07-19T04:00:00.000Z");

describe("KnowledgeCardDispatcher", () => {
  it("claims, re-reads, renders, gates, sends, and activates in order", async () => {
    const order: string[] = [];
    const harness = createHarness({
      claimPresentationSend: async () => {
        order.push("claim");
        return claim();
      },
      getPresentationContext: async () => {
        order.push("context");
        return context();
      },
      renderer: () => {
        order.push("render");
        return rendered();
      },
      canUseKnowledgeCards: () => {
        order.push("gate");
        return true;
      },
      beginExternalAttempt: async () => {
        order.push("begin");
      },
      sendCard: async () => {
        order.push("send");
        return { messageId: "om_sent" };
      },
      completePresentationSend: async () => {
        order.push("complete");
      },
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([
      { status: "sent", presentationId: "presentation-1", code: "send_succeeded" },
    ]);
    expect(order).toEqual([
      "claim",
      "context",
      "render",
      "gate",
      "begin",
      "gate",
      "send",
      "complete",
    ]);
    expect(harness.cardClient.sendCard).toHaveBeenCalledWith({
      chatId: "oc_group",
      cardJson: rendered().json,
      uuid: stableUuid("presentation-1"),
    });
    expect(harness.repository.completePresentationSend).toHaveBeenCalledWith({
      presentationId: "presentation-1",
      workerId: "dispatcher-1",
      messageId: "om_sent",
      at,
    });
  });

  it("fails permanently when runtime is disabled immediately before send", async () => {
    const harness = createHarness({ canUseKnowledgeCards: () => false });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([
      { status: "permanent_failure", presentationId: "presentation-1", code: "runtime_disabled" },
    ]);
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
    expect(harness.repository.failPresentationPreparation).toHaveBeenCalledWith({
      presentationId: "presentation-1",
      workerId: "dispatcher-1",
      errorCode: "runtime_disabled",
      at,
    });
  });

  it("does not call Feishu when the durable external-attempt transition fails", async () => {
    const harness = createHarness({
      beginExternalAttempt: async () => {
        throw new Error("repository unavailable before external call");
      },
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).rejects.toThrow(
      "repository unavailable before external call",
    );
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
    expect(harness.cardClient.updateCard).not.toHaveBeenCalled();
  });

  it("terminalizes a send when runtime is disabled during the durable begin", async () => {
    let enabled = true;
    const harness = createHarness({
      canUseKnowledgeCards: () => enabled,
      beginExternalAttempt: async () => {
        enabled = false;
      },
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      presentationId: "presentation-1",
      code: "runtime_disabled",
    }]);
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
    expect(harness.repository.failPresentationSend).toHaveBeenCalledWith({
      presentationId: "presentation-1",
      workerId: "dispatcher-1",
      classification: "permanent",
      errorCode: "runtime_disabled",
      at,
    });
  });

  it("terminalizes an update when runtime is disabled during the durable begin", async () => {
    let enabled = true;
    const closed = presentation({ state: "closed", messageId: "om_existing", version: 3 });
    const harness = createHarness({
      context: context({ presentation: closed }),
      claim: claim({ presentation: closed }),
      canUseKnowledgeCards: () => enabled,
      beginExternalAttempt: async () => {
        enabled = false;
      },
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      presentationId: "presentation-1",
      code: "runtime_disabled",
    }]);
    expect(harness.cardClient.updateCard).not.toHaveBeenCalled();
    expect(harness.repository.failPresentationSend).toHaveBeenCalledWith({
      presentationId: "presentation-1",
      workerId: "dispatcher-1",
      classification: "permanent",
      errorCode: "runtime_disabled",
      at,
    });
  });

  it("permanently closes invalidated evidence without rendering or sending", async () => {
    const invalidDraft = draft({
      currentRevision: {
        revisionNumber: 1,
        riskLevel: "low",
        author: "iris",
        createdAt: at,
        evidenceState: { status: "invalidated", reason: "message_deleted" },
      },
    });
    const harness = createHarness({ context: context({ draft: invalidDraft }) });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toMatchObject([
      { status: "permanent_failure", code: "evidence_invalidated" },
    ]);
    expect(harness.renderer).not.toHaveBeenCalled();
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
  });

  it("makes renderer review-required outcomes stable and permanent", async () => {
    const harness = createHarness({
      renderer: () => ({ status: "review_required", reason: "body_too_large" }),
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([
      { status: "permanent_failure", presentationId: "presentation-1", code: "body_too_large" },
    ]);
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
  });

  it.each([
    ["request_not_sent", "retryable"],
    ["retryable_remote_failure", "retryable"],
    ["remote_rejected", "permanent"],
    ["outcome_unknown", "outcome_unknown"],
  ] as const)("maps Feishu %s to %s outbox failure", async (classification, expected) => {
    const harness = createHarness({
      sendCard: async () => {
        throw new FeishuInteractiveCardClientError(classification, "private_remote_code");
      },
    });

    const results = await harness.dispatcher.processBatch({ limit: 1 });

    const status = expected === "retryable"
      ? "retrying"
      : expected === "permanent" ? "permanent_failure" : "outcome_unknown";
    expect(results).toEqual([{
      status,
      presentationId: "presentation-1",
      code: classification,
    }]);
    expect(harness.repository.failPresentationSend).toHaveBeenCalledWith({
      presentationId: "presentation-1",
      workerId: "dispatcher-1",
      classification: expected,
      errorCode: classification,
      ...(expected === "retryable" ? { retryAt: new Date(at.getTime() + 30_000) } : {}),
      at,
    });
    expect(JSON.stringify(results)).not.toContain("private_remote_code");
  });

  it("makes a retryable result from external attempt five permanently failed", async () => {
    const harness = createHarness({
      claim: claim({ attempts: 5 }),
      sendCard: async () => {
        throw new FeishuInteractiveCardClientError("retryable_remote_failure", "rate_limited");
      },
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      presentationId: "presentation-1",
      code: "max_attempts_exhausted",
    }]);
    expect(harness.repository.failPresentationSend).toHaveBeenCalledWith({
      presentationId: "presentation-1",
      workerId: "dispatcher-1",
      classification: "permanent",
      errorCode: "max_attempts_exhausted",
      at,
    });
  });

  it("never automatically resends an outcome-unknown claim", async () => {
    const harness = createHarness({
      sendCard: async () => {
        throw new FeishuInteractiveCardClientError("outcome_unknown", "timeout");
      },
    });

    await harness.dispatcher.processBatch({ limit: 2 });

    expect(harness.cardClient.sendCard).toHaveBeenCalledOnce();
    expect(harness.repository.claimPresentationSend).toHaveBeenCalledTimes(2);
    expect(harness.repository.failPresentationSend).toHaveBeenCalledWith(expect.objectContaining({
      classification: "outcome_unknown",
    }));
  });

  it("never retries a send that succeeded before Postgres completion failed", async () => {
    const harness = createHarness({
      completePresentationSend: async () => {
        throw new Error("repository unavailable after remote success");
      },
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "outcome_unknown",
      presentationId: "presentation-1",
      code: "outcome_unknown",
    }]);
    expect(harness.cardClient.sendCard).toHaveBeenCalledOnce();
    expect(harness.repository.failPresentationSend).toHaveBeenCalledWith({
      presentationId: "presentation-1",
      workerId: "dispatcher-1",
      classification: "outcome_unknown",
      errorCode: "outcome_unknown",
      at,
    });
  });

  it("uses the same stable UUID when a retryable claim is recovered", async () => {
    const repository = repositoryMock({ claims: [claim(), claim(), undefined] });
    const sendCard = vi.fn()
      .mockRejectedValueOnce(new FeishuInteractiveCardClientError("request_not_sent", "network"))
      .mockResolvedValueOnce({ messageId: "om_sent_after_retry" });
    const harness = createHarness({ repository, sendCard });

    await harness.dispatcher.processBatch({ limit: 2 });

    expect(sendCard).toHaveBeenCalledTimes(2);
    expect(sendCard.mock.calls[0]?.[0].uuid).toBe(sendCard.mock.calls[1]?.[0].uuid);
    expect(sendCard.mock.calls[0]?.[0].uuid).toBe(stableUuid("presentation-1"));
  });

  it.each([
    context({ presentation: presentation({ version: 2 }) }),
    context({ draft: draft({ version: 2 }) }),
    context({ draft: draft({ sourceGroupId: "oc_other" }) }),
  ])("fails a changed exact context before external send", async (changedContext) => {
    const harness = createHarness({ context: changedContext });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toMatchObject([
      { status: "permanent_failure", code: "stale_presentation" },
    ]);
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
  });

  it("updates a committed result from the same outbox without reapplying the action", async () => {
    const closedPresentation = presentation({
      state: "closed",
      messageId: "om_card",
      closedAt: at,
      version: 3,
    });
    const closedDraft = draft({ status: "pending_review", version: 2 });
    const harness = createHarness({
      claim: claim({ presentation: closedPresentation }),
      context: context({ presentation: closedPresentation, draft: closedDraft }),
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([
      { status: "updated", presentationId: "presentation-1", code: "card_update_succeeded" },
    ]);
    expect(harness.cardClient.updateCard).toHaveBeenCalledWith({
      messageId: "om_card",
      cardJson: expect.stringContaining("Knowledge draft action recorded."),
    });
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
    expect(harness.repository.completePresentationSend).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "om_card",
    }));
  });

  it("claims with a bounded lease and bounds each batch", async () => {
    const harness = createHarness({ claims: [] });

    await harness.dispatcher.processBatch({ limit: 1000 });

    expect(harness.repository.claimPresentationSend).toHaveBeenCalledWith({
      workerId: "dispatcher-1",
      at,
      leaseUntil: new Date(at.getTime() + 30_000),
    });
    await expect(harness.dispatcher.processBatch({ limit: Number.NaN })).rejects.toThrow(
      "knowledge card dispatcher batch limit",
    );
  });
});

type HarnessOverrides = {
  repository?: ReturnType<typeof repositoryMock>;
  claim?: KnowledgeCardSendClaim;
  claims?: Array<KnowledgeCardSendClaim | undefined>;
  context?: KnowledgeCardPresentationContext;
  claimPresentationSend?: () => Promise<KnowledgeCardSendClaim | undefined>;
  getPresentationContext?: () => Promise<KnowledgeCardPresentationContext | undefined>;
  completePresentationSend?: () => Promise<void>;
  beginExternalAttempt?: () => Promise<void>;
  renderer?: () => ReturnType<typeof rendered> | { status: "review_required"; reason: "body_too_large" };
  canUseKnowledgeCards?: () => boolean;
  sendCard?: () => Promise<{ messageId: string }>;
};

function createHarness(overrides: HarnessOverrides = {}) {
  const repository = overrides.repository ?? repositoryMock({
    claims: overrides.claims ?? [overrides.claim ?? claim(), undefined],
    context: overrides.context,
    claimPresentationSend: overrides.claimPresentationSend,
    getPresentationContext: overrides.getPresentationContext,
    completePresentationSend: overrides.completePresentationSend,
    beginExternalAttempt: overrides.beginExternalAttempt,
  });
  const cardClient = {
    sendCard: vi.fn(overrides.sendCard ?? (async () => ({ messageId: "om_sent" }))),
    updateCard: vi.fn(async () => undefined),
  };
  const renderer = vi.fn(overrides.renderer ?? (() => rendered()));
  return {
    repository,
    cardClient,
    renderer,
    dispatcher: createKnowledgeCardDispatcher({
      repository,
      cardClient,
      renderer,
      canUseKnowledgeCards: overrides.canUseKnowledgeCards ?? (() => true),
      targetDisplayName: "Knowledge Base",
      workerId: "dispatcher-1",
      leaseMs: 30_000,
      retryDelayMs: 30_000,
      now: () => new Date(at),
    }),
  };
}

function repositoryMock(input: {
  claims?: Array<KnowledgeCardSendClaim | undefined>;
  context?: KnowledgeCardPresentationContext;
  claimPresentationSend?: () => Promise<KnowledgeCardSendClaim | undefined>;
  getPresentationContext?: () => Promise<KnowledgeCardPresentationContext | undefined>;
  completePresentationSend?: () => Promise<void>;
  beginExternalAttempt?: () => Promise<void>;
} = {}) {
  const claims = [...(input.claims ?? [claim(), undefined])];
  return {
    claimPresentationSend: vi.fn(input.claimPresentationSend ?? (async () => claims.shift())),
    getPresentationContext: vi.fn(input.getPresentationContext ?? (async () => input.context ?? context())),
    beginExternalAttempt: vi.fn(input.beginExternalAttempt ?? (async () => undefined)),
    failPresentationPreparation: vi.fn(async () => undefined),
    completePresentationSend: vi.fn(input.completePresentationSend ?? (async () => undefined)),
    failPresentationSend: vi.fn(async () => undefined),
  };
}

function claim(overrides: Partial<KnowledgeCardSendClaim> = {}): KnowledgeCardSendClaim {
  return {
    presentation: presentation(),
    workerId: "dispatcher-1",
    leaseUntil: new Date(at.getTime() + 30_000),
    attempts: 1,
    ...overrides,
  };
}

function context(overrides: {
  presentation?: KnowledgeDraftPresentation;
  draft?: KnowledgeDraft;
} = {}): KnowledgeCardPresentationContext {
  const currentDraft = overrides.draft ?? draft();
  return {
    presentation: overrides.presentation ?? presentation(),
    draft: currentDraft,
    evidenceState: currentDraft.currentRevision.evidenceState,
  };
}

function presentation(overrides: Partial<KnowledgeDraftPresentation> = {}): KnowledgeDraftPresentation {
  return {
    id: "presentation-1",
    draftId: "draft-1",
    revisionNumber: 1,
    draftVersion: 1,
    chatId: "oc_group",
    contentHash: rendered().contentHash,
    state: "pending_send",
    createdAt: at,
    version: 1,
    ...overrides,
  };
}

function draft(overrides: Partial<KnowledgeDraft> = {}): KnowledgeDraft {
  return {
    id: "draft-1",
    sourceGroupId: "oc_group",
    originKind: "group_conclusion",
    status: "pending_confirmation",
    currentRevisionNumber: 1,
    version: 1,
    createdBy: "iris",
    createdAt: at,
    updatedAt: at,
    currentRevision: {
      revisionNumber: 1,
      riskLevel: "low",
      author: "iris",
      createdAt: at,
      evidenceState: { status: "current" },
      title: "Governed draft",
      content: "Full governed draft body",
      evidence: [],
    },
    ...overrides,
  };
}

function rendered() {
  const json = JSON.stringify({ schema: "2.0", body: { elements: [{ tag: "markdown", content: "Full governed draft body" }] } });
  return {
    status: "rendered" as const,
    card: JSON.parse(json) as Record<string, unknown>,
    json,
    contentHash: createHash("sha256").update(json).digest("hex"),
    componentCount: 1,
  };
}

function stableUuid(presentationId: string): string {
  return createHash("sha256").update(`knowledge-card:${presentationId}`).digest("hex").slice(0, 50);
}
