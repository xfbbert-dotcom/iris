import { randomUUID } from "node:crypto";

import {
  PROACTIVE_SIGNAL_CANDIDATE_STATUSES,
  PROACTIVE_SIGNAL_REASONS,
  PROACTIVE_SIGNAL_SOURCE_TYPES,
  type ProactiveSignalCandidate,
  type ProactiveSignalCandidateProposal,
  type ProactiveSignalScoreFactors,
} from "./proactive-signal-candidate.js";
import type { ProactiveSignalSourceSnapshot } from "./proactive-signal-evaluator.js";
import {
  PROACTIVE_SIGNAL_SCAN_STATUSES,
  type ProactiveSignalRepository,
  type ProactiveSignalScanRun,
  type ProactiveSignalStatusCounts,
} from "./proactive-signal-repository.js";

export type ProactiveSignalQueryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export type ProactiveSignalTransactionClient = ProactiveSignalQueryable & { release(): void };

export type PostgresProactiveSignalDataSource = ProactiveSignalQueryable & {
  connect(): Promise<ProactiveSignalTransactionClient>;
};

const MAX_IDENTIFIER_CHARS = 512;
const MAX_POLICY_VERSION_CHARS = 128;
const MAX_EXPLANATION_CHARS = 512;
const MAX_FAILURE_CLASSIFICATION_CHARS = 128;
const MAX_GROUPS = 100;
const MAX_LIST_LIMIT = 500;

const candidateColumns = `
  id, group_id, source_type, COALESCE(thread_id, action_item_id) AS source_id,
  source_version, reason, score, score_factors, explanation, policy_version,
  status, version, source_activity_at, eligible_at, observed_at,
  dismissed_at, dismissed_by, dismissal_reason, expired_at, created_at, updated_at
`;

const scanRunColumns = `
  id, policy_version, requested_group_ids, status, scanned_source_count,
  created_candidate_count, duplicate_candidate_count, expired_candidate_count,
  skipped_candidate_count, failure_classification, started_at, finished_at,
  created_at, updated_at
`;

export function createPostgresProactiveSignalRepository({
  dataSource,
}: {
  dataSource: ProactiveSignalQueryable | PostgresProactiveSignalDataSource;
}): ProactiveSignalRepository {
  return {
    async loadEligibleSources(input) {
      const groupIds = requireGroupIds(input.groupIds);
      const minConfidence = requireConfidence(input.minConfidence);
      const threadQuietBefore = requireDate("threadQuietBefore", input.threadQuietBefore);
      const actionQuietBefore = requireDate("actionQuietBefore", input.actionQuietBefore);
      const overdueBefore = requireDate("overdueBefore", input.overdueBefore);
      const limit = requireLimit(input.limit);
      const result = await dataSource.query(
        `
        WITH eligible_actions AS (
          SELECT
            0 AS source_priority,
            'action'::TEXT AS source_type,
            action.id AS source_id,
            action.group_id,
            action.version AS source_version,
            action.status,
            (action.retrieval_state = 'visible') AS retrieval_visible,
            action.confidence,
            action.updated_at AS activity_at,
            action.due_at,
            FALSE AS has_eligible_open_action
          FROM action_items action
          WHERE action.group_id = ANY($1::TEXT[])
            AND action.status = 'open'
            AND action.retrieval_state = 'visible'
            AND action.confidence >= $2
            AND (
              (action.due_at IS NOT NULL AND action.due_at <= $5)
              OR action.updated_at <= $4
            )
        ), eligible_threads AS (
          SELECT
            1 AS source_priority,
            'thread'::TEXT AS source_type,
            thread.id AS source_id,
            thread.group_id,
            thread.version AS source_version,
            thread.status,
            (thread.retrieval_state = 'visible') AS retrieval_visible,
            thread.confidence,
            thread.last_activity_at AS activity_at,
            NULL::TIMESTAMPTZ AS due_at,
            FALSE AS has_eligible_open_action
          FROM discussion_threads thread
          WHERE thread.group_id = ANY($1::TEXT[])
            AND thread.status = 'open'
            AND thread.retrieval_state = 'visible'
            AND thread.confidence >= $2
            AND thread.last_activity_at <= $3
            AND NOT EXISTS (
              SELECT 1
              FROM action_items action
              WHERE action.thread_id = thread.id
                AND action.group_id = thread.group_id
                AND action.status = 'open'
                AND action.retrieval_state = 'visible'
                AND action.confidence >= $2
                AND (
                  (action.due_at IS NOT NULL AND action.due_at <= $5)
                  OR action.updated_at <= $4
                )
            )
        )
        SELECT * FROM eligible_actions
        UNION ALL
        SELECT * FROM eligible_threads
        ORDER BY source_priority ASC, activity_at ASC, source_id ASC
        LIMIT $6
        `,
        [groupIds, minConfidence, threadQuietBefore, actionQuietBefore, overdueBefore, limit],
      );
      return result.rows.map(mapSourceRow);
    },

    async observeCandidate(rawProposal) {
      const proposal = validateProposal(rawProposal);
      const source = requireTransactionalSource(dataSource);
      const client = await source.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`proactive:${proposal.groupId}:${proposal.sourceType}:${proposal.sourceId}:${proposal.reason}`],
        );
        const sourceStillCurrent = await loadCurrentSource(client, proposal);
        if (!sourceStillCurrent) {
          await client.query("COMMIT");
          return { outcome: "source_changed", expiredCandidateCount: 0 };
        }
        const exact = await client.query(
          `
          SELECT ${candidateColumns}
          FROM proactive_signal_candidates
          WHERE group_id = $1
            AND source_type = $2
            AND COALESCE(thread_id, action_item_id) = $3
            AND source_version = $4
            AND reason = $5
            AND policy_version = $6
          FOR UPDATE
          `,
          [
            proposal.groupId,
            proposal.sourceType,
            proposal.sourceId,
            proposal.sourceVersion,
            proposal.reason,
            proposal.policyVersion,
          ],
        );
        if (exact.rows.length > 0) {
          const candidate = onlyCandidate(exact.rows);
          await client.query("COMMIT");
          return { outcome: "already_observed", candidate, expiredCandidateCount: 0 };
        }

        const expired = await client.query<{ id: unknown }>(
          `
          WITH expired AS (
            UPDATE proactive_signal_candidates
            SET status = 'expired',
                version = version + 1,
                expired_at = $5,
                updated_at = $5
            WHERE group_id = $1
              AND source_type = $2
              AND COALESCE(thread_id, action_item_id) = $3
              AND reason = $4
              AND status = 'pending'
            RETURNING id, group_id, version
          ), audit AS (
            INSERT INTO proactive_signal_candidate_events (
              id, candidate_id, group_id, event_type, from_version, to_version, created_at
            )
            SELECT gen_random_uuid()::TEXT, id, group_id, 'expired', version - 1, version, $5
            FROM expired
          )
          SELECT id FROM expired
          `,
          [
            proposal.groupId,
            proposal.sourceType,
            proposal.sourceId,
            proposal.reason,
            proposal.observedAt,
          ],
        );
        const candidateId = randomUUID();
        const sourceIds = sourceIdColumns(proposal);
        const inserted = await client.query(
          `
          WITH inserted AS (
            INSERT INTO proactive_signal_candidates (
              id, group_id, source_type, thread_id, action_item_id, source_version,
              reason, score, score_factors, explanation, policy_version, status,
              version, source_activity_at, eligible_at, observed_at, created_at, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6,
              $7, $8, $9::JSONB, $10, $11, 'pending',
              1, $12, $13, $14, $14, $14
            )
            RETURNING *
          ), audit AS (
            INSERT INTO proactive_signal_candidate_events (
              id, candidate_id, group_id, event_type, from_version, to_version, created_at
            )
            SELECT gen_random_uuid()::TEXT, id, group_id, 'created', NULL, version, $14
            FROM inserted
          )
          SELECT ${candidateColumns} FROM inserted
          `,
          [
            candidateId,
            proposal.groupId,
            proposal.sourceType,
            sourceIds.threadId,
            sourceIds.actionItemId,
            proposal.sourceVersion,
            proposal.reason,
            proposal.score,
            JSON.stringify(proposal.scoreFactors),
            proposal.explanation,
            proposal.policyVersion,
            proposal.sourceActivityAt,
            proposal.eligibleAt,
            proposal.observedAt,
          ],
        );
        const candidate = onlyCandidate(inserted.rows);
        await client.query("COMMIT");
        return {
          outcome: "created",
          candidate,
          expiredCandidateCount: expired.rows.length,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async listCandidates(input) {
      const groupId = requireBoundedString("groupId", input.groupId, MAX_IDENTIFIER_CHARS);
      const statuses = input.statuses === undefined
        ? [...PROACTIVE_SIGNAL_CANDIDATE_STATUSES]
        : requireEnums("statuses", input.statuses, PROACTIVE_SIGNAL_CANDIDATE_STATUSES);
      const limit = requireLimit(input.limit);
      const result = await dataSource.query(
        `
        SELECT ${candidateColumns}
        FROM proactive_signal_candidates
        WHERE group_id = $1 AND status = ANY($2::TEXT[])
        ORDER BY score DESC, eligible_at ASC, id ASC
        LIMIT $3
        `,
        [groupId, statuses, limit],
      );
      return result.rows.map(mapCandidateRow);
    },

    async getCandidate(input) {
      const id = requireBoundedString("id", input.id, MAX_IDENTIFIER_CHARS);
      const groupId = requireBoundedString("groupId", input.groupId, MAX_IDENTIFIER_CHARS);
      const result = await dataSource.query(
        `SELECT ${candidateColumns} FROM proactive_signal_candidates WHERE id = $1 AND group_id = $2`,
        [id, groupId],
      );
      return optionalCandidate(result.rows);
    },

    async dismissCandidate(input) {
      const id = requireBoundedString("id", input.id, MAX_IDENTIFIER_CHARS);
      const groupId = requireBoundedString("groupId", input.groupId, MAX_IDENTIFIER_CHARS);
      const expectedVersion = requirePositiveSafeInteger("expectedVersion", input.expectedVersion);
      const dismissedBy = requireBoundedString("dismissedBy", input.dismissedBy, MAX_IDENTIFIER_CHARS);
      const dismissalReason = input.dismissalReason === undefined
        ? null
        : requireBoundedString("dismissalReason", input.dismissalReason, MAX_IDENTIFIER_CHARS);
      const at = requireDate("at", input.at);
      const result = await dataSource.query(
        `
        WITH updated AS (
          UPDATE proactive_signal_candidates
          SET status = 'dismissed',
              version = version + 1,
              dismissed_at = $6,
              dismissed_by = $4,
              dismissal_reason = $5,
              updated_at = $6
          WHERE id = $1 AND group_id = $2 AND version = $3 AND status = 'pending'
          RETURNING *
        ), audit AS (
          INSERT INTO proactive_signal_candidate_events (
            id, candidate_id, group_id, event_type, from_version, to_version,
            actor, reason, created_at
          )
          SELECT gen_random_uuid()::TEXT, id, group_id, 'dismissed', version - 1, version,
            dismissed_by, dismissal_reason, $6
          FROM updated
        )
        SELECT ${candidateColumns} FROM updated
        `,
        [id, groupId, expectedVersion, dismissedBy, dismissalReason, at],
      );
      return result.rows.length === 0 ? "conflict" : onlyCandidate(result.rows);
    },

    async startScanRun(input) {
      const id = requireBoundedString("id", input.id, MAX_IDENTIFIER_CHARS);
      const policyVersion = requireBoundedString(
        "policyVersion",
        input.policyVersion,
        MAX_POLICY_VERSION_CHARS,
      );
      const requestedGroupIds = requireGroupIds(input.requestedGroupIds);
      const startedAt = requireDate("startedAt", input.startedAt);
      const result = await dataSource.query(
        `
        INSERT INTO proactive_signal_scan_runs (
          id, policy_version, requested_group_ids, status, started_at, created_at, updated_at
        ) VALUES ($1, $2, $3, 'processing', $4, $4, $4)
        RETURNING ${scanRunColumns}
        `,
        [id, policyVersion, requestedGroupIds, startedAt],
      );
      return onlyScanRun(result.rows);
    },

    async completeScanRun(input) {
      const id = requireBoundedString("id", input.id, MAX_IDENTIFIER_CHARS);
      const counts = [
        input.scannedSourceCount,
        input.createdCandidateCount,
        input.duplicateCandidateCount,
        input.expiredCandidateCount,
        input.skippedCandidateCount,
      ].map((value) => requireNonNegativeSafeInteger("scan count", value));
      const finishedAt = requireDate("finishedAt", input.finishedAt);
      const result = await dataSource.query(
        `
        UPDATE proactive_signal_scan_runs
        SET status = 'completed', scanned_source_count = $2, created_candidate_count = $3,
            duplicate_candidate_count = $4, expired_candidate_count = $5,
            skipped_candidate_count = $6, finished_at = $7, updated_at = $7
        WHERE id = $1 AND status = 'processing'
        RETURNING ${scanRunColumns}
        `,
        [id, ...counts, finishedAt],
      );
      return onlyScanRun(result.rows);
    },

    async failScanRun(input) {
      const id = requireBoundedString("id", input.id, MAX_IDENTIFIER_CHARS);
      const failureClassification = requireBoundedString(
        "failureClassification",
        input.failureClassification,
        MAX_FAILURE_CLASSIFICATION_CHARS,
      );
      const finishedAt = requireDate("finishedAt", input.finishedAt);
      const result = await dataSource.query(
        `
        UPDATE proactive_signal_scan_runs
        SET status = 'failed', failure_classification = $2, finished_at = $3, updated_at = $3
        WHERE id = $1 AND status = 'processing'
        RETURNING ${scanRunColumns}
        `,
        [id, failureClassification, finishedAt],
      );
      return onlyScanRun(result.rows);
    },

    async getStatusCounts() {
      const [candidateResult, scanResult] = await Promise.all([
        dataSource.query("SELECT status, COUNT(*) AS count FROM proactive_signal_candidates GROUP BY status"),
        dataSource.query("SELECT status, COUNT(*) AS count FROM proactive_signal_scan_runs GROUP BY status"),
      ]);
      return {
        candidates: mapCounts(candidateResult.rows, PROACTIVE_SIGNAL_CANDIDATE_STATUSES),
        scans: mapCounts(scanResult.rows, PROACTIVE_SIGNAL_SCAN_STATUSES),
      } satisfies ProactiveSignalStatusCounts;
    },
  };
}

function mapSourceRow(row: Record<string, unknown>): ProactiveSignalSourceSnapshot {
  const sourceType = requireEnum("source type", row.source_type, PROACTIVE_SIGNAL_SOURCE_TYPES);
  const base = {
    sourceType,
    sourceId: requireBoundedString("source id", row.source_id, MAX_IDENTIFIER_CHARS),
    groupId: requireBoundedString("source group id", row.group_id, MAX_IDENTIFIER_CHARS),
    sourceVersion: requirePositiveSafeInteger("source version", numberValue(row.source_version)),
    retrievalVisible: requireBoolean("retrieval visibility", row.retrieval_visible),
    confidence: requireConfidence(numberValue(row.confidence)),
  } as const;
  const activityAt = requireDateValue("source activity", row.activity_at);
  if (sourceType === "thread") {
    return {
      ...base,
      sourceType,
      status: requireEnum("thread status", row.status, ["candidate", "open", "resolved", "merged"]),
      lastActivityAt: activityAt,
      hasEligibleOpenAction: requireBoolean(
        "eligible action flag",
        row.has_eligible_open_action,
      ),
    };
  }
  const dueAt = optionalDateValue("due time", row.due_at);
  return {
    ...base,
    sourceType,
    status: requireEnum("action status", row.status, ["open", "completed", "cancelled"]),
    updatedAt: activityAt,
    ...(dueAt === undefined ? {} : { dueAt }),
  };
}

function mapCandidateRow(row: Record<string, unknown>): ProactiveSignalCandidate {
  const dismissedAt = optionalDateValue("dismissedAt", row.dismissed_at);
  const dismissedBy = optionalBoundedString("dismissedBy", row.dismissed_by, MAX_IDENTIFIER_CHARS);
  const dismissalReason = optionalBoundedString(
    "dismissalReason",
    row.dismissal_reason,
    MAX_IDENTIFIER_CHARS,
  );
  const expiredAt = optionalDateValue("expiredAt", row.expired_at);
  return {
    id: requireBoundedString("candidate id", row.id, MAX_IDENTIFIER_CHARS),
    groupId: requireBoundedString("candidate group id", row.group_id, MAX_IDENTIFIER_CHARS),
    sourceType: requireEnum("candidate source type", row.source_type, PROACTIVE_SIGNAL_SOURCE_TYPES),
    sourceId: requireBoundedString("candidate source id", row.source_id, MAX_IDENTIFIER_CHARS),
    sourceVersion: requirePositiveSafeInteger("source version", numberValue(row.source_version)),
    reason: requireEnum("candidate reason", row.reason, PROACTIVE_SIGNAL_REASONS),
    score: requireConfidence(numberValue(row.score)),
    scoreFactors: requireScoreFactors(row.score_factors),
    explanation: requireBoundedString("explanation", row.explanation, MAX_EXPLANATION_CHARS),
    policyVersion: requireBoundedString(
      "policyVersion",
      row.policy_version,
      MAX_POLICY_VERSION_CHARS,
    ),
    status: requireEnum("candidate status", row.status, PROACTIVE_SIGNAL_CANDIDATE_STATUSES),
    version: requirePositiveSafeInteger("candidate version", numberValue(row.version)),
    sourceActivityAt: requireDateValue("sourceActivityAt", row.source_activity_at),
    eligibleAt: requireDateValue("eligibleAt", row.eligible_at),
    observedAt: requireDateValue("observedAt", row.observed_at),
    ...(dismissedAt === undefined ? {} : { dismissedAt }),
    ...(dismissedBy === undefined ? {} : { dismissedBy }),
    ...(dismissalReason === undefined ? {} : { dismissalReason }),
    ...(expiredAt === undefined ? {} : { expiredAt }),
    createdAt: requireDateValue("createdAt", row.created_at),
    updatedAt: requireDateValue("updatedAt", row.updated_at),
  };
}

function mapScanRun(row: Record<string, unknown>): ProactiveSignalScanRun {
  const failureClassification = optionalBoundedString(
    "failureClassification",
    row.failure_classification,
    MAX_FAILURE_CLASSIFICATION_CHARS,
  );
  const finishedAt = optionalDateValue("finishedAt", row.finished_at);
  return {
    id: requireBoundedString("scan run id", row.id, MAX_IDENTIFIER_CHARS),
    policyVersion: requireBoundedString(
      "scan policyVersion",
      row.policy_version,
      MAX_POLICY_VERSION_CHARS,
    ),
    requestedGroupIds: requireGroupIds(row.requested_group_ids),
    status: requireEnum("scan status", row.status, PROACTIVE_SIGNAL_SCAN_STATUSES),
    scannedSourceCount: requireNonNegativeSafeInteger("scannedSourceCount", numberValue(row.scanned_source_count)),
    createdCandidateCount: requireNonNegativeSafeInteger("createdCandidateCount", numberValue(row.created_candidate_count)),
    duplicateCandidateCount: requireNonNegativeSafeInteger("duplicateCandidateCount", numberValue(row.duplicate_candidate_count)),
    expiredCandidateCount: requireNonNegativeSafeInteger("expiredCandidateCount", numberValue(row.expired_candidate_count)),
    skippedCandidateCount: requireNonNegativeSafeInteger("skippedCandidateCount", numberValue(row.skipped_candidate_count)),
    ...(failureClassification === undefined ? {} : { failureClassification }),
    startedAt: requireDateValue("startedAt", row.started_at),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    createdAt: requireDateValue("createdAt", row.created_at),
    updatedAt: requireDateValue("updatedAt", row.updated_at),
  };
}

function validateProposal(proposal: ProactiveSignalCandidateProposal): ProactiveSignalCandidateProposal {
  requireBoundedString("groupId", proposal.groupId, MAX_IDENTIFIER_CHARS);
  requireEnum("sourceType", proposal.sourceType, PROACTIVE_SIGNAL_SOURCE_TYPES);
  requireBoundedString("sourceId", proposal.sourceId, MAX_IDENTIFIER_CHARS);
  requirePositiveSafeInteger("sourceVersion", proposal.sourceVersion);
  requireEnum("reason", proposal.reason, PROACTIVE_SIGNAL_REASONS);
  requireConfidence(proposal.score);
  requireScoreFactors(proposal.scoreFactors);
  requireBoundedString("explanation", proposal.explanation, MAX_EXPLANATION_CHARS);
  requireBoundedString("policyVersion", proposal.policyVersion, MAX_POLICY_VERSION_CHARS);
  requireDate("sourceActivityAt", proposal.sourceActivityAt);
  requireDate("eligibleAt", proposal.eligibleAt);
  requireDate("observedAt", proposal.observedAt);
  return proposal;
}

function sourceIdColumns(proposal: ProactiveSignalCandidateProposal) {
  return proposal.sourceType === "thread"
    ? { threadId: proposal.sourceId, actionItemId: null }
    : { threadId: null, actionItemId: proposal.sourceId };
}

async function loadCurrentSource(
  client: ProactiveSignalTransactionClient,
  proposal: ProactiveSignalCandidateProposal,
): Promise<boolean> {
  const table = proposal.sourceType === "thread" ? "discussion_threads" : "action_items";
  const result = await client.query(
    `
    SELECT id
    FROM ${table}
    WHERE id = $1
      AND group_id = $2
      AND version = $3
      AND status = 'open'
      AND retrieval_state = 'visible'
    FOR SHARE
    `,
    [proposal.sourceId, proposal.groupId, proposal.sourceVersion],
  );
  if (result.rows.length > 1) throw new Error("proactive source query returned multiple rows");
  return result.rows.length === 1;
}

function requireTransactionalSource(
  source: ProactiveSignalQueryable | PostgresProactiveSignalDataSource,
): PostgresProactiveSignalDataSource {
  if (!("connect" in source) || typeof source.connect !== "function") {
    throw new Error("proactive candidate observation requires a transactional data source");
  }
  return source;
}

function onlyCandidate(rows: Record<string, unknown>[]): ProactiveSignalCandidate {
  if (rows.length !== 1) throw new Error("proactive candidate persistence failed");
  return mapCandidateRow(rows[0]!);
}

function optionalCandidate(rows: Record<string, unknown>[]): ProactiveSignalCandidate | undefined {
  if (rows.length > 1) throw new Error("proactive candidate query returned multiple rows");
  return rows.length === 0 ? undefined : mapCandidateRow(rows[0]!);
}

function onlyScanRun(rows: Record<string, unknown>[]): ProactiveSignalScanRun {
  if (rows.length !== 1) throw new Error("proactive scan run persistence failed");
  return mapScanRun(rows[0]!);
}

function requireGroupIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_GROUPS) {
    throw new Error("groupIds are invalid");
  }
  const normalized = value.map((groupId) =>
    requireBoundedString("groupId", groupId, MAX_IDENTIFIER_CHARS));
  const unique = [...new Set(normalized)].sort();
  if (unique.length !== normalized.length) throw new Error("groupIds contain duplicates");
  return unique;
}

function requireScoreFactors(value: unknown): ProactiveSignalScoreFactors {
  if (!isRecord(value)) throw new Error("score factors are invalid");
  const expected = [
    "ageContribution",
    "base",
    "confidenceContribution",
    "overdueByMs",
    "overdueContribution",
    "quietForMs",
  ];
  if (Object.keys(value).sort().join("|") !== expected.sort().join("|")) {
    throw new Error("score factors are invalid");
  }
  const result = {
    base: numberValue(value.base),
    confidenceContribution: numberValue(value.confidenceContribution),
    ageContribution: numberValue(value.ageContribution),
    overdueContribution: numberValue(value.overdueContribution),
    quietForMs: numberValue(value.quietForMs),
    overdueByMs: numberValue(value.overdueByMs),
  };
  for (const contribution of [
    result.base,
    result.confidenceContribution,
    result.ageContribution,
    result.overdueContribution,
  ]) requireConfidence(contribution);
  requireNonNegativeSafeInteger("quietForMs", result.quietForMs);
  requireNonNegativeSafeInteger("overdueByMs", result.overdueByMs);
  return result;
}

function mapCounts<T extends string>(
  rows: Record<string, unknown>[],
  statuses: readonly T[],
): Record<T, number> {
  const result = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<T, number>;
  for (const row of rows) {
    const status = requireEnum("count status", row.status, statuses);
    result[status] = requireNonNegativeSafeInteger("count", numberValue(row.count));
  }
  return result;
}

function requireEnums<T extends string>(label: string, value: T[], allowed: readonly T[]): T[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > allowed.length) {
    throw new Error(`${label} are invalid`);
  }
  const normalized = value.map((item) => requireEnum(label, item, allowed));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contain duplicates`);
  return normalized;
}

function requireEnum<T extends string>(label: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} is invalid`);
  }
  return value as T;
}

function requireBoundedString(label: string, value: unknown, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxLength) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function optionalBoundedString(
  label: string,
  value: unknown,
  maxLength: number,
): string | undefined {
  return value === null || value === undefined
    ? undefined
    : requireBoundedString(label, value, maxLength);
}

function requireConfidence(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("confidence is invalid");
  }
  return value;
}

function requireLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new Error("limit is invalid");
  }
  return value;
}

function requirePositiveSafeInteger(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid`);
  return value;
}

function requireNonNegativeSafeInteger(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function requireDate(label: string, value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} is invalid`);
  }
  return new Date(value);
}

function requireDateValue(label: string, value: unknown): Date {
  if (value instanceof Date) return requireDate(label, value);
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  return requireDate(label, new Date(value));
}

function optionalDateValue(label: string, value: unknown): Date | undefined {
  return value === null || value === undefined ? undefined : requireDateValue(label, value);
}

function requireBoolean(label: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid`);
  return value;
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error("numeric value is invalid");
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
