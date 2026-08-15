import { describe, expect, it, vi } from "vitest";

import type { DocumentSource } from "../src/documents/document-source-registry.js";
import type { KnowledgeConflictCandidate } from "../src/knowledge-conflicts/knowledge-conflict.js";
import {
  KnowledgeConflictStaleEvidenceError,
  KnowledgeConflictVersionConflictError,
} from
  "../src/knowledge-conflicts/knowledge-conflict-repository.js";
import { createKnowledgeConflictCurrentValidator } from
  "../src/knowledge-conflicts/knowledge-conflict-current-validator.js";

const validatedAt = new Date("2026-08-15T01:00:00.000Z");

describe("KnowledgeConflictCurrentValidator", () => {
  it("live-checks every exact source before repository current-state validation", async () => {
    const trace: string[] = [];
    const currentCandidate = candidate();
    const validateCandidateCurrentState = vi.fn(async () => ({
      status: "current" as const,
      candidate: currentCandidate,
    }));
    const validator = createKnowledgeConflictCurrentValidator({
      repository: { validateCandidateCurrentState },
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
      now: () => validatedAt,
    });

    await expect(validator.validate({ candidate: currentCandidate, expectedVersion: 3 }))
      .resolves.toEqual({
        status: "current",
        candidate: currentCandidate,
        permissionAttestedAt: validatedAt,
      });
    expect(trace).toEqual(["source:source-a", "permission:source-a"]);
    expect(validateCandidateCurrentState).toHaveBeenCalledWith({
      candidateId: "candidate-a",
      expectedVersion: 3,
      permissionAttestedAt: validatedAt,
      operationKey: "current-validation:candidate-a:v3",
      at: validatedAt,
    });
  });

  it("preserves the earliest real permission completion time across multiple sources", async () => {
    const firstPermissionAt = new Date("2026-08-15T01:00:00.000Z");
    const secondPermissionAt = new Date("2026-08-15T01:00:30.000Z");
    const validationAt = new Date("2026-08-15T01:01:01.000Z");
    const baseCandidate = candidate();
    const currentCandidate = candidate({
      evidence: [
        ...baseCandidate.evidence,
        {
          type: "document_source",
          referenceId: "D2",
          documentSourceId: "source-b",
          expectedUpdatedAt: new Date("2026-08-14T01:00:00.000Z"),
        },
      ],
    });
    const validateCandidateCurrentState = vi.fn(async (input) => {
      expect(input.permissionAttestedAt).toEqual(firstPermissionAt);
      expect(input.at).toEqual(validationAt);
      throw new KnowledgeConflictStaleEvidenceError("permission_stale");
    });
    const times = [firstPermissionAt, secondPermissionAt, validationAt];
    const validator = createKnowledgeConflictCurrentValidator({
      repository: { validateCandidateCurrentState },
      documentSources: {
        async findSourceById(id) { return source({ id }); },
      },
      permissionChecker: { async canReadSource() { return true; } },
      now: () => times.shift() ?? validationAt,
    });

    await expect(validator.validate({ candidate: currentCandidate, expectedVersion: 3 }))
      .resolves.toEqual({
        status: "superseded",
        candidate: currentCandidate,
        reason: "permission_stale",
      });
  });

  it("returns the repository's stable superseded result after live permission succeeds", async () => {
    const superseded = candidate({ status: "superseded", version: 4 });
    const validator = createKnowledgeConflictCurrentValidator({
      repository: {
        validateCandidateCurrentState: vi.fn(async () => ({
          status: "superseded" as const,
          candidate: superseded,
          reasonCode: "snapshot_stale",
        })),
      },
      documentSources: { async findSourceById() { return source(); } },
      permissionChecker: { async canReadSource() { return true; } },
      now: () => validatedAt,
    });

    await expect(validator.validate({ candidate: candidate(), expectedVersion: 3 }))
      .resolves.toEqual({ status: "superseded", candidate: superseded, reason: "snapshot_stale" });
  });

  it("live-checks a changed exact source before durably superseding stale evidence", async () => {
    const trace: string[] = [];
    const superseded = candidate({ status: "superseded", version: 4 });
    const validateCandidateCurrentState = vi.fn(async () => {
      trace.push("repository");
      return {
        status: "superseded" as const,
        candidate: superseded,
        reasonCode: "source_stale",
      };
    });
    const validator = createKnowledgeConflictCurrentValidator({
      repository: { validateCandidateCurrentState },
      documentSources: {
        async findSourceById() {
          trace.push("source");
          return source({ updatedAt: new Date("2026-08-15T00:30:00.000Z") });
        },
      },
      permissionChecker: {
        async canReadSource() {
          trace.push("permission");
          return true;
        },
      },
      now: () => validatedAt,
    });

    await expect(validator.validate({ candidate: candidate(), expectedVersion: 3 }))
      .resolves.toEqual({ status: "superseded", candidate: superseded, reason: "source_stale" });
    expect(trace).toEqual(["source", "permission", "repository"]);
    expect(validateCandidateCurrentState).toHaveBeenCalledWith(expect.objectContaining({
      permissionAttestedAt: validatedAt,
      expectedVersion: 3,
    }));
  });

  it("blocks validation when exact source permission is denied without attesting to the repository", async () => {
    const validateCandidateCurrentState = vi.fn();
    const validator = createKnowledgeConflictCurrentValidator({
      repository: { validateCandidateCurrentState },
      documentSources: { async findSourceById() { return source(); } },
      permissionChecker: { async canReadSource() { return false; } },
      now: () => validatedAt,
    });

    await expect(validator.validate({ candidate: candidate(), expectedVersion: 3 }))
      .resolves.toEqual({ status: "permission_blocked", candidate: candidate() });
    expect(validateCandidateCurrentState).not.toHaveBeenCalled();
  });

  it.each([
    [true, "current"],
    [false, "permission_blocked"],
  ] as const)(
    "uses live permission for a locally unknown exact source (allowed=%s)",
    async (allowed, expectedStatus) => {
      const validateCandidateCurrentState = vi.fn(async () => ({
        status: "current" as const,
        candidate: candidate(),
      }));
      let permissionCalls = 0;
      const validator = createKnowledgeConflictCurrentValidator({
        repository: { validateCandidateCurrentState },
        documentSources: {
          async findSourceById() { return source({ permissionState: "unknown" }); },
        },
        permissionChecker: {
          async canReadSource() {
            permissionCalls += 1;
            return allowed;
          },
        },
        now: () => validatedAt,
      });

      const result = await validator.validate({ candidate: candidate(), expectedVersion: 3 });
      expect(result.status).toBe(expectedStatus);
      expect(permissionCalls).toBe(1);
      expect(validateCandidateCurrentState).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );

  it.each([
    ["source lookup", { findSourceById: async () => { throw new Error("database secret"); } },
      { canReadSource: async () => true }],
    ["permission transport", { findSourceById: async () => source() },
      { canReadSource: async () => { throw new Error("tenant token"); } }],
  ])("returns content-free validation_unavailable for %s failure", async (_label, documentSources, permissionChecker) => {
    const validator = createKnowledgeConflictCurrentValidator({
      repository: { validateCandidateCurrentState: vi.fn() },
      documentSources,
      permissionChecker,
      now: () => validatedAt,
    });

    const result = await validator.validate({ candidate: candidate(), expectedVersion: 3 });
    expect(result).toEqual({ status: "validation_unavailable", candidate: candidate() });
    expect(JSON.stringify(result)).not.toMatch(/database secret|tenant token/iu);
  });

  it("preserves a repository version conflict after live validation", async () => {
    const validator = createKnowledgeConflictCurrentValidator({
      repository: {
        validateCandidateCurrentState: vi.fn(async () => {
          throw new KnowledgeConflictVersionConflictError();
        }),
      },
      documentSources: { async findSourceById() { return source(); } },
      permissionChecker: { async canReadSource() { return true; } },
      now: () => validatedAt,
    });

    await expect(validator.validate({ candidate: candidate(), expectedVersion: 3 }))
      .rejects.toBeInstanceOf(KnowledgeConflictVersionConflictError);
  });
});

function source(overrides: Partial<DocumentSource> = {}): DocumentSource {
  return {
    id: "source-a",
    sourceType: "authorized_wiki_document",
    sourceUri: "https://example.invalid/wiki/source-a",
    authorizedSpaceId: "space-a",
    permissionState: "readable",
    syncState: "synced",
    canUseForAnswering: true,
    canUseForKnowledgeDrafts: true,
    createdAt: validatedAt,
    updatedAt: new Date("2026-08-14T01:00:00.000Z"),
    evidence: [{ kind: "admin_authorization", sourceUri: "https://example.invalid/wiki/source-a",
      spaceId: "space-a", observedAt: validatedAt }],
    ...overrides,
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
    version: 3, createdAt: at, updatedAt: at,
    ...overrides,
  };
}
