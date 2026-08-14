import { describe, expect, it, vi } from "vitest";

import { buildApp, type BuildAppDependencies } from "../src/app.js";
import type { KnowledgeConflictCandidate } from "../src/knowledge-conflicts/knowledge-conflict.js";
import {
  KnowledgeConflictDeliveryConflictError,
  KnowledgeConflictLeaseConflictError,
  KnowledgeConflictNotFoundError,
  KnowledgeConflictOperationConflictError,
  KnowledgeConflictStaleEvidenceError,
  KnowledgeConflictVersionConflictError,
  type KnowledgeConflictRepository,
} from "../src/knowledge-conflicts/knowledge-conflict-repository.js";

const authorization = { authorization: "Bearer operator-secret" };
const operatorHeaders = { ...authorization, "x-iris-operator": "operator@example.com" };

describe("knowledge conflict operator API", () => {
  it("authenticates every route before body parsing and fails closed without the runtime", async () => {
    const harness = createHarness();
    const app = await createApp(harness.repository);

    const unauthorized = await app.inject({
      method: "POST",
      url: "/internal/knowledge-conflicts/groups/group-a/candidates/candidate-a/dismiss",
      headers: { "content-type": "application/json" },
      payload: "{invalid",
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({ ok: false, error: "internal_api_unauthorized" });
    expect(harness.repository.dismissCandidate).not.toHaveBeenCalled();
    await app.close();

    const noRuntime = await createApp(undefined);
    const unavailable = await noRuntime.inject({
      method: "GET",
      url: "/internal/knowledge-conflicts/groups/group-a/candidates",
      headers: authorization,
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({
      ok: false,
      error: "knowledge_conflict_runtime_unavailable",
    });
    await noRuntime.close();
  });

  it("lists only the requested group with bounded status and limit filters", async () => {
    const harness = createHarness();
    const app = await createApp(harness.repository);
    const response = await app.inject({
      method: "GET",
      url: "/internal/knowledge-conflicts/groups/group-a/candidates?status=pending_review,approved_for_delivery&limit=7",
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(harness.repository.listCandidates).toHaveBeenCalledWith({
      groupId: "group-a",
      statuses: ["pending_review", "approved_for_delivery"],
      limit: 7,
    });
    expect(response.json()).toEqual({
      ok: true,
      groupId: "group-a",
      candidates: [expect.objectContaining({
        candidateId: "candidate-a",
        groupId: "group-a",
        subject: "Expense approval threshold",
        candidateVersion: 3,
      })],
    });

    for (const url of [
      "/internal/knowledge-conflicts/groups/%20/candidates",
      "/internal/knowledge-conflicts/groups/group-a/candidates?limit=0",
      "/internal/knowledge-conflicts/groups/group-a/candidates?limit=101",
      "/internal/knowledge-conflicts/groups/group-a/candidates?limit=9007199254740992",
      "/internal/knowledge-conflicts/groups/group-a/candidates?status=pending_review,pending_review",
      "/internal/knowledge-conflicts/groups/group-a/candidates?status=unknown",
      "/internal/knowledge-conflicts/groups/group-a/candidates?cursor=unsafe",
    ]) {
      expect((await app.inject({ method: "GET", url, headers: authorization })).statusCode, url).toBe(400);
    }
    await app.close();
  });

  it("returns scoped safe detail and audit events without actor references or raw source bodies", async () => {
    const harness = createHarness();
    const app = await createApp(harness.repository);

    const detail = await app.inject({
      method: "GET",
      url: "/internal/knowledge-conflicts/groups/group-a/candidates/candidate-a",
      headers: authorization,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual({
      ok: true,
      candidate: expect.objectContaining({
        candidateId: "candidate-a",
        groupId: "group-a",
        target: expect.objectContaining({
          documentSourceId: "source-a",
          snapshotId: "snapshot-a",
          sourceVersion: "revision-7",
        }),
        currentValidation: { status: "requires_revalidation" },
        evidence: expect.arrayContaining([
          expect.objectContaining({
            type: "conversation_message",
            referenceId: "C1",
            conversationMessageId: "message-a",
          }),
          expect.objectContaining({
            type: "document_fragment",
            referenceId: "D1",
            documentFragmentId: "fragment-a",
          }),
        ]),
      }),
      delivery: {
        deliveryId: "delivery-a",
        status: "outcome_unknown",
        attemptCount: 1,
        reconciliationDueAt: "2026-08-15T02:00:00.000Z",
      },
    });
    expect(detail.body).not.toMatch(/hidden source body|denied document text|operator@example\.com|operation-secret/iu);

    const events = await app.inject({
      method: "GET",
      url: "/internal/knowledge-conflicts/groups/group-a/candidates/candidate-a/events?limit=5",
      headers: authorization,
    });
    expect(events.statusCode).toBe(200);
    expect(harness.repository.listCandidateEvents).toHaveBeenCalledWith({
      candidateId: "candidate-a",
      limit: 5,
    });
    expect(events.json()).toEqual({
      ok: true,
      candidateId: "candidate-a",
      events: [expect.objectContaining({
        actorType: "admin_role",
        reason: "operator_confirmed",
        fromVersion: 2,
        toVersion: 3,
      })],
    });
    expect(events.body).not.toMatch(/operator@example\.com|operation-secret/iu);

    const crossGroup = await app.inject({
      method: "GET",
      url: "/internal/knowledge-conflicts/groups/group-b/candidates/candidate-a/events",
      headers: authorization,
    });
    expect(crossGroup.statusCode).toBe(404);
    expect(crossGroup.json()).toEqual({ ok: false, error: "knowledge_conflict_candidate_not_found" });
    expect(harness.repository.listCandidateEvents).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("requires exact versions, operator identity, reasons, and operation keys for idempotent governance", async () => {
    const harness = createHarness();
    harness.repository.dismissCandidate
      .mockResolvedValueOnce({ outcome: "applied", candidate: candidate({ status: "dismissed", version: 4 }) })
      .mockResolvedValueOnce({ outcome: "already_applied", candidate: candidate({ status: "dismissed", version: 4 }) });
    const app = await createApp(harness.repository);
    const payload = {
      expectedVersion: 3,
      reason: "Superseded by a reviewed policy clarification.",
      operationKey: "governance:candidate-a:dismiss:3",
    };

    for (const expectedOutcome of ["applied", "already_applied"]) {
      const response = await app.inject({
        method: "POST",
        url: "/internal/knowledge-conflicts/groups/group-a/candidates/candidate-a/dismiss",
        headers: operatorHeaders,
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        outcome: expectedOutcome,
        candidateId: "candidate-a",
        candidateVersion: 4,
      });
    }
    expect(harness.repository.dismissCandidate).toHaveBeenNthCalledWith(1, {
      candidateId: "candidate-a",
      expectedVersion: 3,
      operationKey: "governance:candidate-a:dismiss:3",
      actorType: "admin_role",
      actorRef: "operator@example.com",
      reasonCode: "Superseded by a reviewed policy clarification.",
      at: new Date("2026-08-15T01:00:00.000Z"),
    });

    for (const request of [
      { headers: authorization, payload },
      { headers: operatorHeaders, payload: { ...payload, expectedVersion: 0 } },
      { headers: operatorHeaders, payload: { ...payload, reason: "" } },
      { headers: operatorHeaders, payload: { ...payload, reason: "x".repeat(129) } },
      { headers: operatorHeaders, payload: { ...payload, actorOpenId: "ou_untrusted" } },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/internal/knowledge-conflicts/groups/group-a/candidates/candidate-a/dismiss",
        ...request,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    }

    const maximumReason = await app.inject({
      method: "POST",
      url: "/internal/knowledge-conflicts/groups/group-a/candidates/candidate-a/dismiss",
      headers: operatorHeaders,
      payload: { ...payload, reason: "x".repeat(128), operationKey: "governance:reason-128" },
    });
    expect(maximumReason.statusCode).toBe(200);
    await app.close();
  });

  it("approves one delivery and maps not-found, version, operation, and stale-evidence conflicts", async () => {
    const harness = createHarness();
    const app = await createApp(harness.repository);
    const payload = {
      expectedVersion: 3,
      reason: "Reviewed for one bounded group delivery.",
      operationKey: "governance:candidate-a:approve:3",
    };

    const approved = await app.inject({
      method: "POST",
      url: "/internal/knowledge-conflicts/groups/group-a/candidates/candidate-a/approve-delivery",
      headers: operatorHeaders,
      payload,
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toEqual({
      ok: true,
      outcome: "applied",
      candidateId: "candidate-a",
      candidateVersion: 4,
      deliveryId: "delivery-a",
    });
    expect(harness.repository.approveForDelivery).toHaveBeenCalledWith(expect.objectContaining({
      candidateId: "candidate-a",
      expectedVersion: 3,
      actorType: "admin_role",
      actorRef: "operator@example.com",
      reasonCode: "Reviewed for one bounded group delivery.",
    }));

    for (const [error, status, code, reason] of [
      [new KnowledgeConflictNotFoundError(), 404, "knowledge_conflict_candidate_not_found", undefined],
      [new KnowledgeConflictVersionConflictError(), 409, "knowledge_conflict_version_conflict", undefined],
      [new KnowledgeConflictOperationConflictError(), 409, "knowledge_conflict_operation_conflict", undefined],
      [new KnowledgeConflictStaleEvidenceError("snapshot_stale"), 409, "knowledge_conflict_evidence_stale", "snapshot_stale"],
      [new KnowledgeConflictStaleEvidenceError("provider secret: token-a"), 409, "knowledge_conflict_evidence_stale", "evidence_stale"],
    ] as const) {
      harness.repository.approveForDelivery.mockRejectedValueOnce(error);
      const response = await app.inject({
        method: "POST",
        url: "/internal/knowledge-conflicts/groups/group-a/candidates/candidate-a/approve-delivery",
        headers: operatorHeaders,
        payload,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({
        ok: false,
        error: code,
        ...(reason === undefined ? {} : { reason }),
      });
    }
    await app.close();
  });

  it("exposes content-free status and bounded dead-letter replay/delete operations", async () => {
    const harness = createHarness();
    const app = await createApp(harness.repository);

    const status = await app.inject({
      method: "GET",
      url: "/internal/knowledge-conflicts/status",
      headers: authorization,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      ok: true,
      scans: expect.objectContaining({ deadLettered: 1 }),
      candidates: expect.objectContaining({ pending_review: 2, superseded: 1 }),
      deliveries: expect.objectContaining({ outcomeUnknown: 1, terminalFailed: 1 }),
      interactions: expect.objectContaining({ applied: 4, rejected: 1 }),
    });
    expect(status.body).not.toMatch(/hidden source body|denied document text|operator@example\.com/iu);

    const list = await app.inject({
      method: "GET",
      url: "/internal/knowledge-conflicts/scans/dead-letters?limit=6",
      headers: authorization,
    });
    expect(list.statusCode).toBe(200);
    expect(harness.repository.listDeadLetterScans).toHaveBeenCalledWith({ limit: 6 });
    expect(list.json()).toEqual({
      ok: true,
      deadLetters: [expect.objectContaining({
        scanId: "scan-a",
        groupId: "group-a",
        attemptCount: 3,
        errorCode: "provider_unavailable",
      })],
    });
    expect(list.body).not.toMatch(/memory-a|hidden source body|denied document text/iu);

    harness.repository.listDeadLetterScans.mockResolvedValueOnce([{
      ...deadLetter(),
      lastErrorCode: "provider secret: token-a",
    }]);
    const unsafeCode = await app.inject({
      method: "GET",
      url: "/internal/knowledge-conflicts/scans/dead-letters?limit=1",
      headers: authorization,
    });
    expect(unsafeCode.json()).toEqual({
      ok: true,
      deadLetters: [expect.objectContaining({ errorCode: "internal_error" })],
    });
    expect(unsafeCode.body).not.toContain("provider secret");

    const replay = await app.inject({
      method: "POST",
      url: "/internal/knowledge-conflicts/scans/dead-letters/scan-a/replay",
      headers: operatorHeaders,
      payload: {},
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ ok: true, outcome: "replayed", scanId: "scan-a", status: "pending" });

    const deleted = await app.inject({
      method: "DELETE",
      url: "/internal/knowledge-conflicts/scans/dead-letters/scan-a",
      headers: operatorHeaders,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true, outcome: "deleted", scanId: "scan-a" });

    expect((await app.inject({
      method: "GET",
      url: "/internal/knowledge-conflicts/scans/dead-letters?limit=101",
      headers: authorization,
    })).statusCode).toBe(400);
    await app.close();
  });

  it("validates reconciliation intent and returns only the stable delivery outcome", async () => {
    const harness = createHarness();
    const app = await createApp(harness.repository);
    const sent = await app.inject({
      method: "POST",
      url: "/internal/knowledge-conflicts/deliveries/delivery-a/reconcile",
      headers: operatorHeaders,
      payload: {
        outcome: "sent",
        messageId: "message-sent-a",
        operationKey: "reconcile:delivery-a:attempt-1",
      },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toEqual({
      ok: true,
      outcome: "reconciled",
      deliveryId: "delivery-a",
      status: "sent",
    });

    for (const payload of [
      { outcome: "sent", operationKey: "reconcile:missing-message" },
      { outcome: "not_sent", messageId: "must-not-be-supplied", operationKey: "reconcile:not-sent" },
      { outcome: "unknown", operationKey: "reconcile:unknown" },
      { outcome: "sent", messageId: "message-a", operationKey: "reconcile:a", actorOpenId: "ou_untrusted" },
    ]) expect((await app.inject({
      method: "POST",
      url: "/internal/knowledge-conflicts/deliveries/delivery-a/reconcile",
      headers: operatorHeaders,
      payload,
    })).statusCode).toBe(400);

    harness.repository.reconcileDelivery.mockRejectedValueOnce(new KnowledgeConflictDeliveryConflictError());
    expect((await app.inject({
      method: "POST",
      url: "/internal/knowledge-conflicts/deliveries/delivery-a/reconcile",
      headers: operatorHeaders,
      payload: {
        outcome: "not_sent",
        operationKey: "reconcile:delivery-a:not-sent",
      },
    })).json()).toEqual({ ok: false, error: "knowledge_conflict_delivery_conflict" });
    await app.close();
  });

  it("maps scan lifecycle conflicts and deletion misses without exposing repository errors", async () => {
    const harness = createHarness();
    const app = await createApp(harness.repository);
    harness.repository.replayDeadLetterScan.mockRejectedValueOnce(new KnowledgeConflictLeaseConflictError());
    expect((await app.inject({
      method: "POST",
      url: "/internal/knowledge-conflicts/scans/dead-letters/scan-a/replay",
      headers: operatorHeaders,
      payload: {},
    })).json()).toEqual({ ok: false, error: "knowledge_conflict_scan_conflict" });

    harness.repository.deleteDeadLetterScan.mockResolvedValueOnce("not_found");
    const missing = await app.inject({
      method: "DELETE",
      url: "/internal/knowledge-conflicts/scans/dead-letters/missing",
      headers: operatorHeaders,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ ok: false, error: "knowledge_conflict_scan_not_found" });

    harness.repository.getCandidate.mockRejectedValueOnce(new Error("raw database credentials"));
    const unavailable = await app.inject({
      method: "GET",
      url: "/internal/knowledge-conflicts/groups/group-a/candidates/candidate-a",
      headers: authorization,
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ ok: false, error: "knowledge_conflict_runtime_unavailable" });
    expect(unavailable.body).not.toContain("raw database credentials");
    await app.close();
  });
});

async function createApp(repository: KnowledgeConflictRepository | undefined) {
  const dependencies = {
    ...disabledRuntimeFactories(),
    internalApiToken: "operator-secret",
    now: () => new Date("2026-08-15T01:00:00.000Z"),
    knowledgeConflictRuntime: repository === undefined ? undefined : { repository },
  };
  return buildApp(dependencies as BuildAppDependencies);
}

function disabledRuntimeFactories() {
  return {
    createAnswerDraftRuntime: () => undefined,
    createMemoryExtractionRuntime: () => undefined,
    createEventWorkerRuntime: () => undefined,
    createDocumentSyncRuntime: () => undefined,
    createReindexWorkerRuntime: () => undefined,
    createConversationStateInspectionRuntime: () => undefined,
    createKnowledgeDraftRuntime: () => undefined,
    createKnowledgeCardRuntime: () => undefined,
    createActionApprovalRuntime: () => undefined,
    createActionReviewRuntime: () => undefined,
    createProactiveSignalDeliveryRuntime: () => undefined,
    createProactiveSignalPlannerRuntime: () => undefined,
  };
}

function createHarness() {
  const baseCandidate = candidate();
  const repository = {
    discoverEligibleScans: vi.fn(),
    maintainNextScan: vi.fn(),
    claimNextScan: vi.fn(),
    completeScan: vi.fn(),
    failScan: vi.fn(),
    listDeadLetterScans: vi.fn(async () => [deadLetter()]),
    replayDeadLetterScan: vi.fn(async () => ({ ...deadLetter(), status: "pending" as const, attemptCount: 0 })),
    deleteDeadLetterScan: vi.fn(async (): Promise<"deleted" | "not_found"> => "deleted"),
    getScanStatusCounts: vi.fn(async () => ({
      pending: 0, processing: 0, retry: 0, completed: 5, deadLettered: 1,
    })),
    recordDetectionResult: vi.fn(),
    getCandidate: vi.fn(async () => baseCandidate),
    listCandidates: vi.fn(async () => [baseCandidate]),
    listCandidateEvents: vi.fn(async () => [{
      id: "event-a",
      candidateId: "candidate-a",
      operationKey: "operation-secret",
      actorType: "admin_role" as const,
      actorRef: "operator@example.com",
      fromStatus: "pending_review" as const,
      toStatus: "approved_for_delivery" as const,
      fromVersion: 2,
      toVersion: 3,
      reasonCode: "operator_confirmed",
      createdAt: new Date("2026-08-15T00:00:00.000Z"),
    }]),
    validateCandidateCurrentState: vi.fn(),
    dismissCandidate: vi.fn<KnowledgeConflictRepository["dismissCandidate"]>(async () => ({
      outcome: "applied" as const,
      candidate: candidate({ status: "dismissed", version: 4 }),
    })),
    approveForDelivery: vi.fn(async () => ({
      outcome: "applied" as const,
      candidate: candidate({ status: "approved_for_delivery", version: 4 }),
      delivery: delivery({ status: "pending" }),
    })),
    claimNextDelivery: vi.fn(),
    beginDeliveryAttempt: vi.fn(),
    completeDelivery: vi.fn(),
    failDelivery: vi.fn(),
    reconcileDelivery: vi.fn(async () => delivery({ status: "sent", sentMessageId: "message-sent-a" })),
    getDelivery: vi.fn(),
    getDeliveryForCandidate: vi.fn(async () => delivery({
      status: "outcome_unknown",
      attemptCount: 1,
      reconciliationDueAt: new Date("2026-08-15T02:00:00.000Z"),
      failureCode: "external_outcome_unknown",
      sentMessageId: "must-not-be-exposed",
    })),
    recordInteraction: vi.fn(),
    applyInteraction: vi.fn(),
    findCurrentOverlap: vi.fn(),
    getCandidateStatusCounts: vi.fn(async () => ({
      pending_review: 2,
      dismissed: 0,
      approved_for_delivery: 1,
      delivered: 0,
      draft_created: 0,
      superseded: 1,
    })),
    getDeliveryStatusCounts: vi.fn(async () => ({
      pending: 1,
      processing: 0,
      externalAttempting: 0,
      sent: 2,
      failed: 1,
      terminalFailed: 1,
      outcomeUnknown: 1,
      cancelled: 0,
    })),
    getInteractionResultCounts: vi.fn(async () => ({ applied: 4, alreadyApplied: 1, rejected: 1 })),
  };
  return { repository: repository as unknown as KnowledgeConflictRepository } as {
    repository: typeof repository & KnowledgeConflictRepository;
  };
}

function candidate(overrides: Partial<KnowledgeConflictCandidate> = {}): KnowledgeConflictCandidate {
  const at = new Date("2026-08-14T02:00:00.000Z");
  return {
    id: "candidate-a",
    idempotencyKey: "candidate-idempotency-secret",
    groupId: "group-a",
    groupMemoryId: "memory-a",
    memoryUpdatedAt: at,
    sourceMessageId: "message-a",
    targetDocumentSourceId: "source-a",
    targetSourceUpdatedAt: new Date("2026-08-14T01:00:00.000Z"),
    targetSourceVersion: "revision-7",
    targetSnapshotId: "snapshot-a",
    targetContentHash: "snapshot-content-hash",
    detectorContractVersion: "conflict-v1",
    status: "pending_review",
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
      { type: "conversation_message", referenceId: "C1", groupId: "group-a", conversationMessageId: "message-a" },
      { type: "group_memory", referenceId: "M1", groupId: "group-a", groupMemoryId: "memory-a", expectedUpdatedAt: at },
      { type: "document_source", referenceId: "D1", documentSourceId: "source-a", expectedUpdatedAt: new Date("2026-08-14T01:00:00.000Z") },
      { type: "document_snapshot", referenceId: "D1", documentSourceId: "source-a", documentSnapshotId: "snapshot-a", contentHash: "snapshot-content-hash" },
      { type: "document_fragment", referenceId: "D1", documentSourceId: "source-a", documentSnapshotId: "snapshot-a", documentFragmentId: "fragment-a", snapshotContentHash: "snapshot-content-hash", contentHash: "fragment-content-hash" },
    ],
    version: 3,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function deadLetter() {
  return {
    id: "scan-a",
    groupId: "group-a",
    groupMemoryId: "memory-a",
    memoryUpdatedAt: new Date("2026-08-14T00:00:00.000Z"),
    status: "dead_lettered" as const,
    attemptCount: 3,
    nextAttemptAt: new Date("2026-08-15T00:00:00.000Z"),
    lastErrorCode: "provider_unavailable",
    createdAt: new Date("2026-08-14T00:00:00.000Z"),
    updatedAt: new Date("2026-08-15T00:00:00.000Z"),
  };
}

function delivery(overrides: Record<string, unknown> = {}) {
  const at = new Date("2026-08-15T01:00:00.000Z");
  return {
    id: "delivery-a",
    candidateId: "candidate-a",
    groupId: "group-a",
    status: "pending" as const,
    retryable: true,
    attemptCount: 0,
    nextAttemptAt: at,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}
