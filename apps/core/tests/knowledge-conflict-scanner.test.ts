import { describe, expect, it } from "vitest";

import type { GroupMemory } from "../src/memory/group-memory-repository.js";
import type {
  KnowledgeConflictEvidenceBuildResult,
  CurrentConflictFingerprint,
} from "../src/knowledge-conflicts/knowledge-conflict-evidence-builder.js";
import {
  KnowledgeConflictOperationConflictError,
  KnowledgeConflictStaleEvidenceError,
  type KnowledgeConflictRepository,
  type KnowledgeConflictScanClaim,
  type RecordKnowledgeConflictDetectionInput,
} from "../src/knowledge-conflicts/knowledge-conflict-repository.js";
import type { KnowledgeConflictPlan } from "../src/knowledge-conflicts/knowledge-conflict.js";
import {
  createKnowledgeConflictScanner,
} from "../src/knowledge-conflicts/knowledge-conflict-scanner.js";
import { ModelProviderHttpError } from "../src/model/model-provider-error.js";

const NOW = new Date("2026-08-13T02:00:00.000Z");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("KnowledgeConflictScanner", () => {
  it("does nothing before discovery when the feature is disabled or no group is configured", async () => {
    const disabledRepository = repositoryFake();
    const disabled = scannerFixture({
      repository: disabledRepository,
      canUseKnowledgeConflict: () => false,
    });

    await expect(disabled.scanBatch({ limit: 10 })).resolves.toEqual(emptyBatch());
    expect(disabledRepository.trace).toEqual([]);

    const noGroupRepository = repositoryFake();
    const noGroup = scannerFixture({ repository: noGroupRepository, groupIds: [] });
    await expect(noGroup.scanBatch({ limit: 10 })).resolves.toEqual(emptyBatch());
    expect(noGroupRepository.trace).toEqual([]);
  });

  it("restricts claims to groups whose live application gate passed discovery", async () => {
    const repository = repositoryFake();
    const scanner = scannerFixture({
      repository,
      groupIds: ["group-disabled", "group-1"],
      canUseKnowledgeConflict: (groupId) => groupId === "group-1",
    });

    await scanner.scanBatch({ limit: 1 });

    expect(repository.claimGroupIds).toEqual([["group-1"]]);
  });

  it("discovers before bounded claims and lets one subject failure yield to the next", async () => {
    const repository = repositoryFake({
      claims: [claim({ scanId: "scan-1", memoryId: "memory-1", attemptCount: 1 }),
        claim({ scanId: "scan-2", memoryId: "memory-2", attemptCount: 1 }),
        claim({ scanId: "scan-3", memoryId: "memory-3", attemptCount: 1 })],
      discovered: 3,
    });
    let buildCount = 0;
    const scanner = scannerFixture({
      repository,
      evidenceBuilder: {
        async build({ memory }) {
          buildCount += 1;
          if (memory.id === "memory-1") {
            return { outcome: "retryable_failure", reasonCode: "embedding_failed" };
          }
          return { outcome: "insufficient_evidence", reasonCode: "no_authorized_document_evidence" };
        },
      },
    });

    await expect(scanner.scanBatch({ limit: 2 })).resolves.toEqual({
      ...emptyBatch(),
      discovered: 2,
      claimed: 2,
      insufficientEvidence: 1,
      retrying: 1,
    });
    expect(buildCount).toBe(2);
    expect(repository.trace).toEqual([
      "discover:2",
      "claim:scan-1",
      "fail:scan-1:retryable:embedding_failed:2026-08-13T02:00:30.000Z",
      "claim:scan-2",
      "record:scan-2:insufficient_evidence",
    ]);
  });

  it.each([
    ["insufficient_evidence", "insufficientEvidence"],
    ["permission_blocked", "permissionBlocked"],
  ] as const)("records %s as a terminal content-free outcome", async (outcome, countName) => {
    const repository = repositoryFake({ claims: [claim()] });
    const scanner = scannerFixture({
      repository,
      evidenceBuilder: {
        async build() {
          return { outcome, reasonCode: "denied raw text must not escape" };
        },
      },
    });

    const result = await scanner.scanBatch({ limit: 1 });

    expect(result).toEqual({ ...emptyBatch(), claimed: 1, [countName]: 1 });
    expect(repository.records).toEqual([{ scanId: "scan-1", outcome }]);
    expect(JSON.stringify(result)).not.toContain("denied raw text");
  });

  it("records no-conflict without constructing a candidate and calls the detector once", async () => {
    const repository = repositoryFake({ claims: [claim()] });
    let detectorCalls = 0;
    const scanner = scannerFixture({
      repository,
      detector: {
        async detect() {
          detectorCalls += 1;
          return noConflictPlan();
        },
      },
    });

    await expect(scanner.scanBatch({ limit: 1 })).resolves.toEqual({
      ...emptyBatch(), claimed: 1, noConflict: 1,
    });
    expect(detectorCalls).toBe(1);
    expect(repository.records).toEqual([{ scanId: "scan-1", outcome: "no_conflict" }]);
  });

  it("persists a conflict with deterministic identity and only the exact cited evidence", async () => {
    const repository = repositoryFake({ claims: [claim()] });
    const scanner = scannerFixture({ repository });

    await expect(scanner.scanBatch({ limit: 1 })).resolves.toEqual({
      ...emptyBatch(), claimed: 1, conflict: 1,
    });

    const record = repository.recordInputs[0];
    expect(record?.result.outcome).toBe("conflict");
    if (record?.result.outcome !== "conflict") throw new Error("expected conflict record");
    expect(record.result.candidate).toMatchObject({
      id: "knowledge-conflict-candidate:3a513c79aea6a5a349357547b98ca62c9dfa3f62c864dfc0d1d9255b0943ad65",
      idempotencyKey: "knowledge-conflict:3a513c79aea6a5a349357547b98ca62c9dfa3f62c864dfc0d1d9255b0943ad65",
      groupId: "group-1",
      groupMemoryId: "memory-1",
      sourceMessageId: "message-1",
      targetDocumentSourceId: "source-1",
      targetSnapshotId: "snapshot-1",
      targetContentHash: HASH_A,
      detectorContractVersion: "knowledge-conflict-v1",
      permissionAttestedAt: NOW,
    });
    expect(record.result.candidate.evidence).toEqual([
      { type: "group_memory", referenceId: "M1", groupId: "group-1",
        groupMemoryId: "memory-1", expectedUpdatedAt: NOW },
      { type: "conversation_message", referenceId: "C1", groupId: "group-1",
        conversationMessageId: "message-1" },
      { type: "document_source", referenceId: "D1", documentSourceId: "source-1",
        expectedUpdatedAt: NOW },
      { type: "document_snapshot", referenceId: "D1", documentSourceId: "source-1",
        documentSnapshotId: "snapshot-1", contentHash: HASH_A },
      { type: "document_fragment", referenceId: "D1", documentSourceId: "source-1",
        documentSnapshotId: "snapshot-1", documentFragmentId: "fragment-1",
        snapshotContentHash: HASH_A, contentHash: HASH_B },
    ]);
  });

  it("rechecks the live application gate before retrieval, model use, and persistence", async () => {
    const repository = repositoryFake({ claims: [claim()] });
    const gateAnswers = [true, true, true, false];
    let buildCalls = 0;
    let detectorCalls = 0;
    const scanner = scannerFixture({
      repository,
      canUseKnowledgeConflict: () => gateAnswers.shift() ?? false,
      evidenceBuilder: { async build() { buildCalls += 1; return readyEvidence(); } },
      detector: { async detect() { detectorCalls += 1; return conflictPlan(); } },
    });

    await expect(scanner.scanBatch({ limit: 1 })).resolves.toEqual({
      ...emptyBatch(), claimed: 1, permissionBlocked: 1,
    });
    expect(buildCalls).toBe(1);
    expect(detectorCalls).toBe(1);
    expect(repository.records).toEqual([{ scanId: "scan-1", outcome: "permission_blocked" }]);
  });

  it("completes a fingerprint rejected after the model call as superseded", async () => {
    const repository = repositoryFake({
      claims: [claim()],
      recordError: new KnowledgeConflictStaleEvidenceError("snapshot_stale"),
    });
    const scanner = scannerFixture({ repository });

    await expect(scanner.scanBatch({ limit: 1 })).resolves.toEqual({
      ...emptyBatch(), claimed: 1, superseded: 1,
    });
    expect(repository.trace).toContain("complete:scan-1:superseded");
  });

  it.each([
    [new ModelProviderHttpError(429, "raw provider capacity body"), "provider_capacity"],
    [new TypeError("raw transport URL and token"), "provider_transport"],
    [new Error("knowledge conflict detector response was invalid"), "provider_invalid_response"],
  ])("retries a provider failure with a stable content-free code", async (error, code) => {
    const repository = repositoryFake({ claims: [claim()] });
    const scanner = scannerFixture({
      repository,
      detector: { async detect() { throw error; } },
    });

    const result = await scanner.scanBatch({ limit: 1 });

    expect(result).toEqual({ ...emptyBatch(), claimed: 1, retrying: 1 });
    expect(repository.trace).toContain(
      `fail:scan-1:retryable:${code}:2026-08-13T02:00:30.000Z`,
    );
    expect(JSON.stringify(result)).not.toContain(error.message);
  });

  it("permanently rejects a divergent idempotency replay", async () => {
    const repository = repositoryFake({
      claims: [claim()],
      recordError: new KnowledgeConflictOperationConflictError(),
      failStatuses: ["dead_lettered"],
    });
    const scanner = scannerFixture({ repository });

    await expect(scanner.scanBatch({ limit: 1 })).resolves.toMatchObject({
      claimed: 1, retrying: 0, deadLettered: 1,
    });
    expect(repository.trace).toContain(
      "fail:scan-1:permanent:operation_conflict:none",
    );
  });

  it("does not mislabel a non-provider TypeError as provider transport", async () => {
    const repository = repositoryFake({ claims: [claim()] });
    const scanner = scannerFixture({
      repository,
      evidenceBuilder: {
        async build() { throw new TypeError("local evidence adapter defect"); },
      },
    });

    await scanner.scanBatch({ limit: 1 });

    expect(repository.trace).toContain(
      "fail:scan-1:retryable:internal_error:2026-08-13T02:00:30.000Z",
    );
  });

  it("uses attempt-count-only capped exponential backoff and reports exhaustion", async () => {
    const repository = repositoryFake({
      claims: [claim({ scanId: "scan-1", attemptCount: 1 }),
        claim({ scanId: "scan-2", attemptCount: 2 }),
        claim({ scanId: "scan-3", attemptCount: 20 })],
      failStatuses: ["retry", "retry", "dead_lettered"],
    });
    const scanner = scannerFixture({
      repository,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 5_000,
      detector: { async detect() { throw new TypeError("offline"); } },
    });

    await expect(scanner.scanBatch({ limit: 3 })).resolves.toEqual({
      ...emptyBatch(), claimed: 3, retrying: 2, deadLettered: 1,
    });
    expect(repository.retryTimes).toEqual([
      new Date("2026-08-13T02:00:01.000Z"),
      new Date("2026-08-13T02:00:02.000Z"),
      new Date("2026-08-13T02:00:05.000Z"),
    ]);
  });

  it("dead-letters impossible detector identities as permanent failures", async () => {
    const repository = repositoryFake({
      claims: [claim()],
      failStatuses: ["dead_lettered"],
    });
    const scanner = scannerFixture({
      repository,
      detector: {
        async detect() {
          return { ...conflictPlan(), targetDocumentRef: "D12",
            knowledgeBaseCitationRefs: ["D12"] };
        },
      },
    });

    await expect(scanner.scanBatch({ limit: 1 })).resolves.toEqual({
      ...emptyBatch(), claimed: 1, deadLettered: 1,
    });
    expect(repository.trace).toContain(
      "fail:scan-1:permanent:impossible_evidence_identity:none",
    );
  });

  it("dead-letters malformed persisted scan facts without storing their raw values", async () => {
    const malformed = claim();
    malformed.scan.attemptCount = 0;
    const repository = repositoryFake({
      claims: [malformed],
      failStatuses: ["dead_lettered"],
    });
    const scanner = scannerFixture({ repository });

    await expect(scanner.scanBatch({ limit: 1 })).resolves.toEqual({
      ...emptyBatch(), claimed: 1, deadLettered: 1,
    });
    expect(repository.trace).toContain(
      "fail:scan-1:permanent:malformed_persisted_facts:none",
    );
  });

  it("treats detector input rejection as malformed persisted facts, not a provider retry", async () => {
    const repository = repositoryFake({
      claims: [claim()],
      failStatuses: ["dead_lettered"],
    });
    const scanner = scannerFixture({
      repository,
      detector: {
        async detect() { throw new Error("knowledge conflict detector input is invalid"); },
      },
    });

    await expect(scanner.scanBatch({ limit: 1 })).resolves.toMatchObject({
      claimed: 1, retrying: 0, deadLettered: 1,
    });
    expect(repository.trace).toContain(
      "fail:scan-1:permanent:malformed_persisted_facts:none",
    );
  });
});

function scannerFixture(overrides: Partial<Parameters<typeof createKnowledgeConflictScanner>[0]> = {}) {
  return createKnowledgeConflictScanner({
    repository: repositoryFake(),
    evidenceBuilder: { async build() { return readyEvidence(); } },
    detector: { async detect() { return conflictPlan(); } },
    groupIds: ["group-1"],
    canUseKnowledgeConflict: () => true,
    workerId: "scanner-1",
    leaseDurationMs: 10_000,
    retryBaseDelayMs: 30_000,
    retryMaxDelayMs: 600_000,
    detectorContractVersion: "knowledge-conflict-v1",
    now: () => new Date(NOW),
    ...overrides,
  });
}

type RepositoryFake = Pick<KnowledgeConflictRepository,
  "discoverEligibleScans" | "claimNextScan" | "completeScan" | "failScan" |
  "recordDetectionResult"> & {
    trace: string[];
    records: Array<{ scanId: string; outcome: string }>;
    recordInputs: RecordKnowledgeConflictDetectionInput[];
    retryTimes: Array<Date | undefined>;
    claimGroupIds: string[][];
  };

function repositoryFake(options: {
  claims?: KnowledgeConflictScanClaim[];
  discovered?: number;
  failStatuses?: Array<"retry" | "dead_lettered">;
  recordError?: Error;
} = {}): RepositoryFake {
  const claims = [...(options.claims ?? [])];
  const failStatuses = [...(options.failStatuses ?? [])];
  const trace: string[] = [];
  const records: RepositoryFake["records"] = [];
  const recordInputs: RecordKnowledgeConflictDetectionInput[] = [];
  const retryTimes: Array<Date | undefined> = [];
  const claimGroupIds: string[][] = [];
  return {
    trace,
    records,
    recordInputs,
    retryTimes,
    claimGroupIds,
    async discoverEligibleScans({ limit }) {
      trace.push(`discover:${limit}`);
      return { discovered: options.discovered ?? 0, existing: 0 };
    },
    async claimNextScan(input) {
      claimGroupIds.push([...(input as typeof input & { groupIds?: string[] }).groupIds ?? []]);
      const next = claims.shift();
      if (next !== undefined) trace.push(`claim:${next.scan.id}`);
      return next;
    },
    async completeScan(input) {
      trace.push(`complete:${input.scanId}:${input.outcome}`);
      return { ...scan(input.scanId), status: "completed", terminalOutcome: input.outcome };
    },
    async failScan(input) {
      retryTimes.push(input.retryAt === undefined ? undefined : new Date(input.retryAt));
      trace.push(`fail:${input.scanId}:${input.classification}:${input.errorCode}:` +
        `${input.retryAt?.toISOString() ?? "none"}`);
      return { status: failStatuses.shift() ?? "retry" };
    },
    async recordDetectionResult(input) {
      recordInputs.push(input);
      records.push({ scanId: input.scanId, outcome: input.result.outcome });
      trace.push(`record:${input.scanId}:${input.result.outcome}`);
      if (options.recordError !== undefined) throw options.recordError;
      if (input.result.outcome === "conflict") {
        return {
          outcome: "applied",
          candidate: {
            ...input.result.candidate,
            evidence: [...input.result.candidate.evidence],
            status: "pending_review",
            version: 1,
            createdAt: input.at,
            updatedAt: input.at,
          },
          scan: { ...scan(input.scanId), status: "completed", terminalOutcome: "conflict" },
        };
      }
      return {
        outcome: "completed",
        scan: { ...scan(input.scanId), status: "completed", terminalOutcome: input.result.outcome },
      };
    },
  };
}

function claim(options: {
  scanId?: string;
  memoryId?: string;
  attemptCount?: number;
} = {}): KnowledgeConflictScanClaim {
  const memoryId = options.memoryId ?? "memory-1";
  return {
    scan: {
      ...scan(options.scanId ?? "scan-1", options.attemptCount ?? 1),
      groupMemoryId: memoryId,
      status: "processing",
      leaseWorkerId: "scanner-1",
      leaseUntil: new Date("2026-08-13T02:00:10.000Z"),
    },
    memory: memory(memoryId),
  };
}

function scan(id = "scan-1", attemptCount = 1) {
  return {
    id,
    groupId: "group-1",
    groupMemoryId: "memory-1",
    memoryUpdatedAt: new Date(NOW),
    status: "processing" as const,
    attemptCount,
    nextAttemptAt: new Date(NOW),
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  };
}

function memory(id = "memory-1"): GroupMemory {
  return {
    id,
    groupId: "group-1",
    scope: "group",
    category: "decision",
    content: "Expense approval threshold",
    importance: 4,
    confidence: 0.9,
    status: "active",
    idempotencyKey: `memory:${id}`,
    origin: "extractor",
    createdBy: "iris",
    evidenceMessageIds: ["message-1"],
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  };
}

function readyEvidence(): Extract<KnowledgeConflictEvidenceBuildResult, { outcome: "ready" }> {
  const fingerprint: CurrentConflictFingerprint = {
    memory: { groupMemoryId: "memory-1", groupId: "group-1", updatedAt: new Date(NOW) },
    messages: [{ referenceId: "C1", conversationMessageId: "message-1",
      chatId: "group-1", sentAt: new Date("2026-08-13T01:00:00.000Z") }],
    documents: [{ referenceId: "D1", documentSourceId: "source-1",
      sourceUpdatedAt: new Date(NOW), documentSnapshotId: "snapshot-1",
      sourceVersion: "revision-7", snapshotContentHash: HASH_A,
      snapshotFetchedAt: new Date("2026-08-12T01:00:00.000Z"),
      documentFragmentId: "fragment-1", fragmentContentHash: HASH_B }],
    publicationTarget: { id: "target-1", version: 1, spaceId: "space-1" },
    permissionAttestedAt: new Date(NOW),
  };
  return {
    outcome: "ready",
    input: {
      subject: { referenceId: "M1", groupMemoryId: "memory-1", groupId: "group-1",
        category: "decision", content: "Expense approval threshold" },
      groupEvidence: [{ referenceId: "C1", conversationMessageId: "message-1",
        sentAt: new Date("2026-08-13T01:00:00.000Z"), text: "Use 5000" }],
      documentEvidence: [{ referenceId: "D1", documentSourceId: "source-1",
        sourceUri: "https://example.invalid/wiki/source-1", authorizedSpaceId: "space-1",
        sourceUpdatedAt: new Date(NOW), documentSnapshotId: "snapshot-1",
        sourceVersion: "revision-7", snapshotContentHash: HASH_A,
        snapshotFetchedAt: new Date("2026-08-12T01:00:00.000Z"),
        documentFragmentId: "fragment-1", fragmentContentHash: HASH_B, text: "Use 1000" }],
    },
    fingerprint,
  };
}

function conflictPlan(): KnowledgeConflictPlan & { outcome: "conflict" } {
  return {
    outcome: "conflict",
    subject: "Expense approval threshold",
    knowledgeBaseStatement: "Use 1000",
    knowledgeBaseCitationRefs: ["D1"],
    groupConclusionStatement: "Use 5000",
    groupCitationRefs: ["M1", "C1"],
    difference: "The thresholds differ",
    suggestedUpdate: "Replace 1000 with 5000",
    targetDocumentRef: "D1",
    missingEvidence: [],
    confidence: "high",
  };
}

function noConflictPlan(): KnowledgeConflictPlan {
  return {
    outcome: "no_conflict",
    subject: "Expense approval threshold",
    knowledgeBaseStatement: "Use 5000",
    knowledgeBaseCitationRefs: ["D1"],
    groupConclusionStatement: "Use 5000",
    groupCitationRefs: ["M1", "C1"],
    difference: null,
    suggestedUpdate: null,
    targetDocumentRef: null,
    missingEvidence: [],
    confidence: "high",
  };
}

function emptyBatch() {
  return {
    discovered: 0,
    claimed: 0,
    conflict: 0,
    noConflict: 0,
    insufficientEvidence: 0,
    permissionBlocked: 0,
    retrying: 0,
    deadLettered: 0,
    superseded: 0,
  };
}
