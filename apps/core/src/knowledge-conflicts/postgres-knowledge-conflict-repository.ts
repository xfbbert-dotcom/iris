import { createHash, randomUUID } from "node:crypto";

import type {
  CreateKnowledgeConflictCandidateInput,
  KnowledgeConflictCandidateEvent,
  KnowledgeConflictDelivery,
  KnowledgeConflictDeliveryClaim,
  KnowledgeConflictInteraction,
  KnowledgeConflictMutationResult,
  KnowledgeConflictRepository,
  RecordKnowledgeConflictDetectionInput,
  RecordKnowledgeConflictDetectionResult,
  KnowledgeConflictScan,
  KnowledgeConflictScanClaim,
  KnowledgeConflictScanMaintenanceOutcome,
  KnowledgeConflictScanOperationResult,
} from "./knowledge-conflict-repository.js";
import {
  KnowledgeConflictDeliveryConflictError,
  KnowledgeConflictLeaseConflictError,
  KnowledgeConflictNotFoundError,
  KnowledgeConflictOperationConflictError,
  KnowledgeConflictStaleEvidenceError,
  KnowledgeConflictTargetPolicyConflictError,
  KnowledgeConflictVersionConflictError,
} from "./knowledge-conflict-repository.js";
export {
  KnowledgeConflictDeliveryConflictError,
  KnowledgeConflictLeaseConflictError,
  KnowledgeConflictNotFoundError,
  KnowledgeConflictOperationConflictError,
  KnowledgeConflictStaleEvidenceError,
  KnowledgeConflictTargetPolicyConflictError,
  KnowledgeConflictVersionConflictError,
} from "./knowledge-conflict-repository.js";
import type {
  KnowledgeConflictCandidate,
  KnowledgeConflictCandidateStatus,
  KnowledgeConflictEvidenceReference,
} from "./knowledge-conflict.js";
import { parseKnowledgeConflictPlan } from "./knowledge-conflict.js";
import type {
  GroupMemory,
  GroupMemoryCategory,
  GroupMemoryOrigin,
  GroupMemoryScope,
  GroupMemoryStatus,
} from "../memory/group-memory-repository.js";

export type PostgresKnowledgeConflictQueryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export type PostgresKnowledgeConflictTransactionClient =
  PostgresKnowledgeConflictQueryable & { release(): void };

export type PostgresKnowledgeConflictDataSource = PostgresKnowledgeConflictQueryable & {
  connect(): Promise<PostgresKnowledgeConflictTransactionClient>;
};

type ScanRow = {
  id: string;
  group_id: string;
  group_memory_id: string;
  memory_updated_at: Date;
  status: KnowledgeConflictScan["status"];
  attempt_count: string | number;
  next_attempt_at: Date;
  lease_worker_id: string | null;
  lease_until: Date | null;
  terminal_outcome: KnowledgeConflictScan["terminalOutcome"] | null;
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
};

type MemoryRow = {
  id: string;
  group_id: string;
  memory_scope: GroupMemoryScope;
  category: GroupMemoryCategory;
  thread_key: string | null;
  content: string;
  importance: string | number;
  confidence: string | number;
  status: GroupMemoryStatus;
  idempotency_key: string;
  origin: GroupMemoryOrigin;
  created_by: string;
  supersedes_memory_id: string | null;
  evidence_message_ids: string[];
  created_at: Date;
  updated_at: Date;
};

type ClaimRow = ScanRow & {
  memory_id: string;
  memory_group_id: string;
  memory_memory_scope: GroupMemoryScope;
  memory_category: GroupMemoryCategory;
  memory_thread_key: string | null;
  memory_content: string;
  memory_importance: string | number;
  memory_confidence: string | number;
  memory_status: GroupMemoryStatus;
  memory_idempotency_key: string;
  memory_origin: GroupMemoryOrigin;
  memory_created_by: string;
  memory_supersedes_memory_id: string | null;
  memory_evidence_message_ids: string[];
  memory_created_at: Date;
  memory_updated_at: Date;
};

type MaintenanceRow = ScanRow & {
  maintenance_outcome: KnowledgeConflictScanMaintenanceOutcome["outcome"];
};

type CountRow = { existing_count: string | number };
type StatusCountRow = { status: KnowledgeConflictScan["status"]; count: string | number };

type CandidateRow = {
  id: string;
  idempotency_key: string;
  group_id: string;
  group_memory_id: string;
  memory_updated_at: Date;
  source_message_id: string;
  target_document_source_id: string;
  target_source_updated_at: Date;
  target_source_version: string | null;
  target_snapshot_id: string;
  target_content_hash: string;
  detector_contract_version: string;
  status: KnowledgeConflictCandidateStatus;
  subject: string;
  knowledge_base_statement: string;
  group_conclusion_statement: string;
  difference: string;
  suggested_update: string;
  target_document_ref: string;
  confidence: "high" | "medium";
  version: string | number;
  created_at: Date;
  updated_at: Date;
};

type EvidenceRow = {
  id: string | number;
  candidate_id: string;
  evidence_type: KnowledgeConflictEvidenceReference["type"];
  reference_id: string;
  group_id: string | null;
  conversation_message_id: string | null;
  group_memory_id: string | null;
  source_updated_at: Date | null;
  document_source_id: string | null;
  document_snapshot_id: string | null;
  document_fragment_id: string | null;
  snapshot_content_hash: string | null;
  content_hash: string | null;
  created_at: Date;
};

type DeliveryRow = {
  id: string;
  candidate_id: string;
  group_id: string;
  status: KnowledgeConflictDelivery["status"];
  retryable: boolean;
  attempt_count: string | number;
  next_attempt_at: Date;
  lease_worker_id: string | null;
  lease_until: Date | null;
  external_attempt_started_at: Date | null;
  reconciliation_due_at: Date | null;
  reconciliation_operation_key: string | null;
  reconciliation_outcome: "sent" | "not_sent" | null;
  reconciled_at: Date | null;
  sent_message_id: string | null;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
};

type DeliveryCandidateRow = DeliveryRow & {
  [key: `candidate_${string}`]: unknown;
};

type EventRow = {
  id: string;
  candidate_id: string;
  operation_key: string;
  actor_type: KnowledgeConflictCandidateEvent["actorType"];
  actor_ref: string;
  from_status: KnowledgeConflictCandidateStatus | null;
  to_status: KnowledgeConflictCandidateStatus;
  from_version: string | number | null;
  to_version: string | number;
  reason_code: string;
  created_at: Date;
};

type InteractionRow = {
  id: string;
  candidate_id: string;
  callback_operation_key: string;
  actor_ref: string;
  action: KnowledgeConflictInteraction["action"];
  result: KnowledgeConflictInteraction["result"];
  draft_id: string | null;
  reason_code: string | null;
  created_at: Date;
};

type ReconciliationRow = {
  operation_key: string;
  delivery_id: string;
  attempt_count: string | number;
  outcome: "sent" | "not_sent";
  sent_message_id: string | null;
  actor_ref: string;
  created_at: Date;
};

type ScanOperationRow = {
  operation_key: string;
  scan_id: string;
  group_id: string;
  actor_ref: string;
  action: "replay" | "delete";
  expected_attempt_count: string | number;
  expected_updated_at: Date;
  result_status: "pending" | "deleted";
  created_at: Date;
};

type SourceValidationRow = {
  id: string;
  authorized_space_id: string | null;
  source_type: string;
  permission_state: string;
  sync_state: string;
  can_use_for_knowledge_drafts: boolean;
  updated_at: Date;
  evidence_timestamp_current: boolean;
  candidate_timestamp_current: boolean;
};

type SnapshotValidationRow = {
  id: string;
  document_source_id: string;
  fetch_status: string;
  content_hash: string | null;
  source_version: string | null;
  fetched_at: Date;
};

const MAX_BATCH_SIZE = 50;
const MAX_SCAN_ATTEMPTS = 5;
const MAX_REFERENCE_CHARS = 512;
const MAX_ERROR_CODE_CHARS = 128;
const DEFAULT_MAX_PERMISSION_ATTESTATION_AGE_MS = 60_000;
const ANSWER_VISIBLE_CANDIDATE_STATUSES = new Set<KnowledgeConflictCandidateStatus>([
  "pending_review",
  "approved_for_delivery",
  "delivered",
  "draft_created",
]);

export function createPostgresKnowledgeConflictRepository({
  dataSource,
  createId = randomUUID,
  maxScanAttempts = MAX_SCAN_ATTEMPTS,
  maxPermissionAttestationAgeMs = DEFAULT_MAX_PERMISSION_ATTESTATION_AGE_MS,
}: {
  dataSource: PostgresKnowledgeConflictDataSource;
  createId?: () => string;
  maxScanAttempts?: number;
  maxPermissionAttestationAgeMs?: number;
}): KnowledgeConflictRepository {
  const attemptLimit = requireAttemptLimit(maxScanAttempts);
  const permissionAgeMs = requirePositiveSafeInteger(
    "maxPermissionAttestationAgeMs",
    maxPermissionAttestationAgeMs,
  );
  return {
    discoverEligibleScans(input) {
      return discoverEligibleScans(dataSource, createId, input);
    },
    maintainNextScan(input) {
      return maintainNextScan(dataSource, attemptLimit, input);
    },
    claimNextScan(input) {
      return claimNextScan(dataSource, attemptLimit, input);
    },
    completeScan(input) {
      return completeScan(dataSource, input);
    },
    failScan(input) {
      return failScan(dataSource, attemptLimit, input);
    },
    listDeadLetterScans(input) {
      return listDeadLetterScans(dataSource, input);
    },
    replayDeadLetterScan(input) {
      return replayDeadLetterScan(dataSource, input);
    },
    deleteDeadLetterScan(input) {
      return deleteDeadLetterScan(dataSource, input);
    },
    getScanStatusCounts() {
      return getScanStatusCounts(dataSource);
    },
    recordDetectionResult(input) {
      return recordDetectionResult(dataSource, createId, permissionAgeMs, input);
    },
    getCandidate(id) {
      return loadCandidate(dataSource, requireReference("candidate id", id));
    },
    listCandidates(input) {
      return listCandidates(dataSource, input);
    },
    listCandidateEvents(input) {
      return listCandidateEvents(dataSource, input);
    },
    validateCandidateCurrentState(input) {
      return validateCandidateCurrentState(dataSource, createId, permissionAgeMs, input);
    },
    dismissCandidate(input) {
      return dismissCandidate(dataSource, createId, input);
    },
    approveForDelivery(input) {
      return approveForDelivery(dataSource, createId, input);
    },
    claimNextDelivery(input) {
      return claimNextDelivery(dataSource, input);
    },
    beginDeliveryAttempt(input) {
      return beginDeliveryAttempt(dataSource, input);
    },
    completeDelivery(input) {
      return completeDelivery(dataSource, createId, input);
    },
    failDelivery(input) {
      return failDelivery(dataSource, input);
    },
    reconcileDelivery(input) {
      return reconcileDelivery(dataSource, createId, input);
    },
    getDelivery(id) {
      return loadDelivery(dataSource, requireReference("delivery id", id));
    },
    getDeliveryForCandidate(candidateId) {
      return loadDeliveryByCandidate(dataSource, requireReference("candidate id", candidateId));
    },
    recordInteraction(input) {
      return recordInteraction(dataSource, input);
    },
    applyInteraction(input) {
      return applyInteraction(dataSource, createId, permissionAgeMs, input);
    },
    findCurrentOverlap(input) {
      return findCurrentOverlap(dataSource, permissionAgeMs, input);
    },
    getCandidateStatusCounts() {
      return getCandidateStatusCounts(dataSource);
    },
    getDeliveryStatusCounts() {
      return getDeliveryStatusCounts(dataSource);
    },
    getInteractionResultCounts() {
      return getInteractionResultCounts(dataSource);
    },
  };
}

export async function lockCurrentKnowledgeConflictCandidateForAnswerSend(
  client: PostgresKnowledgeConflictTransactionClient,
  input: {
    candidateId: string;
    expectedVersion?: number;
    expectedGroupId?: string;
  },
): Promise<{ candidateId: string; candidateVersion: number; groupId: string }> {
  const candidateId = requireReference("candidateId", input.candidateId);
  const expectedGroupId = input.expectedGroupId === undefined
    ? undefined
    : requireReference("expectedGroupId", input.expectedGroupId);
  const expectedVersion = input.expectedVersion === undefined
    ? undefined
    : requirePositiveSafeInteger("expectedVersion", input.expectedVersion);
  const candidate = await lockCandidateMemoryBeforeCandidate(client, candidateId);
  const candidateVersion = requirePositiveSafeInteger("candidate version", Number(candidate.version));
  if (
    (expectedGroupId !== undefined && candidate.group_id !== expectedGroupId)
    || (expectedVersion !== undefined && candidateVersion !== expectedVersion)
    || !ANSWER_VISIBLE_CANDIDATE_STATUSES.has(candidate.status)
  ) {
    throw new KnowledgeConflictVersionConflictError();
  }
  const evidence = await loadEvidence(client, candidateId);
  const staleReason = await findStaleReason(client, candidate, evidence);
  if (staleReason !== undefined) throw new KnowledgeConflictStaleEvidenceError(staleReason);
  return { candidateId, candidateVersion, groupId: candidate.group_id };
}

async function discoverEligibleScans(
  dataSource: PostgresKnowledgeConflictDataSource,
  createId: () => string,
  input: { groupIds: readonly string[]; limit: number; at: Date },
): Promise<{ discovered: number; existing: number }> {
  const groupIds = normalizeGroupIds(input.groupIds);
  const limit = requireLimit(input.limit);
  const at = requireDate("at", input.at);
  if (groupIds.length === 0 || limit === 0) return { discovered: 0, existing: 0 };

  return withTransaction(dataSource, async (client) => {
    const eligible = await client.query<Pick<MemoryRow, "id" | "group_id" | "updated_at">>(
      `${eligibleMemorySelect()}
       AND NOT EXISTS (
         SELECT 1 FROM knowledge_conflict_scan_inbox inbox
         WHERE inbox.group_memory_id = gm.id
           AND inbox.memory_updated_at = gm.updated_at
       )
       ORDER BY gm.updated_at ASC, gm.id ASC
       LIMIT $2
       FOR UPDATE OF gm SKIP LOCKED`,
      [groupIds, limit],
    );

    let discovered = 0;
    for (const row of eligible.rows) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO knowledge_conflict_scan_inbox (
           id, group_id, group_memory_id, memory_updated_at, status,
           attempt_count, next_attempt_at, created_at, updated_at
         )
         SELECT $1, gm.group_id, gm.id, gm.updated_at, 'pending', 0, $4, $4, $4
         FROM group_memories gm
         WHERE gm.id = $2 AND gm.group_id = $3
         ON CONFLICT (group_memory_id, memory_updated_at) DO NOTHING
         RETURNING id`,
        [requireReference("scan id", createId()), row.id, row.group_id, at],
      );
      discovered += inserted.rows.length;
    }

    const existingResult = await client.query<CountRow>(
      `SELECT count(*) AS existing_count
       FROM group_memories gm
       WHERE gm.group_id = ANY($1::text[])
         AND gm.memory_scope = 'group'
         AND gm.category IN ('decision', 'workflow', 'term')
         AND gm.confidence >= 0.80
         AND gm.importance >= 3
         AND gm.status = 'active'
         AND EXISTS (${currentEvidenceExistsSql()})
         AND EXISTS (
           SELECT 1 FROM knowledge_conflict_scan_inbox inbox
           WHERE inbox.group_memory_id = gm.id
             AND inbox.memory_updated_at = gm.updated_at
         )`,
      [groupIds],
    );
    const existing = requireCount(existingResult.rows[0]?.existing_count ?? 0);
    return { discovered, existing: Math.max(0, existing - discovered) };
  });
}

async function claimNextScan(
  dataSource: PostgresKnowledgeConflictDataSource,
  attemptLimit: number,
  input: { groupIds: readonly string[]; workerId: string; at: Date; leaseUntil: Date },
): Promise<KnowledgeConflictScanClaim | undefined> {
  const groupIds = normalizeGroupIds(input.groupIds);
  if (groupIds.length === 0) return undefined;
  const workerId = requireReference("workerId", input.workerId);
  const at = requireDate("at", input.at);
  const leaseUntil = requireDate("leaseUntil", input.leaseUntil);
  if (leaseUntil.getTime() <= at.getTime()) throw new Error("leaseUntil must be after at");

  return withTransaction(dataSource, async (client) => {
    const result = await client.query<ClaimRow>(
      `WITH claimable AS (
         SELECT inbox.id
         FROM knowledge_conflict_scan_inbox inbox
         WHERE (
           (inbox.status IN ('pending', 'retry') AND inbox.next_attempt_at <= $1)
           OR (inbox.status = 'processing' AND inbox.lease_until <= $1)
         )
           AND inbox.group_id = ANY($4::text[])
           AND inbox.attempt_count < $5
           AND ${currentScanFactsExistSql("inbox")}
         ORDER BY inbox.next_attempt_at ASC, inbox.created_at ASC, inbox.id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE knowledge_conflict_scan_inbox inbox
         SET status = 'processing', attempt_count = inbox.attempt_count + 1,
             lease_worker_id = $2, lease_until = $3, last_error_code = NULL,
             updated_at = $1
         FROM claimable
         WHERE inbox.id = claimable.id
         RETURNING inbox.*
       )
       SELECT claimed.*,
         gm.id AS memory_id,
         gm.group_id AS memory_group_id,
         gm.memory_scope AS memory_memory_scope,
         gm.category AS memory_category,
         gm.thread_key AS memory_thread_key,
         gm.content AS memory_content,
         gm.importance AS memory_importance,
         gm.confidence AS memory_confidence,
         gm.status AS memory_status,
         gm.idempotency_key AS memory_idempotency_key,
         gm.origin AS memory_origin,
         gm.created_by AS memory_created_by,
         gm.supersedes_memory_id AS memory_supersedes_memory_id,
         gm.created_at AS memory_created_at,
         gm.updated_at AS memory_updated_at,
         ARRAY_AGG(evidence.conversation_message_id ORDER BY evidence.conversation_message_id)
           AS memory_evidence_message_ids
       FROM claimed
       JOIN group_memories gm
         ON gm.id = claimed.group_memory_id
        AND gm.group_id = claimed.group_id
        AND gm.updated_at = claimed.memory_updated_at
        AND gm.status = 'active'
       JOIN group_memory_message_evidence evidence ON evidence.memory_id = gm.id
       JOIN conversation_messages message
         ON message.id = evidence.conversation_message_id
        AND message.chat_id = gm.group_id
       LEFT JOIN conversation_message_deletion_tombstones tombstone
         ON tombstone.conversation_message_id = message.id
       WHERE tombstone.conversation_message_id IS NULL
       GROUP BY claimed.id, claimed.group_id, claimed.group_memory_id,
         claimed.memory_updated_at, claimed.status, claimed.attempt_count,
         claimed.next_attempt_at, claimed.lease_worker_id, claimed.lease_until,
         claimed.terminal_outcome, claimed.last_error_code, claimed.created_at,
         claimed.updated_at, gm.id`,
      [at, workerId, leaseUntil, groupIds, attemptLimit],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      scan: mapScan(row) as KnowledgeConflictScan & { status: "processing" },
      memory: mapClaimMemory(row),
    };
  });
}

async function maintainNextScan(
  dataSource: PostgresKnowledgeConflictDataSource,
  attemptLimit: number,
  input: { groupIds: readonly string[]; at: Date },
): Promise<KnowledgeConflictScanMaintenanceOutcome | undefined> {
  const groupIds = normalizeGroupIds(input.groupIds);
  if (groupIds.length === 0) return undefined;
  const at = requireDate("at", input.at);
  const currentFacts = currentScanFactsExistSql("inbox");
  const result = await dataSource.query<MaintenanceRow>(
    `WITH maintainable AS (
       SELECT inbox.id,
         CASE WHEN NOT ${currentFacts}
           THEN 'superseded' ELSE 'dead_lettered' END AS maintenance_outcome
       FROM knowledge_conflict_scan_inbox inbox
       WHERE inbox.group_id = ANY($2::text[])
         AND (
           (inbox.status IN ('pending', 'retry') AND NOT ${currentFacts})
           OR (
             inbox.status = 'processing'
             AND inbox.lease_until <= $1
             AND (NOT ${currentFacts} OR inbox.attempt_count >= $3)
           )
           OR (
             inbox.status IN ('pending', 'retry')
             AND inbox.next_attempt_at <= $1
             AND inbox.attempt_count >= $3
           )
         )
       ORDER BY inbox.next_attempt_at ASC, inbox.created_at ASC, inbox.id ASC
       LIMIT 1
       FOR UPDATE OF inbox SKIP LOCKED
     ), maintained AS (
       UPDATE knowledge_conflict_scan_inbox inbox
       SET status = CASE maintainable.maintenance_outcome
             WHEN 'superseded' THEN 'completed' ELSE 'dead_lettered' END,
           terminal_outcome = CASE maintainable.maintenance_outcome
             WHEN 'superseded' THEN 'superseded' ELSE NULL END,
           last_error_code = CASE maintainable.maintenance_outcome
             WHEN 'dead_lettered' THEN 'scan_attempts_exhausted' ELSE NULL END,
           lease_worker_id = NULL, lease_until = NULL, updated_at = $1
       FROM maintainable
       WHERE inbox.id = maintainable.id
       RETURNING inbox.*, maintainable.maintenance_outcome
     )
     SELECT * FROM maintained`,
    [at, groupIds, attemptLimit],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const scanId = requireReference("scan id", row.id);
  return row.maintenance_outcome === "superseded"
    ? { outcome: "superseded", scanId }
    : { outcome: "dead_lettered", scanId, errorCode: "scan_attempts_exhausted" };
}

async function completeScan(
  dataSource: PostgresKnowledgeConflictDataSource,
  input: {
    scanId: string;
    workerId: string;
    outcome: Exclude<NonNullable<KnowledgeConflictScan["terminalOutcome"]>, "conflict">;
    at: Date;
  },
): Promise<KnowledgeConflictScan> {
  const result = await dataSource.query<ScanRow>(
    `UPDATE knowledge_conflict_scan_inbox
     SET status = 'completed', terminal_outcome = $3, lease_worker_id = NULL,
         lease_until = NULL, last_error_code = NULL, updated_at = $4
     WHERE id = $1 AND status = 'processing' AND lease_worker_id = $2
     RETURNING *`,
    [requireReference("scanId", input.scanId), requireReference("workerId", input.workerId),
      requireTerminalOutcome(input.outcome), requireDate("at", input.at)],
  );
  const row = result.rows[0];
  if (row === undefined) throw new KnowledgeConflictLeaseConflictError();
  return mapScan(row);
}

async function failScan(
  dataSource: PostgresKnowledgeConflictDataSource,
  maxScanAttempts: number,
  input: {
    scanId: string;
    workerId: string;
    classification: "retryable" | "permanent";
    errorCode: string;
    retryAt?: Date;
    at: Date;
  },
): Promise<{ status: "retry" | "dead_lettered" }> {
  const retryAt = input.retryAt === undefined ? undefined : requireDate("retryAt", input.retryAt);
  if (input.classification === "retryable" && retryAt === undefined) {
    throw new Error("retryAt is required for retryable scan failures");
  }
  const result = await dataSource.query<{ status: "retry" | "dead_lettered" }>(
    `UPDATE knowledge_conflict_scan_inbox
     SET status = CASE
           WHEN $3 = 'retryable' AND attempt_count < $4 THEN 'retry'
           ELSE 'dead_lettered'
         END,
         next_attempt_at = CASE
           WHEN $3 = 'retryable' AND attempt_count < $4 THEN $5
           ELSE next_attempt_at
         END,
         lease_worker_id = NULL, lease_until = NULL, last_error_code = $6, updated_at = $7
     WHERE id = $1 AND status = 'processing' AND lease_worker_id = $2
     RETURNING status`,
    [requireReference("scanId", input.scanId), requireReference("workerId", input.workerId),
      input.classification, maxScanAttempts, retryAt ?? null,
      requireBoundedString("errorCode", input.errorCode, MAX_ERROR_CODE_CHARS),
      requireDate("at", input.at)],
  );
  const row = result.rows[0];
  if (row === undefined) throw new KnowledgeConflictLeaseConflictError();
  return { status: row.status };
}

async function listDeadLetterScans(
  dataSource: PostgresKnowledgeConflictDataSource,
  input: { limit: number },
): Promise<KnowledgeConflictScan[]> {
  const result = await dataSource.query<ScanRow>(
    `SELECT * FROM knowledge_conflict_scan_inbox
     WHERE status = 'dead_lettered'
     ORDER BY updated_at ASC, id ASC
     LIMIT $1`,
    [requireLimit(input.limit)],
  );
  return result.rows.map(mapScan);
}

async function replayDeadLetterScan(
  dataSource: PostgresKnowledgeConflictDataSource,
  input: Parameters<KnowledgeConflictRepository["replayDeadLetterScan"]>[0],
): Promise<KnowledgeConflictScanOperationResult> {
  return applyDeadLetterScanOperation(dataSource, { ...input, action: "replay" });
}

async function deleteDeadLetterScan(
  dataSource: PostgresKnowledgeConflictDataSource,
  input: Parameters<KnowledgeConflictRepository["deleteDeadLetterScan"]>[0],
): Promise<KnowledgeConflictScanOperationResult> {
  return applyDeadLetterScanOperation(dataSource, { ...input, action: "delete" });
}

async function applyDeadLetterScanOperation(
  dataSource: PostgresKnowledgeConflictDataSource,
  input: Parameters<KnowledgeConflictRepository["replayDeadLetterScan"]>[0] & {
    action: "replay" | "delete";
  },
): Promise<KnowledgeConflictScanOperationResult> {
  const scanId = requireReference("scanId", input.scanId);
  const operationKey = requireReference("operationKey", input.operationKey);
  const actorRef = requireReference("actorRef", input.actorRef);
  const expectedAttemptCount = requireAttemptCount(
    "expectedAttemptCount",
    input.expectedAttemptCount,
  );
  const expectedUpdatedAt = requireDate("expectedUpdatedAt", input.expectedUpdatedAt);
  const at = requireDate("at", input.at);
  const resultStatus = input.action === "replay" ? "pending" as const : "deleted" as const;
  return withTransaction(dataSource, async (client) => {
    await lockOperationKey(client, operationKey);
    const existingResult = await client.query<ScanOperationRow>(
      "SELECT * FROM knowledge_conflict_scan_operations WHERE operation_key = $1",
      [operationKey],
    );
    const existing = existingResult.rows[0];
    if (existing !== undefined) {
      if (existing.scan_id !== scanId
        || existing.actor_ref !== actorRef
        || existing.action !== input.action
        || requireAttemptCount("stored expected attempt count", existing.expected_attempt_count)
          !== expectedAttemptCount
        || requireDate("stored expected updated at", existing.expected_updated_at).getTime()
          !== expectedUpdatedAt.getTime()
        || existing.result_status !== resultStatus) {
        throw new KnowledgeConflictOperationConflictError();
      }
      return { outcome: "already_applied", scanId, status: existing.result_status };
    }

    const scan = await lockScan(client, scanId);
    if (scan.status !== "dead_lettered"
      || requireAttemptCount("scan attempt count", scan.attempt_count) !== expectedAttemptCount
      || requireDate("scan updated at", scan.updated_at).getTime() !== expectedUpdatedAt.getTime()) {
      throw new KnowledgeConflictLeaseConflictError();
    }
    if (input.action === "replay") {
      const updated = await client.query<ScanRow>(
        `UPDATE knowledge_conflict_scan_inbox
         SET status = 'pending', attempt_count = 0, next_attempt_at = $2,
             last_error_code = NULL, lease_worker_id = NULL, lease_until = NULL, updated_at = $2
         WHERE id = $1 AND status = 'dead_lettered'
         RETURNING *`,
        [scanId, at],
      );
      if (updated.rows[0] === undefined) throw new KnowledgeConflictLeaseConflictError();
    }
    await client.query<ScanOperationRow>(
      `INSERT INTO knowledge_conflict_scan_operations (
         operation_key, scan_id, group_id, actor_ref, action, expected_attempt_count,
         expected_updated_at, result_status, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [operationKey, scanId, scan.group_id, actorRef, input.action, expectedAttemptCount,
        expectedUpdatedAt, resultStatus, at],
    );
    if (input.action === "delete") {
      const deleted = await client.query<{ id: string }>(
        `DELETE FROM knowledge_conflict_scan_inbox
         WHERE id = $1 AND status = 'dead_lettered'
         RETURNING id`,
        [scanId],
      );
      if (deleted.rows[0] === undefined) throw new KnowledgeConflictLeaseConflictError();
    }
    return { outcome: "applied", scanId, status: resultStatus };
  });
}

async function getScanStatusCounts(dataSource: PostgresKnowledgeConflictDataSource) {
  const result = await dataSource.query<StatusCountRow>(
    "SELECT status, count(*) AS count FROM knowledge_conflict_scan_inbox GROUP BY status",
  );
  const counts = { pending: 0, processing: 0, retry: 0, completed: 0, deadLettered: 0 };
  for (const row of result.rows) {
    const count = requireCount(row.count);
    if (row.status === "dead_lettered") counts.deadLettered = count;
    else counts[row.status] = count;
  }
  return counts;
}

async function recordDetectionResult(
  dataSource: PostgresKnowledgeConflictDataSource,
  createId: () => string,
  maxPermissionAgeMs: number,
  input: RecordKnowledgeConflictDetectionInput,
): Promise<RecordKnowledgeConflictDetectionResult> {
  const scanId = requireReference("scanId", input.scanId);
  const workerId = requireReference("workerId", input.workerId);
  const at = requireDate("at", input.at);
  return withTransaction(dataSource, async (client) => {
    const scan = await lockScan(client, scanId);
    if (input.result.outcome !== "conflict") {
      requireOwnedProcessingScan(scan, workerId);
      const completed = await completeOwnedScan(
        client,
        scanId,
        workerId,
        input.result.outcome,
        at,
      );
      return { outcome: "completed", scan: completed as KnowledgeConflictScan & { status: "completed" } };
    }

    const candidateInput = normalizeCandidateInput(input.result.candidate, at);
    if (scan.group_id !== candidateInput.groupId
      || scan.group_memory_id !== candidateInput.groupMemoryId
      || scan.memory_updated_at.getTime() !== candidateInput.memoryUpdatedAt.getTime()) {
      throw new KnowledgeConflictStaleEvidenceError("scan_identity_mismatch");
    }
    const existingResult = await client.query<CandidateRow>(
      "SELECT * FROM knowledge_conflict_candidates WHERE idempotency_key = $1 FOR UPDATE",
      [candidateInput.idempotencyKey],
    );
    const existing = existingResult.rows[0];
    if (existing !== undefined) {
      const evidence = await loadEvidence(client, existing.id);
      if (!candidateMatchesInput(existing, evidence, candidateInput)) {
        throw new KnowledgeConflictOperationConflictError();
      }
      if (scan.status !== "completed" || scan.terminal_outcome !== "conflict") {
        requireOwnedProcessingScan(scan, workerId);
        await completeOwnedScan(client, scanId, workerId, "conflict", at);
      }
      return {
        outcome: "already_applied",
        candidate: mapCandidate(existing, evidence),
        scan: mapScan({
          ...scan,
          status: "completed",
          terminal_outcome: "conflict",
          lease_worker_id: null,
          lease_until: null,
          updated_at: at,
        }) as KnowledgeConflictScan & { status: "completed"; terminalOutcome: "conflict" },
      };
    }

    requireOwnedProcessingScan(scan, workerId);
    assertFreshPermission(candidateInput.permissionAttestedAt, at, maxPermissionAgeMs);
    await validateDetectionFingerprint(client, candidateInput);
    await supersedeCompetingCandidates(client, createId, candidateInput, at);
    const inserted = await insertCandidateFacts(client, createId, scanId, candidateInput, at);
    const completed = await completeOwnedScan(client, scanId, workerId, "conflict", at);
    return {
      outcome: "applied",
      candidate: inserted,
      scan: completed as KnowledgeConflictScan & {
        status: "completed";
        terminalOutcome: "conflict";
      },
    };
  });
}

async function lockScan(
  client: PostgresKnowledgeConflictTransactionClient,
  scanId: string,
): Promise<ScanRow> {
  const result = await client.query<ScanRow>(
    "SELECT * FROM knowledge_conflict_scan_inbox WHERE id = $1 FOR UPDATE",
    [scanId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new KnowledgeConflictLeaseConflictError();
  return row;
}

function requireOwnedProcessingScan(scan: ScanRow, workerId: string): void {
  if (scan.status !== "processing" || scan.lease_worker_id !== workerId) {
    throw new KnowledgeConflictLeaseConflictError();
  }
}

async function completeOwnedScan(
  client: PostgresKnowledgeConflictTransactionClient,
  scanId: string,
  workerId: string,
  outcome: NonNullable<KnowledgeConflictScan["terminalOutcome"]>,
  at: Date,
): Promise<KnowledgeConflictScan> {
  const result = await client.query<ScanRow>(
    `UPDATE knowledge_conflict_scan_inbox
     SET status = 'completed', terminal_outcome = $3, lease_worker_id = NULL,
         lease_until = NULL, last_error_code = NULL, updated_at = $4
     WHERE id = $1 AND status = 'processing' AND lease_worker_id = $2
     RETURNING *`,
    [scanId, workerId, outcome, at],
  );
  const row = result.rows[0];
  if (row === undefined) throw new KnowledgeConflictLeaseConflictError();
  return mapScan(row);
}

type NormalizedCandidateInput = Omit<CreateKnowledgeConflictCandidateInput, "at"> & {
  at: Date;
  permissionAttestedAt: Date;
};

function normalizeCandidateInput(
  input: Omit<CreateKnowledgeConflictCandidateInput, "at"> & {
    at?: Date;
    permissionAttestedAt?: Date;
  },
  fallbackAt: Date,
): NormalizedCandidateInput {
  const at = requireDate("candidate at", input.at ?? fallbackAt);
  const evidence = input.evidence.map(normalizeEvidenceReference);
  if (evidence.length < 4 || evidence.length > 50) throw new Error("candidate evidence is invalid");
  const normalized: NormalizedCandidateInput = {
    id: requireReference("candidate id", input.id),
    idempotencyKey: requireReference("candidate idempotency key", input.idempotencyKey),
    groupId: requireReference("candidate group id", input.groupId),
    groupMemoryId: requireReference("candidate memory id", input.groupMemoryId),
    memoryUpdatedAt: requireDate("candidate memory updated at", input.memoryUpdatedAt),
    sourceMessageId: requireReference("candidate source message id", input.sourceMessageId),
    targetDocumentSourceId: requireReference(
      "candidate document source id",
      input.targetDocumentSourceId,
    ),
    targetSourceUpdatedAt: requireDate(
      "candidate source updated at",
      input.targetSourceUpdatedAt,
    ),
    ...(input.targetSourceVersion === undefined
      ? {}
      : { targetSourceVersion: requireReference("candidate source version", input.targetSourceVersion) }),
    targetSnapshotId: requireReference("candidate snapshot id", input.targetSnapshotId),
    targetContentHash: requireHash("candidate target content hash", input.targetContentHash),
    detectorContractVersion: requireBoundedString(
      "candidate detector contract version",
      input.detectorContractVersion,
      128,
    ),
    plan: parseConflictPlan(input.plan, evidence),
    evidence,
    at,
    permissionAttestedAt: requireDate(
      "permissionAttestedAt",
      input.permissionAttestedAt ?? at,
    ),
  };
  validateCandidateEvidenceShape(normalized);
  return normalized;
}

async function validateDetectionFingerprint(
  client: PostgresKnowledgeConflictTransactionClient,
  input: NormalizedCandidateInput,
): Promise<void> {
  const memoryResult = await client.query<MemoryRow>(
    "SELECT * FROM group_memories WHERE id = $1 AND group_id = $2 FOR UPDATE",
    [input.groupMemoryId, input.groupId],
  );
  const memory = memoryResult.rows[0];
  if (
    memory === undefined
    || memory.status !== "active"
    || memory.updated_at.getTime() !== input.memoryUpdatedAt.getTime()
  ) throw new KnowledgeConflictStaleEvidenceError("memory_stale");

  const messageEvidence = input.evidence.filter(
    (item): item is Extract<KnowledgeConflictEvidenceReference, { type: "conversation_message" }> =>
      item.type === "conversation_message",
  );
  const messageResult = await client.query<{ id: string; chat_id: string; sent_at: Date }>(
    `SELECT message.id, message.chat_id, message.sent_at
     FROM conversation_messages message
     JOIN group_memory_message_evidence memory_evidence
       ON memory_evidence.conversation_message_id = message.id
      AND memory_evidence.memory_id = $3
     LEFT JOIN conversation_message_deletion_tombstones tombstone
       ON tombstone.conversation_message_id = message.id
     WHERE message.id = ANY($1::text[])
       AND message.chat_id = $2
       AND tombstone.conversation_message_id IS NULL
     ORDER BY message.id
     FOR UPDATE OF message`,
    [messageEvidence.map((item) => item.conversationMessageId), input.groupId, input.groupMemoryId],
  );
  const actualMessageIds = new Set(messageResult.rows.map((row) => row.id));
  if (messageResult.rows.length !== messageEvidence.length
    || messageEvidence.some((item) => !actualMessageIds.has(item.conversationMessageId))) {
    throw new KnowledgeConflictStaleEvidenceError("message_stale");
  }

  const sourceEvidence = input.evidence.filter(
    (item): item is Extract<KnowledgeConflictEvidenceReference, { type: "document_source" }> =>
      item.type === "document_source",
  ).sort((left, right) => left.documentSourceId.localeCompare(right.documentSourceId));
  for (const expectedSource of sourceEvidence) {
    const sourceResult = await client.query<SourceValidationRow>(
      `SELECT source.id, source.authorized_space_id, source.source_type,
         source.permission_state, source.sync_state,
         source.can_use_for_knowledge_drafts, source.updated_at
       FROM document_sources source
       WHERE source.id = $1
       FOR UPDATE OF source`,
      [expectedSource.documentSourceId],
    );
    const source = sourceResult.rows[0];
    if (
      source === undefined
      || source.id !== expectedSource.documentSourceId
      || source.source_type !== "authorized_wiki_document"
      || !["unknown", "readable"].includes(source.permission_state)
      || source.sync_state !== "synced"
      || !source.can_use_for_knowledge_drafts
      || source.updated_at.getTime() !== expectedSource.expectedUpdatedAt.getTime()
    ) throw new KnowledgeConflictStaleEvidenceError("source_stale");
    if (source.authorized_space_id === null
      || !(await lockAuthorizingPublicationPolicy(client, source.authorized_space_id, input.groupId))) {
      throw new KnowledgeConflictStaleEvidenceError("source_stale");
    }
  }

  const snapshots = input.evidence.filter(
    (item): item is Extract<KnowledgeConflictEvidenceReference, { type: "document_snapshot" }> =>
      item.type === "document_snapshot",
  ).sort((left, right) => left.documentSourceId.localeCompare(right.documentSourceId));
  const snapshotFetchedAts: Date[] = [];
  for (const expectedSnapshot of snapshots) {
    const snapshotResult = await client.query<SnapshotValidationRow>(
      `SELECT id, document_source_id, fetch_status, content_hash, source_version, fetched_at
       FROM document_snapshots
       WHERE document_source_id = $1
       ORDER BY fetched_at DESC, id ASC
       LIMIT 1
       FOR UPDATE`,
      [expectedSnapshot.documentSourceId],
    );
    const snapshot = snapshotResult.rows[0];
    if (
      snapshot === undefined
      || snapshot.document_source_id !== expectedSnapshot.documentSourceId
      || snapshot.fetch_status !== "succeeded"
      || snapshot.id !== expectedSnapshot.documentSnapshotId
      || snapshot.content_hash !== expectedSnapshot.contentHash
      || (expectedSnapshot.documentSourceId === input.targetDocumentSourceId
        && (snapshot.source_version ?? undefined) !== input.targetSourceVersion)
    ) throw new KnowledgeConflictStaleEvidenceError("snapshot_stale");
    snapshotFetchedAts.push(snapshot.fetched_at);
  }
  if (!hasStrictMessageAfterSnapshotChronology(messageResult.rows, snapshotFetchedAts)) {
    throw new KnowledgeConflictStaleEvidenceError("chronology_stale");
  }

  const fragments = input.evidence.filter(
    (item): item is Extract<KnowledgeConflictEvidenceReference, { type: "document_fragment" }> =>
      item.type === "document_fragment",
  );
  if (fragments.length > 0) {
    const fragmentResult = await client.query<{
      id: string;
      document_source_id: string;
      document_snapshot_id: string;
      content_hash: string;
    }>(
      `SELECT id, document_source_id, document_snapshot_id, content_hash
       FROM document_fragments
       WHERE id = ANY($1::text[])
       ORDER BY id
       FOR UPDATE`,
      [fragments.map((item) => item.documentFragmentId)],
    );
    const actual = new Map(fragmentResult.rows.map((row) => [row.id, row]));
    if (fragments.some((item) => {
      const row = actual.get(item.documentFragmentId);
      return row === undefined
        || row.document_source_id !== item.documentSourceId
        || row.document_snapshot_id !== item.documentSnapshotId
        || row.content_hash !== item.contentHash;
    })) throw new KnowledgeConflictStaleEvidenceError("fragment_stale");
  }
}

async function insertCandidateFacts(
  client: PostgresKnowledgeConflictTransactionClient,
  createId: () => string,
  scanId: string,
  input: NormalizedCandidateInput,
  at: Date,
): Promise<KnowledgeConflictCandidate> {
  const result = await client.query<CandidateRow>(
    `INSERT INTO knowledge_conflict_candidates (
       id, idempotency_key, group_id, group_memory_id, memory_updated_at,
       source_message_id, target_document_source_id, target_source_updated_at,
       target_source_version, target_snapshot_id, target_content_hash,
       detector_contract_version, status, subject, knowledge_base_statement,
       group_conclusion_statement, difference, suggested_update, target_document_ref,
       confidence, version, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4,
       (SELECT exact_scan.memory_updated_at
        FROM knowledge_conflict_scan_inbox exact_scan
        WHERE exact_scan.id = $19),
       $5, $6,
       (SELECT exact_source.updated_at
        FROM document_sources exact_source
        WHERE exact_source.id = $6),
       $7, $8, $9, $10,
       'pending_review', $11, $12, $13, $14, $15, $16, $17, 1, $18, $18
     ) RETURNING *`,
    [
      input.id,
      input.idempotencyKey,
      input.groupId,
      input.groupMemoryId,
      input.sourceMessageId,
      input.targetDocumentSourceId,
      input.targetSourceVersion ?? null,
      input.targetSnapshotId,
      input.targetContentHash,
      input.detectorContractVersion,
      input.plan.subject,
      input.plan.knowledgeBaseStatement,
      input.plan.groupConclusionStatement,
      input.plan.difference,
      input.plan.suggestedUpdate,
      input.plan.targetDocumentRef,
      input.plan.confidence,
      at,
      scanId,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("knowledge conflict candidate insert returned no row");
  for (const evidence of input.evidence) await insertEvidence(client, input.id, evidence, at);
  await insertCandidateEvent(client, createId, {
    candidateId: input.id,
    operationKey: derivedOperationKey("detection", input.idempotencyKey),
    actorType: "system",
    actorRef: "knowledge_conflict_detector",
    fromStatus: undefined,
    toStatus: "pending_review",
    fromVersion: undefined,
    toVersion: 1,
    reasonCode: "conflict_detected",
    at,
  });
  return mapCandidate(row, input.evidence);
}

async function insertEvidence(
  client: PostgresKnowledgeConflictTransactionClient,
  candidateId: string,
  evidence: KnowledgeConflictEvidenceReference,
  at: Date,
): Promise<void> {
  const values: unknown[] = [candidateId, evidence.type, evidence.referenceId];
  let groupId: string | null = null;
  let messageId: string | null = null;
  let memoryId: string | null = null;
  let sourceId: string | null = null;
  let snapshotId: string | null = null;
  let fragmentId: string | null = null;
  let snapshotHash: string | null = null;
  let contentHash: string | null = null;
  if (evidence.type === "conversation_message") {
    groupId = evidence.groupId;
    messageId = evidence.conversationMessageId;
  } else if (evidence.type === "group_memory") {
    groupId = evidence.groupId;
    memoryId = evidence.groupMemoryId;
  } else if (evidence.type === "document_source") {
    sourceId = evidence.documentSourceId;
  } else if (evidence.type === "document_snapshot") {
    sourceId = evidence.documentSourceId;
    snapshotId = evidence.documentSnapshotId;
    snapshotHash = evidence.contentHash;
    contentHash = evidence.contentHash;
  } else {
    sourceId = evidence.documentSourceId;
    snapshotId = evidence.documentSnapshotId;
    fragmentId = evidence.documentFragmentId;
    snapshotHash = evidence.snapshotContentHash;
    contentHash = evidence.contentHash;
  }
  values.push(groupId, messageId, memoryId, sourceId, snapshotId,
    fragmentId, snapshotHash, contentHash, at);
  await client.query(
    `INSERT INTO knowledge_conflict_evidence (
       candidate_id, evidence_type, reference_id, group_id, conversation_message_id,
       group_memory_id, source_updated_at, document_source_id, document_snapshot_id,
       document_fragment_id, snapshot_content_hash, content_hash, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       CASE
         WHEN $2 = 'group_memory' THEN (
           SELECT candidate.memory_updated_at
           FROM knowledge_conflict_candidates candidate
           WHERE candidate.id = $1
         )
         WHEN $2 = 'document_source' THEN (
           SELECT source.updated_at
           FROM document_sources source
           WHERE source.id = $7
         )
         ELSE NULL::timestamptz
       END,
       $7, $8, $9, $10, $11, $12
     )`,
    values,
  );
}

async function insertCandidateEvent(
  client: PostgresKnowledgeConflictTransactionClient,
  createId: () => string,
  input: {
    candidateId: string;
    operationKey: string;
    actorType: KnowledgeConflictCandidateEvent["actorType"];
    actorRef: string;
    fromStatus?: KnowledgeConflictCandidateStatus;
    toStatus: KnowledgeConflictCandidateStatus;
    fromVersion?: number;
    toVersion: number;
    reasonCode: string;
    at: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_conflict_candidate_events (
       id, candidate_id, operation_key, actor_type, actor_ref, from_status,
       to_status, from_version, to_version, reason_code, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [requireReference("event id", createId()), input.candidateId, input.operationKey,
      input.actorType, input.actorRef, input.fromStatus ?? null, input.toStatus,
      input.fromVersion ?? null, input.toVersion, input.reasonCode, input.at],
  );
}

async function supersedeCompetingCandidates(
  client: PostgresKnowledgeConflictTransactionClient,
  createId: () => string,
  input: NormalizedCandidateInput,
  at: Date,
): Promise<void> {
  const result = await client.query<CandidateRow>(
    `SELECT * FROM knowledge_conflict_candidates
     WHERE group_memory_id = $1
       AND target_document_source_id = $2
       AND status IN ('pending_review', 'approved_for_delivery', 'delivered')
       AND idempotency_key <> $3
     ORDER BY id
     FOR UPDATE`,
    [input.groupMemoryId, input.targetDocumentSourceId, input.idempotencyKey],
  );
  for (const row of result.rows) {
    await assertAnswerAttemptsAllowCandidateTransition(client, row.id, "superseded");
    const deliveryResult = await client.query<DeliveryRow>(
      `SELECT * FROM knowledge_conflict_delivery_outbox
       WHERE candidate_id = $1
       FOR UPDATE`,
      [row.id],
    );
    const delivery = deliveryResult.rows[0];
    if (delivery?.status === "external_attempting" || delivery?.status === "outcome_unknown") {
      throw new KnowledgeConflictDeliveryConflictError();
    }
    const updatedResult = await client.query<CandidateRow>(
      `UPDATE knowledge_conflict_candidates
       SET status = 'superseded', version = version + 1, updated_at = $2
       WHERE id = $1 AND version = $3
       RETURNING *`,
      [row.id, at, Number(row.version)],
    );
    if (updatedResult.rows[0] === undefined) throw new KnowledgeConflictVersionConflictError();
    await client.query(
      `UPDATE knowledge_conflict_delivery_outbox
       SET status = 'cancelled', lease_worker_id = NULL, lease_until = NULL,
           retryable = TRUE, failure_code = 'superseded', updated_at = $2
       WHERE candidate_id = $1 AND status IN ('pending', 'processing', 'failed')`,
      [row.id, at],
    );
    await insertCandidateEvent(client, createId, {
      candidateId: row.id,
      operationKey: derivedOperationKey("supersede", input.idempotencyKey, row.id),
      actorType: "system",
      actorRef: "knowledge_conflict_detector",
      fromStatus: row.status,
      toStatus: "superseded",
      fromVersion: Number(row.version),
      toVersion: Number(row.version) + 1,
      reasonCode: "new_detection",
      at,
    });
  }
}

async function loadEvidence(
  queryable: PostgresKnowledgeConflictQueryable,
  candidateId: string,
): Promise<KnowledgeConflictEvidenceReference[]> {
  const result = await queryable.query<EvidenceRow>(
    `SELECT * FROM knowledge_conflict_evidence
     WHERE candidate_id = $1
     ORDER BY evidence_type, reference_id, id`,
    [candidateId],
  );
  return result.rows.map(mapEvidence);
}

function mapEvidence(row: EvidenceRow): KnowledgeConflictEvidenceReference {
  if (row.evidence_type === "conversation_message") {
    if (row.group_id === null || row.conversation_message_id === null) throw invalidEvidence();
    return { type: "conversation_message", referenceId: row.reference_id as "C1",
      groupId: row.group_id, conversationMessageId: row.conversation_message_id };
  }
  if (row.evidence_type === "group_memory") {
    if (row.group_id === null || row.group_memory_id === null || row.source_updated_at === null) {
      throw invalidEvidence();
    }
    return { type: "group_memory", referenceId: "M1", groupId: row.group_id,
      groupMemoryId: row.group_memory_id,
      expectedUpdatedAt: requireDate("evidence memory updated at", row.source_updated_at) };
  }
  if (row.evidence_type === "document_source") {
    if (row.document_source_id === null || row.source_updated_at === null) throw invalidEvidence();
    return { type: "document_source", referenceId: row.reference_id as "D1",
      documentSourceId: row.document_source_id,
      expectedUpdatedAt: requireDate("evidence source updated at", row.source_updated_at) };
  }
  if (row.evidence_type === "document_snapshot") {
    if (row.document_source_id === null || row.document_snapshot_id === null
      || row.content_hash === null) throw invalidEvidence();
    return { type: "document_snapshot", referenceId: row.reference_id as "D1",
      documentSourceId: row.document_source_id, documentSnapshotId: row.document_snapshot_id,
      contentHash: row.content_hash };
  }
  if (row.document_source_id === null || row.document_snapshot_id === null
    || row.document_fragment_id === null || row.snapshot_content_hash === null
    || row.content_hash === null) throw invalidEvidence();
  return { type: "document_fragment", referenceId: row.reference_id as "D1",
    documentSourceId: row.document_source_id, documentSnapshotId: row.document_snapshot_id,
    documentFragmentId: row.document_fragment_id,
    snapshotContentHash: row.snapshot_content_hash, contentHash: row.content_hash };
}

function invalidEvidence(): Error {
  return new Error("invalid persisted knowledge conflict evidence");
}

function mapCandidate(
  row: CandidateRow,
  evidence: readonly KnowledgeConflictEvidenceReference[],
): KnowledgeConflictCandidate {
  const knowledgeRefs = uniqueSortedRefs(evidence
    .filter((item) => item.type === "document_snapshot")
    .map((item) => item.referenceId));
  const groupRefs = uniqueSortedRefs(evidence
    .filter((item) => item.type === "group_memory" || item.type === "conversation_message")
    .map((item) => item.referenceId));
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    groupId: row.group_id,
    groupMemoryId: row.group_memory_id,
    memoryUpdatedAt: requireDate("candidate memory updated at", row.memory_updated_at),
    sourceMessageId: row.source_message_id,
    targetDocumentSourceId: row.target_document_source_id,
    targetSourceUpdatedAt: requireDate("candidate source updated at", row.target_source_updated_at),
    ...(row.target_source_version === null ? {} : { targetSourceVersion: row.target_source_version }),
    targetSnapshotId: row.target_snapshot_id,
    targetContentHash: row.target_content_hash,
    detectorContractVersion: row.detector_contract_version,
    status: row.status,
    plan: {
      outcome: "conflict",
      subject: row.subject,
      knowledgeBaseStatement: row.knowledge_base_statement,
      knowledgeBaseCitationRefs: knowledgeRefs,
      groupConclusionStatement: row.group_conclusion_statement,
      groupCitationRefs: groupRefs,
      difference: row.difference,
      suggestedUpdate: row.suggested_update,
      targetDocumentRef: row.target_document_ref,
      missingEvidence: [],
      confidence: row.confidence,
    },
    evidence: evidence.map(cloneEvidence),
    version: requirePositiveInteger("candidate version", row.version),
    createdAt: requireDate("candidate created at", row.created_at),
    updatedAt: requireDate("candidate updated at", row.updated_at),
  };
}

function candidateMatchesInput(
  row: CandidateRow,
  evidence: readonly KnowledgeConflictEvidenceReference[],
  input: NormalizedCandidateInput,
): boolean {
  return row.id === input.id
    && row.group_id === input.groupId
    && row.group_memory_id === input.groupMemoryId
    && row.memory_updated_at.getTime() === input.memoryUpdatedAt.getTime()
    && row.source_message_id === input.sourceMessageId
    && row.target_document_source_id === input.targetDocumentSourceId
    && row.target_source_updated_at.getTime() === input.targetSourceUpdatedAt.getTime()
    && (row.target_source_version ?? undefined) === input.targetSourceVersion
    && row.target_snapshot_id === input.targetSnapshotId
    && row.target_content_hash === input.targetContentHash
    && row.detector_contract_version === input.detectorContractVersion
    && row.subject === input.plan.subject
    && row.knowledge_base_statement === input.plan.knowledgeBaseStatement
    && row.group_conclusion_statement === input.plan.groupConclusionStatement
    && row.difference === input.plan.difference
    && row.suggested_update === input.plan.suggestedUpdate
    && row.target_document_ref === input.plan.targetDocumentRef
    && row.confidence === input.plan.confidence
    && evidenceIdentity(evidence) === evidenceIdentity(input.evidence);
}

function evidenceIdentity(evidence: readonly KnowledgeConflictEvidenceReference[]): string {
  return evidence.map((item) => {
    if (item.type === "conversation_message") {
      return [item.type, item.referenceId, item.groupId, item.conversationMessageId].join("\u0000");
    }
    if (item.type === "group_memory") {
      return [item.type, item.referenceId, item.groupId, item.groupMemoryId,
        item.expectedUpdatedAt.toISOString()].join("\u0000");
    }
    if (item.type === "document_source") {
      return [item.type, item.referenceId, item.documentSourceId,
        item.expectedUpdatedAt.toISOString()].join("\u0000");
    }
    if (item.type === "document_snapshot") {
      return [item.type, item.referenceId, item.documentSourceId,
        item.documentSnapshotId, item.contentHash].join("\u0000");
    }
    return [item.type, item.referenceId, item.documentSourceId, item.documentSnapshotId,
      item.documentFragmentId, item.snapshotContentHash, item.contentHash].join("\u0000");
  }).sort().join("\u0001");
}

function normalizeEvidenceReference(
  evidence: KnowledgeConflictEvidenceReference,
): KnowledgeConflictEvidenceReference {
  if (evidence.type === "conversation_message") {
    return { type: evidence.type, referenceId: evidence.referenceId,
      groupId: requireReference("evidence group id", evidence.groupId),
      conversationMessageId: requireReference("evidence message id", evidence.conversationMessageId) };
  }
  if (evidence.type === "group_memory") {
    return { type: evidence.type, referenceId: "M1",
      groupId: requireReference("evidence group id", evidence.groupId),
      groupMemoryId: requireReference("evidence memory id", evidence.groupMemoryId),
      expectedUpdatedAt: requireDate("evidence memory updated at", evidence.expectedUpdatedAt) };
  }
  if (evidence.type === "document_source") {
    return { type: evidence.type, referenceId: evidence.referenceId,
      documentSourceId: requireReference("evidence source id", evidence.documentSourceId),
      expectedUpdatedAt: requireDate("evidence source updated at", evidence.expectedUpdatedAt) };
  }
  if (evidence.type === "document_snapshot") {
    return { type: evidence.type, referenceId: evidence.referenceId,
      documentSourceId: requireReference("evidence source id", evidence.documentSourceId),
      documentSnapshotId: requireReference("evidence snapshot id", evidence.documentSnapshotId),
      contentHash: requireHash("evidence snapshot hash", evidence.contentHash) };
  }
  return { type: evidence.type, referenceId: evidence.referenceId,
    documentSourceId: requireReference("evidence source id", evidence.documentSourceId),
    documentSnapshotId: requireReference("evidence snapshot id", evidence.documentSnapshotId),
    documentFragmentId: requireReference("evidence fragment id", evidence.documentFragmentId),
    snapshotContentHash: requireHash("evidence snapshot hash", evidence.snapshotContentHash),
    contentHash: requireHash("evidence fragment hash", evidence.contentHash) };
}

function validateCandidateEvidenceShape(input: NormalizedCandidateInput): void {
  const memory = input.evidence.filter((item) => item.type === "group_memory");
  const messages = input.evidence.filter((item) => item.type === "conversation_message");
  const sources = input.evidence.filter((item) => item.type === "document_source");
  const snapshots = input.evidence.filter((item) => item.type === "document_snapshot");
  const fragments = input.evidence.filter((item) => item.type === "document_fragment");
  if (memory.length !== 1 || messages.length < 1 || sources.length < 1 || snapshots.length < 1) {
    throw new Error("candidate evidence is incomplete");
  }
  const exactMemory = memory[0] as Extract<KnowledgeConflictEvidenceReference,
    { type: "group_memory" }>;
  if (exactMemory.groupMemoryId !== input.groupMemoryId
    || exactMemory.groupId !== input.groupId
    || exactMemory.expectedUpdatedAt.getTime() !== input.memoryUpdatedAt.getTime()) {
    throw new Error("candidate memory evidence does not match candidate identity");
  }
  if (!messages.some((item) => item.type === "conversation_message"
    && item.conversationMessageId === input.sourceMessageId && item.groupId === input.groupId)) {
    throw new Error("candidate source message is not exact evidence");
  }
  const exactSource = sources.find((item) => item.type === "document_source"
    && item.documentSourceId === input.targetDocumentSourceId);
  if (exactSource?.type !== "document_source"
    || exactSource.expectedUpdatedAt.getTime() !== input.targetSourceUpdatedAt.getTime()) {
    throw new Error("candidate source evidence does not match candidate identity");
  }
  if (!snapshots.some((item) => item.type === "document_snapshot"
    && item.documentSourceId === input.targetDocumentSourceId
    && item.documentSnapshotId === input.targetSnapshotId
    && item.contentHash === input.targetContentHash
    && item.referenceId === input.plan.targetDocumentRef)) {
    throw new Error("candidate snapshot evidence does not match candidate identity");
  }
  const hasExactSource = (snapshot: Extract<KnowledgeConflictEvidenceReference,
    { type: "document_snapshot" }>) => sources.some((source) => source.type === "document_source"
      && source.referenceId === snapshot.referenceId
      && source.documentSourceId === snapshot.documentSourceId);
  const hasExactSnapshot = (source: Extract<KnowledgeConflictEvidenceReference,
    { type: "document_source" }>) => snapshots.some((snapshot) => snapshot.type === "document_snapshot"
      && snapshot.referenceId === source.referenceId
      && snapshot.documentSourceId === source.documentSourceId);
  const fragmentHasExactSnapshot = (fragment: Extract<KnowledgeConflictEvidenceReference,
    { type: "document_fragment" }>) => snapshots.some((snapshot) =>
      snapshot.type === "document_snapshot"
      && snapshot.referenceId === fragment.referenceId
      && snapshot.documentSourceId === fragment.documentSourceId
      && snapshot.documentSnapshotId === fragment.documentSnapshotId
      && snapshot.contentHash === fragment.snapshotContentHash);
  if (!snapshots.every((item) => item.type === "document_snapshot" && hasExactSource(item))
    || !sources.every((item) => item.type === "document_source" && hasExactSnapshot(item))
    || !fragments.every((item) => item.type === "document_fragment"
      && fragmentHasExactSnapshot(item))) {
    throw new Error("candidate document evidence is incomplete");
  }
  if (new Set(input.evidence.map((item) => `${item.type}:${item.referenceId}`)).size
    !== input.evidence.length) throw new Error("candidate evidence contains duplicate identities");
}

function parseConflictPlan(
  plan: CreateKnowledgeConflictCandidateInput["plan"],
  evidence: readonly KnowledgeConflictEvidenceReference[],
): CreateKnowledgeConflictCandidateInput["plan"] {
  const parsed = parseKnowledgeConflictPlan(
    JSON.stringify(plan),
    new Set(evidence.map((item) => item.referenceId)),
  );
  if (parsed.outcome !== "conflict") throw new Error("candidate plan must be a conflict");
  return { ...parsed, outcome: "conflict" };
}

function cloneEvidence(item: KnowledgeConflictEvidenceReference): KnowledgeConflictEvidenceReference {
  if (item.type === "group_memory" || item.type === "document_source") {
    return { ...item, expectedUpdatedAt: new Date(item.expectedUpdatedAt) };
  }
  return { ...item };
}

function uniqueSortedRefs(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en", { numeric: true }));
}

async function loadCandidate(
  queryable: PostgresKnowledgeConflictQueryable,
  id: string,
): Promise<KnowledgeConflictCandidate | undefined> {
  const result = await queryable.query<CandidateRow>(
    "SELECT * FROM knowledge_conflict_candidates WHERE id = $1",
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return mapCandidate(row, await loadEvidence(queryable, row.id));
}

async function listCandidates(
  dataSource: PostgresKnowledgeConflictDataSource,
  input: { groupId?: string; statuses?: KnowledgeConflictCandidateStatus[]; limit: number },
): Promise<KnowledgeConflictCandidate[]> {
  const statuses = input.statuses === undefined ? [] : [...new Set(input.statuses)];
  const result = await dataSource.query<CandidateRow>(
    `SELECT * FROM knowledge_conflict_candidates
     WHERE ($1::text IS NULL OR group_id = $1)
       AND (cardinality($2::text[]) = 0 OR status = ANY($2::text[]))
     ORDER BY updated_at DESC, id ASC
     LIMIT $3`,
    [input.groupId === undefined ? null : requireReference("groupId", input.groupId),
      statuses, requireLimit(input.limit)],
  );
  const candidates: KnowledgeConflictCandidate[] = [];
  for (const row of result.rows) candidates.push(mapCandidate(row, await loadEvidence(dataSource, row.id)));
  return candidates;
}

async function listCandidateEvents(
  dataSource: PostgresKnowledgeConflictDataSource,
  input: { candidateId: string; limit: number },
): Promise<KnowledgeConflictCandidateEvent[]> {
  const result = await dataSource.query<EventRow>(
    `SELECT * FROM knowledge_conflict_candidate_events
     WHERE candidate_id = $1
     ORDER BY created_at ASC, id ASC
     LIMIT $2`,
    [requireReference("candidateId", input.candidateId), requireLimit(input.limit)],
  );
  return result.rows.map(mapEvent);
}

async function dismissCandidate(
  dataSource: PostgresKnowledgeConflictDataSource,
  createId: () => string,
  input: {
    candidateId: string;
    expectedVersion: number;
    operationKey: string;
    actorType: "system" | "feishu_user" | "admin_role";
    actorRef: string;
    reasonCode: string;
    at: Date;
  },
): Promise<KnowledgeConflictMutationResult> {
  return withTransaction(dataSource, (client) => transitionCandidateInTransaction(client, createId, {
    ...input,
    toStatus: "dismissed",
  }));
}

async function transitionCandidateInTransaction(
  client: PostgresKnowledgeConflictTransactionClient,
  createId: () => string,
  raw: {
    candidateId: string;
    expectedVersion: number;
    operationKey: string;
    actorType: "system" | "feishu_user" | "admin_role";
    actorRef: string;
    toStatus: KnowledgeConflictCandidateStatus;
    reasonCode: string;
    at: Date;
  },
): Promise<KnowledgeConflictMutationResult> {
  const input = normalizeTransition(raw);
  await lockOperationKey(client, input.operationKey);
  const replayResult = await client.query<EventRow>(
    "SELECT * FROM knowledge_conflict_candidate_events WHERE operation_key = $1",
    [input.operationKey],
  );
  const replay = replayResult.rows[0];
  if (replay !== undefined) {
    if (replay.candidate_id !== input.candidateId
      || Number(replay.from_version) !== input.expectedVersion
      || replay.to_status !== input.toStatus
      || replay.actor_type !== input.actorType
      || replay.actor_ref !== input.actorRef
      || replay.reason_code !== input.reasonCode) {
      throw new KnowledgeConflictOperationConflictError();
    }
    const candidate = await loadCandidate(client, input.candidateId);
    if (candidate === undefined) throw new KnowledgeConflictNotFoundError();
    return { outcome: "already_applied", candidate };
  }

  const row = await lockCandidate(client, input.candidateId);
  if (Number(row.version) !== input.expectedVersion) throw new KnowledgeConflictVersionConflictError();
  requireCandidateTransition(row.status, input.toStatus);
  await assertAnswerAttemptsAllowCandidateTransition(client, row.id, input.toStatus);
  await assertDeliveryAllowsCandidateTransition(client, row, input.toStatus);
  const result = await client.query<CandidateRow>(
    `UPDATE knowledge_conflict_candidates
     SET status = $2, version = version + 1, updated_at = $3
     WHERE id = $1 AND version = $4
     RETURNING *`,
    [input.candidateId, input.toStatus, input.at, input.expectedVersion],
  );
  const updated = result.rows[0];
  if (updated === undefined) throw new KnowledgeConflictVersionConflictError();
  await insertCandidateEvent(client, createId, {
    candidateId: input.candidateId,
    operationKey: input.operationKey,
    actorType: input.actorType,
    actorRef: input.actorRef,
    fromStatus: row.status,
    toStatus: input.toStatus,
    fromVersion: input.expectedVersion,
    toVersion: input.expectedVersion + 1,
    reasonCode: input.reasonCode,
    at: input.at,
  });
  return { outcome: "applied", candidate: mapCandidate(updated, await loadEvidence(client, row.id)) };
}

async function lockCandidate(
  client: PostgresKnowledgeConflictTransactionClient,
  id: string,
): Promise<CandidateRow> {
  const result = await client.query<CandidateRow>(
    "SELECT * FROM knowledge_conflict_candidates WHERE id = $1 FOR UPDATE",
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new KnowledgeConflictNotFoundError();
  return row;
}

async function lockCandidateMemoryBeforeCandidate(
  client: PostgresKnowledgeConflictTransactionClient,
  id: string,
): Promise<CandidateRow> {
  const identityResult = await client.query<Pick<
    CandidateRow,
    "id" | "group_id" | "group_memory_id" | "memory_updated_at"
  >>(
    `SELECT id, group_id, group_memory_id, memory_updated_at
     FROM knowledge_conflict_candidates
     WHERE id = $1`,
    [id],
  );
  const identity = identityResult.rows[0];
  if (identity === undefined) throw new KnowledgeConflictNotFoundError();
  await client.query<{ id: string }>(
    `SELECT id FROM group_memories
     WHERE id = $1 AND group_id = $2
     ORDER BY id
     FOR UPDATE`,
    [identity.group_memory_id, identity.group_id],
  );
  const candidate = await lockCandidate(client, id);
  if (candidate.group_id !== identity.group_id
    || candidate.group_memory_id !== identity.group_memory_id
    || candidate.memory_updated_at.getTime() !== identity.memory_updated_at.getTime()) {
    throw new KnowledgeConflictVersionConflictError();
  }
  return candidate;
}

function normalizeTransition(input: {
  candidateId: string;
  expectedVersion: number;
  operationKey: string;
  actorType: "system" | "feishu_user" | "admin_role";
  actorRef: string;
  toStatus: KnowledgeConflictCandidateStatus;
  reasonCode: string;
  at: Date;
}) {
  return {
    candidateId: requireReference("candidateId", input.candidateId),
    expectedVersion: requirePositiveInteger("expectedVersion", input.expectedVersion),
    operationKey: requireReference("operationKey", input.operationKey),
    actorType: input.actorType,
    actorRef: requireReference("actorRef", input.actorRef),
    toStatus: input.toStatus,
    reasonCode: requireBoundedString("reasonCode", input.reasonCode, 128),
    at: requireDate("at", input.at),
  };
}

function requireCandidateTransition(
  from: KnowledgeConflictCandidateStatus,
  to: KnowledgeConflictCandidateStatus,
): void {
  const allowed: Record<KnowledgeConflictCandidateStatus, KnowledgeConflictCandidateStatus[]> = {
    pending_review: ["dismissed", "approved_for_delivery", "superseded"],
    approved_for_delivery: ["dismissed", "delivered", "superseded"],
    delivered: ["dismissed", "draft_created", "superseded"],
    dismissed: [],
    draft_created: [],
    superseded: [],
  };
  if (!allowed[from].includes(to)) throw new KnowledgeConflictVersionConflictError();
}

function mapEvent(row: EventRow): KnowledgeConflictCandidateEvent {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    operationKey: row.operation_key,
    actorType: row.actor_type,
    actorRef: row.actor_ref,
    ...(row.from_status === null ? {} : { fromStatus: row.from_status }),
    toStatus: row.to_status,
    ...(row.from_version === null ? {} : { fromVersion: Number(row.from_version) }),
    toVersion: requirePositiveInteger("event to version", row.to_version),
    reasonCode: row.reason_code,
    createdAt: requireDate("event created at", row.created_at),
  };
}

async function approveForDelivery(
  dataSource: PostgresKnowledgeConflictDataSource,
  createId: () => string,
  input: {
    candidateId: string;
    expectedVersion: number;
    operationKey: string;
    actorType: "admin_role";
    actorRef: string;
    reasonCode: string;
    at: Date;
  },
): Promise<KnowledgeConflictMutationResult & { delivery: KnowledgeConflictDelivery }> {
  return withTransaction(dataSource, async (client) => {
    const normalized = normalizeTransition({ ...input, toStatus: "approved_for_delivery" });
    await lockOperationKey(client, normalized.operationKey);
    const existingDelivery = await loadDeliveryByCandidate(client, normalized.candidateId);
    const replayEvent = await client.query<EventRow>(
      "SELECT * FROM knowledge_conflict_candidate_events WHERE operation_key = $1",
      [normalized.operationKey],
    );
    if (replayEvent.rows[0] !== undefined) {
      const mutation = await transitionCandidateInTransaction(client, createId, normalized);
      if (existingDelivery === undefined) throw new KnowledgeConflictOperationConflictError();
      return { ...mutation, delivery: existingDelivery };
    }
    if (existingDelivery !== undefined) throw new KnowledgeConflictOperationConflictError();

    const locked = await lockCandidateMemoryBeforeCandidate(client, normalized.candidateId);
    if (Number(locked.version) !== normalized.expectedVersion) {
      throw new KnowledgeConflictVersionConflictError();
    }
    const evidence = await loadEvidence(client, locked.id);
    const staleReason = await findStaleReason(client, locked, evidence);
    if (staleReason !== undefined) throw new KnowledgeConflictStaleEvidenceError(staleReason);

    const mutation = await transitionLockedCandidate(client, createId, locked, evidence, normalized);
    const deliveryResult = await client.query<DeliveryRow>(
      `INSERT INTO knowledge_conflict_delivery_outbox (
         id, candidate_id, group_id, status, attempt_count, next_attempt_at,
         created_at, updated_at
       ) VALUES ($1, $2, $3, 'pending', 0, $4, $4, $4)
       RETURNING *`,
      [requireReference("delivery id", createId()), locked.id, locked.group_id, normalized.at],
    );
    const delivery = deliveryResult.rows[0];
    if (delivery === undefined) throw new Error("knowledge conflict delivery insert returned no row");
    return { ...mutation, delivery: mapDelivery(delivery) };
  });
}

async function transitionLockedCandidate(
  client: PostgresKnowledgeConflictTransactionClient,
  createId: () => string,
  row: CandidateRow,
  evidence: readonly KnowledgeConflictEvidenceReference[],
  input: ReturnType<typeof normalizeTransition>,
): Promise<KnowledgeConflictMutationResult> {
  requireCandidateTransition(row.status, input.toStatus);
  await assertAnswerAttemptsAllowCandidateTransition(client, row.id, input.toStatus);
  await assertDeliveryAllowsCandidateTransition(client, row, input.toStatus);
  const result = await client.query<CandidateRow>(
    `UPDATE knowledge_conflict_candidates
     SET status = $2, version = version + 1, updated_at = $3
     WHERE id = $1 AND version = $4
     RETURNING *`,
    [input.candidateId, input.toStatus, input.at, input.expectedVersion],
  );
  const updated = result.rows[0];
  if (updated === undefined) throw new KnowledgeConflictVersionConflictError();
  await insertCandidateEvent(client, createId, {
    candidateId: input.candidateId,
    operationKey: input.operationKey,
    actorType: input.actorType,
    actorRef: input.actorRef,
    fromStatus: row.status,
    toStatus: input.toStatus,
    fromVersion: input.expectedVersion,
    toVersion: input.expectedVersion + 1,
    reasonCode: input.reasonCode,
    at: input.at,
  });
  return { outcome: "applied", candidate: mapCandidate(updated, evidence) };
}

async function assertDeliveryAllowsCandidateTransition(
  client: PostgresKnowledgeConflictTransactionClient,
  row: CandidateRow,
  toStatus: KnowledgeConflictCandidateStatus,
): Promise<void> {
  if (row.status !== "approved_for_delivery" || toStatus === "delivered") return;
  const result = await client.query<DeliveryRow>(
    `SELECT * FROM knowledge_conflict_delivery_outbox
     WHERE candidate_id = $1
     FOR UPDATE`,
    [row.id],
  );
  const delivery = result.rows[0];
  if (delivery?.status === "external_attempting" || delivery?.status === "outcome_unknown") {
    throw new KnowledgeConflictDeliveryConflictError();
  }
}

async function assertAnswerAttemptsAllowCandidateTransition(
  client: PostgresKnowledgeConflictTransactionClient,
  candidateId: string,
  toStatus: KnowledgeConflictCandidateStatus,
): Promise<void> {
  if (toStatus !== "dismissed" && toStatus !== "superseded") return;
  const result = await client.query<{ id: string }>(
    `SELECT delivery.id
     FROM answer_reply_knowledge_conflicts binding
     JOIN answer_reply_deliveries delivery ON delivery.id = binding.delivery_id
     WHERE binding.candidate_id = $1
       AND delivery.state IN ('sending', 'reconciliation_required')
     ORDER BY delivery.id
     FOR UPDATE OF delivery`,
    [candidateId],
  );
  if (result.rows.length > 0) throw new KnowledgeConflictDeliveryConflictError();
}

async function validateCandidateCurrentState(
  dataSource: PostgresKnowledgeConflictDataSource,
  createId: () => string,
  maxPermissionAgeMs: number,
  input: {
    candidateId: string;
    expectedVersion: number;
    permissionAttestedAt: Date;
    operationKey: string;
    at: Date;
  },
) {
  const candidateId = requireReference("candidateId", input.candidateId);
  const expectedVersion = requirePositiveSafeInteger("expectedVersion", input.expectedVersion);
  const at = requireDate("at", input.at);
  assertFreshPermission(input.permissionAttestedAt, at, maxPermissionAgeMs);
  return withTransaction(dataSource, async (client) => {
    const row = await lockCandidateMemoryBeforeCandidate(client, candidateId);
    if (Number(row.version) !== expectedVersion) throw new KnowledgeConflictVersionConflictError();
    const evidence = await loadEvidence(client, candidateId);
    const staleReason = await findStaleReason(client, row, evidence);
    if (staleReason === undefined) return { status: "current" as const, candidate: mapCandidate(row, evidence) };
    if (["dismissed", "draft_created", "superseded"].includes(row.status)) {
      return { status: "superseded" as const, candidate: mapCandidate(row, evidence), reasonCode: staleReason };
    }
    const deliveryResult = await client.query<DeliveryRow>(
      `SELECT * FROM knowledge_conflict_delivery_outbox
       WHERE candidate_id = $1
       FOR UPDATE`,
      [candidateId],
    );
    const delivery = deliveryResult.rows[0];
    if (delivery?.status === "external_attempting" || delivery?.status === "outcome_unknown") {
      throw new KnowledgeConflictDeliveryConflictError();
    }
    const transition = await transitionLockedCandidate(client, createId, row, evidence, normalizeTransition({
      candidateId,
      expectedVersion: Number(row.version),
      operationKey: input.operationKey,
      actorType: "system",
      actorRef: "knowledge_conflict_validator",
      toStatus: "superseded",
      reasonCode: staleReason,
      at,
    }));
    await client.query(
      `UPDATE knowledge_conflict_delivery_outbox
       SET status = 'cancelled', lease_worker_id = NULL, lease_until = NULL,
           retryable = TRUE, failure_code = $2, updated_at = $3
       WHERE candidate_id = $1 AND status IN ('pending', 'processing', 'failed')`,
      [candidateId, staleReason, at],
    );
    return { status: "superseded" as const, candidate: transition.candidate, reasonCode: staleReason };
  });
}

async function findStaleReason(
  client: PostgresKnowledgeConflictTransactionClient,
  candidate: CandidateRow,
  evidence: readonly KnowledgeConflictEvidenceReference[],
): Promise<string | undefined> {
  const memory = await client.query<{ id: string }>(
    `SELECT memory.id
     FROM group_memories memory
     JOIN knowledge_conflict_candidates persisted_candidate
       ON persisted_candidate.id = $3
      AND persisted_candidate.group_memory_id = memory.id
      AND persisted_candidate.group_id = memory.group_id
      AND persisted_candidate.memory_updated_at = memory.updated_at
     JOIN knowledge_conflict_evidence memory_evidence
       ON memory_evidence.candidate_id = persisted_candidate.id
      AND memory_evidence.evidence_type = 'group_memory'
      AND memory_evidence.group_memory_id = memory.id
      AND memory_evidence.group_id = memory.group_id
      AND memory_evidence.source_updated_at = memory.updated_at
     WHERE memory.id = $1 AND memory.group_id = $2 AND memory.status = 'active'
     FOR UPDATE OF memory`,
    [candidate.group_memory_id, candidate.group_id, candidate.id],
  );
  if (memory.rows[0] === undefined) return "memory_stale";
  const messageIds = evidence.filter(
    (item): item is Extract<KnowledgeConflictEvidenceReference, { type: "conversation_message" }> =>
      item.type === "conversation_message",
  ).map((item) => item.conversationMessageId);
  const messages = await client.query<{ id: string; sent_at: Date }>(
    `SELECT message.id, message.sent_at FROM conversation_messages message
     JOIN group_memory_message_evidence memory_evidence
       ON memory_evidence.conversation_message_id = message.id
      AND memory_evidence.memory_id = $3
     LEFT JOIN conversation_message_deletion_tombstones tombstone
       ON tombstone.conversation_message_id = message.id
     WHERE message.id = ANY($1::text[]) AND message.chat_id = $2
       AND tombstone.conversation_message_id IS NULL
     ORDER BY message.id FOR UPDATE OF message`,
    [messageIds, candidate.group_id, candidate.group_memory_id],
  );
  const actualMessageIds = new Set(messages.rows.map((row) => row.id));
  if (messages.rows.length !== messageIds.length
    || messageIds.some((id) => !actualMessageIds.has(id))) return "message_stale";
  const sources = evidence.filter(
    (item): item is Extract<KnowledgeConflictEvidenceReference, { type: "document_source" }> =>
      item.type === "document_source",
  ).sort((left, right) => left.documentSourceId.localeCompare(right.documentSourceId));
  for (const expectedSource of sources) {
    const source = await client.query<SourceValidationRow>(
      `SELECT source.id, source.authorized_space_id, source.source_type,
         source.permission_state, source.sync_state,
         source.can_use_for_knowledge_drafts, source.updated_at,
         source.updated_at = source_evidence.source_updated_at
           AS evidence_timestamp_current,
         (source.id <> persisted_candidate.target_document_source_id
           OR source.updated_at = persisted_candidate.target_source_updated_at)
           AS candidate_timestamp_current
       FROM document_sources source
       JOIN knowledge_conflict_candidates persisted_candidate
         ON persisted_candidate.id = $2
       JOIN knowledge_conflict_evidence source_evidence
         ON source_evidence.candidate_id = persisted_candidate.id
        AND source_evidence.evidence_type = 'document_source'
        AND source_evidence.reference_id = $3
        AND source_evidence.document_source_id = source.id
       WHERE source.id = $1
       FOR UPDATE OF source`,
      [expectedSource.documentSourceId, candidate.id, expectedSource.referenceId],
    );
    const currentSource = source.rows[0];
    if (currentSource === undefined
      || currentSource.id !== expectedSource.documentSourceId
      || currentSource.source_type !== "authorized_wiki_document"
      || currentSource.sync_state !== "synced"
      || !["unknown", "readable"].includes(currentSource.permission_state)
      || !currentSource.can_use_for_knowledge_drafts
      || !currentSource.evidence_timestamp_current
      || !currentSource.candidate_timestamp_current) {
      return "source_stale";
    }
    if (currentSource.authorized_space_id === null
      || !(await lockAuthorizingPublicationPolicy(
        client,
        currentSource.authorized_space_id,
        candidate.group_id,
      ))) return "source_stale";
  }
  const snapshots = evidence.filter(
    (item): item is Extract<KnowledgeConflictEvidenceReference, { type: "document_snapshot" }> =>
      item.type === "document_snapshot",
  ).sort((left, right) => left.documentSourceId.localeCompare(right.documentSourceId));
  const snapshotFetchedAts: Date[] = [];
  for (const expectedSnapshot of snapshots) {
    const snapshot = await client.query<SnapshotValidationRow>(
      `SELECT id, document_source_id, fetch_status, content_hash, source_version, fetched_at
       FROM document_snapshots
       WHERE document_source_id = $1
       ORDER BY fetched_at DESC, id ASC LIMIT 1 FOR UPDATE`,
      [expectedSnapshot.documentSourceId],
    );
    const currentSnapshot = snapshot.rows[0];
    if (currentSnapshot?.id !== expectedSnapshot.documentSnapshotId
      || currentSnapshot.document_source_id !== expectedSnapshot.documentSourceId
      || currentSnapshot.fetch_status !== "succeeded"
      || currentSnapshot.content_hash !== expectedSnapshot.contentHash
      || (expectedSnapshot.documentSourceId === candidate.target_document_source_id
        && (currentSnapshot.source_version ?? null) !== candidate.target_source_version)) {
      return "snapshot_stale";
    }
    snapshotFetchedAts.push(currentSnapshot.fetched_at);
  }
  if (!hasStrictMessageAfterSnapshotChronology(messages.rows, snapshotFetchedAts)) {
    return "chronology_stale";
  }
  const fragments = evidence.filter(
    (item): item is Extract<KnowledgeConflictEvidenceReference, { type: "document_fragment" }> =>
      item.type === "document_fragment",
  );
  if (fragments.length > 0) {
    const rows = await client.query<{
      id: string;
      document_source_id: string;
      document_snapshot_id: string;
      content_hash: string;
    }>(
      `SELECT id, document_source_id, document_snapshot_id, content_hash
       FROM document_fragments WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
      [fragments.map((item) => item.documentFragmentId)],
    );
    const current = new Map(rows.rows.map((row) => [row.id, row]));
    if (fragments.some((item) => {
      const row = current.get(item.documentFragmentId);
      return row === undefined || row.document_source_id !== item.documentSourceId
        || row.document_snapshot_id !== item.documentSnapshotId
        || row.content_hash !== item.contentHash;
    })) return "fragment_stale";
  }
  return undefined;
}

function hasStrictMessageAfterSnapshotChronology(
  messages: readonly { sent_at: Date }[],
  snapshotFetchedAts: readonly Date[],
): boolean {
  if (messages.length === 0 || snapshotFetchedAts.length === 0) return false;
  const latestSnapshotTime = Math.max(...snapshotFetchedAts.map((value) => value.getTime()));
  return Number.isFinite(latestSnapshotTime) && messages.every(({ sent_at: sentAt }) => (
    sentAt instanceof Date
    && Number.isFinite(sentAt.getTime())
    && sentAt.getTime() > latestSnapshotTime
  ));
}

async function lockAuthorizingPublicationPolicy(
  client: PostgresKnowledgeConflictTransactionClient,
  authorizedSpaceId: string,
  groupId: string,
): Promise<boolean> {
  const policies = await client.query<{ id: string }>(
    `SELECT id FROM knowledge_publication_target_policies
     WHERE space_id = $1
       AND enabled = TRUE
       AND $2 = ANY(allowed_group_ids)
     ORDER BY id
     FOR UPDATE`,
    [authorizedSpaceId, groupId],
  );
  return policies.rows.length > 0;
}

async function loadDeliveryByCandidate(
  queryable: PostgresKnowledgeConflictQueryable,
  candidateId: string,
): Promise<KnowledgeConflictDelivery | undefined> {
  const result = await queryable.query<DeliveryRow>(
    "SELECT * FROM knowledge_conflict_delivery_outbox WHERE candidate_id = $1",
    [candidateId],
  );
  return result.rows[0] === undefined ? undefined : mapDelivery(result.rows[0]);
}

async function loadDelivery(
  queryable: PostgresKnowledgeConflictQueryable,
  id: string,
): Promise<KnowledgeConflictDelivery | undefined> {
  const result = await queryable.query<DeliveryRow>(
    "SELECT * FROM knowledge_conflict_delivery_outbox WHERE id = $1",
    [id],
  );
  return result.rows[0] === undefined ? undefined : mapDelivery(result.rows[0]);
}

async function claimNextDelivery(
  dataSource: PostgresKnowledgeConflictDataSource,
  input: { workerId: string; at: Date; leaseUntil: Date },
): Promise<KnowledgeConflictDeliveryClaim | undefined> {
  const workerId = requireReference("workerId", input.workerId);
  const at = requireDate("at", input.at);
  const leaseUntil = requireDate("leaseUntil", input.leaseUntil);
  if (leaseUntil.getTime() <= at.getTime()) throw new Error("leaseUntil must be after at");
  return withTransaction(dataSource, async (client) => {
    await client.query(
      `UPDATE knowledge_conflict_delivery_outbox
       SET status = 'failed', lease_worker_id = NULL, lease_until = NULL,
           failure_code = 'preparation_lease_expired', next_attempt_at = $1, updated_at = $1
       WHERE status = 'processing' AND lease_until <= $1`,
      [at],
    );
    await client.query(
      `UPDATE knowledge_conflict_delivery_outbox
       SET status = 'outcome_unknown', lease_worker_id = NULL, lease_until = NULL,
           failure_code = 'external_attempt_lease_expired', reconciliation_due_at = $1,
           updated_at = $1
       WHERE status = 'external_attempting' AND lease_until <= $1`,
      [at],
    );
    const result = await client.query<DeliveryCandidateRow>(
      `WITH claimable AS (
         SELECT delivery.id
         FROM knowledge_conflict_delivery_outbox delivery
         JOIN knowledge_conflict_candidates candidate ON candidate.id = delivery.candidate_id
         WHERE delivery.status IN ('pending', 'failed')
           AND delivery.retryable = TRUE
           AND delivery.next_attempt_at <= $1
           AND candidate.status = 'approved_for_delivery'
         ORDER BY delivery.next_attempt_at, delivery.created_at, delivery.id
         LIMIT 1
         FOR UPDATE OF delivery SKIP LOCKED
       ), claimed AS (
         UPDATE knowledge_conflict_delivery_outbox delivery
         SET status = 'processing', attempt_count = attempt_count + 1,
             lease_worker_id = $2, lease_until = $3, failure_code = NULL, updated_at = $1
         FROM claimable WHERE delivery.id = claimable.id
         RETURNING delivery.*
       )
       SELECT claimed.*,
         candidate.id AS candidate_id_value,
         candidate.idempotency_key AS candidate_idempotency_key,
         candidate.group_id AS candidate_group_id,
         candidate.group_memory_id AS candidate_group_memory_id,
         candidate.memory_updated_at AS candidate_memory_updated_at,
         candidate.source_message_id AS candidate_source_message_id,
         candidate.target_document_source_id AS candidate_target_document_source_id,
         candidate.target_source_updated_at AS candidate_target_source_updated_at,
         candidate.target_source_version AS candidate_target_source_version,
         candidate.target_snapshot_id AS candidate_target_snapshot_id,
         candidate.target_content_hash AS candidate_target_content_hash,
         candidate.detector_contract_version AS candidate_detector_contract_version,
         candidate.status AS candidate_status,
         candidate.subject AS candidate_subject,
         candidate.knowledge_base_statement AS candidate_knowledge_base_statement,
         candidate.group_conclusion_statement AS candidate_group_conclusion_statement,
         candidate.difference AS candidate_difference,
         candidate.suggested_update AS candidate_suggested_update,
         candidate.target_document_ref AS candidate_target_document_ref,
         candidate.confidence AS candidate_confidence,
         candidate.version AS candidate_version,
         candidate.created_at AS candidate_created_at,
         candidate.updated_at AS candidate_updated_at
       FROM claimed JOIN knowledge_conflict_candidates candidate
         ON candidate.id = claimed.candidate_id`,
      [at, workerId, leaseUntil],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const candidateRow = prefixedCandidateRow(row);
    const evidence = await loadEvidence(client, candidateRow.id);
    return {
      delivery: mapDelivery(row) as KnowledgeConflictDelivery & { status: "processing" },
      candidate: mapCandidate(candidateRow, evidence),
    };
  });
}

async function beginDeliveryAttempt(
  dataSource: PostgresKnowledgeConflictDataSource,
  input: {
    deliveryId: string;
    candidateId: string;
    expectedCandidateVersion: number;
    expectedAttemptCount: number;
    workerId: string;
    at: Date;
  },
): Promise<KnowledgeConflictDelivery> {
  const deliveryId = requireReference("deliveryId", input.deliveryId);
  const candidateId = requireReference("candidateId", input.candidateId);
  const expectedCandidateVersion = requirePositiveSafeInteger(
    "expectedCandidateVersion",
    input.expectedCandidateVersion,
  );
  const expectedAttemptCount = requireAttemptCount(
    "expectedAttemptCount",
    input.expectedAttemptCount,
  );
  const workerId = requireReference("workerId", input.workerId);
  const at = requireDate("at", input.at);
  return withTransaction(dataSource, async (client) => {
    const candidate = await lockCandidate(client, candidateId);
    if (candidate.status !== "approved_for_delivery"
      || Number(candidate.version) !== expectedCandidateVersion) {
      throw new KnowledgeConflictVersionConflictError();
    }
    const delivery = await lockDelivery(client, deliveryId);
    if (delivery.candidate_id !== candidate.id
      || delivery.group_id !== candidate.group_id
      || delivery.status !== "processing"
      || delivery.lease_worker_id !== workerId
      || requireAttemptCount("delivery attempt count", delivery.attempt_count)
        !== expectedAttemptCount) {
      throw new KnowledgeConflictDeliveryConflictError();
    }
    const result = await client.query<DeliveryRow>(
      `UPDATE knowledge_conflict_delivery_outbox
       SET status = 'external_attempting', external_attempt_started_at = $5,
           reconciliation_operation_key = NULL, reconciliation_outcome = NULL,
           reconciled_at = NULL, updated_at = $5
       WHERE id = $1 AND candidate_id = $2 AND status = 'processing'
         AND lease_worker_id = $3 AND attempt_count = $4
       RETURNING *`,
      [deliveryId, candidateId, workerId, expectedAttemptCount, at],
    );
    const row = result.rows[0];
    if (row === undefined) throw new KnowledgeConflictDeliveryConflictError();
    return mapDelivery(row);
  });
}

async function completeDelivery(
  dataSource: PostgresKnowledgeConflictDataSource,
  createId: () => string,
  input: { deliveryId: string; workerId: string; messageId: string; at: Date },
): Promise<{ delivery: KnowledgeConflictDelivery; candidate: KnowledgeConflictCandidate }> {
  const deliveryId = requireReference("deliveryId", input.deliveryId);
  const workerId = requireReference("workerId", input.workerId);
  const at = requireDate("at", input.at);
  return withTransaction(dataSource, async (client) => {
    const candidateId = await loadDeliveryCandidateId(client, deliveryId);
    const candidate = await lockCandidate(client, candidateId);
    const delivery = await lockDelivery(client, deliveryId);
    if (delivery.candidate_id !== candidate.id) throw new KnowledgeConflictDeliveryConflictError();
    if (delivery.status !== "external_attempting" || delivery.lease_worker_id !== workerId) {
      throw new KnowledgeConflictDeliveryConflictError();
    }
    if (candidate.status !== "approved_for_delivery") throw new KnowledgeConflictDeliveryConflictError();
    const evidence = await loadEvidence(client, candidate.id);
    const candidateResult = await client.query<CandidateRow>(
      `UPDATE knowledge_conflict_candidates
       SET status = 'delivered', version = version + 1, updated_at = $2
       WHERE id = $1 AND version = $3 AND status = 'approved_for_delivery'
       RETURNING *`,
      [candidate.id, at, Number(candidate.version)],
    );
    const updatedCandidate = candidateResult.rows[0];
    if (updatedCandidate === undefined) throw new KnowledgeConflictVersionConflictError();
    await insertCandidateEvent(client, createId, {
      candidateId: candidate.id,
      operationKey: derivedOperationKey("delivery_sent", deliveryId),
      actorType: "system",
      actorRef: "knowledge_conflict_dispatcher",
      fromStatus: "approved_for_delivery",
      toStatus: "delivered",
      fromVersion: Number(candidate.version),
      toVersion: Number(candidate.version) + 1,
      reasonCode: "card_sent",
      at,
    });
    const deliveryResult = await client.query<DeliveryRow>(
      `UPDATE knowledge_conflict_delivery_outbox
       SET status = 'sent', lease_worker_id = NULL, lease_until = NULL,
           sent_message_id = $3, failure_code = NULL, updated_at = $4
       WHERE id = $1 AND status = 'external_attempting' AND lease_worker_id = $2
       RETURNING *`,
      [deliveryId, workerId, requireReference("messageId", input.messageId), at],
    );
    const updatedDelivery = deliveryResult.rows[0];
    if (updatedDelivery === undefined) throw new KnowledgeConflictDeliveryConflictError();
    return {
      delivery: mapDelivery(updatedDelivery),
      candidate: mapCandidate(updatedCandidate, evidence),
    };
  });
}

async function failDelivery(
  dataSource: PostgresKnowledgeConflictDataSource,
  input: {
    deliveryId: string;
    workerId: string;
    classification: "retryable" | "permanent" | "outcome_unknown";
    errorCode: string;
    retryAt?: Date;
    reconciliationDueAt?: Date;
    at: Date;
  },
): Promise<KnowledgeConflictDelivery> {
  const retryAt = input.retryAt === undefined ? undefined : requireDate("retryAt", input.retryAt);
  const reconciliationDueAt = input.reconciliationDueAt === undefined
    ? undefined : requireDate("reconciliationDueAt", input.reconciliationDueAt);
  if (input.classification === "retryable" && retryAt === undefined) {
    throw new Error("retryAt is required for retryable delivery failure");
  }
  if (input.classification === "outcome_unknown" && reconciliationDueAt === undefined) {
    throw new Error("reconciliationDueAt is required for outcome-unknown delivery failure");
  }
  const result = await dataSource.query<DeliveryRow>(
    `UPDATE knowledge_conflict_delivery_outbox
     SET status = CASE WHEN $3 = 'outcome_unknown' THEN 'outcome_unknown' ELSE 'failed' END,
         retryable = CASE WHEN $3 = 'permanent' THEN FALSE ELSE TRUE END,
         next_attempt_at = CASE WHEN $3 = 'retryable' THEN $4 ELSE next_attempt_at END,
         reconciliation_due_at = CASE WHEN $3 = 'outcome_unknown' THEN $5 ELSE NULL END,
         lease_worker_id = NULL, lease_until = NULL, failure_code = $6, updated_at = $7
     WHERE id = $1 AND status IN ('processing', 'external_attempting')
       AND lease_worker_id = $2
     RETURNING *`,
    [requireReference("deliveryId", input.deliveryId), requireReference("workerId", input.workerId),
      input.classification, retryAt ?? null, reconciliationDueAt ?? null,
      requireBoundedString("errorCode", input.errorCode, MAX_ERROR_CODE_CHARS),
      requireDate("at", input.at)],
  );
  const row = result.rows[0];
  if (row === undefined) throw new KnowledgeConflictDeliveryConflictError();
  return mapDelivery(row);
}

async function reconcileDelivery(
  dataSource: PostgresKnowledgeConflictDataSource,
  createId: () => string,
  input: {
    deliveryId: string;
    expectedAttemptCount: number;
    outcome: "sent" | "not_sent";
    operationKey: string;
    actorRef: string;
    messageId?: string;
    at: Date;
  },
): Promise<KnowledgeConflictDelivery> {
  const deliveryId = requireReference("deliveryId", input.deliveryId);
  const operationKey = requireReference("operationKey", input.operationKey);
  const expectedAttemptCount = requireAttemptCount(
    "expectedAttemptCount",
    input.expectedAttemptCount,
  );
  const actorRef = requireReference("actorRef", input.actorRef);
  const at = requireDate("at", input.at);
  if (input.outcome === "sent" && input.messageId === undefined) {
    throw new Error("messageId is required for sent reconciliation");
  }
  return withTransaction(dataSource, async (client) => {
    await lockOperationKey(client, operationKey);
    const replayResult = await client.query<ReconciliationRow>(
      `SELECT * FROM knowledge_conflict_delivery_reconciliations
       WHERE operation_key = $1`,
      [operationKey],
    );
    const replay = replayResult.rows[0];
    if (replay !== undefined) {
      if (replay.delivery_id !== deliveryId
        || requireAttemptCount("stored delivery attempt count", replay.attempt_count)
          !== expectedAttemptCount
        || replay.outcome !== input.outcome
        || replay.actor_ref !== actorRef
        || (replay.sent_message_id ?? undefined) !== input.messageId) {
        throw new KnowledgeConflictOperationConflictError();
      }
      const current = await lockDelivery(client, deliveryId);
      return mapDelivery(current);
    }
    const candidateId = await loadDeliveryCandidateId(client, deliveryId);
    const candidate = await lockCandidate(client, candidateId);
    const delivery = await lockDelivery(client, deliveryId);
    if (delivery.candidate_id !== candidate.id
      || candidate.status !== "approved_for_delivery") {
      throw new KnowledgeConflictDeliveryConflictError();
    }
    if (requireAttemptCount("delivery attempt count", delivery.attempt_count)
      !== expectedAttemptCount
      || delivery.status !== "outcome_unknown") throw new KnowledgeConflictDeliveryConflictError();
    await client.query<ReconciliationRow>(
      `INSERT INTO knowledge_conflict_delivery_reconciliations (
         operation_key, delivery_id, attempt_count, outcome, sent_message_id, actor_ref, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [operationKey, deliveryId, expectedAttemptCount, input.outcome,
        input.messageId ?? null, actorRef, at],
    );
    if (input.outcome === "not_sent") {
      const result = await client.query<DeliveryRow>(
        `UPDATE knowledge_conflict_delivery_outbox
         SET status = 'failed', next_attempt_at = $2, reconciliation_operation_key = $3,
             retryable = TRUE,
             reconciliation_outcome = 'not_sent', reconciled_at = $2,
             reconciliation_due_at = NULL, failure_code = 'reconciled_not_sent', updated_at = $2
         WHERE id = $1 AND status = 'outcome_unknown'
         RETURNING *`,
        [deliveryId, at, operationKey],
      );
      const row = result.rows[0];
      if (row === undefined) throw new KnowledgeConflictDeliveryConflictError();
      return mapDelivery(row);
    }

    const candidateResult = await client.query<CandidateRow>(
      `UPDATE knowledge_conflict_candidates
       SET status = 'delivered', version = version + 1, updated_at = $2
       WHERE id = $1 AND version = $3 AND status = 'approved_for_delivery'
       RETURNING *`,
      [candidate.id, at, Number(candidate.version)],
    );
    if (candidateResult.rows[0] === undefined) throw new KnowledgeConflictVersionConflictError();
    await insertCandidateEvent(client, createId, {
      candidateId: candidate.id,
      operationKey,
      actorType: "admin_role",
      actorRef,
      fromStatus: "approved_for_delivery",
      toStatus: "delivered",
      fromVersion: Number(candidate.version),
      toVersion: Number(candidate.version) + 1,
      reasonCode: "reconciled_sent",
      at,
    });
    const result = await client.query<DeliveryRow>(
      `UPDATE knowledge_conflict_delivery_outbox
       SET status = 'sent', sent_message_id = $2, reconciliation_operation_key = $3,
           reconciliation_outcome = 'sent', reconciled_at = $4,
           reconciliation_due_at = NULL, failure_code = NULL, updated_at = $4
       WHERE id = $1 AND status = 'outcome_unknown'
       RETURNING *`,
      [deliveryId, requireReference("messageId", input.messageId!), operationKey, at],
    );
    const row = result.rows[0];
    if (row === undefined) throw new KnowledgeConflictDeliveryConflictError();
    return mapDelivery(row);
  });
}

async function loadDeliveryCandidateId(
  queryable: PostgresKnowledgeConflictQueryable,
  deliveryId: string,
): Promise<string> {
  const result = await queryable.query<{ candidate_id: string }>(
    "SELECT candidate_id FROM knowledge_conflict_delivery_outbox WHERE id = $1",
    [deliveryId],
  );
  const candidateId = result.rows[0]?.candidate_id;
  if (candidateId === undefined) throw new KnowledgeConflictDeliveryConflictError();
  return requireReference("delivery candidate id", candidateId);
}

async function lockDelivery(
  client: PostgresKnowledgeConflictTransactionClient,
  id: string,
): Promise<DeliveryRow> {
  const result = await client.query<DeliveryRow>(
    "SELECT * FROM knowledge_conflict_delivery_outbox WHERE id = $1 FOR UPDATE",
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new KnowledgeConflictDeliveryConflictError();
  return row;
}

function mapDelivery(row: DeliveryRow): KnowledgeConflictDelivery {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    groupId: row.group_id,
    status: row.status,
    retryable: row.retryable,
    attemptCount: requireNonNegativeInteger("delivery attempt count", row.attempt_count),
    nextAttemptAt: requireDate("delivery next attempt at", row.next_attempt_at),
    ...(row.lease_worker_id == null ? {} : { leaseWorkerId: row.lease_worker_id }),
    ...(row.lease_until == null ? {} : { leaseUntil: requireDate("delivery lease until", row.lease_until) }),
    ...(row.external_attempt_started_at == null
      ? {} : { externalAttemptStartedAt: requireDate("external attempt started at", row.external_attempt_started_at) }),
    ...(row.reconciliation_due_at == null
      ? {} : { reconciliationDueAt: requireDate("reconciliation due at", row.reconciliation_due_at) }),
    ...(row.sent_message_id == null ? {} : { sentMessageId: row.sent_message_id }),
    ...(row.failure_code == null ? {} : { failureCode: row.failure_code }),
    createdAt: requireDate("delivery created at", row.created_at),
    updatedAt: requireDate("delivery updated at", row.updated_at),
  };
}

function prefixedCandidateRow(row: DeliveryCandidateRow): CandidateRow {
  const value = (name: string): unknown => row[`candidate_${name}`];
  return {
    id: String(value("id") ?? value("id_value")),
    idempotency_key: String(value("idempotency_key")),
    group_id: String(value("group_id")),
    group_memory_id: String(value("group_memory_id")),
    memory_updated_at: value("memory_updated_at") as Date,
    source_message_id: String(value("source_message_id")),
    target_document_source_id: String(value("target_document_source_id")),
    target_source_updated_at: value("target_source_updated_at") as Date,
    target_source_version: value("target_source_version") as string | null,
    target_snapshot_id: String(value("target_snapshot_id")),
    target_content_hash: String(value("target_content_hash")),
    detector_contract_version: String(value("detector_contract_version")),
    status: value("status") as KnowledgeConflictCandidateStatus,
    subject: String(value("subject")),
    knowledge_base_statement: String(value("knowledge_base_statement")),
    group_conclusion_statement: String(value("group_conclusion_statement")),
    difference: String(value("difference")),
    suggested_update: String(value("suggested_update")),
    target_document_ref: String(value("target_document_ref")),
    confidence: value("confidence") as "high" | "medium",
    version: value("version") as string | number,
    created_at: value("created_at") as Date,
    updated_at: value("updated_at") as Date,
  };
}

async function recordInteraction(
  dataSource: PostgresKnowledgeConflictDataSource,
  input: {
    id: string;
    candidateId: string;
    callbackOperationKey: string;
    actorRef: string;
    action: KnowledgeConflictInteraction["action"];
    result: KnowledgeConflictInteraction["result"];
    draftId?: string;
    reasonCode?: string;
    at: Date;
  },
): Promise<{ outcome: "applied" | "already_applied"; interaction: KnowledgeConflictInteraction }> {
  const normalized = {
    id: requireReference("interaction id", input.id),
    candidateId: requireReference("candidateId", input.candidateId),
    callbackOperationKey: requireReference("callbackOperationKey", input.callbackOperationKey),
    actorRef: requireReference("actorRef", input.actorRef),
    action: input.action,
    result: input.result,
    ...(input.draftId === undefined ? {} : { draftId: requireReference("draftId", input.draftId) }),
    ...(input.reasonCode === undefined
      ? {} : { reasonCode: requireBoundedString("reasonCode", input.reasonCode, 128) }),
    at: requireDate("at", input.at),
  };
  if ((normalized.action === "create_draft" && normalized.result === "applied")
    !== (normalized.draftId !== undefined)) {
    throw new Error("interaction draft identity is invalid");
  }
  return withTransaction(dataSource, async (client) => {
    await lockOperationKey(client, normalized.callbackOperationKey);
    const existingResult = await client.query<InteractionRow>(
      "SELECT * FROM knowledge_conflict_interactions WHERE callback_operation_key = $1",
      [normalized.callbackOperationKey],
    );
    const existing = existingResult.rows[0];
    if (existing !== undefined) {
      if (!interactionMatches(existing, normalized)) throw new KnowledgeConflictOperationConflictError();
      return { outcome: "already_applied", interaction: mapInteraction(existing) };
    }
    const result = await client.query<InteractionRow>(
      `INSERT INTO knowledge_conflict_interactions (
         id, candidate_id, callback_operation_key, actor_ref, action, result,
         draft_id, reason_code, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [normalized.id, normalized.candidateId, normalized.callbackOperationKey,
        normalized.actorRef, normalized.action, normalized.result, normalized.draftId ?? null,
        normalized.reasonCode ?? null, normalized.at],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("knowledge conflict interaction insert returned no row");
    return { outcome: "applied", interaction: mapInteraction(row) };
  });
}

async function applyInteraction(
  dataSource: PostgresKnowledgeConflictDataSource,
  createId: () => string,
  maxPermissionAgeMs: number,
  input: {
    id: string;
    candidateId: string;
    expectedVersion: number;
    callbackOperationKey: string;
    actorRef: string;
    action: "dismiss" | "create_draft";
    draftId?: string;
    targetPolicyId?: string;
    targetPolicyVersion?: number;
    reasonCode: string;
    permissionAttestedAt: Date;
    at: Date;
  },
) {
  const normalized = {
    id: requireReference("interaction id", input.id),
    candidateId: requireReference("candidateId", input.candidateId),
    expectedVersion: requirePositiveInteger("expectedVersion", input.expectedVersion),
    callbackOperationKey: requireReference("callbackOperationKey", input.callbackOperationKey),
    actorRef: requireReference("actorRef", input.actorRef),
    action: input.action,
    ...(input.draftId === undefined ? {} : { draftId: requireReference("draftId", input.draftId) }),
    ...(input.targetPolicyId === undefined
      ? {} : { targetPolicyId: requireReference("targetPolicyId", input.targetPolicyId) }),
    ...(input.targetPolicyVersion === undefined
      ? {} : { targetPolicyVersion: requirePositiveInteger(
          "targetPolicyVersion",
          input.targetPolicyVersion,
        ) }),
    reasonCode: requireBoundedString("reasonCode", input.reasonCode, 128),
    permissionAttestedAt: requireDate("permissionAttestedAt", input.permissionAttestedAt),
    at: requireDate("at", input.at),
  };
  if ((normalized.action === "create_draft") !== (normalized.draftId !== undefined)) {
    throw new Error("create_draft interaction requires a draft id");
  }
  if ((normalized.action === "create_draft") !==
    (normalized.targetPolicyId !== undefined && normalized.targetPolicyVersion !== undefined)) {
    throw new Error("create_draft interaction requires a target policy identity");
  }
  assertFreshPermission(normalized.permissionAttestedAt, normalized.at, maxPermissionAgeMs);
  return withTransaction(dataSource, async (client) => {
    await lockOperationKey(client, normalized.callbackOperationKey);
    const existingResult = await client.query<InteractionRow>(
      "SELECT * FROM knowledge_conflict_interactions WHERE callback_operation_key = $1",
      [normalized.callbackOperationKey],
    );
    const existing = existingResult.rows[0];
    if (existing !== undefined) {
      if (!interactionMatches(existing, {
        ...normalized,
        result: "applied",
      })) throw new KnowledgeConflictOperationConflictError();
      const candidate = await loadCandidate(client, normalized.candidateId);
      if (candidate === undefined) throw new KnowledgeConflictNotFoundError();
      return { outcome: "already_applied" as const, interaction: mapInteraction(existing), candidate };
    }

    const candidateRow = await lockCandidateMemoryBeforeCandidate(client, normalized.candidateId);
    if (Number(candidateRow.version) !== normalized.expectedVersion) {
      throw new KnowledgeConflictVersionConflictError();
    }
    const evidence = await loadEvidence(client, candidateRow.id);
    const staleReason = await findStaleReason(client, candidateRow, evidence);
    if (staleReason !== undefined) throw new KnowledgeConflictStaleEvidenceError(staleReason);
    if (normalized.action === "create_draft") {
      await validateInteractionTargetPolicy(client, {
        id: normalized.targetPolicyId!,
        version: normalized.targetPolicyVersion!,
        groupId: candidateRow.group_id,
      });
    }
    const toStatus = normalized.action === "dismiss" ? "dismissed" : "draft_created";
    requireCandidateTransition(candidateRow.status, toStatus);
    const interactionResult = await client.query<InteractionRow>(
      `INSERT INTO knowledge_conflict_interactions (
         id, candidate_id, callback_operation_key, actor_ref, action, result,
         draft_id, reason_code, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'applied', $6, $7, $8)
       RETURNING *`,
      [normalized.id, normalized.candidateId, normalized.callbackOperationKey,
        normalized.actorRef, normalized.action, normalized.draftId ?? null,
        normalized.reasonCode, normalized.at],
    );
    const interaction = interactionResult.rows[0];
    if (interaction === undefined) throw new Error("knowledge conflict interaction insert returned no row");
    const mutation = await transitionLockedCandidate(client, createId, candidateRow, evidence,
      normalizeTransition({
        candidateId: normalized.candidateId,
        expectedVersion: normalized.expectedVersion,
        operationKey: derivedOperationKey("interaction", normalized.callbackOperationKey),
        actorType: "feishu_user",
        actorRef: normalized.actorRef,
        toStatus,
        reasonCode: normalized.reasonCode,
        at: normalized.at,
      }));
    return {
      outcome: "applied" as const,
      interaction: mapInteraction(interaction),
      candidate: mutation.candidate,
    };
  });
}

type InteractionTargetPolicyRow = {
  id: string;
  allowed_group_ids: string[];
  allowed_risk_levels: string[];
  enabled: boolean;
  version: string | number;
};

async function validateInteractionTargetPolicy(
  client: PostgresKnowledgeConflictQueryable,
  input: { id: string; version: number; groupId: string },
): Promise<void> {
  const result = await client.query<InteractionTargetPolicyRow>(
    `SELECT id, allowed_group_ids, allowed_risk_levels, enabled, version
     FROM knowledge_publication_target_policies
     WHERE id = $1
     FOR UPDATE`,
    [input.id],
  );
  const policy = result.rows[0];
  if (policy === undefined ||
    Number(policy.version) !== input.version ||
    policy.enabled !== true ||
    !policy.allowed_group_ids.includes(input.groupId) ||
    !policy.allowed_risk_levels.includes("medium")) {
    throw new KnowledgeConflictTargetPolicyConflictError();
  }
}

function interactionMatches(
  row: InteractionRow,
  input: {
    id: string;
    candidateId: string;
    callbackOperationKey: string;
    actorRef: string;
    action: KnowledgeConflictInteraction["action"];
    result: KnowledgeConflictInteraction["result"];
    draftId?: string;
    reasonCode?: string;
  },
): boolean {
  return row.id === input.id
    && row.candidate_id === input.candidateId
    && row.callback_operation_key === input.callbackOperationKey
    && row.actor_ref === input.actorRef
    && row.action === input.action
    && row.result === input.result
    && (row.draft_id ?? undefined) === input.draftId
    && (row.reason_code ?? undefined) === input.reasonCode;
}

function mapInteraction(row: InteractionRow): KnowledgeConflictInteraction {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    callbackOperationKey: row.callback_operation_key,
    actorRef: row.actor_ref,
    action: row.action,
    result: row.result,
    ...(row.draft_id === null ? {} : { draftId: row.draft_id }),
    ...(row.reason_code === null ? {} : { reasonCode: row.reason_code }),
    createdAt: requireDate("interaction created at", row.created_at),
  };
}

async function findCurrentOverlap(
  dataSource: PostgresKnowledgeConflictDataSource,
  maxPermissionAgeMs: number,
  input: {
    groupId: string;
    groupMemoryIds: readonly string[];
    documents: readonly { sourceId: string; snapshotId: string }[];
    permissionAttestedAt: Date;
    at: Date;
  },
): Promise<KnowledgeConflictCandidate | undefined> {
  const groupId = requireReference("groupId", input.groupId);
  const at = requireDate("at", input.at);
  assertFreshPermission(input.permissionAttestedAt, at, maxPermissionAgeMs);
  const memoryIds = normalizeReferences("groupMemoryIds", input.groupMemoryIds);
  const documents = input.documents.map((document) => ({
    sourceId: requireReference("sourceId", document.sourceId),
    snapshotId: requireReference("snapshotId", document.snapshotId),
  }));
  if (memoryIds.length === 0 || documents.length === 0) return undefined;
  return withTransaction(dataSource, async (client) => {
    await client.query<{ id: string }>(
      `SELECT id FROM group_memories
       WHERE group_id = $1 AND id = ANY($2::text[])
       ORDER BY id
       FOR UPDATE`,
      [groupId, memoryIds],
    );
    const result = await client.query<CandidateRow>(
      `SELECT candidate.*
       FROM knowledge_conflict_candidates candidate
       WHERE candidate.group_id = $1
         AND candidate.group_memory_id = ANY($2::text[])
         AND candidate.status IN (
           'pending_review', 'approved_for_delivery', 'delivered', 'draft_created'
         )
         AND EXISTS (
           SELECT 1 FROM unnest($3::text[], $4::text[]) AS overlap(source_id, snapshot_id)
           WHERE overlap.source_id = candidate.target_document_source_id
             AND overlap.snapshot_id = candidate.target_snapshot_id
         )
       ORDER BY candidate.updated_at DESC, candidate.id ASC
       LIMIT 50
       FOR UPDATE OF candidate`,
      [groupId, memoryIds, documents.map((item) => item.sourceId),
        documents.map((item) => item.snapshotId)],
    );
    for (const row of result.rows) {
      const evidence = await loadEvidence(client, row.id);
      if (await findStaleReason(client, row, evidence) === undefined) {
        return mapCandidate(row, evidence);
      }
    }
    return undefined;
  });
}

async function getCandidateStatusCounts(dataSource: PostgresKnowledgeConflictDataSource) {
  const result = await dataSource.query<{ status: KnowledgeConflictCandidateStatus; count: string | number }>(
    "SELECT status, count(*) AS count FROM knowledge_conflict_candidates GROUP BY status",
  );
  const counts = {
    pending_review: 0,
    dismissed: 0,
    approved_for_delivery: 0,
    delivered: 0,
    draft_created: 0,
    superseded: 0,
  };
  for (const row of result.rows) counts[row.status] = requireCount(row.count);
  return counts;
}

async function getDeliveryStatusCounts(dataSource: PostgresKnowledgeConflictDataSource) {
  const result = await dataSource.query<{ status: KnowledgeConflictDelivery["status"]; count: string | number }>(
    "SELECT status, count(*) AS count FROM knowledge_conflict_delivery_outbox GROUP BY status",
  );
  const counts = { pending: 0, processing: 0, externalAttempting: 0, sent: 0,
    failed: 0, terminalFailed: 0, outcomeUnknown: 0, cancelled: 0 };
  for (const row of result.rows) {
    const key = row.status === "external_attempting" ? "externalAttempting"
      : row.status === "outcome_unknown" ? "outcomeUnknown" : row.status;
    counts[key] = requireCount(row.count);
  }
  const terminal = await dataSource.query<{ count: string | number }>(
    `SELECT count(*) AS count FROM knowledge_conflict_delivery_outbox
     WHERE status = 'failed' AND retryable = FALSE`,
  );
  counts.terminalFailed = requireCount(terminal.rows[0]?.count ?? 0);
  return counts;
}

async function getInteractionResultCounts(dataSource: PostgresKnowledgeConflictDataSource) {
  const result = await dataSource.query<{ result: KnowledgeConflictInteraction["result"]; count: string | number }>(
    "SELECT result, count(*) AS count FROM knowledge_conflict_interactions GROUP BY result",
  );
  const counts = { applied: 0, alreadyApplied: 0, rejected: 0 };
  for (const row of result.rows) {
    const key = row.result === "already_applied" ? "alreadyApplied" : row.result;
    counts[key] = requireCount(row.count);
  }
  return counts;
}

function eligibleMemorySelect(): string {
  return `SELECT gm.id, gm.group_id, gm.updated_at
    FROM group_memories gm
    WHERE gm.group_id = ANY($1::text[])
      AND gm.memory_scope = 'group'
      AND gm.category IN ('decision', 'workflow', 'term')
      AND gm.confidence >= 0.80
      AND gm.importance >= 3
      AND gm.status = 'active'
      AND EXISTS (${currentEvidenceExistsSql()})`;
}

function currentEvidenceExistsSql(): string {
  return `SELECT 1
    FROM group_memory_message_evidence evidence
    JOIN conversation_messages message
      ON message.id = evidence.conversation_message_id
     AND message.chat_id = gm.group_id
    LEFT JOIN conversation_message_deletion_tombstones tombstone
      ON tombstone.conversation_message_id = message.id
    WHERE evidence.memory_id = gm.id
      AND tombstone.conversation_message_id IS NULL`;
}

function currentScanFactsExistSql(inboxAlias: "inbox"): string {
  return `EXISTS (
    SELECT 1
    FROM group_memories current_memory
    WHERE current_memory.id = ${inboxAlias}.group_memory_id
      AND current_memory.group_id = ${inboxAlias}.group_id
      AND current_memory.updated_at = ${inboxAlias}.memory_updated_at
      AND current_memory.status = 'active'
      AND EXISTS (
        SELECT 1
        FROM group_memory_message_evidence current_evidence
        JOIN conversation_messages current_message
          ON current_message.id = current_evidence.conversation_message_id
         AND current_message.chat_id = ${inboxAlias}.group_id
        LEFT JOIN conversation_message_deletion_tombstones current_tombstone
          ON current_tombstone.conversation_message_id = current_message.id
        WHERE current_evidence.memory_id = current_memory.id
          AND current_tombstone.conversation_message_id IS NULL
      )
  )`;
}

function mapScan(row: ScanRow): KnowledgeConflictScan {
  return {
    id: requireReference("scan id", row.id),
    groupId: requireReference("scan group id", row.group_id),
    groupMemoryId: requireReference("scan memory id", row.group_memory_id),
    memoryUpdatedAt: requireDate("scan memory updated at", row.memory_updated_at),
    status: row.status,
    attemptCount: requireNonNegativeInteger("scan attempt count", row.attempt_count),
    nextAttemptAt: requireDate("scan next attempt at", row.next_attempt_at),
    ...(row.lease_worker_id === null ? {} : { leaseWorkerId: row.lease_worker_id }),
    ...(row.lease_until === null ? {} : { leaseUntil: requireDate("scan lease until", row.lease_until) }),
    ...(row.terminal_outcome === null ? {} : { terminalOutcome: row.terminal_outcome }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    createdAt: requireDate("scan created at", row.created_at),
    updatedAt: requireDate("scan updated at", row.updated_at),
  };
}

function mapClaimMemory(row: ClaimRow): GroupMemory {
  return {
    id: row.memory_id,
    groupId: row.memory_group_id,
    scope: row.memory_memory_scope,
    category: row.memory_category,
    ...(row.memory_thread_key === null ? {} : { threadKey: row.memory_thread_key }),
    content: row.memory_content,
    importance: Number(row.memory_importance),
    confidence: Number(row.memory_confidence),
    status: row.memory_status,
    idempotencyKey: row.memory_idempotency_key,
    origin: row.memory_origin,
    createdBy: row.memory_created_by,
    ...(row.memory_supersedes_memory_id === null
      ? {}
      : { supersedesMemoryId: row.memory_supersedes_memory_id }),
    evidenceMessageIds: [...row.memory_evidence_message_ids],
    createdAt: requireDate("memory created at", row.memory_created_at),
    updatedAt: requireDate("memory updated at", row.memory_updated_at),
  };
}

async function withTransaction<T>(
  dataSource: PostgresKnowledgeConflictDataSource,
  operation: (client: PostgresKnowledgeConflictTransactionClient) => Promise<T>,
): Promise<T> {
  const client = await dataSource.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function lockOperationKey(
  client: PostgresKnowledgeConflictTransactionClient,
  operationKey: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [operationKey],
  );
}

function normalizeGroupIds(values: readonly string[]): string[] {
  if (values.length > MAX_BATCH_SIZE) throw new Error("groupIds exceeds batch limit");
  const normalized = values.map((value) => requireReference("groupId", value));
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

function requireLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_BATCH_SIZE) {
    throw new Error("limit must be an integer between 0 and 50");
  }
  return value;
}

function requireAttemptLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new Error("maxScanAttempts must be an integer between 1 and 20");
  }
  return value;
}

function requireReference(name: string, value: string): string {
  return requireBoundedString(name, value, MAX_REFERENCE_CHARS);
}

function requireBoundedString(name: string, value: string, maxChars: number): string {
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > maxChars) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function requireDate(name: string, value: Date): Date {
  const normalized = new Date(value);
  if (Number.isNaN(normalized.getTime())) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireCount(value: string | number): number {
  return requireNonNegativeInteger("count", value);
}

function requireNonNegativeInteger(name: string, value: string | number): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw new Error(`${name} is invalid`);
  return normalized;
}

function requirePositiveInteger(name: string, value: string | number): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireAttemptCount(name: string, value: string | number): number {
  const normalized = requirePositiveInteger(name, value);
  if (normalized > 20) throw new Error(`${name} is invalid`);
  return normalized;
}

function requirePositiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} is invalid`);
  return value;
}

function requireHash(name: string, value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function normalizeReferences(name: string, values: readonly string[]): string[] {
  if (values.length > MAX_BATCH_SIZE) throw new Error(`${name} exceeds batch limit`);
  return [...new Set(values.map((value) => requireReference(name, value)))].sort();
}

function assertFreshPermission(attestedAtValue: Date, at: Date, maxAgeMs: number): void {
  const attestedAt = requireDate("permissionAttestedAt", attestedAtValue);
  const age = at.getTime() - attestedAt.getTime();
  if (age < 0 || age > maxAgeMs) throw new KnowledgeConflictStaleEvidenceError("permission_stale");
}

function derivedOperationKey(kind: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return `knowledge_conflict:${kind}:${digest}`;
}

function requireTerminalOutcome(
  value: NonNullable<KnowledgeConflictScan["terminalOutcome"]>,
): NonNullable<KnowledgeConflictScan["terminalOutcome"]> {
  if (![
    "conflict", "no_conflict", "insufficient_evidence", "superseded", "permission_blocked",
  ].includes(value)) throw new Error("terminal outcome is invalid");
  return value;
}
