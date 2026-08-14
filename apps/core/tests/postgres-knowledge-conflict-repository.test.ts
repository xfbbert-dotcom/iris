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
    const client = routedClient((sql) => {
      if (sql.includes("WITH claimable")) {
        return { rows: [claimRow({ status: "processing", attempt_count: 2 })] };
      }
      return { rows: [] };
    });
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: dataSource(client) });

    await expect(repository.claimNextScan({
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
    await expect(repository.replayDeadLetterScan({ scanId: "scan-1", at }))
      .resolves.toMatchObject({ status: "pending", attemptCount: 0 });
    await expect(repository.deleteDeadLetterScan("scan-1")).resolves.toBe("deleted");
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
      at,
    })).resolves.toMatchObject({ status: "failed", failureCode: "reconciled_not_sent" });
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

  it("supersedes a candidate when the current snapshot hash no longer matches", async () => {
    const client = routedClient((sql) => {
      if (sql.includes("FROM knowledge_conflict_candidates") && sql.includes("FOR UPDATE")) {
        return { rows: [candidateRow({ status: "pending_review", version: 1 })] };
      }
      if (sql.includes("FROM knowledge_conflict_evidence")) return { rows: evidenceRows() };
      if (sql.includes("SELECT id FROM group_memories")) return { rows: [{ id: "memory-1" }] };
      if (sql.includes("SELECT message.id FROM conversation_messages")) {
        return { rows: [{ id: "message-1" }] };
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
      permissionAttestedAt: at,
      operationKey: "supersede-hash-change",
      at,
    })).resolves.toMatchObject({
      status: "superseded",
      reasonCode: "snapshot_stale",
      candidate: { status: "superseded", version: 2 },
    });
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
      `INSERT INTO document_sources (
         id, source_type, source_uri, permission_state, sync_state,
         can_use_for_answering, can_use_for_knowledge_drafts, created_at, updated_at
       ) VALUES ($1, 'authorized_wiki_document', $2, 'readable', 'synced',
         TRUE, TRUE, $3, $3)`,
      [sourceId, `https://example.com/wiki/${suffix}`, at],
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
      `INSERT INTO document_fragments (
         id, document_source_id, document_snapshot_id, source_uri, chunk_index,
         text, content_hash, embedding, created_at, embedding_profile_id
       ) VALUES ($1, $2, $3, $4, 0, 'CNY 5,000', $5,
         '[0,0,0,0,0,0]', $6, 'static-dev-6d')`,
      [fragmentId, sourceId, snapshotId, `https://example.com/wiki/${suffix}`,
        "c".repeat(64), at],
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

  it("uses skip-locked claims and recovers an expired processing lease", async () => {
    const repository = createPostgresKnowledgeConflictRepository({ dataSource: pool! });
    const first = await repository.claimNextScan({ workerId: "worker-1", at, leaseUntil });
    expect(first?.memory.id).toBe(memoryIds[0]);

    const second = await repository.claimNextScan({ workerId: "worker-2", at, leaseUntil });
    expect(second?.scan.id).not.toBe(first?.scan.id);

    const recovered = await repository.claimNextScan({
      workerId: "worker-3",
      at: new Date("2026-08-13T02:00:31.000Z"),
      leaseUntil: new Date("2026-08-13T02:01:01.000Z"),
    });
    expect(recovered?.scan.id).toBe(first?.scan.id);
    expect(recovered?.scan.attemptCount).toBe(2);
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
          ],
        },
      },
      at,
    };

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
    expect(evidenceFacts.rows).toHaveLength(5);
    expect(evidenceFacts.rows).toContainEqual({ evidence_type: "document_source", source_updated_at: at });
    await expect(pool!.query(
      "UPDATE knowledge_conflict_evidence SET reference_id = 'D2' WHERE candidate_id = $1",
      [candidateId],
    )).rejects.toThrow(/append-only/iu);

    const approval = await repository.approveForDelivery({
      candidateId,
      expectedVersion: 1,
      operationKey: `approve-${suffix}`,
      actorType: "admin_role",
      actorRef: "knowledge-admin",
      reasonCode: "reviewed",
      at,
    });
    expect(approval).toMatchObject({
      outcome: "applied",
      candidate: { status: "approved_for_delivery", version: 2 },
      delivery: { status: "pending" },
    });
    await expect(repository.approveForDelivery({
      candidateId,
      expectedVersion: 1,
      operationKey: `approve-${suffix}`,
      actorType: "admin_role",
      actorRef: "knowledge-admin",
      reasonCode: "reviewed",
      at,
    })).resolves.toMatchObject({ outcome: "already_applied", delivery: { id: approval.delivery.id } });

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
    await expect(repository.completeDelivery({
      deliveryId: approval.delivery.id,
      workerId: "delivery-worker",
      messageId: `om-${suffix}`,
      at,
    })).resolves.toMatchObject({
      delivery: { status: "sent" },
      candidate: { status: "delivered", version: 3 },
    });

    await expect(repository.findCurrentOverlap({
      groupId,
      groupMemoryIds: [memoryId],
      documents: [{ sourceId, snapshotId }],
      permissionAttestedAt: at,
      at,
    })).resolves.toMatchObject({ id: candidateId, status: "delivered" });

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
    await expect(repository.recordInteraction(interaction)).resolves.toMatchObject({ outcome: "applied" });
    await expect(repository.recordInteraction(interaction)).resolves.toMatchObject({
      outcome: "already_applied",
    });
    await expect(repository.recordInteraction({ ...interaction, reasonCode: "changed" }))
      .rejects.toBeInstanceOf(KnowledgeConflictOperationConflictError);

    const changedAt = new Date("2026-08-13T02:00:01.000Z");
    await pool!.query("UPDATE document_sources SET updated_at = $2 WHERE id = $1", [sourceId, changedAt]);
    await expect(repository.validateCandidateCurrentState({
      candidateId,
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

function candidateClient(input: { existingCandidate?: boolean; completedScan?: boolean } = {}) {
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
      if (sql.includes("FROM knowledge_conflict_delivery_outbox")) {
        return { rows: [deliveryRow({ status: "outcome_unknown" })] };
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
