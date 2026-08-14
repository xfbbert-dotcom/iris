import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  KnowledgeConflictDeliveryConflictError,
  KnowledgeConflictLeaseConflictError,
  KnowledgeConflictOperationConflictError,
  KnowledgeConflictStaleEvidenceError,
  KnowledgeConflictVersionConflictError,
  createPostgresKnowledgeConflictRepository,
  type PostgresKnowledgeConflictDataSource,
} from "../src/knowledge-conflicts/postgres-knowledge-conflict-repository.js";
import type {
  RecordKnowledgeConflictDetectionInput,
} from "../src/knowledge-conflicts/knowledge-conflict-repository.js";
import type {
  KnowledgeConflictEvidenceReference,
} from "../src/knowledge-conflicts/knowledge-conflict.js";
import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe.sequential : describe.skip;
const at = new Date("2026-08-13T02:00:00.000Z");
const leaseUntil = new Date("2026-08-13T02:00:30.000Z");

describe("PostgresKnowledgeConflictRepository scan lifecycle", () => {
  it("does not expose candidate or transition bypass methods", () => {
    const repository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(routedClient(() => ({ rows: [] }))),
    });

    expect(Object.keys(repository)).not.toContain("createCandidate");
    expect(Object.keys(repository)).not.toContain("transitionCandidate");
  });

  it("discovers an eligible memory and reports an existing identity without duplicating it", async () => {
    const eligible = memoryRow();
    const client = routedClient((sql) => {
      if (sql.includes("AS existing_count")) return { rows: [{ existing_count: "1" }] };
      if (sql.includes("FROM group_memories gm") && sql.includes("knowledge_conflict_scan_inbox")) {
        return { rows: [eligible] };
      }
      if (sql.includes("INSERT INTO knowledge_conflict_scan_inbox")) {
        return { rows: [{ id: "scan-1" }] };
      }
      return { rows: [] };
    });
    const repository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(client),
      createId: () => "scan-1",
    });

    await expect(repository.discoverEligibleScans({
      groupIds: ["group-1"],
      limit: 10,
      at,
    })).resolves.toEqual({ discovered: 1, existing: 0 });

    const duplicateClient = routedClient((sql) => {
      if (sql.includes("AS existing_count")) return { rows: [{ existing_count: "1" }] };
      if (sql.includes("FROM group_memories gm") && sql.includes("knowledge_conflict_scan_inbox")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const duplicateRepository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(duplicateClient),
    });
    await expect(duplicateRepository.discoverEligibleScans({
      groupIds: ["group-1"],
      limit: 10,
      at,
    })).resolves.toEqual({ discovered: 0, existing: 1 });
  });

  it("does not access Postgres when discovery has no allowlisted groups", async () => {
    const source = dataSource(routedClient(() => ({ rows: [] })));
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: source });

    await expect(repository.discoverEligibleScans({
      groupIds: [],
      limit: 10,
      at,
    })).resolves.toEqual({ discovered: 0, existing: 0 });
    expect(source.connect).not.toHaveBeenCalled();
  });

  it("claims a due scan with its exact active memory evidence and recovers an expired lease", async () => {
    const queryValues: unknown[][] = [];
    const client = routedClient((sql) => {
      if (sql.includes("WITH claimable")) {
        return { rows: [claimRow({ status: "processing", attempt_count: 2 })] };
      }
      return { rows: [] };
    });
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: dataSource(client) });

    await expect(repository.claimNextScan({
      groupIds: ["group-1"],
      workerId: "conflict-scanner-1",
      at,
      leaseUntil,
    })).resolves.toMatchObject({
      scan: {
        id: "scan-1",
        status: "processing",
        attemptCount: 2,
        leaseWorkerId: "conflict-scanner-1",
      },
      memory: {
        id: "memory-1",
        groupId: "group-1",
        evidenceMessageIds: ["message-1"],
      },
    });
    for (const call of client.query.mock.calls) queryValues.push(call[1] ?? []);
    expect(queryValues.filter((values) => values.includes("conflict-scanner-1")))
      .toEqual([[at, "conflict-scanner-1", leaseUntil, ["group-1"], 5]]);
  });

  it("bounds stale maintenance to one ordered lock-safe row", async () => {
    const client = routedClient((sql) => sql.includes("WITH maintainable")
      ? { rows: [{ ...scanRow({ status: "completed", terminal_outcome: "superseded" }),
        maintenance_outcome: "superseded" }] }
      : { rows: [] });
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: dataSource(client) });

    await expect(repository.maintainNextScan({ groupIds: ["group-1"], at }))
      .resolves.toEqual({ outcome: "superseded", scanId: "scan-1" });

    const staleMutation = client.query.mock.calls
      .map(([sql]) => String(sql).replaceAll(/\s+/gu, " ").trim())
      .find((sql) => sql.includes("WITH maintainable"));
    expect(staleMutation).toContain("LIMIT 1");
    expect(staleMutation).toContain("FOR UPDATE OF inbox SKIP LOCKED");
  });

  it("dead-letters an expired final attempt once with a stable content-free code", async () => {
    let maintenanceCalls = 0;
    const client = routedClient((sql) => {
      if (!sql.includes("WITH maintainable")) return { rows: [] };
      maintenanceCalls += 1;
      return maintenanceCalls === 1
        ? { rows: [{ ...scanRow({ status: "dead_lettered", attempt_count: 3,
          last_error_code: "scan_attempts_exhausted" }), maintenance_outcome: "dead_lettered" }] }
        : { rows: [] };
    });
    const repository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(client), maxScanAttempts: 3,
    });

    await expect(repository.maintainNextScan({ groupIds: ["group-1"], at }))
      .resolves.toEqual({ outcome: "dead_lettered", scanId: "scan-1",
        errorCode: "scan_attempts_exhausted" });
    await expect(repository.maintainNextScan({ groupIds: ["group-1"], at }))
      .resolves.toBeUndefined();

    const values = client.query.mock.calls
      .filter(([sql]) => String(sql).includes("WITH maintainable"))
      .map(([, parameters]) => parameters);
    expect(values).toEqual([[at, ["group-1"], 3], [at, ["group-1"], 3]]);
  });

  it("passes the configured attempt bound into claiming so recovery cannot exceed it", async () => {
    const client = routedClient((sql) => {
      if (sql.includes("WITH claimable")) {
        return { rows: [claimRow({ status: "processing", attempt_count: 3 })] };
      }
      return { rows: [] };
    });
    const repository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(client),
      maxScanAttempts: 3,
    });

    await repository.claimNextScan({
      groupIds: ["group-1"], workerId: "conflict-scanner-1", at, leaseUntil,
    });

    const claimCall = client.query.mock.calls.find(([sql]) => String(sql).includes("WITH claimable"));
    expect(String(claimCall?.[0])).toContain("attempt_count <");
    expect(claimCall?.[1]).toContain(3);
  });

  it("retries only for the lease owner and dead-letters permanent or exhausted failures", async () => {
    const retryClient = routedClient((sql) => {
      if (sql.includes("UPDATE knowledge_conflict_scan_inbox") && sql.includes("RETURNING status")) {
        return { rows: [{ status: "retry" }] };
      }
      return { rows: [] };
    });
    const retryRepository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(retryClient),
      maxScanAttempts: 3,
    });
    await expect(retryRepository.failScan({
      scanId: "scan-1",
      workerId: "conflict-scanner-1",
      classification: "retryable",
      errorCode: "provider_capacity",
      retryAt: new Date("2026-08-13T02:01:00.000Z"),
      at,
    })).resolves.toEqual({ status: "retry" });

    const deadLetterClient = routedClient((sql) => {
      if (sql.includes("UPDATE knowledge_conflict_scan_inbox") && sql.includes("RETURNING status")) {
        return { rows: [{ status: "dead_lettered" }] };
      }
      return { rows: [] };
    });
    const deadLetterRepository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(deadLetterClient),
      maxScanAttempts: 3,
    });
    await expect(deadLetterRepository.failScan({
      scanId: "scan-1",
      workerId: "conflict-scanner-1",
      classification: "permanent",
      errorCode: "invalid_persisted_fact",
      at,
    })).resolves.toEqual({ status: "dead_lettered" });

    const lostLeaseRepository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(routedClient(() => ({ rows: [] }))),
    });
    await expect(lostLeaseRepository.failScan({
      scanId: "scan-1",
      workerId: "wrong-worker",
      classification: "permanent",
      errorCode: "invalid_persisted_fact",
      at,
    })).rejects.toBeInstanceOf(KnowledgeConflictLeaseConflictError);
  });

  it("lists, replays, and deletes only dead-lettered scans", async () => {
    const client = routedClient((sql) => {
      if (sql.includes("FROM knowledge_conflict_scan_inbox") && sql.includes("dead_lettered")) {
        return { rows: [scanRow({ status: "dead_lettered", last_error_code: "provider_capacity" })] };
      }
      if (sql.includes("FROM knowledge_conflict_scan_inbox") && sql.includes("FOR UPDATE")) {
        return { rows: [scanRow({ status: "dead_lettered", attempt_count: 1 })] };
      }
      if (sql.includes("UPDATE knowledge_conflict_scan_inbox") && sql.includes("RETURNING")) {
        return { rows: [scanRow({ status: "pending", attempt_count: 0 })] };
      }
      if (sql.includes("DELETE FROM knowledge_conflict_scan_inbox")) {
        return { rows: [{ id: "scan-1" }] };
      }
      return { rows: [] };
    });
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: dataSource(client) });

    await expect(repository.listDeadLetterScans({ limit: 10 })).resolves.toMatchObject([
      { id: "scan-1", status: "dead_lettered", lastErrorCode: "provider_capacity" },
    ]);
    await expect(repository.replayDeadLetterScan({
      scanId: "scan-1",
      expectedAttemptCount: 1,
      expectedUpdatedAt: at,
      operationKey: "replay-scan-1-attempt-1",
      actorRef: "knowledge-admin",
      at,
    })).resolves.toMatchObject({ outcome: "applied", scanId: "scan-1", status: "pending" });
    await expect(repository.deleteDeadLetterScan({
      scanId: "scan-1",
      expectedAttemptCount: 1,
      expectedUpdatedAt: at,
      operationKey: "delete-scan-1-attempt-1",
      actorRef: "knowledge-admin",
      at,
    })).resolves.toMatchObject({ outcome: "applied", scanId: "scan-1", status: "deleted" });
  });

  it("idempotently replays one exact dead-letter generation and rejects a stale generation", async () => {
    let scan = scanRow({ status: "dead_lettered", attempt_count: 3, updated_at: at });
    const operations = new Map<string, Record<string, unknown>>();
    const client = routedClient((sql, values) => {
      if (sql.includes("FROM knowledge_conflict_scan_operations")) {
        const row = operations.get(String(values?.[0]));
        return { rows: row === undefined ? [] : [row] };
      }
      if (sql.includes("FROM knowledge_conflict_scan_inbox") && sql.includes("FOR UPDATE")) {
        return { rows: [scan] };
      }
      if (sql.includes("UPDATE knowledge_conflict_scan_inbox")) {
        scan = scanRow({ status: "pending", attempt_count: 0, updated_at: at });
        return { rows: [scan] };
      }
      if (sql.includes("INSERT INTO knowledge_conflict_scan_operations")) {
        const row = {
          operation_key: values?.[0], scan_id: values?.[1], group_id: values?.[2],
          actor_ref: values?.[3], action: values?.[4], expected_attempt_count: values?.[5],
          expected_updated_at: values?.[6], result_status: values?.[7], created_at: values?.[8],
        };
        operations.set(String(values?.[0]), row);
        return { rows: [row] };
      }
      return { rows: [] };
    });
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: dataSource(client) });
    const input = {
      scanId: "scan-1", expectedAttemptCount: 3, expectedUpdatedAt: at,
      operationKey: "replay-scan-generation-3", actorRef: "knowledge-admin", at,
    };

    await expect(repository.replayDeadLetterScan(input)).resolves.toEqual({
      outcome: "applied", scanId: "scan-1", status: "pending",
    });
    await expect(repository.replayDeadLetterScan(input)).resolves.toEqual({
      outcome: "already_applied", scanId: "scan-1", status: "pending",
    });
    await expect(repository.replayDeadLetterScan({
      ...input, operationKey: "stale-replay", expectedAttemptCount: 2,
    })).rejects.toBeInstanceOf(KnowledgeConflictLeaseConflictError);
  });
});

describe("PostgresKnowledgeConflictRepository candidate lifecycle", () => {
  it("atomically records exact candidate evidence and treats an identical replay as already applied", async () => {
    const client = candidateClient();
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: dataSource(client) });

    await expect(repository.recordDetectionResult(conflictDetectionInput())).resolves.toMatchObject({
      outcome: "applied",
      scan: { id: "scan-1", status: "completed", terminalOutcome: "conflict" },
      candidate: {
        id: "candidate-1",
        targetSourceUpdatedAt: at,
        targetSourceVersion: "revision-7",
        version: 1,
        evidence: expect.arrayContaining([
          expect.objectContaining({ type: "conversation_message", conversationMessageId: "message-1" }),
          expect.objectContaining({ type: "group_memory", groupMemoryId: "memory-1", expectedUpdatedAt: at }),
          expect.objectContaining({ type: "document_source", documentSourceId: "source-1", expectedUpdatedAt: at }),
          expect.objectContaining({ type: "document_snapshot", documentSnapshotId: "snapshot-1" }),
          expect.objectContaining({ type: "document_fragment", documentFragmentId: "fragment-1" }),
        ]),
      },
    });
    const policyLock = client.query.mock.calls.find(([sql]) =>
      sql.includes("FROM knowledge_publication_target_policies"));
    expect(policyLock?.[0]).toContain("$2 = ANY(allowed_group_ids)");
    expect(policyLock?.[0]).toContain("FOR UPDATE");
    expect(policyLock?.[1]).toEqual(["space-1", "group-1"]);

    const replayClient = candidateClient({ existingCandidate: true, completedScan: true });
    const replayRepository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(replayClient),
    });
    await expect(replayRepository.recordDetectionResult(conflictDetectionInput())).resolves
      .toMatchObject({ outcome: "already_applied", candidate: { id: "candidate-1" } });
  });

  it("rejects a reused detection identity with different content", async () => {
    const repository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(candidateClient({ existingCandidate: true, completedScan: true })),
    });

    await expect(repository.recordDetectionResult(conflictDetectionInput({
      plan: { ...conflictPlan(), difference: "A different material difference." },
    }))).rejects.toBeInstanceOf(KnowledgeConflictOperationConflictError);
  });

  it("rejects same-group message evidence that is not bound to the claimed memory", async () => {
    const client = candidateClient();
    const input = conflictDetectionInput({
      sourceMessageId: "message-2",
      evidence: conflictEvidence().map((item) => item.type === "conversation_message"
        ? { ...item, conversationMessageId: "message-2" }
        : item),
    });

    const repository = createPostgresKnowledgeConflictRepository({ dataSource: dataSource(client) });
    await expect(repository.recordDetectionResult(input))
      .rejects.toMatchObject({ reasonCode: "message_stale" });
  });

  it("rejects document snapshots that have no exact document-source evidence fact", async () => {
    const input = conflictDetectionInput({
      evidence: [
        ...conflictEvidence(),
        {
          type: "document_snapshot" as const,
          referenceId: "D2" as const,
          documentSourceId: "source-2",
          documentSnapshotId: "snapshot-2",
          contentHash: "b".repeat(64),
        },
      ],
    });
    const repository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(candidateClient()),
    });

    await expect(repository.recordDetectionResult(input))
      .rejects.toThrow("candidate document evidence is incomplete");
  });

  it("denies persistence when no enabled policy explicitly allows the source group", async () => {
    const repository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(candidateClient({ authorizedPolicy: false })),
    });

    await expect(repository.recordDetectionResult(conflictDetectionInput()))
      .rejects.toMatchObject({ reasonCode: "source_stale" });
  });

  it.each([
    ["memory", { memoryUpdatedAt: new Date("2026-08-13T01:59:59.000Z") }],
    ["source", { targetSourceUpdatedAt: new Date("2026-08-13T01:59:59.000Z") }],
    ["snapshot", { targetContentHash: "b".repeat(64) }],
  ])("rejects stale %s identity before candidate insertion", async (_label, changes) => {
    const client = candidateClient();
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: dataSource(client) });

    await expect(repository.recordDetectionResult(conflictDetectionInput(changes)))
      .rejects.toBeInstanceOf(KnowledgeConflictStaleEvidenceError);
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO knowledge_conflict_candidates"),
      expect.anything(),
    );
  });

  it("revalidates every persisted document-source evidence identity", async () => {
    const repository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(candidateClient()),
    });
    await expect(repository.recordDetectionResult(conflictDetectionInput({
      evidence: [
        ...conflictEvidence(),
        {
          type: "document_source",
          referenceId: "D2",
          documentSourceId: "source-2",
          expectedUpdatedAt: at,
        },
        {
          type: "document_snapshot",
          referenceId: "D2",
          documentSourceId: "source-2",
          documentSnapshotId: "snapshot-2",
          contentHash: "b".repeat(64),
        },
      ],
    }))).rejects.toMatchObject({
      name: "KnowledgeConflictStaleEvidenceError",
      reasonCode: "source_stale",
    });
  });

  it("completes a non-conflict scan without inserting candidate facts", async () => {
    const client = routedClient((sql) => {
      if (sql.includes("FROM knowledge_conflict_scan_inbox") && sql.includes("FOR UPDATE")) {
        return { rows: [scanRow({ status: "processing", lease_worker_id: "worker-1" })] };
      }
      if (sql.includes("UPDATE knowledge_conflict_scan_inbox")) {
        return { rows: [scanRow({ status: "completed", terminal_outcome: "no_conflict" })] };
      }
      return { rows: [] };
    });
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: dataSource(client) });

    await expect(repository.recordDetectionResult({
      scanId: "scan-1",
      workerId: "worker-1",
      result: { outcome: "no_conflict" },
      at,
    })).resolves.toMatchObject({
      outcome: "completed",
      scan: { status: "completed", terminalOutcome: "no_conflict" },
    });
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO knowledge_conflict_candidates"),
      expect.anything(),
    );
  });

  it("rejects a candidate whose memory identity does not belong to the claimed scan", async () => {
    const repository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(candidateClient()),
    });
    await expect(repository.recordDetectionResult(conflictDetectionInput({
      groupMemoryId: "memory-other",
      evidence: conflictEvidence().map((item) => item.type === "group_memory"
        ? { ...item, groupMemoryId: "memory-other" }
        : item),
    }))).rejects.toMatchObject({
      name: "KnowledgeConflictStaleEvidenceError",
      reasonCode: "scan_identity_mismatch",
    });
  });

  it("dismisses and approves exact candidate versions with one delivery intent", async () => {
    const dismissClient = transitionClient({ toStatus: "dismissed" });
    const dismissRepository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(dismissClient),
    });
    await expect(dismissRepository.dismissCandidate({
      candidateId: "candidate-1",
      expectedVersion: 1,
      operationKey: "dismiss-1",
      actorType: "admin_role",
      actorRef: "knowledge-admin",
      reasonCode: "not_current_policy",
      at,
    })).resolves.toMatchObject({
      outcome: "applied",
      candidate: { status: "dismissed", version: 2 },
    });

    const approveClient = transitionClient({ toStatus: "approved_for_delivery", delivery: true });
    const approveRepository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(approveClient),
      createId: () => "delivery-1",
    });
    await expect(approveRepository.approveForDelivery({
      candidateId: "candidate-1",
      expectedVersion: 1,
      operationKey: "approve-1",
      actorType: "admin_role",
      actorRef: "knowledge-admin",
      reasonCode: "reviewed",
      at,
    })).resolves.toMatchObject({
      outcome: "applied",
      candidate: { status: "approved_for_delivery", version: 2 },
      delivery: { id: "delivery-1", status: "pending", candidateId: "candidate-1" },
    });

    const versionClient = transitionClient({ toStatus: "dismissed", currentVersion: 2 });
    const versionRepository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(versionClient),
    });
    await expect(versionRepository.dismissCandidate({
      candidateId: "candidate-1",
      expectedVersion: 1,
      operationKey: "dismiss-stale",
      actorType: "admin_role",
      actorRef: "knowledge-admin",
      reasonCode: "stale",
      at,
    })).rejects.toBeInstanceOf(KnowledgeConflictVersionConflictError);
  });

  it("locks the candidate memory before the candidate during approval freshness validation", async () => {
    const repository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(memoryBeforeCandidateClient({ approval: true })),
    });

    await expect(repository.approveForDelivery({
      candidateId: "candidate-1",
      expectedVersion: 1,
      operationKey: "approve-memory-first",
      actorType: "admin_role",
      actorRef: "knowledge-admin",
      reasonCode: "reviewed",
      at,
    })).resolves.toMatchObject({
      outcome: "applied",
      candidate: { status: "approved_for_delivery", version: 2 },
      delivery: { status: "pending" },
    });
  });

  it("locks the candidate memory before the candidate during current-state validation", async () => {
    const repository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(memoryBeforeCandidateClient()),
    });

    await expect(repository.validateCandidateCurrentState({
      candidateId: "candidate-1",
      expectedVersion: 1,
      permissionAttestedAt: at,
      operationKey: "validate-memory-first",
      at,
    })).resolves.toMatchObject({ status: "current", candidate: { id: "candidate-1" } });
  });

  it("claims, begins, completes, fails, and reconciles one delivery lifecycle", async () => {
    const claimRepository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(routedClient((sql) => sql.includes("WITH claimable")
        ? { rows: [deliveryCandidateRow({ status: "processing", lease_worker_id: "worker-1",
          lease_until: leaseUntil, attempt_count: 1 })] }
        : { rows: [] })),
    });
    await expect(claimRepository.claimNextDelivery({ workerId: "worker-1", at, leaseUntil }))
      .resolves.toMatchObject({
        delivery: { id: "delivery-1", status: "processing", attemptCount: 1 },
        candidate: { id: "candidate-1", status: "approved_for_delivery" },
      });

    const beginRepository = repositoryForDeliveryMutation(deliveryRow({
      status: "external_attempting", lease_worker_id: "worker-1", lease_until: leaseUntil,
      external_attempt_started_at: at,
    }));
    await expect(beginRepository.beginDeliveryAttempt({
      deliveryId: "delivery-1", workerId: "worker-1", at,
    })).resolves.toMatchObject({ status: "external_attempting" });

    const completeClient = routedClient((sql) => {
      if (sql === "SELECT candidate_id FROM knowledge_conflict_delivery_outbox WHERE id = $1") {
        return { rows: [{ candidate_id: "candidate-1" }] };
      }
      if (sql.includes("FROM knowledge_conflict_delivery_outbox") && sql.includes("FOR UPDATE")) {
        return { rows: [deliveryRow({ status: "external_attempting", lease_worker_id: "worker-1",
          lease_until: leaseUntil, external_attempt_started_at: at })] };
      }
      if (sql.includes("FROM knowledge_conflict_candidates") && sql.includes("FOR UPDATE")) {
        return { rows: [candidateRow({ status: "approved_for_delivery", version: 2 })] };
      }
      if (sql.includes("UPDATE knowledge_conflict_candidates")) {
        return { rows: [candidateRow({ status: "delivered", version: 3 })] };
      }
      if (sql.includes("UPDATE knowledge_conflict_delivery_outbox")) {
        return { rows: [deliveryRow({ status: "sent", sent_message_id: "om-1" })] };
      }
      return { rows: [] };
    });
    const completeRepository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(completeClient),
    });
    await expect(completeRepository.completeDelivery({
      deliveryId: "delivery-1", workerId: "worker-1", messageId: "om-1", at,
    })).resolves.toMatchObject({
      delivery: { status: "sent", sentMessageId: "om-1" },
      candidate: { status: "delivered", version: 3 },
    });

    const unknownRepository = repositoryForDeliveryMutation(deliveryRow({
      status: "outcome_unknown", reconciliation_due_at: leaseUntil,
    }));
    await expect(unknownRepository.failDelivery({
      deliveryId: "delivery-1",
      workerId: "worker-1",
      classification: "outcome_unknown",
      errorCode: "timeout",
      reconciliationDueAt: leaseUntil,
      at,
    })).resolves.toMatchObject({ status: "outcome_unknown" });

    const permanentRepository = repositoryForDeliveryMutation(deliveryRow({
      status: "failed", failure_code: "remote_rejected", retryable: false,
    }));
    await expect(permanentRepository.failDelivery({
      deliveryId: "delivery-1",
      workerId: "worker-1",
      classification: "permanent",
      errorCode: "remote_rejected",
      at,
    })).resolves.toMatchObject({ status: "failed", retryable: false });

    const reconcileRepository = repositoryForDeliveryMutation(deliveryRow({
      status: "failed", failure_code: "reconciled_not_sent",
    }));
    await expect(reconcileRepository.reconcileDelivery({
      deliveryId: "delivery-1",
      outcome: "not_sent",
      operationKey: "reconcile-1",
      expectedAttemptCount: 1,
      actorRef: "knowledge-admin",
      at,
    })).resolves.toMatchObject({ status: "failed", failureCode: "reconciled_not_sent" });
  });

  it("locks the candidate before the delivery for completion and reconciliation", async () => {
    const completeOrder: string[] = [];
    const completeClient = routedClient((sql) => {
      if (sql === "SELECT candidate_id FROM knowledge_conflict_delivery_outbox WHERE id = $1") {
        completeOrder.push("identity");
        return { rows: [{ candidate_id: "candidate-1" }] };
      }
      if (sql.includes("FROM knowledge_conflict_candidates") && sql.includes("FOR UPDATE")) {
        completeOrder.push("candidate");
        return { rows: [candidateRow({ status: "approved_for_delivery", version: 2 })] };
      }
      if (sql.includes("FROM knowledge_conflict_delivery_outbox") && sql.includes("FOR UPDATE")) {
        completeOrder.push("delivery");
        return { rows: [deliveryRow({ status: "external_attempting", attempt_count: 1,
          lease_worker_id: "worker-1" })] };
      }
      if (sql.includes("FROM knowledge_conflict_evidence")) return { rows: evidenceRows() };
      if (sql.includes("UPDATE knowledge_conflict_candidates")) {
        return { rows: [candidateRow({ status: "delivered", version: 3 })] };
      }
      if (sql.includes("UPDATE knowledge_conflict_delivery_outbox")) {
        return { rows: [deliveryRow({ status: "sent", attempt_count: 1,
          sent_message_id: "om-1" })] };
      }
      return { rows: [] };
    });
    const completeRepository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(completeClient),
    });
    await completeRepository.completeDelivery({
      deliveryId: "delivery-1", workerId: "worker-1", messageId: "om-1", at,
    });
    expect(completeOrder).toEqual(["identity", "candidate", "delivery"]);

    const reconcileOrder: string[] = [];
    const reconcileClient = routedClient((sql) => {
      if (sql.includes("FROM knowledge_conflict_delivery_reconciliations")) return { rows: [] };
      if (sql === "SELECT candidate_id FROM knowledge_conflict_delivery_outbox WHERE id = $1") {
        reconcileOrder.push("identity");
        return { rows: [{ candidate_id: "candidate-1" }] };
      }
      if (sql.includes("FROM knowledge_conflict_candidates") && sql.includes("FOR UPDATE")) {
        reconcileOrder.push("candidate");
        return { rows: [candidateRow({ status: "approved_for_delivery", version: 2 })] };
      }
      if (sql.includes("FROM knowledge_conflict_delivery_outbox") && sql.includes("FOR UPDATE")) {
        reconcileOrder.push("delivery");
        return { rows: [deliveryRow({ status: "outcome_unknown", attempt_count: 1 })] };
      }
      if (sql.includes("UPDATE knowledge_conflict_delivery_outbox")) {
        return { rows: [deliveryRow({ status: "failed", attempt_count: 1,
          failure_code: "reconciled_not_sent" })] };
      }
      return { rows: [] };
    });
    const reconcileRepository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(reconcileClient),
    });
    await reconcileRepository.reconcileDelivery({
      deliveryId: "delivery-1", outcome: "not_sent", operationKey: "reconcile-order",
      expectedAttemptCount: 1, actorRef: "knowledge-admin", at,
    });
    expect(reconcileOrder).toEqual(["identity", "candidate", "delivery"]);
  });

  it("rejects reconciliation from a stale delivery attempt before mutating the current attempt", async () => {
    const delivery = deliveryRow({
      status: "outcome_unknown", attempt_count: 2, reconciliation_due_at: leaseUntil,
    });
    const client = routedClient((sql) => {
      if (sql.includes("FROM knowledge_conflict_delivery_reconciliations")) return { rows: [] };
      if (sql === "SELECT candidate_id FROM knowledge_conflict_delivery_outbox WHERE id = $1") {
        return { rows: [{ candidate_id: "candidate-1" }] };
      }
      if (sql.includes("FROM knowledge_conflict_candidates") && sql.includes("FOR UPDATE")) {
        return { rows: [candidateRow({ status: "approved_for_delivery", version: 2 })] };
      }
      if (sql.includes("FROM knowledge_conflict_delivery_outbox") && sql.includes("FOR UPDATE")) {
        return { rows: [delivery] };
      }
      if (sql.includes("UPDATE knowledge_conflict_delivery_outbox")) {
        return { rows: [deliveryRow({ status: "failed", attempt_count: 2 })] };
      }
      return { rows: [] };
    });
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: dataSource(client) });

    await expect(repository.reconcileDelivery({
      deliveryId: "delivery-1", outcome: "not_sent", operationKey: "stale-attempt-1",
      expectedAttemptCount: 1, actorRef: "knowledge-admin", at,
    })).rejects.toBeInstanceOf(KnowledgeConflictDeliveryConflictError);
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO knowledge_conflict_delivery_reconciliations"),
      expect.anything(),
    );
  });

  it("reconciles a second unknown external attempt after the first was confirmed not sent", async () => {
    const state = {
      delivery: deliveryRow({
        status: "outcome_unknown",
        attempt_count: 1,
        reconciliation_due_at: leaseUntil,
      }),
      candidate: candidateRow({ status: "approved_for_delivery", version: 2 }),
      reconciliations: new Map<string, Record<string, unknown>>(),
    };
    const client = routedClient((sql, values) => {
      if (sql.includes("FROM knowledge_conflict_delivery_reconciliations")) {
        return { rows: state.reconciliations.has(String(values?.[0]))
          ? [state.reconciliations.get(String(values?.[0]))!] : [] };
      }
      if (sql.includes("INSERT INTO knowledge_conflict_delivery_reconciliations")) {
        const row = {
          operation_key: String(values?.[0]),
          delivery_id: String(values?.[1]),
          attempt_count: Number(values?.[2]),
          outcome: String(values?.[3]),
          sent_message_id: values?.[4] ?? null,
          actor_ref: values?.[5],
        };
        state.reconciliations.set(row.operation_key, row);
        return { rows: [row] };
      }
      if (sql.includes("WITH claimable")) {
        state.delivery = deliveryRow({ status: "processing", attempt_count: 2,
          lease_worker_id: "worker-2", lease_until: leaseUntil });
        return { rows: [deliveryCandidateRow(state.delivery)] };
      }
      if (sql === "SELECT candidate_id FROM knowledge_conflict_delivery_outbox WHERE id = $1") {
        return { rows: [{ candidate_id: state.delivery.candidate_id }] };
      }
      if (sql.includes("FROM knowledge_conflict_delivery_outbox") && sql.includes("FOR UPDATE")) {
        return { rows: [state.delivery] };
      }
      if (sql.includes("UPDATE knowledge_conflict_delivery_outbox")) {
        if (sql.includes("reconciled_not_sent")) {
          state.delivery = deliveryRow({ status: "failed", attempt_count: 1,
            reconciliation_operation_key: "reconcile-not-sent",
            reconciliation_outcome: "not_sent", reconciled_at: at,
            failure_code: "reconciled_not_sent" });
        } else if (sql.includes("status = 'sent'")) {
          state.delivery = deliveryRow({ status: "sent", attempt_count: 2,
            reconciliation_operation_key: "reconcile-sent",
            reconciliation_outcome: "sent", reconciled_at: at,
            sent_message_id: "om-second" });
        } else if (sql.includes("CASE WHEN $3 = 'outcome_unknown'")) {
          state.delivery = deliveryRow({ status: "outcome_unknown", attempt_count: 2,
            reconciliation_due_at: leaseUntil });
        } else if (sql.includes("external_attempting")) {
          state.delivery = deliveryRow({ status: "external_attempting", attempt_count: 2,
            lease_worker_id: "worker-2", lease_until: leaseUntil,
            external_attempt_started_at: at });
        }
        return { rows: [state.delivery] };
      }
      if (sql.includes("FROM knowledge_conflict_candidates") && sql.includes("FOR UPDATE")) {
        return { rows: [state.candidate] };
      }
      if (sql.includes("UPDATE knowledge_conflict_candidates")) {
        state.candidate = candidateRow({ status: "delivered", version: 3 });
        return { rows: [state.candidate] };
      }
      return { rows: [] };
    });
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: dataSource(client) });

    await expect(repository.reconcileDelivery({
      deliveryId: "delivery-1", outcome: "not_sent",
      operationKey: "reconcile-not-sent", expectedAttemptCount: 1,
      actorRef: "knowledge-admin", at,
    })).resolves.toMatchObject({ status: "failed" });
    await repository.claimNextDelivery({ workerId: "worker-2", at, leaseUntil });
    await repository.beginDeliveryAttempt({ deliveryId: "delivery-1", workerId: "worker-2", at });
    await repository.failDelivery({
      deliveryId: "delivery-1", workerId: "worker-2", classification: "outcome_unknown",
      errorCode: "timeout_again", reconciliationDueAt: leaseUntil, at,
    });
    await expect(repository.reconcileDelivery({
      deliveryId: "delivery-1", outcome: "sent", operationKey: "reconcile-sent",
      expectedAttemptCount: 2, actorRef: "knowledge-admin", messageId: "om-second", at,
    })).resolves.toMatchObject({ status: "sent", sentMessageId: "om-second" });
  });

  it("deduplicates exact interactions and rejects changed intent under the same callback key", async () => {
    const exact = interactionRow();
    const repository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(routedClient((sql) => {
        if (sql.includes("FROM knowledge_conflict_interactions")) return { rows: [exact] };
        return { rows: [] };
      })),
    });
    await expect(repository.recordInteraction(interactionInput())).resolves.toMatchObject({
      outcome: "already_applied",
      interaction: { id: "interaction-1", action: "dismiss", result: "applied" },
    });
    await expect(repository.recordInteraction({
      ...interactionInput(), action: "create_draft", result: "rejected",
    }))
      .rejects.toBeInstanceOf(KnowledgeConflictOperationConflictError);
  });

  it("atomically applies a member interaction with its candidate transition", async () => {
    const client = transitionClient({ toStatus: "dismissed" });
    const repository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(client),
      createId: () => "interaction-1",
    });
    await expect(repository.applyInteraction({
      id: "interaction-1",
      candidateId: "candidate-1",
      expectedVersion: 1,
      callbackOperationKey: "callback-atomic-1",
      actorRef: "ou-member",
      action: "dismiss",
      reasonCode: "not_a_conflict",
      permissionAttestedAt: at,
      at,
    })).resolves.toMatchObject({
      outcome: "applied",
      interaction: { action: "dismiss", result: "applied" },
      candidate: { status: "dismissed", version: 2 },
    });
  });

  it("returns current overlap only for exact memory and source/snapshot identities", async () => {
    const repository = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(routedClient((sql) => {
        if (sql.includes("FROM knowledge_conflict_candidates candidate")) {
          return { rows: [candidateRow()] };
        }
        if (sql.includes("FROM knowledge_conflict_evidence")) return { rows: evidenceRows() };
        if (sql.includes("SELECT id FROM group_memories")) return { rows: [{ id: "memory-1" }] };
        if (sql.includes("SELECT message.id FROM conversation_messages")) {
          return { rows: [{ id: "message-1" }] };
        }
        if (sql.includes("FROM knowledge_publication_target_policies")) {
          return { rows: [{ id: "policy-1" }] };
        }
        if (sql.includes("FROM document_sources")) return { rows: [sourceRow()] };
        if (sql.includes("FROM document_snapshots")) return { rows: [snapshotRow()] };
        if (sql.includes("FROM document_fragments")) {
          return { rows: [{ id: "fragment-1", document_source_id: "source-1",
            document_snapshot_id: "snapshot-1", content_hash: "c".repeat(64) }] };
        }
        return { rows: [] };
      })),
    });
    await expect(repository.findCurrentOverlap({
      groupId: "group-1",
      groupMemoryIds: ["memory-1"],
      documents: [{ sourceId: "source-1", snapshotId: "snapshot-1" }],
      permissionAttestedAt: at,
      at,
    })).resolves.toMatchObject({ id: "candidate-1" });

    const none = createPostgresKnowledgeConflictRepository({
      dataSource: dataSource(routedClient(() => ({ rows: [] }))),
    });
    await expect(none.findCurrentOverlap({
      groupId: "group-1",
      groupMemoryIds: ["other-memory"],
      documents: [{ sourceId: "source-1", snapshotId: "snapshot-1" }],
      permissionAttestedAt: at,
      at,
    })).resolves.toBeUndefined();
  });

  it("reads overlap candidate and all exact evidence in one transaction", async () => {
    const client = routedClient((sql) => {
      if (sql.includes("FROM knowledge_conflict_candidates")) return { rows: [candidateRow()] };
      if (sql.includes("FROM knowledge_conflict_evidence")) return { rows: evidenceRows() };
      if (sql.includes("SELECT id FROM group_memories")) return { rows: [{ id: "memory-1" }] };
      if (sql.includes("SELECT message.id FROM conversation_messages")) {
        return { rows: [{ id: "message-1" }] };
      }
      if (sql.includes("FROM knowledge_publication_target_policies")) {
        return { rows: [{ id: "policy-1" }] };
      }
      if (sql.includes("FROM document_sources")) return { rows: [sourceRow()] };
      if (sql.includes("FROM document_snapshots")) return { rows: [snapshotRow()] };
      if (sql.includes("FROM document_fragments")) {
        return { rows: [{ id: "fragment-1", document_source_id: "source-1",
          document_snapshot_id: "snapshot-1", content_hash: "c".repeat(64) }] };
      }
      return { rows: [] };
    });
    const source = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => { throw new Error("overlap escaped its transaction"); }),
    } as unknown as PostgresKnowledgeConflictDataSource;
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: source });

    await expect(repository.findCurrentOverlap({
      groupId: "group-1",
      groupMemoryIds: ["memory-1"],
      documents: [{ sourceId: "source-1", snapshotId: "snapshot-1" }],
      permissionAttestedAt: at,
      at,
    })).resolves.toMatchObject({ id: "candidate-1" });
    expect(source.connect).toHaveBeenCalledOnce();
  });

  it("denies overlap when no enabled policy explicitly allows the source group", async () => {
    const client = routedClient((sql) => {
      if (sql.includes("FROM knowledge_conflict_candidates")) return { rows: [candidateRow()] };
      if (sql.includes("FROM knowledge_conflict_evidence")) return { rows: evidenceRows() };
      if (sql.includes("SELECT id FROM group_memories")) return { rows: [{ id: "memory-1" }] };
      if (sql.includes("SELECT message.id FROM conversation_messages")) {
        return { rows: [{ id: "message-1" }] };
      }
      if (sql.includes("FROM knowledge_publication_target_policies")) return { rows: [] };
      if (sql.includes("FROM document_sources")) return { rows: [sourceRow()] };
      if (sql.includes("FROM document_snapshots")) return { rows: [snapshotRow()] };
      if (sql.includes("FROM document_fragments")) {
        return { rows: [{ id: "fragment-1", document_source_id: "source-1",
          document_snapshot_id: "snapshot-1", content_hash: "c".repeat(64) }] };
      }
      return { rows: [] };
    });
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: dataSource(client) });

    await expect(repository.findCurrentOverlap({
      groupId: "group-1",
      groupMemoryIds: ["memory-1"],
      documents: [{ sourceId: "source-1", snapshotId: "snapshot-1" }],
      permissionAttestedAt: at,
      at,
    })).resolves.toBeUndefined();
  });

  it("locks overlap memories before candidate rows", async () => {
    let memoryLocked = false;
    const client = routedClient((sql) => {
      if (sql.includes("FROM group_memories") && sql.includes("FOR UPDATE")) {
        memoryLocked = true;
        return { rows: [{ id: "memory-1" }] };
      }
      if (sql.includes("FROM knowledge_conflict_candidates")) {
        if (!memoryLocked) throw new Error("candidate locked before memory");
        return { rows: [candidateRow()] };
      }
      if (sql.includes("FROM knowledge_conflict_evidence")) return { rows: evidenceRows() };
      if (sql.includes("SELECT message.id FROM conversation_messages")) {
        return { rows: [{ id: "message-1" }] };
      }
      if (sql.includes("FROM knowledge_publication_target_policies")) {
        return { rows: [{ id: "policy-1" }] };
      }
      if (sql.includes("FROM document_sources")) return { rows: [sourceRow()] };
      if (sql.includes("FROM document_snapshots")) return { rows: [snapshotRow()] };
      if (sql.includes("FROM document_fragments")) {
        return { rows: [{ id: "fragment-1", document_source_id: "source-1",
          document_snapshot_id: "snapshot-1", content_hash: "c".repeat(64) }] };
      }
      return { rows: [] };
    });
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: dataSource(client) });

    await expect(repository.findCurrentOverlap({
      groupId: "group-1",
      groupMemoryIds: ["memory-1"],
      documents: [{ sourceId: "source-1", snapshotId: "snapshot-1" }],
      permissionAttestedAt: at,
      at,
    })).resolves.toMatchObject({ id: "candidate-1" });
  });

  it("supersedes a candidate when the current snapshot hash no longer matches", async () => {
    const client = routedClient((sql) => {
      if (sql.includes("FROM knowledge_conflict_candidates") && sql.includes("FOR UPDATE")) {
        return { rows: [candidateRow({ status: "pending_review", version: 1 })] };
      }
      if (sql.includes("FROM knowledge_conflict_candidates")) {
        return { rows: [candidateRow({ status: "pending_review", version: 1 })] };
      }
      if (sql.includes("FROM knowledge_conflict_evidence")) return { rows: evidenceRows() };
      if (sql.includes("SELECT id FROM group_memories")) return { rows: [{ id: "memory-1" }] };
      if (sql.includes("SELECT message.id FROM conversation_messages")) {
        return { rows: [{ id: "message-1" }] };
      }
      if (sql.includes("FROM knowledge_publication_target_policies")) {
        return { rows: [{ id: "policy-1" }] };
      }
      if (sql.includes("FROM document_sources")) return { rows: [sourceRow()] };
      if (sql.includes("FROM document_snapshots")) {
        return { rows: [snapshotRow({ content_hash: "b".repeat(64) })] };
      }
      if (sql.includes("FROM document_fragments")) {
        return { rows: [{ id: "fragment-1", document_source_id: "source-1",
          document_snapshot_id: "snapshot-1", content_hash: "c".repeat(64) }] };
      }
      if (sql.includes("UPDATE knowledge_conflict_candidates")) {
        return { rows: [candidateRow({ status: "superseded", version: 2 })] };
      }
      return { rows: [] };
    });
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: dataSource(client) });
    await expect(repository.validateCandidateCurrentState({
      candidateId: "candidate-1",
      expectedVersion: 1,
      permissionAttestedAt: at,
      operationKey: "supersede-hash-change",
      at,
    })).resolves.toMatchObject({
      status: "superseded",
      reasonCode: "snapshot_stale",
      candidate: { status: "superseded", version: 2 },
    });
  });

  it("keeps a stale candidate reconcilable while its external delivery outcome is unresolved", async () => {
    const client = routedClient((sql) => {
      if (sql.includes("FROM knowledge_conflict_candidates") && sql.includes("FOR UPDATE")) {
        return { rows: [candidateRow({ status: "approved_for_delivery", version: 2 })] };
      }
      if (sql.includes("FROM knowledge_conflict_candidates")) {
        return { rows: [candidateRow({ status: "approved_for_delivery", version: 2 })] };
      }
      if (sql.includes("FROM knowledge_conflict_evidence")) return { rows: evidenceRows() };
      if (sql.includes("SELECT id FROM group_memories")) return { rows: [{ id: "memory-1" }] };
      if (sql.includes("SELECT message.id FROM conversation_messages")) {
        return { rows: [{ id: "message-1" }] };
      }
      if (sql.includes("FROM document_sources")) {
        return { rows: [sourceRow({ updated_at: new Date(at.getTime() + 1) })] };
      }
      if (sql.includes("FROM knowledge_conflict_delivery_outbox") && sql.includes("FOR UPDATE")) {
        return { rows: [deliveryRow({ status: "outcome_unknown",
          reconciliation_due_at: leaseUntil })] };
      }
      if (sql.includes("UPDATE knowledge_conflict_candidates")) {
        return { rows: [candidateRow({ status: "superseded", version: 3 })] };
      }
      return { rows: [] };
    });
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: dataSource(client) });

    await expect(repository.validateCandidateCurrentState({
      candidateId: "candidate-1", expectedVersion: 2, permissionAttestedAt: at,
      operationKey: "validate-unresolved-delivery", at,
    })).rejects.toBeInstanceOf(KnowledgeConflictDeliveryConflictError);
  });

  it("does not supersede a candidate while an external delivery outcome is unresolved", async () => {
    const client = routedClient((sql) => {
      if (sql.includes("FROM knowledge_conflict_scan_inbox") && sql.includes("FOR UPDATE")) {
        return { rows: [scanRow({ status: "processing", lease_worker_id: "worker-1" })] };
      }
      if (sql.includes("WHERE idempotency_key = $1")) return { rows: [] };
      if (sql.includes("FROM group_memories") && sql.includes("FOR UPDATE")) {
        return { rows: [memoryRow()] };
      }
      if (sql.includes("FROM conversation_messages")) {
        return { rows: [{ id: "message-1", chat_id: "group-1" }] };
      }
      if (sql.includes("FROM document_sources") && sql.includes("FOR UPDATE")) {
        return { rows: [sourceRow()] };
      }
      if (sql.includes("FROM knowledge_publication_target_policies")) {
        return { rows: [{ id: "policy-1" }] };
      }
      if (sql.includes("FROM document_snapshots") && sql.includes("FOR UPDATE")) {
        return { rows: [snapshotRow()] };
      }
      if (sql.includes("FROM document_fragments")) {
        return { rows: [{ id: "fragment-1", document_source_id: "source-1",
          document_snapshot_id: "snapshot-1", content_hash: "c".repeat(64) }] };
      }
      if (sql.includes("WHERE group_memory_id = $1")) {
        return { rows: [candidateRow({ id: "candidate-old", idempotency_key: "candidate-old-op",
          status: "approved_for_delivery", version: 2 })] };
      }
      if (sql.includes("FROM knowledge_conflict_delivery_outbox") && sql.includes("FOR UPDATE")) {
        return { rows: [deliveryRow({ id: "delivery-old", candidate_id: "candidate-old",
          status: "external_attempting", lease_worker_id: "delivery-worker",
          lease_until: leaseUntil, external_attempt_started_at: at })] };
      }
      if (sql.includes("UPDATE knowledge_conflict_candidates")) {
        return { rows: [candidateRow({ id: "candidate-old", status: "superseded", version: 3 })] };
      }
      if (sql.includes("INSERT INTO knowledge_conflict_candidates")) return { rows: [candidateRow()] };
      if (sql.includes("UPDATE knowledge_conflict_scan_inbox")) {
        return { rows: [scanRow({ status: "completed", terminal_outcome: "conflict" })] };
      }
      return { rows: [] };
    });
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: dataSource(client) });
    await expect(repository.recordDetectionResult(conflictDetectionInput()))
      .rejects.toBeInstanceOf(KnowledgeConflictDeliveryConflictError);
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO knowledge_conflict_candidates"),
      expect.anything(),
    );
  });
});

runIfDatabase("PostgresKnowledgeConflictRepository scan behavior with Postgres", () => {
  let pool: pg.Pool | undefined;
  let adminPool: pg.Pool | undefined;
  const suffix = randomUUID();
  const schema = `knowledge_conflict_repository_${suffix.replaceAll("-", "")}`;
  const groupId = `conflict-group-${suffix}`;
  const otherGroupId = `conflict-other-${suffix}`;
  const messageIds = Array.from({ length: 10 }, (_, index) => `feishu:conflict-${index}-${suffix}`);
  const memoryIds = Array.from({ length: 10 }, (_, index) => `conflict-memory-${index}-${suffix}`);
  const sourceId = `conflict-source-${suffix}`;
  const snapshotId = `conflict-snapshot-${suffix}`;
  const fragmentId = `conflict-fragment-${suffix}`;
  const secondarySourceId = `conflict-source-secondary-${suffix}`;
  const secondarySnapshotId = `conflict-snapshot-secondary-${suffix}`;
  const secondaryFragmentId = `conflict-fragment-secondary-${suffix}`;
  const authorizedSpaceId = `conflict-space-${suffix}`;
  const targetPolicyId = `conflict-policy-${suffix}`;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: databaseUrl });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    const client = await pool.connect();
    try {
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally {
      client.release();
    }
    for (let index = 0; index < messageIds.length; index += 1) {
      await insertMessage(pool, messageIds[index]!, index === 8 ? otherGroupId : groupId);
    }
    const fixtures = [
      [0, "group", "decision", 4, 0.9, "active", true],
      [1, "group", "summary", 4, 0.9, "active", true],
      [2, "thread", "decision", 4, 0.9, "active", true],
      [3, "group", "decision", 2, 0.9, "active", true],
      [4, "group", "decision", 4, 0.79, "active", true],
      [5, "group", "decision", 4, 0.9, "active", false],
      [6, "group", "workflow", 4, 0.9, "superseded", true],
      [7, "group", "term", 3, 0.8, "active", true],
      [8, "group", "decision", 4, 0.9, "active", true],
    ] as const;
    for (const [index, scope, category, importance, confidence, status, withEvidence] of fixtures) {
      const fixtureGroup = index === 8 ? otherGroupId : groupId;
      await pool.query(
        `INSERT INTO group_memories (
          id, group_id, memory_scope, category, thread_key, content, importance,
          confidence, status, idempotency_key, origin, created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'operator', 'tester', $11, $11)`,
        [memoryIds[index], fixtureGroup, scope, category, scope === "thread" ? `thread-${suffix}` : null,
          `memory ${index}`, importance, confidence, status, `memory-op-${index}-${suffix}`, at],
      );
      if (withEvidence) {
        await pool.query(
          `INSERT INTO group_memory_message_evidence (memory_id, conversation_message_id)
           VALUES ($1, $2)`,
          [memoryIds[index], messageIds[index]],
        );
      }
    }
    await pool.query(
      `INSERT INTO knowledge_publication_target_policies (
         id, space_id, display_name, allowed_group_ids, allowed_risk_levels,
         enabled, operation_key, operation_fingerprint, created_by, updated_by,
         created_at, updated_at
       ) VALUES ($1, $2, 'Conflict test policy', ARRAY[$3]::text[],
         ARRAY['medium']::text[], TRUE, $4, $5, 'tester', 'tester', $6, $6)`,
      [targetPolicyId, authorizedSpaceId, groupId, `conflict-policy-operation-${suffix}`,
        "f".repeat(64), at],
    );
    await pool.query(
      `INSERT INTO document_sources (
         id, source_type, source_uri, authorized_space_id, permission_state, sync_state,
         can_use_for_answering, can_use_for_knowledge_drafts, created_at, updated_at
       ) VALUES
         ($1, 'authorized_wiki_document', $2, $3, 'readable', 'synced', TRUE, TRUE, $4, $4),
         ($5, 'authorized_wiki_document', $6, $3, 'readable', 'synced', TRUE, TRUE, $4, $4)`,
      [sourceId, `https://example.com/wiki/${suffix}`, authorizedSpaceId, at,
        secondarySourceId, `https://example.com/wiki/secondary-${suffix}`],
    );
    await pool.query(
      `INSERT INTO document_snapshots (
         id, document_source_id, source_uri, fetch_status, body_text, content_hash,
         source_version, fetched_at, created_at
       ) VALUES ($1, $2, $3, 'succeeded', 'CNY 5,000', $4, 'revision-7', $5, $5)`,
      [snapshotId, sourceId, `https://example.com/wiki/${suffix}`, "a".repeat(64),
        new Date("2026-08-13T01:00:00.000Z")],
    );
    await pool.query(
      `INSERT INTO document_snapshots (
         id, document_source_id, source_uri, fetch_status, body_text, content_hash,
         source_version, fetched_at, created_at
       ) VALUES ($1, $2, $3, 'succeeded', 'CNY 6,000', $4, 'revision-3', $5, $5)`,
      [secondarySnapshotId, secondarySourceId,
        `https://example.com/wiki/secondary-${suffix}`, "b".repeat(64),
        new Date("2026-08-13T01:00:00.000Z")],
    );
    await pool.query(
      `INSERT INTO document_fragments (
         id, document_source_id, document_snapshot_id, source_uri, chunk_index,
         text, content_hash, embedding, created_at, embedding_profile_id
       ) VALUES ($1, $2, $3, $4, 0, 'CNY 5,000', $5,
         '[0,0,0,0,0,0]', $6, 'static-dev-6d')`,
      [fragmentId, sourceId, snapshotId, `https://example.com/wiki/${suffix}`,
        "c".repeat(64), at],
    );
    await pool.query(
      `INSERT INTO document_fragments (
         id, document_source_id, document_snapshot_id, source_uri, chunk_index,
         text, content_hash, embedding, created_at, embedding_profile_id
       ) VALUES ($1, $2, $3, $4, 0, 'CNY 6,000', $5,
         '[0,0,0,0,0,0]', $6, 'static-dev-6d')`,
      [secondaryFragmentId, secondarySourceId, secondarySnapshotId,
        `https://example.com/wiki/secondary-${suffix}`, "d".repeat(64), at],
    );
  });

  afterAll(async () => {
    if (pool === undefined || adminPool === undefined) return;
    try {
      await pool.end();
      pool = undefined;
      await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await adminPool.end();
    }
  });

  async function insertDetectionFixture(label: string, memoryUpdatedAt = at) {
    const memoryId = `${label}-memory-${suffix}`;
    const messageId = `feishu:${label}-message-${suffix}`;
    const scanId = `${label}-scan-${suffix}`;
    const candidateId = `${label}-candidate-${suffix}`;
    const workerId = `${label}-worker`;
    await insertMessage(pool!, messageId, groupId);
    await pool!.query(
      `INSERT INTO group_memories (
         id, group_id, memory_scope, category, content, importance, confidence,
         status, idempotency_key, origin, created_by, created_at, updated_at
       ) VALUES ($1, $2, 'group', 'decision', 'CNY 10,000', 5, 0.95,
         'active', $3, 'operator', 'tester', $4, $4)`,
      [memoryId, groupId, `${label}-memory-operation-${suffix}`, memoryUpdatedAt],
    );
    await pool!.query(
      `INSERT INTO group_memory_message_evidence (memory_id, conversation_message_id)
       VALUES ($1, $2)`,
      [memoryId, messageId],
    );
    await pool!.query(
      `INSERT INTO knowledge_conflict_scan_inbox (
         id, group_id, group_memory_id, memory_updated_at, status, attempt_count,
         next_attempt_at, lease_worker_id, lease_until, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'processing', 1, $4, $5, $6, $4, $4)`,
      [scanId, groupId, memoryId, memoryUpdatedAt, workerId,
        new Date(memoryUpdatedAt.getTime() + 30_000)],
    );
    return {
      memoryId,
      messageId,
      scanId,
      candidateId,
      workerId,
      input: integrationDetectionInput({
        scanId,
        candidateId,
        workerId,
        groupId,
        memoryId,
        messageId,
        memoryUpdatedAt,
        operationKey: `${label}-candidate-operation-${suffix}`,
        sourceId,
        snapshotId,
        fragmentId,
      }),
    };
  }

  async function runOverlapAgainstCandidateOperation(
    label: string,
    startOperation: (
      repository: ReturnType<typeof createPostgresKnowledgeConflictRepository>,
      candidateId: string,
    ) => Promise<unknown>,
  ) {
    const fixture = await insertDetectionFixture(label);
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: pool! });
    await repository.recordDetectionResult(fixture.input);

    const candidateLocked = deferred<void>();
    const releaseCandidate = deferred<void>();
    let operationPaused = false;
    const operationRepository = createPostgresKnowledgeConflictRepository({
      dataSource: instrumentedDataSource(pool!, async (sql, execute) => {
        const result = await execute();
        if (!operationPaused
          && sql.includes("FROM knowledge_conflict_candidates")
          && sql.includes("FOR UPDATE")) {
          operationPaused = true;
          candidateLocked.resolve();
          await releaseCandidate.promise;
        }
        return result;
      }),
    });
    const overlapMemoryQueryStarted = deferred<void>();
    const overlapPid = deferred<number>();
    let overlapStarted = false;
    const overlapRepository = createPostgresKnowledgeConflictRepository({
      dataSource: instrumentedDataSource(
        pool!,
        async (sql, execute) => {
          if (!overlapStarted
            && sql.includes("FROM group_memories")
            && sql.includes("FOR UPDATE")) {
            overlapStarted = true;
            overlapMemoryQueryStarted.resolve();
          }
          return execute();
        },
        (pid) => overlapPid.resolve(pid),
      ),
    });

    const operation = startOperation(operationRepository, fixture.candidateId);
    await candidateLocked.promise;
    const overlap = overlapRepository.findCurrentOverlap({
      groupId,
      groupMemoryIds: [fixture.memoryId],
      documents: [{ sourceId, snapshotId }],
      permissionAttestedAt: at,
      at,
    });
    try {
      await overlapMemoryQueryStarted.promise;
      await waitForPostgresLock(pool!, await overlapPid.promise);
      releaseCandidate.resolve();
      const [operationResult, current] = await Promise.all([operation, overlap]);
      return { operationResult, current };
    } catch (error) {
      releaseCandidate.resolve();
      await Promise.allSettled([operation, overlap]);
      throw error;
    }
  }

  it("discovers only eligible allowlisted group memories and deduplicates corrected identities", async () => {
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: pool! });
    await expect(repository.discoverEligibleScans({ groupIds: [groupId], limit: 20, at }))
      .resolves.toEqual({ discovered: 2, existing: 0 });
    await expect(repository.discoverEligibleScans({ groupIds: [groupId], limit: 20, at }))
      .resolves.toEqual({ discovered: 0, existing: 2 });
    await expect(repository.discoverEligibleScans({ groupIds: [otherGroupId], limit: 20, at }))
      .resolves.toEqual({ discovered: 1, existing: 0 });

    await pool!.query("UPDATE group_memories SET updated_at = $2 WHERE id = $1", [
      memoryIds[0], new Date("2026-08-13T02:05:00.000Z"),
    ]);
    await expect(repository.discoverEligibleScans({ groupIds: [groupId], limit: 20, at }))
      .resolves.toEqual({ discovered: 1, existing: 1 });
  });

  it("skips a scan locked by another transaction and recovers an expired processing lease", async () => {
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: pool! });
    const due = await pool!.query<{ id: string }>(
      `SELECT id FROM knowledge_conflict_scan_inbox
       WHERE status IN ('pending', 'retry') ORDER BY next_attempt_at, created_at, id LIMIT 1`,
    );
    const lockedId = due.rows[0]!.id;
    const locker = await pool!.connect();
    await locker.query("BEGIN");
    try {
      await locker.query("SELECT id FROM knowledge_conflict_scan_inbox WHERE id = $1 FOR UPDATE", [lockedId]);
      const skipped = await repository.claimNextScan({
        groupIds: [groupId], workerId: "worker-2", at, leaseUntil,
      });
      expect(skipped?.scan.id).not.toBe(lockedId);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }

    const recovered = await repository.claimNextScan({
      groupIds: [groupId],
      workerId: "worker-3",
      at: new Date("2026-08-13T02:00:31.000Z"),
      leaseUntil: new Date("2026-08-13T02:01:01.000Z"),
    });
    expect(recovered?.scan.attemptCount).toBeGreaterThanOrEqual(1);
  });

  it("dead-letters an expired final attempt once and then claims a later memory", async () => {
    const recoveryGroupId = `recovery-group-${suffix}`;
    const recoveryAt = new Date("2026-08-13T03:00:00.000Z");
    const recoveryNow = new Date("2026-08-13T03:01:00.000Z");
    const rows = ["final", "later"] as const;
    for (const label of rows) {
      const messageId = `feishu:recovery-${label}-${suffix}`;
      const memoryId = `recovery-${label}-memory-${suffix}`;
      await insertMessage(pool!, messageId, recoveryGroupId);
      await pool!.query(
        `INSERT INTO group_memories (
           id, group_id, memory_scope, category, content, importance, confidence,
           status, idempotency_key, origin, created_by, created_at, updated_at
         ) VALUES ($1, $2, 'group', 'decision', $3, 4, 0.9,
           'active', $4, 'operator', 'tester', $5, $5)`,
        [memoryId, recoveryGroupId, label, `recovery-${label}-op-${suffix}`, recoveryAt],
      );
      await pool!.query(
        `INSERT INTO group_memory_message_evidence (memory_id, conversation_message_id)
         VALUES ($1, $2)`,
        [memoryId, messageId],
      );
    }
    const finalScanId = `recovery-final-scan-${suffix}`;
    const laterScanId = `recovery-later-scan-${suffix}`;
    await pool!.query(
      `INSERT INTO knowledge_conflict_scan_inbox (
         id, group_id, group_memory_id, memory_updated_at, status, attempt_count,
         next_attempt_at, lease_worker_id, lease_until, created_at, updated_at
       ) VALUES
         ($1, $2, $3, $4, 'processing', 2, $4, 'dead-worker', $5, $4, $4),
         ($6, $2, $7, $4, 'pending', 0, $4, NULL, NULL, $8, $8)`,
      [finalScanId, recoveryGroupId, `recovery-final-memory-${suffix}`, recoveryAt,
        new Date("2026-08-13T03:00:30.000Z"), laterScanId,
        `recovery-later-memory-${suffix}`, new Date(recoveryAt.getTime() + 1)],
    );
    const repository = createPostgresKnowledgeConflictRepository({
      dataSource: pool!, maxScanAttempts: 2,
    });

    await expect(repository.maintainNextScan({ groupIds: [recoveryGroupId], at: recoveryNow }))
      .resolves.toEqual({ outcome: "dead_lettered", scanId: finalScanId,
        errorCode: "scan_attempts_exhausted" });
    await expect(repository.maintainNextScan({ groupIds: [recoveryGroupId], at: recoveryNow }))
      .resolves.toBeUndefined();
    await expect(repository.claimNextScan({
      groupIds: [recoveryGroupId], workerId: "recovery-worker", at: recoveryNow,
      leaseUntil: new Date("2026-08-13T03:01:30.000Z"),
    })).resolves.toMatchObject({ scan: { id: laterScanId, attemptCount: 1 } });
    await expect(pool!.query(
      `SELECT status, attempt_count, last_error_code
       FROM knowledge_conflict_scan_inbox WHERE id = $1`,
      [finalScanId],
    )).resolves.toMatchObject({ rows: [{ status: "dead_lettered", attempt_count: 2,
      last_error_code: "scan_attempts_exhausted" }] });
  });

  it("persists attributable idempotent dead-letter recovery across replay and delete", async () => {
    const memoryId = `recovery-audit-memory-${suffix}`;
    const messageId = `feishu:recovery-audit-message-${suffix}`;
    const replayScanId = `recovery-audit-replay-${suffix}`;
    const deleteScanId = `recovery-audit-delete-${suffix}`;
    await insertMessage(pool!, messageId, groupId);
    await pool!.query(
      `INSERT INTO group_memories (
         id, group_id, memory_scope, category, content, importance, confidence,
         status, idempotency_key, origin, created_by, created_at, updated_at
       ) VALUES ($1, $2, 'group', 'decision', 'Recovery audit', 4, 0.9,
         'active', $3, 'operator', 'tester', $4, $4)`,
      [memoryId, groupId, `recovery-audit-memory-op-${suffix}`, at],
    );
    await pool!.query(
      "INSERT INTO group_memory_message_evidence (memory_id, conversation_message_id) VALUES ($1, $2)",
      [memoryId, messageId],
    );
    for (const [scanId, attempts] of [[replayScanId, 3], [deleteScanId, 4]] as const) {
      await pool!.query(
        `INSERT INTO knowledge_conflict_scan_inbox (
           id, group_id, group_memory_id, memory_updated_at, status, attempt_count,
           next_attempt_at, last_error_code, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'dead_lettered', $5, $4, 'provider_unavailable', $4, $4)`,
        [scanId, groupId, memoryId, at, attempts],
      );
    }
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: pool! });
    const replayInput = {
      scanId: replayScanId, expectedAttemptCount: 3, expectedUpdatedAt: at,
      operationKey: `replay-audit-${suffix}`, actorRef: "knowledge-admin", at,
    };
    const replayResults = await Promise.all([
      repository.replayDeadLetterScan(replayInput),
      repository.replayDeadLetterScan(replayInput),
    ]);
    expect(replayResults.map((result) => result.outcome).sort())
      .toEqual(["already_applied", "applied"]);
    await expect(repository.replayDeadLetterScan({
      ...replayInput, operationKey: `replay-stale-${suffix}`, expectedAttemptCount: 2,
    })).rejects.toBeInstanceOf(KnowledgeConflictLeaseConflictError);

    const deleteInput = {
      scanId: deleteScanId, expectedAttemptCount: 4, expectedUpdatedAt: at,
      operationKey: `delete-audit-${suffix}`, actorRef: "knowledge-admin", at,
    };
    await expect(repository.deleteDeadLetterScan(deleteInput)).resolves.toMatchObject({
      outcome: "applied", status: "deleted",
    });
    await expect(repository.deleteDeadLetterScan(deleteInput)).resolves.toMatchObject({
      outcome: "already_applied", status: "deleted",
    });
    await expect(pool!.query(
      `SELECT scan_id, actor_ref, action, expected_attempt_count, result_status
       FROM knowledge_conflict_scan_operations
       WHERE operation_key IN ($1, $2) ORDER BY action`,
      [deleteInput.operationKey, replayInput.operationKey],
    )).resolves.toMatchObject({ rows: [
      { scan_id: deleteScanId, actor_ref: "knowledge-admin", action: "delete",
        expected_attempt_count: 4, result_status: "deleted" },
      { scan_id: replayScanId, actor_ref: "knowledge-admin", action: "replay",
        expected_attempt_count: 3, result_status: "pending" },
    ] });
    await expect(pool!.query(
      "UPDATE knowledge_conflict_scan_operations SET actor_ref = 'changed' WHERE operation_key = $1",
      [deleteInput.operationKey],
    )).rejects.toThrow(/append-only/iu);
  });

  it("maintains at most one stale row from a backlog per call", async () => {
    const staleGroupId = `stale-backlog-group-${suffix}`;
    const staleScanIds: string[] = [];
    for (const index of [1, 2]) {
      const messageId = `feishu:stale-backlog-${index}-${suffix}`;
      const memoryId = `stale-backlog-memory-${index}-${suffix}`;
      const scanId = `stale-backlog-scan-${index}-${suffix}`;
      staleScanIds.push(scanId);
      await insertMessage(pool!, messageId, staleGroupId);
      await pool!.query(
        `INSERT INTO group_memories (
           id, group_id, memory_scope, category, content, importance, confidence,
           status, idempotency_key, origin, created_by, created_at, updated_at
         ) VALUES ($1, $2, 'group', 'decision', $3, 4, 0.9,
           'superseded', $4, 'operator', 'tester', $5, $5)`,
        [memoryId, staleGroupId, `stale ${index}`,
          `stale-backlog-op-${index}-${suffix}`, at],
      );
      await pool!.query(
        `INSERT INTO group_memory_message_evidence (memory_id, conversation_message_id)
         VALUES ($1, $2)`,
        [memoryId, messageId],
      );
      await pool!.query(
        `INSERT INTO knowledge_conflict_scan_inbox (
           id, group_id, group_memory_id, memory_updated_at, status, attempt_count,
           next_attempt_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'pending', 0, $4, $5, $5)`,
        [scanId, staleGroupId, memoryId, at, new Date(at.getTime() + index)],
      );
    }
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: pool! });

    await expect(repository.maintainNextScan({ groupIds: [staleGroupId], at: leaseUntil }))
      .resolves.toEqual({ outcome: "superseded", scanId: staleScanIds[0] });
    await expect(pool!.query<{ status: string; count: string }>(
      `SELECT status, count(*) AS count
       FROM knowledge_conflict_scan_inbox
       WHERE id = ANY($1::text[]) GROUP BY status ORDER BY status`,
      [staleScanIds],
    )).resolves.toMatchObject({ rows: [
      { status: "completed", count: "1" },
      { status: "pending", count: "1" },
    ] });
  });

  it("does not clean up a stale processing scan until its active lease expires", async () => {
    const leasedGroupId = `leased-stale-group-${suffix}`;
    const memoryId = `leased-stale-memory-${suffix}`;
    const messageId = `feishu:leased-stale-${suffix}`;
    const scanId = `leased-stale-scan-${suffix}`;
    await insertMessage(pool!, messageId, leasedGroupId);
    await pool!.query(
      `INSERT INTO group_memories (
         id, group_id, memory_scope, category, content, importance, confidence,
         status, idempotency_key, origin, created_by, created_at, updated_at
       ) VALUES ($1, $2, 'group', 'decision', 'leased stale', 4, 0.9,
         'active', $3, 'operator', 'tester', $4, $4)`,
      [memoryId, leasedGroupId, `leased-stale-memory-op-${suffix}`, at],
    );
    await pool!.query(
      `INSERT INTO group_memory_message_evidence (memory_id, conversation_message_id)
       VALUES ($1, $2)`,
      [memoryId, messageId],
    );
    await pool!.query(
      `INSERT INTO knowledge_conflict_scan_inbox (
         id, group_id, group_memory_id, memory_updated_at, status, attempt_count,
         next_attempt_at, lease_worker_id, lease_until, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'processing', 1, $4, 'active-owner', $5, $4, $4)`,
      [scanId, leasedGroupId, memoryId, at, leaseUntil],
    );
    await pool!.query("UPDATE group_memories SET status = 'superseded' WHERE id = $1", [memoryId]);
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: pool! });

    await repository.maintainNextScan({
      groupIds: [leasedGroupId],
      at: new Date("2026-08-13T02:00:10.000Z"),
    });
    await expect(pool!.query(
      "SELECT status, lease_worker_id FROM knowledge_conflict_scan_inbox WHERE id = $1",
      [scanId],
    )).resolves.toMatchObject({ rows: [{ status: "processing", lease_worker_id: "active-owner" }] });

    await repository.maintainNextScan({
      groupIds: [leasedGroupId],
      at: new Date("2026-08-13T02:00:31.000Z"),
    });
    await expect(pool!.query(
      "SELECT status, terminal_outcome FROM knowledge_conflict_scan_inbox WHERE id = $1",
      [scanId],
    )).resolves.toMatchObject({ rows: [{ status: "completed", terminal_outcome: "superseded" }] });
  });

  it("requires explicit policy membership and holds its policy lock through persistence", async () => {
    const fixture = await insertDetectionFixture("policy-lock");
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: pool! });
    await pool!.query(
      "UPDATE knowledge_publication_target_policies SET allowed_group_ids = '{}' WHERE id = $1",
      [targetPolicyId],
    );
    await expect(repository.recordDetectionResult(fixture.input))
      .rejects.toMatchObject({ reasonCode: "source_stale" });
    await pool!.query(
      `UPDATE knowledge_publication_target_policies
       SET allowed_group_ids = ARRAY[$2]::text[] WHERE id = $1`,
      [targetPolicyId, groupId],
    );

    const policyLocked = deferred<void>();
    const releasePolicy = deferred<void>();
    let paused = false;
    const gatedRepository = createPostgresKnowledgeConflictRepository({
      dataSource: instrumentedDataSource(pool!, async (sql, execute) => {
        const result = await execute();
        if (!paused
          && sql.includes("FROM knowledge_publication_target_policies")
          && sql.includes("FOR UPDATE")) {
          paused = true;
          policyLocked.resolve();
          await releasePolicy.promise;
        }
        return result;
      }),
    });
    const detection = gatedRepository.recordDetectionResult(fixture.input);
    await policyLocked.promise;

    const mutator = await pool!.connect();
    await mutator.query("BEGIN");
    try {
      const pid = (await mutator.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const mutation = mutator.query(
        "UPDATE knowledge_publication_target_policies SET allowed_group_ids = '{}' WHERE id = $1",
        [targetPolicyId],
      );
      await waitForPostgresLock(pool!, pid);
      await expect(pool!.query<{ wait_event_type: string | null }>(
        "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
        [pid],
      )).resolves.toMatchObject({ rows: [{ wait_event_type: "Lock" }] });
      releasePolicy.resolve();
      await expect(detection).resolves.toMatchObject({ outcome: "applied" });
      await mutation;
      await mutator.query("COMMIT");
    } catch (error) {
      releasePolicy.resolve();
      await Promise.allSettled([detection]);
      await mutator.query("ROLLBACK");
      throw error;
    } finally {
      mutator.release();
    }
    await pool!.query(
      `UPDATE knowledge_publication_target_policies
       SET allowed_group_ids = ARRAY[$2]::text[] WHERE id = $1`,
      [targetPolicyId, groupId],
    );
  });

  it("uses memory-before-candidate locking across overlap and competing detection", async () => {
    const first = await insertDetectionFixture("lock-order");
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: pool! });
    await expect(repository.recordDetectionResult(first.input))
      .resolves.toMatchObject({ outcome: "applied", candidate: { id: first.candidateId } });

    const correctedAt = new Date(at.getTime() + 10_000);
    const nextScanId = `lock-order-next-scan-${suffix}`;
    const nextCandidateId = `lock-order-next-candidate-${suffix}`;
    const nextWorkerId = "lock-order-next-worker";
    await pool!.query("UPDATE group_memories SET updated_at = $2 WHERE id = $1", [
      first.memoryId, correctedAt,
    ]);
    await pool!.query(
      `INSERT INTO knowledge_conflict_scan_inbox (
         id, group_id, group_memory_id, memory_updated_at, status, attempt_count,
         next_attempt_at, lease_worker_id, lease_until, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'processing', 1, $4, $5, $6, $4, $4)`,
      [nextScanId, groupId, first.memoryId, correctedAt, nextWorkerId,
        new Date(correctedAt.getTime() + 30_000)],
    );
    const nextInput = integrationDetectionInput({
      scanId: nextScanId,
      candidateId: nextCandidateId,
      workerId: nextWorkerId,
      groupId,
      memoryId: first.memoryId,
      messageId: first.messageId,
      memoryUpdatedAt: correctedAt,
      operationKey: `lock-order-next-operation-${suffix}`,
      sourceId,
      snapshotId,
      fragmentId,
    });

    const detectionMemoryLocked = deferred<void>();
    const releaseDetection = deferred<void>();
    let detectionPaused = false;
    const detectionRepository = createPostgresKnowledgeConflictRepository({
      dataSource: instrumentedDataSource(pool!, async (sql, execute) => {
        const result = await execute();
        if (!detectionPaused && sql.startsWith("SELECT * FROM group_memories")
          && sql.includes("FOR UPDATE")) {
          detectionPaused = true;
          detectionMemoryLocked.resolve();
          await releaseDetection.promise;
        }
        return result;
      }),
    });
    const overlapMemoryQueryStarted = deferred<void>();
    let overlapStarted = false;
    const overlapRepository = createPostgresKnowledgeConflictRepository({
      dataSource: instrumentedDataSource(pool!, async (sql, execute) => {
        if (!overlapStarted && sql.includes("FROM group_memories") && sql.includes("FOR UPDATE")) {
          overlapStarted = true;
          overlapMemoryQueryStarted.resolve();
        }
        return execute();
      }),
    });

    const detection = detectionRepository.recordDetectionResult(nextInput);
    await detectionMemoryLocked.promise;
    const overlap = overlapRepository.findCurrentOverlap({
      groupId,
      groupMemoryIds: [first.memoryId],
      documents: [{ sourceId, snapshotId }],
      permissionAttestedAt: correctedAt,
      at: correctedAt,
    });
    await overlapMemoryQueryStarted.promise;

    try {
      const inspector = await pool!.connect();
      await inspector.query("BEGIN");
      try {
        await expect(inspector.query(
          "SELECT id FROM knowledge_conflict_candidates WHERE id = $1 FOR UPDATE NOWAIT",
          [first.candidateId],
        )).resolves.toMatchObject({ rows: [{ id: first.candidateId }] });
      } finally {
        await inspector.query("ROLLBACK");
        inspector.release();
      }

      releaseDetection.resolve();
      const [detected, current] = await Promise.all([detection, overlap]);
      expect(detected).toMatchObject({ outcome: "applied", candidate: { id: nextCandidateId } });
      expect(current).toMatchObject({ id: nextCandidateId, status: "pending_review" });
    } catch (error) {
      releaseDetection.resolve();
      await Promise.allSettled([detection, overlap]);
      throw error;
    }
  });

  it("completes concurrent overlap and approval without a candidate-memory deadlock", async () => {
    const result = await runOverlapAgainstCandidateOperation(
      "overlap-approval",
      (repository, candidateId) => repository.approveForDelivery({
        candidateId,
        expectedVersion: 1,
        operationKey: `overlap-approval-operation-${suffix}`,
        actorType: "admin_role",
        actorRef: "knowledge-admin",
        reasonCode: "reviewed",
        at,
      }),
    );

    expect(result.operationResult).toMatchObject({
      outcome: "applied",
      candidate: { status: "approved_for_delivery", version: 2 },
    });
    expect(result.current).toMatchObject({ status: "approved_for_delivery", version: 2 });
  });

  it("completes concurrent overlap and current validation without a candidate-memory deadlock", async () => {
    const result = await runOverlapAgainstCandidateOperation(
      "overlap-validation",
      (repository, candidateId) => repository.validateCandidateCurrentState({
        candidateId,
        expectedVersion: 1,
        permissionAttestedAt: at,
        operationKey: `overlap-validation-operation-${suffix}`,
        at,
      }),
    );

    expect(result.operationResult).toMatchObject({
      status: "current",
      candidate: { status: "pending_review", version: 1 },
    });
    expect(result.current).toMatchObject({ status: "pending_review", version: 1 });
  });

  it("serializes stale validation and reconciliation candidate-before-delivery", async () => {
    const fixture = await insertDetectionFixture("validation-reconciliation-lock-order");
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: pool! });
    await repository.recordDetectionResult(fixture.input);
    const approval = await repository.approveForDelivery({
      candidateId: fixture.candidateId,
      expectedVersion: 1,
      operationKey: `validation-reconciliation-approve-${suffix}`,
      actorType: "admin_role",
      actorRef: "knowledge-admin",
      reasonCode: "reviewed",
      at,
    });
    await pool!.query(
      `UPDATE knowledge_conflict_delivery_outbox
       SET status = 'outcome_unknown', attempt_count = 1, reconciliation_due_at = $2,
           updated_at = $2
       WHERE id = $1`,
      [approval.delivery.id, leaseUntil],
    );
    const changedAt = new Date("2026-08-13T02:00:03.000Z");
    await pool!.query("UPDATE document_sources SET updated_at = $2 WHERE id = $1", [sourceId, changedAt]);

    const candidateLocked = deferred<void>();
    const releaseCandidate = deferred<void>();
    const validationRepository = createPostgresKnowledgeConflictRepository({
      dataSource: instrumentedDataSource(pool!, async (sql, execute) => {
        const result = await execute();
        if (sql.includes("FROM knowledge_conflict_candidates") && sql.includes("FOR UPDATE")) {
          candidateLocked.resolve();
          await releaseCandidate.promise;
        }
        return result;
      }),
    });
    const reconciliationPid = deferred<number>();
    const reconciliationRepository = createPostgresKnowledgeConflictRepository({
      dataSource: instrumentedDataSource(
        pool!,
        async (_sql, execute) => execute(),
        (pid) => reconciliationPid.resolve(pid),
      ),
    });
    const validation = validationRepository.validateCandidateCurrentState({
      candidateId: fixture.candidateId,
      expectedVersion: 2,
      permissionAttestedAt: changedAt,
      operationKey: `validation-reconciliation-supersede-${suffix}`,
      at: changedAt,
    });
    await candidateLocked.promise;
    const reconciliation = reconciliationRepository.reconcileDelivery({
      deliveryId: approval.delivery.id,
      expectedAttemptCount: 1,
      outcome: "not_sent",
      operationKey: `validation-reconciliation-not-sent-${suffix}`,
      actorRef: "knowledge-admin",
      at: changedAt,
    });
    try {
      await waitForPostgresLock(pool!, await reconciliationPid.promise);
      const inspector = await pool!.connect();
      try {
        await inspector.query("BEGIN");
        await expect(inspector.query(
          "SELECT id FROM knowledge_conflict_delivery_outbox WHERE id = $1 FOR UPDATE NOWAIT",
          [approval.delivery.id],
        )).resolves.toMatchObject({ rows: [{ id: approval.delivery.id }] });
      } finally {
        await inspector.query("ROLLBACK");
        inspector.release();
      }
      releaseCandidate.resolve();
      const [validationResult, reconciliationResult] = await Promise.allSettled([
        validation,
        reconciliation,
      ]);
      expect(validationResult).toMatchObject({
        status: "fulfilled",
        value: { status: "superseded", reasonCode: "source_stale" },
      });
      expect(reconciliationResult.status).toBe("rejected");
      if (reconciliationResult.status === "rejected") {
        expect(reconciliationResult.reason).toBeInstanceOf(KnowledgeConflictDeliveryConflictError);
        expect(String(reconciliationResult.reason)).not.toMatch(/40p01|deadlock/iu);
      }
    } catch (error) {
      releaseCandidate.resolve();
      await Promise.allSettled([validation, reconciliation]);
      throw error;
    } finally {
      await pool!.query("UPDATE document_sources SET updated_at = $2 WHERE id = $1", [sourceId, at]);
    }
  });

  it("persists and governs an exact current conflict through one delivery and interaction", async () => {
    const memoryId = memoryIds[9]!;
    const messageId = messageIds[9]!;
    const scanId = `conflict-scan-candidate-${suffix}`;
    const candidateId = `conflict-candidate-${suffix}`;
    await pool!.query(
      `INSERT INTO group_memories (
         id, group_id, memory_scope, category, content, importance, confidence,
         status, idempotency_key, origin, created_by, created_at, updated_at
       ) VALUES ($1, $2, 'group', 'decision', 'CNY 10,000', 5, 0.95,
         'active', $3, 'operator', 'tester', $4, $4)`,
      [memoryId, groupId, `candidate-memory-${suffix}`, at],
    );
    await pool!.query(
      `INSERT INTO group_memory_message_evidence (memory_id, conversation_message_id)
       VALUES ($1, $2)`,
      [memoryId, messageId],
    );
    await pool!.query(
      `INSERT INTO knowledge_conflict_scan_inbox (
         id, group_id, group_memory_id, memory_updated_at, status, attempt_count,
         next_attempt_at, lease_worker_id, lease_until, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'processing', 1, $4, 'worker-candidate', $5, $4, $4)`,
      [scanId, groupId, memoryId, at, leaseUntil],
    );
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: pool! });
    const candidateInput = {
      scanId,
      workerId: "worker-candidate",
      result: {
        outcome: "conflict" as const,
        candidate: {
          id: candidateId,
          idempotencyKey: `candidate-operation-${suffix}`,
          groupId,
          groupMemoryId: memoryId,
          memoryUpdatedAt: at,
          sourceMessageId: messageId,
          targetDocumentSourceId: sourceId,
          targetSourceUpdatedAt: at,
          targetSourceVersion: "revision-7",
          targetSnapshotId: snapshotId,
          targetContentHash: "a".repeat(64),
          detectorContractVersion: "v1",
          permissionAttestedAt: at,
          plan: conflictPlan(),
          evidence: [
            { type: "conversation_message" as const, referenceId: "C1" as const,
              groupId, conversationMessageId: messageId },
            { type: "group_memory" as const, referenceId: "M1" as const,
              groupId, groupMemoryId: memoryId, expectedUpdatedAt: at },
            { type: "document_source" as const, referenceId: "D1" as const,
              documentSourceId: sourceId, expectedUpdatedAt: at },
            { type: "document_snapshot" as const, referenceId: "D1" as const,
              documentSourceId: sourceId, documentSnapshotId: snapshotId,
              contentHash: "a".repeat(64) },
            { type: "document_fragment" as const, referenceId: "D1" as const,
              documentSourceId: sourceId, documentSnapshotId: snapshotId,
              documentFragmentId: fragmentId, snapshotContentHash: "a".repeat(64),
              contentHash: "c".repeat(64) },
            { type: "document_source" as const, referenceId: "D2" as const,
              documentSourceId: secondarySourceId, expectedUpdatedAt: at },
            { type: "document_snapshot" as const, referenceId: "D2" as const,
              documentSourceId: secondarySourceId, documentSnapshotId: secondarySnapshotId,
              contentHash: "b".repeat(64) },
            { type: "document_fragment" as const, referenceId: "D2" as const,
              documentSourceId: secondarySourceId, documentSnapshotId: secondarySnapshotId,
              documentFragmentId: secondaryFragmentId, snapshotContentHash: "b".repeat(64),
              contentHash: "d".repeat(64) },
          ],
        },
      },
      at,
    };

    const unrelatedMessageInput = {
      ...candidateInput,
      result: {
        ...candidateInput.result,
        candidate: {
          ...candidateInput.result.candidate,
          sourceMessageId: messageIds[0]!,
          evidence: candidateInput.result.candidate.evidence.map((item) =>
            item.type === "conversation_message"
              ? { ...item, conversationMessageId: messageIds[0]! }
              : item),
        },
      },
    };
    await expect(repository.recordDetectionResult(unrelatedMessageInput))
      .rejects.toMatchObject({ reasonCode: "message_stale" });

    await pool!.query(
      "UPDATE knowledge_publication_target_policies SET allowed_group_ids = '{}' WHERE id = $1",
      [targetPolicyId],
    );
    await expect(repository.recordDetectionResult(candidateInput))
      .rejects.toMatchObject({ reasonCode: "source_stale" });
    await pool!.query(
      `UPDATE knowledge_publication_target_policies
       SET allowed_group_ids = ARRAY[$2]::text[] WHERE id = $1`,
      [targetPolicyId, groupId],
    );

    await pool!.query(
      "UPDATE knowledge_publication_target_policies SET enabled = FALSE WHERE id = $1",
      [targetPolicyId],
    );
    await expect(repository.recordDetectionResult(candidateInput))
      .rejects.toMatchObject({ reasonCode: "source_stale" });
    await pool!.query(
      "UPDATE knowledge_publication_target_policies SET enabled = TRUE WHERE id = $1",
      [targetPolicyId],
    );

    await expect(repository.recordDetectionResult(candidateInput)).resolves.toMatchObject({
      outcome: "applied",
      candidate: { id: candidateId, targetSourceVersion: "revision-7", version: 1 },
      scan: { status: "completed", terminalOutcome: "conflict" },
    });
    await expect(repository.recordDetectionResult(candidateInput)).resolves.toMatchObject({
      outcome: "already_applied",
      candidate: { id: candidateId },
    });
    await expect(pool!.query<{
      target_source_updated_at: Date;
      target_source_version: string | null;
    }>(
      `SELECT target_source_updated_at, target_source_version
       FROM knowledge_conflict_candidates WHERE id = $1`,
      [candidateId],
    )).resolves.toMatchObject({ rows: [{
      target_source_updated_at: at,
      target_source_version: "revision-7",
    }] });
    const evidenceFacts = await pool!.query<{
      evidence_type: string;
      source_updated_at: Date | null;
    }>(
      `SELECT evidence_type, source_updated_at FROM knowledge_conflict_evidence
       WHERE candidate_id = $1 ORDER BY evidence_type`,
      [candidateId],
    );
    expect(evidenceFacts.rows).toHaveLength(8);
    expect(evidenceFacts.rows.filter((row) => row.evidence_type === "document_source"))
      .toEqual([
        { evidence_type: "document_source", source_updated_at: at },
        { evidence_type: "document_source", source_updated_at: at },
      ]);
    await expect(pool!.query(
      "UPDATE knowledge_conflict_evidence SET reference_id = 'D2' WHERE candidate_id = $1",
      [candidateId],
    )).rejects.toThrow(/append-only/iu);

    const approvalInput = {
      candidateId,
      expectedVersion: 1,
      operationKey: `approve-${suffix}`,
      actorType: "admin_role" as const,
      actorRef: "knowledge-admin",
      reasonCode: "reviewed",
      at,
    };
    const concurrentApprovals = await Promise.all([
      repository.approveForDelivery(approvalInput),
      repository.approveForDelivery(approvalInput),
    ]);
    expect(concurrentApprovals.map((result) => result.outcome).sort())
      .toEqual(["already_applied", "applied"]);
    const approval = concurrentApprovals.find((result) => result.outcome === "applied")!;
    expect(approval).toMatchObject({
      outcome: "applied",
      candidate: { status: "approved_for_delivery", version: 2 },
      delivery: { status: "pending" },
    });
    await expect(repository.approveForDelivery(approvalInput))
      .resolves.toMatchObject({ outcome: "already_applied", delivery: { id: approval.delivery.id } });

    const claim = await repository.claimNextDelivery({
      workerId: "delivery-worker",
      at,
      leaseUntil,
    });
    expect(claim).toMatchObject({ delivery: { id: approval.delivery.id, status: "processing" } });
    await repository.beginDeliveryAttempt({
      deliveryId: approval.delivery.id,
      workerId: "delivery-worker",
      at,
    });
    await repository.failDelivery({
      deliveryId: approval.delivery.id,
      workerId: "delivery-worker",
      classification: "outcome_unknown",
      errorCode: "first_timeout",
      reconciliationDueAt: leaseUntil,
      at,
    });

    const staleDuringUnknown = new Date("2026-08-13T02:00:01.000Z");
    await pool!.query("UPDATE document_sources SET updated_at = $2 WHERE id = $1", [
      secondarySourceId, staleDuringUnknown,
    ]);
    await expect(repository.validateCandidateCurrentState({
      candidateId,
      expectedVersion: 2,
      permissionAttestedAt: staleDuringUnknown,
      operationKey: `validate-outcome-unknown-${suffix}`,
      at: staleDuringUnknown,
    })).rejects.toBeInstanceOf(KnowledgeConflictDeliveryConflictError);
    await expect(repository.getCandidate(candidateId))
      .resolves.toMatchObject({ status: "approved_for_delivery", version: 2 });
    await pool!.query("UPDATE document_sources SET updated_at = $2 WHERE id = $1", [
      secondarySourceId, at,
    ]);

    await expect(repository.reconcileDelivery({
      deliveryId: approval.delivery.id,
      outcome: "not_sent",
      operationKey: `reconcile-not-sent-${suffix}`,
      expectedAttemptCount: 1,
      actorRef: "knowledge-admin",
      at,
    })).resolves.toMatchObject({ status: "failed", failureCode: "reconciled_not_sent" });
    const retryClaim = await repository.claimNextDelivery({
      workerId: "delivery-worker-2", at, leaseUntil,
    });
    expect(retryClaim).toMatchObject({ delivery: { id: approval.delivery.id, attemptCount: 2 } });
    await repository.beginDeliveryAttempt({
      deliveryId: approval.delivery.id, workerId: "delivery-worker-2", at,
    });
    await repository.failDelivery({
      deliveryId: approval.delivery.id,
      workerId: "delivery-worker-2",
      classification: "outcome_unknown",
      errorCode: "second_timeout",
      reconciliationDueAt: leaseUntil,
      at,
    });
    await expect(repository.reconcileDelivery({
      deliveryId: approval.delivery.id,
      outcome: "not_sent",
      operationKey: `stale-reconcile-not-sent-${suffix}`,
      expectedAttemptCount: 1,
      actorRef: "knowledge-admin",
      at,
    })).rejects.toBeInstanceOf(KnowledgeConflictDeliveryConflictError);
    await expect(repository.reconcileDelivery({
      deliveryId: approval.delivery.id,
      outcome: "sent",
      operationKey: `reconcile-sent-${suffix}`,
      expectedAttemptCount: 2,
      actorRef: "knowledge-admin",
      messageId: `om-${suffix}`,
      at,
    })).resolves.toMatchObject({ status: "sent", sentMessageId: `om-${suffix}` });
    await expect(repository.getCandidate(candidateId))
      .resolves.toMatchObject({ status: "delivered", version: 3 });
    await expect(pool!.query(
      `SELECT operation_key, attempt_count, actor_ref, outcome
       FROM knowledge_conflict_delivery_reconciliations
       WHERE delivery_id = $1 ORDER BY operation_key`,
      [approval.delivery.id],
    )).resolves.toMatchObject({ rows: [
      { operation_key: `reconcile-not-sent-${suffix}`, attempt_count: 1,
        actor_ref: "knowledge-admin", outcome: "not_sent" },
      { operation_key: `reconcile-sent-${suffix}`, attempt_count: 2,
        actor_ref: "knowledge-admin", outcome: "sent" },
    ] });

    await expect(repository.findCurrentOverlap({
      groupId,
      groupMemoryIds: [memoryId],
      documents: [{ sourceId, snapshotId }],
      permissionAttestedAt: at,
      at,
    })).resolves.toMatchObject({ id: candidateId, status: "delivered" });
    await pool!.query(
      "UPDATE knowledge_publication_target_policies SET allowed_group_ids = '{}' WHERE id = $1",
      [targetPolicyId],
    );
    await expect(repository.findCurrentOverlap({
      groupId,
      groupMemoryIds: [memoryId],
      documents: [{ sourceId, snapshotId }],
      permissionAttestedAt: at,
      at,
    })).resolves.toBeUndefined();
    await pool!.query(
      `UPDATE knowledge_publication_target_policies
       SET allowed_group_ids = ARRAY[$2]::text[] WHERE id = $1`,
      [targetPolicyId, groupId],
    );

    const interaction = {
      id: `interaction-${suffix}`,
      candidateId,
      callbackOperationKey: `callback-${suffix}`,
      actorRef: "ou-member",
      action: "dismiss" as const,
      result: "applied" as const,
      reasonCode: "not_a_conflict",
      at,
    };
    const concurrentInteractions = await Promise.all([
      repository.recordInteraction(interaction),
      repository.recordInteraction(interaction),
    ]);
    expect(concurrentInteractions.map((result) => result.outcome).sort())
      .toEqual(["already_applied", "applied"]);
    await expect(repository.recordInteraction({ ...interaction, reasonCode: "changed" }))
      .rejects.toBeInstanceOf(KnowledgeConflictOperationConflictError);

    const callbackCandidateId = `callback-candidate-${suffix}`;
    await pool!.query(
      `INSERT INTO knowledge_conflict_candidates (
         id, idempotency_key, group_id, group_memory_id, memory_updated_at,
         source_message_id, target_document_source_id, target_source_updated_at,
         target_source_version, target_snapshot_id, target_content_hash,
         detector_contract_version, status, subject, knowledge_base_statement,
         group_conclusion_statement, difference, suggested_update, target_document_ref,
         confidence, version, created_at, updated_at
       ) SELECT $1, $2, group_id, group_memory_id, memory_updated_at,
         source_message_id, target_document_source_id, target_source_updated_at,
         target_source_version, target_snapshot_id, target_content_hash,
         'v2', 'pending_review', subject, knowledge_base_statement,
         group_conclusion_statement, difference, suggested_update, target_document_ref,
         confidence, 1, created_at, updated_at
       FROM knowledge_conflict_candidates WHERE id = $3`,
      [callbackCandidateId, `callback-candidate-operation-${suffix}`, candidateId],
    );
    await pool!.query(
      `INSERT INTO knowledge_conflict_evidence (
         candidate_id, evidence_type, reference_id, group_id, conversation_message_id,
         group_memory_id, source_updated_at, document_source_id, document_snapshot_id,
         document_fragment_id, snapshot_content_hash, content_hash, created_at
       ) SELECT $1, evidence_type, reference_id, group_id, conversation_message_id,
         group_memory_id, source_updated_at, document_source_id, document_snapshot_id,
         document_fragment_id, snapshot_content_hash, content_hash, created_at
       FROM knowledge_conflict_evidence WHERE candidate_id = $2`,
      [callbackCandidateId, candidateId],
    );
    const applyInput = {
      id: `callback-interaction-${suffix}`,
      candidateId: callbackCandidateId,
      expectedVersion: 1,
      callbackOperationKey: `callback-atomic-${suffix}`,
      actorRef: "ou-member",
      action: "dismiss" as const,
      reasonCode: "not_a_conflict",
      permissionAttestedAt: at,
      at,
    };
    const concurrentCallbacks = await Promise.all([
      repository.applyInteraction(applyInput),
      repository.applyInteraction(applyInput),
    ]);
    expect(concurrentCallbacks.map((result) => result.outcome).sort())
      .toEqual(["already_applied", "applied"]);
    await expect(repository.getCandidate(callbackCandidateId))
      .resolves.toMatchObject({ status: "dismissed", version: 2 });

    const changedAt = new Date("2026-08-13T02:00:02.000Z");
    await pool!.query("UPDATE document_sources SET updated_at = $2 WHERE id = $1", [
      secondarySourceId, changedAt,
    ]);
    await expect(repository.findCurrentOverlap({
      groupId,
      groupMemoryIds: [memoryId],
      documents: [{ sourceId, snapshotId }],
      permissionAttestedAt: changedAt,
      at: changedAt,
    })).resolves.toBeUndefined();
    await expect(repository.validateCandidateCurrentState({
      candidateId,
      expectedVersion: 3,
      permissionAttestedAt: changedAt,
      operationKey: `supersede-${suffix}`,
      at: changedAt,
    })).resolves.toMatchObject({
      status: "superseded",
      reasonCode: "source_stale",
      candidate: { status: "superseded", version: 4 },
    });
  });
});

function integrationDetectionInput(input: {
  scanId: string;
  candidateId: string;
  workerId: string;
  groupId: string;
  memoryId: string;
  messageId: string;
  memoryUpdatedAt: Date;
  operationKey: string;
  sourceId: string;
  snapshotId: string;
  fragmentId: string;
}): RecordKnowledgeConflictDetectionInput {
  return {
    scanId: input.scanId,
    workerId: input.workerId,
    result: {
      outcome: "conflict",
      candidate: {
        id: input.candidateId,
        idempotencyKey: input.operationKey,
        groupId: input.groupId,
        groupMemoryId: input.memoryId,
        memoryUpdatedAt: input.memoryUpdatedAt,
        sourceMessageId: input.messageId,
        targetDocumentSourceId: input.sourceId,
        targetSourceUpdatedAt: at,
        targetSourceVersion: "revision-7",
        targetSnapshotId: input.snapshotId,
        targetContentHash: "a".repeat(64),
        detectorContractVersion: "v1",
        permissionAttestedAt: input.memoryUpdatedAt,
        plan: conflictPlan(),
        evidence: [
          { type: "conversation_message", referenceId: "C1", groupId: input.groupId,
            conversationMessageId: input.messageId },
          { type: "group_memory", referenceId: "M1", groupId: input.groupId,
            groupMemoryId: input.memoryId, expectedUpdatedAt: input.memoryUpdatedAt },
          { type: "document_source", referenceId: "D1", documentSourceId: input.sourceId,
            expectedUpdatedAt: at },
          { type: "document_snapshot", referenceId: "D1", documentSourceId: input.sourceId,
            documentSnapshotId: input.snapshotId, contentHash: "a".repeat(64) },
          { type: "document_fragment", referenceId: "D1", documentSourceId: input.sourceId,
            documentSnapshotId: input.snapshotId, documentFragmentId: input.fragmentId,
            snapshotContentHash: "a".repeat(64), contentHash: "c".repeat(64) },
        ],
      },
    },
    at: input.memoryUpdatedAt,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function instrumentedDataSource(
  pool: pg.Pool,
  intercept: (
    normalizedSql: string,
    execute: () => Promise<{ rows: Record<string, unknown>[] }>,
  ) => Promise<{ rows: Record<string, unknown>[] }>,
  onConnect?: (pid: number) => void,
): PostgresKnowledgeConflictDataSource {
  return {
    query: (sql: string, values?: unknown[]) => pool.query(sql, values),
    connect: async () => {
      const client = await pool.connect();
      if (onConnect !== undefined) {
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        onConnect(pid);
      }
      return {
        release: () => client.release(),
        query: (sql: string, values?: unknown[]) => intercept(
          sql.replaceAll(/\s+/gu, " ").trim(),
          async () => client.query(sql, values),
        ),
      };
    },
  } as unknown as PostgresKnowledgeConflictDataSource;
}

async function waitForPostgresLock(pool: pg.Pool, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const activity = await pool.query<{ wait_event_type: string | null }>(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (activity.rows[0]?.wait_event_type === "Lock") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PostgreSQL backend ${pid} did not block on the expected row lock`);
}

function dataSource(client: ReturnType<typeof routedClient>): PostgresKnowledgeConflictDataSource {
  return {
    connect: vi.fn(async () => client),
    query: vi.fn((sql: string, values?: unknown[]) => client.query(sql, values)),
  } as unknown as PostgresKnowledgeConflictDataSource;
}

function routedClient(route: (normalizedSql: string, values?: unknown[]) => { rows: unknown[] }) {
  return {
    release: vi.fn(),
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      const normalized = sql.replaceAll(/\s+/gu, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [] };
      return route(normalized, values);
    }),
  };
}

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "memory-1",
    group_id: "group-1",
    memory_scope: "group",
    category: "decision",
    thread_key: null,
    content: "Director approval starts at CNY 10,000.",
    importance: 4,
    confidence: 0.9,
    status: "active",
    idempotency_key: "memory-op-1",
    origin: "operator",
    created_by: "tester",
    supersedes_memory_id: null,
    evidence_message_ids: ["message-1"],
    created_at: at,
    updated_at: at,
    ...overrides,
  };
}

function scanRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "scan-1",
    group_id: "group-1",
    group_memory_id: "memory-1",
    memory_updated_at: at,
    status: "pending",
    attempt_count: 0,
    next_attempt_at: at,
    lease_worker_id: null,
    lease_until: null,
    terminal_outcome: null,
    last_error_code: null,
    created_at: at,
    updated_at: at,
    ...overrides,
  };
}

function claimRow(overrides: Record<string, unknown> = {}) {
  return {
    ...scanRow({ lease_worker_id: "conflict-scanner-1", lease_until: leaseUntil }),
    ...Object.fromEntries(Object.entries(memoryRow()).map(([key, value]) => [`memory_${key}`, value])),
    ...overrides,
  };
}

function conflictPlan() {
  return {
    outcome: "conflict" as const,
    subject: "Expense approval threshold",
    knowledgeBaseStatement: "Director approval starts at CNY 5,000.",
    knowledgeBaseCitationRefs: ["D1"],
    groupConclusionStatement: "Director approval now starts at CNY 10,000.",
    groupCitationRefs: ["M1", "C1"],
    difference: "The approval threshold differs.",
    suggestedUpdate: "Replace CNY 5,000 with CNY 10,000.",
    targetDocumentRef: "D1",
    missingEvidence: [],
    confidence: "high" as const,
  };
}

function conflictEvidence() {
  return [
    {
      type: "conversation_message" as const,
      referenceId: "C1" as const,
      groupId: "group-1",
      conversationMessageId: "message-1",
    },
    {
      type: "group_memory" as const,
      referenceId: "M1" as const,
      groupId: "group-1",
      groupMemoryId: "memory-1",
      expectedUpdatedAt: at,
    },
    {
      type: "document_source" as const,
      referenceId: "D1" as const,
      documentSourceId: "source-1",
      expectedUpdatedAt: at,
    },
    {
      type: "document_snapshot" as const,
      referenceId: "D1" as const,
      documentSourceId: "source-1",
      documentSnapshotId: "snapshot-1",
      contentHash: "a".repeat(64),
    },
    {
      type: "document_fragment" as const,
      referenceId: "D1" as const,
      documentSourceId: "source-1",
      documentSnapshotId: "snapshot-1",
      documentFragmentId: "fragment-1",
      snapshotContentHash: "a".repeat(64),
      contentHash: "c".repeat(64),
    },
  ];
}

type ConflictCandidateInput = Extract<
  RecordKnowledgeConflictDetectionInput["result"],
  { outcome: "conflict" }
>["candidate"];

function conflictDetectionInput(
  overrides: Partial<ConflictCandidateInput> = {},
): RecordKnowledgeConflictDetectionInput {
  const base = {
    scanId: "scan-1",
    workerId: "worker-1",
    result: {
      outcome: "conflict" as const,
      candidate: {
        id: "candidate-1",
        idempotencyKey: "candidate-op-1",
        groupId: "group-1",
        groupMemoryId: "memory-1",
        memoryUpdatedAt: at,
        sourceMessageId: "message-1",
        targetDocumentSourceId: "source-1",
        targetSourceUpdatedAt: at,
        targetSnapshotId: "snapshot-1",
        targetContentHash: "a".repeat(64),
        targetSourceVersion: "revision-7",
        detectorContractVersion: "v1",
        permissionAttestedAt: at,
        plan: conflictPlan(),
        evidence: conflictEvidence(),
      },
    },
    at,
  };
  const { plan, ...candidateOverrides } = overrides;
  const memoryUpdatedAt = candidateOverrides.memoryUpdatedAt as Date | undefined;
  const sourceUpdatedAt = candidateOverrides.targetSourceUpdatedAt as Date | undefined;
  const targetContentHash = candidateOverrides.targetContentHash as string | undefined;
  const evidence = base.result.candidate.evidence.map((item) => {
    if (item.type === "group_memory" && memoryUpdatedAt !== undefined) {
      return { ...item, expectedUpdatedAt: memoryUpdatedAt };
    }
    if (item.type === "document_source" && sourceUpdatedAt !== undefined) {
      return { ...item, expectedUpdatedAt: sourceUpdatedAt };
    }
    if (item.type === "document_snapshot" && targetContentHash !== undefined) {
      return { ...item, contentHash: targetContentHash };
    }
    if (item.type === "document_fragment" && targetContentHash !== undefined) {
      return { ...item, snapshotContentHash: targetContentHash };
    }
    return item;
  }) as KnowledgeConflictEvidenceReference[];
  return {
    ...base,
    result: {
      ...base.result,
      candidate: {
        ...base.result.candidate,
        evidence,
        ...candidateOverrides,
        ...(plan === undefined ? {} : { plan }),
      },
    },
  };
}

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "candidate-1",
    idempotency_key: "candidate-op-1",
    group_id: "group-1",
    group_memory_id: "memory-1",
    memory_updated_at: at,
    source_message_id: "message-1",
    target_document_source_id: "source-1",
    target_source_updated_at: at,
    target_snapshot_id: "snapshot-1",
    target_content_hash: "a".repeat(64),
    target_source_version: "revision-7",
    detector_contract_version: "v1",
    status: "pending_review",
    subject: conflictPlan().subject,
    knowledge_base_statement: conflictPlan().knowledgeBaseStatement,
    group_conclusion_statement: conflictPlan().groupConclusionStatement,
    difference: conflictPlan().difference,
    suggested_update: conflictPlan().suggestedUpdate,
    target_document_ref: "D1",
    confidence: "high",
    version: 1,
    created_at: at,
    updated_at: at,
    ...overrides,
  };
}

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "source-1",
    authorized_space_id: "space-1",
    source_type: "authorized_wiki_document",
    permission_state: "readable",
    sync_state: "synced",
    can_use_for_knowledge_drafts: true,
    updated_at: at,
    ...overrides,
  };
}

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "snapshot-1",
    document_source_id: "source-1",
    fetch_status: "succeeded",
    content_hash: "a".repeat(64),
    source_version: "revision-7",
    fetched_at: new Date("2026-08-13T01:00:00.000Z"),
    ...overrides,
  };
}

function evidenceRows() {
  return conflictEvidence().map((evidence, index) => ({
    id: index + 1,
    candidate_id: "candidate-1",
    evidence_type: evidence.type,
    reference_id: evidence.referenceId,
    group_id: "groupId" in evidence ? evidence.groupId : null,
    conversation_message_id:
      evidence.type === "conversation_message" ? evidence.conversationMessageId : null,
    group_memory_id: evidence.type === "group_memory" ? evidence.groupMemoryId : null,
    source_updated_at:
      evidence.type === "group_memory" || evidence.type === "document_source"
        ? evidence.expectedUpdatedAt
        : null,
    document_source_id: "documentSourceId" in evidence ? evidence.documentSourceId : null,
    document_snapshot_id:
      evidence.type === "document_snapshot" || evidence.type === "document_fragment"
        ? evidence.documentSnapshotId
        : null,
    document_fragment_id:
      evidence.type === "document_fragment" ? evidence.documentFragmentId : null,
    snapshot_content_hash:
      evidence.type === "document_snapshot"
        ? evidence.contentHash
        : evidence.type === "document_fragment" ? evidence.snapshotContentHash : null,
    content_hash:
      evidence.type === "document_snapshot" || evidence.type === "document_fragment"
        ? evidence.contentHash
        : null,
    created_at: at,
  }));
}

function candidateClient(input: {
  existingCandidate?: boolean;
  completedScan?: boolean;
  authorizedPolicy?: boolean;
} = {}) {
  return routedClient((sql) => {
    if (sql.includes("FROM knowledge_conflict_scan_inbox") && sql.includes("FOR UPDATE")) {
      return { rows: [scanRow({
        status: input.completedScan ? "completed" : "processing",
        lease_worker_id: input.completedScan ? null : "worker-1",
        terminal_outcome: input.completedScan ? "conflict" : null,
      })] };
    }
    if (sql.includes("FROM knowledge_conflict_candidates") && sql.includes("idempotency_key")) {
      return { rows: input.existingCandidate ? [candidateRow()] : [] };
    }
    if (sql.includes("FROM group_memories") && sql.includes("FOR UPDATE")) {
      return { rows: [memoryRow()] };
    }
    if (sql.includes("FROM conversation_messages")) {
      return { rows: [{ id: "message-1", chat_id: "group-1" }] };
    }
    if (sql.includes("FROM document_sources") && sql.includes("FOR UPDATE")) {
      return { rows: [sourceRow()] };
    }
    if (sql.includes("FROM knowledge_publication_target_policies")) {
      return { rows: input.authorizedPolicy === false ? [] : [{ id: "policy-1" }] };
    }
    if (sql.includes("FROM document_snapshots") && sql.includes("FOR UPDATE")) {
      return { rows: [snapshotRow()] };
    }
    if (sql.includes("FROM document_fragments")) {
      return { rows: [{
        id: "fragment-1",
        document_source_id: "source-1",
        document_snapshot_id: "snapshot-1",
        content_hash: "c".repeat(64),
      }] };
    }
    if (sql.includes("INSERT INTO knowledge_conflict_candidates")) {
      return { rows: [candidateRow()] };
    }
    if (sql.includes("FROM knowledge_conflict_evidence")) return { rows: evidenceRows() };
    if (sql.includes("UPDATE knowledge_conflict_scan_inbox")) {
      return { rows: [scanRow({ status: "completed", terminal_outcome: "conflict",
        lease_worker_id: null })] };
    }
    return { rows: [] };
  });
}

function transitionClient(input: {
  toStatus: "dismissed" | "approved_for_delivery";
  delivery?: boolean;
  currentVersion?: number;
}) {
  return routedClient((sql) => {
    if (sql.includes("FROM knowledge_conflict_interactions")) return { rows: [] };
    if (sql.includes("INSERT INTO knowledge_conflict_interactions")) {
      return { rows: [interactionRow({ callback_operation_key: "callback-atomic-1" })] };
    }
    if (sql.includes("SELECT id FROM group_memories")) return { rows: [{ id: "memory-1" }] };
    if (sql.includes("SELECT message.id FROM conversation_messages")) {
      return { rows: [{ id: "message-1" }] };
    }
    if (sql.includes("FROM knowledge_publication_target_policies")) {
      return { rows: [{ id: "policy-1" }] };
    }
    if (sql.includes("FROM document_sources")) return { rows: [sourceRow()] };
    if (sql.includes("FROM document_snapshots")) return { rows: [snapshotRow()] };
    if (sql.includes("FROM document_fragments")) {
      return { rows: [{ id: "fragment-1", document_source_id: "source-1",
        document_snapshot_id: "snapshot-1", content_hash: "c".repeat(64) }] };
    }
    if (sql.includes("FROM knowledge_conflict_candidate_events") && sql.includes("operation_key")) {
      return { rows: [] };
    }
    if (sql.includes("FROM knowledge_conflict_candidates") && sql.includes("FOR UPDATE")) {
      return { rows: [candidateRow({ version: input.currentVersion ?? 1 })] };
    }
    if (sql.includes("FROM knowledge_conflict_candidates")) {
      return { rows: [candidateRow({ version: input.currentVersion ?? 1 })] };
    }
    if (sql.includes("UPDATE knowledge_conflict_candidates")) {
      return { rows: [candidateRow({ status: input.toStatus, version: 2 })] };
    }
    if (sql.includes("INSERT INTO knowledge_conflict_delivery_outbox")) {
      return { rows: [deliveryRow()] };
    }
    if (sql.includes("FROM knowledge_conflict_evidence")) return { rows: evidenceRows() };
    return { rows: [] };
  });
}

function memoryBeforeCandidateClient(input: { approval?: boolean } = {}) {
  let memoryLocked = false;
  return routedClient((sql) => {
    if (sql.includes("FROM group_memories") && sql.includes("FOR UPDATE")) {
      memoryLocked = true;
      return { rows: [{ id: "memory-1" }] };
    }
    if (sql.includes("FROM knowledge_conflict_candidates")) {
      if (sql.includes("FOR UPDATE") && !memoryLocked) {
        throw new Error("candidate locked before memory");
      }
      return { rows: [candidateRow()] };
    }
    if (sql.includes("FROM knowledge_conflict_delivery_outbox")) return { rows: [] };
    if (sql.includes("FROM knowledge_conflict_candidate_events")) return { rows: [] };
    if (sql.includes("FROM knowledge_conflict_evidence")) return { rows: evidenceRows() };
    if (sql.includes("SELECT message.id FROM conversation_messages")) {
      return { rows: [{ id: "message-1" }] };
    }
    if (sql.includes("FROM document_sources")) return { rows: [sourceRow()] };
    if (sql.includes("FROM knowledge_publication_target_policies")) {
      return { rows: [{ id: "policy-1" }] };
    }
    if (sql.includes("FROM document_snapshots")) return { rows: [snapshotRow()] };
    if (sql.includes("FROM document_fragments")) {
      return { rows: [{
        id: "fragment-1",
        document_source_id: "source-1",
        document_snapshot_id: "snapshot-1",
        content_hash: "c".repeat(64),
      }] };
    }
    if (sql.includes("UPDATE knowledge_conflict_candidates")) {
      return { rows: [candidateRow({ status: "approved_for_delivery", version: 2 })] };
    }
    if (sql.includes("INSERT INTO knowledge_conflict_delivery_outbox")) {
      return { rows: input.approval ? [deliveryRow()] : [] };
    }
    return { rows: [] };
  });
}

function deliveryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "delivery-1",
    candidate_id: "candidate-1",
    group_id: "group-1",
    status: "pending",
    retryable: true,
    attempt_count: 0,
    next_attempt_at: at,
    lease_worker_id: null,
    lease_until: null,
    external_attempt_started_at: null,
    reconciliation_due_at: null,
    reconciliation_operation_key: null,
    reconciliation_outcome: null,
    reconciled_at: null,
    sent_message_id: null,
    failure_code: null,
    created_at: at,
    updated_at: at,
    ...overrides,
  };
}

function deliveryCandidateRow(overrides: Record<string, unknown> = {}) {
  return {
    ...deliveryRow(overrides),
    ...Object.fromEntries(Object.entries(candidateRow({
      status: "approved_for_delivery",
      version: 2,
    })).map(([key, value]) => [`candidate_${key}`, value])),
  };
}

function repositoryForDeliveryMutation(row: ReturnType<typeof deliveryRow>) {
  return createPostgresKnowledgeConflictRepository({
    dataSource: dataSource(routedClient((sql) => {
      if (sql.includes("UPDATE knowledge_conflict_delivery_outbox")) return { rows: [row] };
      if (sql === "SELECT candidate_id FROM knowledge_conflict_delivery_outbox WHERE id = $1") {
        return { rows: [{ candidate_id: "candidate-1" }] };
      }
      if (sql.includes("FROM knowledge_conflict_candidates") && sql.includes("FOR UPDATE")) {
        return { rows: [candidateRow({ status: "approved_for_delivery", version: 2 })] };
      }
      if (sql.includes("FROM knowledge_conflict_delivery_outbox")) {
        return { rows: [deliveryRow({ status: "outcome_unknown", attempt_count: 1 })] };
      }
      return { rows: [] };
    })),
  });
}

function interactionInput() {
  return {
    id: "interaction-1",
    candidateId: "candidate-1",
    callbackOperationKey: "callback-1",
    actorRef: "ou-member",
    action: "dismiss" as const,
    result: "applied" as const,
    reasonCode: "not_a_conflict",
    at,
  };
}

function interactionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "interaction-1",
    candidate_id: "candidate-1",
    callback_operation_key: "callback-1",
    actor_ref: "ou-member",
    action: "dismiss",
    result: "applied",
    draft_id: null,
    reason_code: "not_a_conflict",
    created_at: at,
    ...overrides,
  };
}

async function insertMessage(pool: pg.Pool, id: string, groupId: string): Promise<void> {
  await pool.query(
    `INSERT INTO conversation_messages (
      id, provider, provider_message_id, chat_id, sender_id,
      message_type, text, sent_at, raw_event_idempotency_key
    ) VALUES ($1, 'feishu', $2, $3, 'tester', 'text', 'evidence', $4, $5)`,
    [id, id.slice("feishu:".length), groupId, at, `event-${id}`],
  );
}
