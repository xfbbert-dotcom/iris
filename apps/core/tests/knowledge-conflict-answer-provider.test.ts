import { describe, expect, it, vi } from "vitest";

import type { DocumentSource } from "../src/documents/document-source-registry.js";
import type { RetrievedDocumentFragment } from
  "../src/documents/document-fragment-repository.js";
import {
  createKnowledgeConflictAnswerProvider,
} from "../src/knowledge-conflicts/knowledge-conflict-answer-provider.js";
import type { KnowledgeConflictCandidate } from
  "../src/knowledge-conflicts/knowledge-conflict.js";
import type { PromptGroupMemory } from "../src/memory/context-assembly.js";

const answerAt = new Date("2026-08-15T03:00:00.000Z");

describe("KnowledgeConflictAnswerProvider", () => {
  it("live-checks permission before loading candidate text and maps exact overlap", async () => {
    const trace: string[] = [];
    const findCurrentOverlap = vi.fn(async () => {
      trace.push("repository");
      return candidate();
    });
    const provider = createKnowledgeConflictAnswerProvider({
      repository: { findCurrentOverlap },
      documentSources: {
        async findSourceById(id) {
          trace.push(`source:${id}`);
          return source();
        },
      },
      permissionChecker: {
        async canReadSource(value) {
          trace.push(`permission:${value.id}`);
          return true;
        },
      },
      now: () => answerAt,
    });

    const result = await provider.findConflictPlan({
      groupId: "group-a",
      usedGroupMemories: [memory()],
      allowedFragments: [fragment()],
    });

    expect(trace).toEqual(["source:source-a", "permission:source-a", "repository"]);
    expect(findCurrentOverlap).toHaveBeenCalledWith({
      groupId: "group-a",
      groupMemoryIds: ["memory-a"],
      documents: [{ sourceId: "source-a", snapshotId: "snapshot-a" }],
      permissionAttestedAt: answerAt,
      at: answerAt,
    });
    expect(result).toMatchObject({
      candidateId: "candidate-a",
      plan: {
        evidenceState: "conflict",
        premises: [
          { citationRef: "M1", statement: "Director approval now starts at CNY 10,000." },
          { citationRef: "D1", statement: "Director approval starts at CNY 5,000." },
        ],
        missingInformation: [],
        confidence: "high",
      },
    });
    expect(result?.plan.proposedAnswer).toContain("current synchronized knowledge");
    expect(result?.plan.proposedAnswer).toContain("newer group conclusion");
    expect(result?.plan.proposedAnswer).toContain("does not select a winner");
    expect(result?.plan.proposedAnswer).not.toContain("Replace CNY");
  });

  it("falls through without repository text access when live permission is denied", async () => {
    const findCurrentOverlap = vi.fn();
    const provider = createKnowledgeConflictAnswerProvider({
      repository: { findCurrentOverlap },
      documentSources: { async findSourceById() { return source(); } },
      permissionChecker: { async canReadSource() { return false; } },
      now: () => answerAt,
    });

    await expect(provider.findConflictPlan({
      groupId: "group-a",
      usedGroupMemories: [memory()],
      allowedFragments: [fragment({ text: "DENIED_DOCUMENT_TEXT" })],
    })).resolves.toBeUndefined();
    expect(findCurrentOverlap).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", undefined],
    ["dismissed", candidate({ status: "dismissed" })],
    ["superseded", candidate({ status: "superseded" })],
  ] as const)("falls through for %s candidates", async (_label, currentCandidate) => {
    const provider = providerReturning(currentCandidate);
    await expect(provider.findConflictPlan({
      groupId: "group-a",
      usedGroupMemories: [memory()],
      allowedFragments: [fragment()],
    })).resolves.toBeUndefined();
  });

  it("rejects a repository result that does not exactly overlap the answer window", async () => {
    const provider = providerReturning(candidate({ groupMemoryId: "memory-other" }));
    await expect(provider.findConflictPlan({
      groupId: "group-a",
      usedGroupMemories: [memory()],
      allowedFragments: [fragment()],
    })).resolves.toBeUndefined();
  });
});

function providerReturning(currentCandidate: KnowledgeConflictCandidate | undefined) {
  return createKnowledgeConflictAnswerProvider({
    repository: { findCurrentOverlap: vi.fn(async () => currentCandidate) },
    documentSources: { async findSourceById() { return source(); } },
    permissionChecker: { async canReadSource() { return true; } },
    now: () => answerAt,
  });
}

function memory(): PromptGroupMemory {
  return {
    id: "memory-a", scope: "group", category: "decision",
    content: "Director approval now starts at CNY 10,000.",
    evidenceMessageIds: ["message-a"],
  };
}

function fragment(overrides: Partial<RetrievedDocumentFragment> = {}): RetrievedDocumentFragment {
  return {
    id: "fragment-a", documentSourceId: "source-a", documentSnapshotId: "snapshot-a",
    sourceUri: "https://example.invalid/wiki/source-a", chunkIndex: 0,
    text: "Director approval starts at CNY 5,000.", contentHash: "b".repeat(64),
    embedding: [1, 0, 0, 0, 0, 0], embeddingProfileId: "static-dev-6d",
    createdAt: answerAt, sourceType: "feishu_wiki", ...overrides,
  };
}

function source(): DocumentSource {
  return {
    id: "source-a", sourceType: "authorized_wiki_document",
    sourceUri: "https://example.invalid/wiki/source-a", authorizedSpaceId: "space-a",
    permissionState: "readable", syncState: "synced", canUseForAnswering: true,
    canUseForKnowledgeDrafts: true, createdAt: answerAt,
    updatedAt: new Date("2026-08-14T01:00:00.000Z"),
    evidence: [{ kind: "admin_authorization", sourceUri: "https://example.invalid/wiki/source-a",
      spaceId: "space-a", observedAt: answerAt }],
  };
}

function candidate(overrides: Partial<KnowledgeConflictCandidate> = {}): KnowledgeConflictCandidate {
  const at = new Date("2026-08-14T02:00:00.000Z");
  return {
    id: "candidate-a", idempotencyKey: "candidate-operation-a", groupId: "group-a",
    groupMemoryId: "memory-a", memoryUpdatedAt: at, sourceMessageId: "message-a",
    targetDocumentSourceId: "source-a",
    targetSourceUpdatedAt: new Date("2026-08-14T01:00:00.000Z"),
    targetSourceVersion: "revision-7", targetSnapshotId: "snapshot-a",
    targetContentHash: "a".repeat(64), detectorContractVersion: "conflict-v1",
    status: "pending_review",
    plan: {
      outcome: "conflict", subject: "Expense approval threshold",
      knowledgeBaseStatement: "Director approval starts at CNY 5,000.",
      knowledgeBaseCitationRefs: ["D1"],
      groupConclusionStatement: "Director approval now starts at CNY 10,000.",
      groupCitationRefs: ["M1", "C1"], difference: "The approval threshold differs.",
      suggestedUpdate: "Replace CNY 5,000 with CNY 10,000.", targetDocumentRef: "D1",
      missingEvidence: [], confidence: "high",
    },
    evidence: [
      { type: "conversation_message", referenceId: "C1", groupId: "group-a",
        conversationMessageId: "message-a" },
      { type: "group_memory", referenceId: "M1", groupId: "group-a",
        groupMemoryId: "memory-a", expectedUpdatedAt: at },
      { type: "document_source", referenceId: "D1", documentSourceId: "source-a",
        expectedUpdatedAt: new Date("2026-08-14T01:00:00.000Z") },
      { type: "document_snapshot", referenceId: "D1", documentSourceId: "source-a",
        documentSnapshotId: "snapshot-a", contentHash: "a".repeat(64) },
      { type: "document_fragment", referenceId: "D1", documentSourceId: "source-a",
        documentSnapshotId: "snapshot-a", documentFragmentId: "fragment-a",
        snapshotContentHash: "a".repeat(64), contentHash: "b".repeat(64) },
    ],
    version: 3, createdAt: at, updatedAt: at, ...overrides,
  };
}
