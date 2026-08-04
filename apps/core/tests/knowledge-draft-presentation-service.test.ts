import { describe, expect, it, vi } from "vitest";

import {
  KnowledgeDraftPresentationServiceError,
  presentKnowledgeDraft,
} from "../src/knowledge-cards/knowledge-draft-presentation-service.js";
import type {
  KnowledgeCardRuntime,
  KnowledgeCardRuntimeRepository,
} from "../src/runtime/knowledge-card-runtime.js";
import type { KnowledgeDraft } from "../src/knowledge-governance/knowledge-draft-repository.js";
import type { KnowledgeDraftPresentation } from "../src/knowledge-cards/knowledge-card-repository.js";
import { KnowledgeDraftEvidenceError } from "../src/knowledge-governance/postgres-knowledge-draft-evidence.js";
import { KnowledgeCardOperationConflictError } from "../src/knowledge-cards/postgres-knowledge-card-repository.js";

const at = new Date("2026-08-02T02:00:00.000Z");

describe("knowledge draft presentation service", () => {
  it("creates a presentation and returns an exact replay without a second write", async () => {
    const runtime = runtimeFixture();
    let stored: KnowledgeDraftPresentation | undefined;
    vi.mocked(runtime.repository.getPresentation).mockImplementation(async () => stored);
    vi.mocked(runtime.repository.createPresentation).mockImplementation(async (input) => {
      stored = presentation({
        id: input.id,
        draftId: input.draftId,
        revisionNumber: input.expectedRevisionNumber,
        draftVersion: input.expectedDraftVersion,
        chatId: input.chatId,
        contentHash: input.contentHash,
        createdAt: input.at,
      });
      return { outcome: "applied", presentation: stored, draft: currentDraft() };
    });

    const first = await presentKnowledgeDraft({
      runtime,
      draftId: "draft-1",
      expectedVersion: 7,
      operationKey: "operation-1",
      at,
    });
    const replay = await presentKnowledgeDraft({
      runtime,
      draftId: "draft-1",
      expectedVersion: 7,
      operationKey: "operation-1",
      at,
    });

    expect(first).toMatchObject({ outcome: "applied", presentation: stored });
    expect(replay).toEqual({ outcome: "already_applied", presentation: stored });
    expect(runtime.repository.createPresentation).toHaveBeenCalledTimes(1);
    expect(runtime.repository.createPresentation).toHaveBeenCalledWith({
      id: expect.stringMatching(/^knowledge-card-[a-f0-9]{40}$/u),
      draftId: "draft-1",
      expectedDraftVersion: 7,
      expectedRevisionNumber: 3,
      chatId: "oc_pilot",
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      operationKey: "operation-1",
      at,
    });
  });

  it("recovers an identical concurrent create as an idempotent replay", async () => {
    const runtime = runtimeFixture();
    let stored: KnowledgeDraftPresentation | undefined;
    vi.mocked(runtime.repository.getPresentation).mockImplementation(async () => stored);
    vi.mocked(runtime.repository.createPresentation).mockImplementation(async (input) => {
      stored = presentation({
        id: input.id,
        draftId: input.draftId,
        revisionNumber: input.expectedRevisionNumber,
        draftVersion: input.expectedDraftVersion,
        chatId: input.chatId,
        contentHash: input.contentHash,
        createdAt: input.at,
      });
      throw new KnowledgeCardOperationConflictError();
    });

    const result = await presentKnowledgeDraft({
      runtime,
      draftId: "draft-1",
      expectedVersion: 7,
      operationKey: "operation-race",
      at,
    });
    expect(result).toEqual({ outcome: "already_applied", presentation: stored });
    expect(runtime.repository.getPresentation).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "missing draft",
      configure: (runtime: Runtime) => vi.mocked(runtime.repository.getDraft).mockResolvedValue(undefined),
      code: "knowledge_draft_not_found",
    },
    {
      name: "disabled group runtime",
      configure: (runtime: Runtime) => vi.mocked(runtime.canUseKnowledgeCards).mockReturnValue(false),
      code: "iris_runtime_disabled",
    },
    {
      name: "stale draft version",
      configure: (runtime: Runtime) => vi.mocked(runtime.repository.getDraft).mockResolvedValue(currentDraft({ version: 8 })),
      code: "knowledge_card_conflict",
    },
    {
      name: "invalidated evidence",
      configure: (runtime: Runtime) => vi.mocked(runtime.repository.getDraft).mockResolvedValue(currentDraft({ invalidEvidence: true })),
      code: "knowledge_draft_evidence_invalid",
    },
    {
      name: "oversized review surface",
      configure: (runtime: Runtime) => vi.mocked(runtime.repository.getDraft).mockResolvedValue(currentDraft({ content: "x".repeat(8_001) })),
      code: "review_surface_required",
    },
  ] as const)("fails closed for $name", async ({ configure, code }) => {
    const runtime = runtimeFixture();
    configure(runtime);

    await expect(presentKnowledgeDraft({
      runtime,
      draftId: "draft-1",
      expectedVersion: 7,
      operationKey: "operation-fail-closed",
      at,
    })).rejects.toMatchObject({
      name: "KnowledgeDraftPresentationServiceError",
      code,
    } satisfies Partial<KnowledgeDraftPresentationServiceError>);
    expect(runtime.repository.createPresentation).not.toHaveBeenCalled();
  });

  it("normalizes repository evidence and operation failures", async () => {
    const evidenceRuntime = runtimeFixture();
    vi.mocked(evidenceRuntime.repository.createPresentation).mockRejectedValue(
      new KnowledgeDraftEvidenceError("message_deleted"),
    );
    await expect(presentKnowledgeDraft({
      runtime: evidenceRuntime,
      draftId: "draft-1",
      expectedVersion: 7,
      operationKey: "operation-evidence",
      at,
    })).rejects.toMatchObject({ code: "knowledge_draft_evidence_invalid" });

    const conflictRuntime = runtimeFixture();
    vi.mocked(conflictRuntime.repository.createPresentation).mockRejectedValue(
      new KnowledgeCardOperationConflictError(),
    );
    await expect(presentKnowledgeDraft({
      runtime: conflictRuntime,
      draftId: "draft-1",
      expectedVersion: 7,
      operationKey: "operation-conflict",
      at,
    })).rejects.toMatchObject({ code: "knowledge_card_conflict" });
  });
});

type Runtime = Pick<KnowledgeCardRuntime, "repository" | "canUseKnowledgeCards">;

function runtimeFixture(): Runtime {
  const repository: KnowledgeCardRuntimeRepository = {
    createPresentation: vi.fn(async (input) => ({
      outcome: "applied" as const,
      presentation: presentation({
        id: input.id,
        draftId: input.draftId,
        revisionNumber: input.expectedRevisionNumber,
        draftVersion: input.expectedDraftVersion,
        chatId: input.chatId,
        contentHash: input.contentHash,
        createdAt: input.at,
      }),
      draft: currentDraft(),
    })),
    claimPresentationSend: vi.fn(),
    beginExternalAttempt: vi.fn(),
    failPresentationPreparation: vi.fn(),
    completePresentationSend: vi.fn(),
    failPresentationSend: vi.fn(),
    applyInteraction: vi.fn(),
    getPresentation: vi.fn(async () => undefined),
    getPresentationContext: vi.fn(),
    listPresentations: vi.fn(async () => []),
    getStatusCounts: vi.fn(),
    getOutboxStatusCounts: vi.fn(),
    getDraft: vi.fn(async () => currentDraft()),
  };
  return {
    repository,
    canUseKnowledgeCards: vi.fn(() => true),
  };
}

function currentDraft(overrides: {
  content?: string;
  invalidEvidence?: boolean;
  version?: number;
} = {}): KnowledgeDraft {
  const createdAt = new Date("2026-08-02T01:00:00.000Z");
  const version = overrides.version ?? 7;
  const base = {
    id: "draft-1",
    sourceGroupId: "oc_pilot",
    originKind: "user_requested" as const,
    status: "pending_confirmation" as const,
    currentRevisionNumber: 3,
    version,
    createdBy: "iris",
    createdAt,
    updatedAt: createdAt,
  };
  if (overrides.invalidEvidence) {
    return {
      ...base,
      currentRevision: {
        revisionNumber: 3,
        riskLevel: "medium",
        author: "iris",
        createdAt,
        evidenceState: { status: "invalidated", reason: "message_deleted" },
      },
    };
  }
  return {
    ...base,
    currentRevision: {
      revisionNumber: 3,
      riskLevel: "medium",
      author: "iris",
      createdAt,
      evidenceState: { status: "current" },
      title: "Pilot summary",
      content: overrides.content ?? "A grounded group summary.",
      reviewer: { type: "feishu_user", ref: "ou_owner" },
      suggestedPublication: { spaceId: "spc_pilot", parentNodeToken: "wikcn_parent" },
      evidence: [{ type: "conversation_message", id: "feishu:om_1", groupId: "oc_pilot" }],
    },
  };
}

function presentation(overrides: Partial<KnowledgeDraftPresentation> = {}): KnowledgeDraftPresentation {
  return {
    id: "presentation-1",
    draftId: "draft-1",
    revisionNumber: 3,
    draftVersion: 7,
    chatId: "oc_pilot",
    contentHash: "a".repeat(64),
    state: "pending_send",
    createdAt: at,
    version: 1,
    ...overrides,
  };
}
