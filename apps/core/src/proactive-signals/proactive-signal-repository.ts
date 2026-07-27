import { createHash } from "node:crypto";

import type { ProactiveSignalCandidate } from "./proactive-signal-planner.js";
import { readDatabaseConfig, type DatabaseEnv } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";

export type ProactiveSignalRecordResult = {
  recordedCount: number;
  existingCount: number;
  suppressedCount?: number;
  recordedKeys: string[];
};

export type ProactiveSignalFeedback = "helpful" | "irrelevant";

export type ProactiveSignalFeedbackResult =
  | { status: "applied" }
  | { status: "already_applied" }
  | { status: "stale_binding" };

export type ProactiveSignalFeedbackSummary = {
  groupId: string;
  totalCount: number;
  helpfulCount: number;
  irrelevantCount: number;
  helpfulRate: number | null;
  activeSuppressionCount: number;
  lastFeedbackAt?: Date;
};

export type PersistedProactiveSignalCandidate = {
  idempotencyKey: string;
  groupId: string;
  kind: ProactiveSignalCandidate["kind"];
  priority: ProactiveSignalCandidate["priority"];
  entityType: "thread" | "action";
  entityId: string;
  entityVersion: number;
  reasonCode: ProactiveSignalCandidate["reasonCode"];
  suggestedMode: ProactiveSignalCandidate["suggestedMode"];
  status: "pending" | "dismissed" | "superseded";
  lastRelevantAt: Date;
  createdAt: Date;
  updatedAt: Date;
  evidenceMessageIds: string[];
};

export type ProactiveSignalDeliveryStatus = "pending" | "processing" | "sent" | "failed" | "cancelled";

export type ProactiveSignalDelivery = {
  id: string;
  candidateIdempotencyKey: string;
  groupId: string;
  status: ProactiveSignalDeliveryStatus;
  attemptCount: number;
};

export type ProactiveSignalDeliveryClaim = {
  delivery: ProactiveSignalDelivery;
  workerId: string;
  leaseUntil: Date;
  attempts: number;
};

export type ProactiveSignalDeliveryContext = {
  delivery: ProactiveSignalDelivery;
  candidate: PersistedProactiveSignalCandidate;
};

export type ProactiveSignalRepository = {
  recordCandidates(input: {
    signals: ProactiveSignalCandidate[];
    now: Date;
  }): Promise<ProactiveSignalRecordResult>;
  recordFeedback(input: {
    idempotencyKey: string;
    deliveryId: string;
    candidateIdempotencyKey: string;
    groupId: string;
    messageId?: string;
    entityVersion: number;
    actorFingerprint: string;
    feedback: ProactiveSignalFeedback;
    suppressUntil: Date;
    at: Date;
  }): Promise<ProactiveSignalFeedbackResult>;
  getFeedbackSummary(input: {
    groupId: string;
    at: Date;
  }): Promise<ProactiveSignalFeedbackSummary>;
  listPendingCandidates(input: {
    groupId: string;
    limit: number;
  }): Promise<PersistedProactiveSignalCandidate[]>;
  dismissCandidate(input: {
    idempotencyKey: string;
    groupId: string;
    operatorHint: string;
    now: Date;
  }): Promise<{ status: "dismissed" | "not_found" }>;
  approveCandidateForDelivery(input: {
    idempotencyKey: string;
    groupId: string;
    operatorHint: string;
    now: Date;
  }): Promise<
    | { status: "queued"; deliveryId: string }
    | { status: "already_queued"; deliveryId: string }
    | { status: "not_found" }
  >;
  claimProactiveSignalDelivery(input: {
    workerId: string;
    at: Date;
    leaseUntil: Date;
  }): Promise<ProactiveSignalDeliveryClaim | undefined>;
  getProactiveSignalDeliveryContext(deliveryId: string): Promise<ProactiveSignalDeliveryContext | undefined>;
  beginProactiveSignalDeliveryAttempt(input: {
    deliveryId: string;
    workerId: string;
    at: Date;
  }): Promise<void>;
  failProactiveSignalDeliveryPreparation(input: {
    deliveryId: string;
    workerId: string;
    errorCode: string;
    at: Date;
  }): Promise<void>;
  completeProactiveSignalDelivery(input: {
    deliveryId: string;
    workerId: string;
    messageId: string;
    at: Date;
  }): Promise<void>;
  failProactiveSignalDelivery(input: {
    deliveryId: string;
    workerId: string;
    classification: "retryable" | "permanent" | "outcome_unknown";
    errorCode: string;
    retryAt?: Date;
    at: Date;
  }): Promise<void>;
};

export type ProactiveSignalRuntime = {
  repository: ProactiveSignalRepository;
  close(): Promise<void>;
};

export type Queryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export type TransactionClient = Queryable & { release(): void };

export type ProactiveSignalDataSource = Queryable & {
  connect(): Promise<TransactionClient>;
};

const MAX_BATCH_SIZE = 50;
const MAX_IDENTIFIER_CHARS = 512;

export function createPostgresProactiveSignalRepository({
  dataSource,
}: {
  dataSource: ProactiveSignalDataSource;
}): ProactiveSignalRepository {
  return {
    recordCandidates(input) {
      return recordCandidates(dataSource, input);
    },
    recordFeedback(input) {
      return recordFeedback(dataSource, input);
    },
    getFeedbackSummary(input) {
      return getFeedbackSummary(dataSource, input);
    },
    listPendingCandidates(input) {
      return listPendingCandidates(dataSource, input);
    },
    dismissCandidate(input) {
      return dismissCandidate(dataSource, input);
    },
    approveCandidateForDelivery(input) {
      return approveCandidateForDelivery(dataSource, input);
    },
    claimProactiveSignalDelivery(input) {
      return claimProactiveSignalDelivery(dataSource, input);
    },
    getProactiveSignalDeliveryContext(input) {
      return getProactiveSignalDeliveryContext(dataSource, input);
    },
    beginProactiveSignalDeliveryAttempt(input) {
      return beginProactiveSignalDeliveryAttempt(dataSource, input);
    },
    failProactiveSignalDeliveryPreparation(input) {
      return failProactiveSignalDeliveryPreparation(dataSource, input);
    },
    completeProactiveSignalDelivery(input) {
      return completeProactiveSignalDelivery(dataSource, input);
    },
    failProactiveSignalDelivery(input) {
      return failProactiveSignalDelivery(dataSource, input);
    },
  };
}

export function createProactiveSignalRuntime({
  env = process.env,
  createPool = createPostgresPool,
}: {
  env?: DatabaseEnv;
  createPool?: typeof createPostgresPool;
} = {}): ProactiveSignalRuntime | undefined {
  if (env.DATABASE_URL?.trim() === undefined || env.DATABASE_URL.trim().length === 0) {
    return undefined;
  }
  const pool = createPool(readDatabaseConfig(env));
  return {
    repository: createPostgresProactiveSignalRepository({ dataSource: pool as never }),
    close: () => pool.end(),
  };
}

async function listPendingCandidates(
  queryable: Queryable,
  input: { groupId: string; limit: number },
): Promise<PersistedProactiveSignalCandidate[]> {
  const groupId = requireBoundedString("groupId", input.groupId);
  const limit = requireLimit(input.limit);
  const result = await queryable.query<Record<string, unknown>>(
    `
    SELECT candidate.*,
      ARRAY(
        SELECT evidence.conversation_message_id
        FROM proactive_signal_candidate_evidence evidence
        WHERE evidence.idempotency_key = candidate.idempotency_key
          AND evidence.group_id = candidate.group_id
        ORDER BY evidence.created_at ASC, evidence.conversation_message_id ASC
        LIMIT 20
      ) AS evidence_message_ids
    FROM proactive_signal_candidates candidate
    WHERE candidate.group_id = $1
      AND candidate.status = 'pending'
    ORDER BY candidate.priority DESC, candidate.last_relevant_at ASC, candidate.idempotency_key ASC
    LIMIT $2
    `,
    [groupId, limit],
  );
  return result.rows.map(mapCandidateRow);
}

async function recordFeedback(
  dataSource: ProactiveSignalDataSource,
  input: {
    idempotencyKey: string;
    deliveryId: string;
    candidateIdempotencyKey: string;
    groupId: string;
    messageId?: string;
    entityVersion: number;
    actorFingerprint: string;
    feedback: ProactiveSignalFeedback;
    suppressUntil: Date;
    at: Date;
  },
): Promise<ProactiveSignalFeedbackResult> {
  const idempotencyKey = requireBoundedString("idempotencyKey", input.idempotencyKey);
  const deliveryId = requireBoundedString("deliveryId", input.deliveryId);
  const candidateIdempotencyKey = requireBoundedString("candidateIdempotencyKey", input.candidateIdempotencyKey);
  const groupId = requireBoundedString("groupId", input.groupId);
  const messageId = input.messageId === undefined ? undefined : requireBoundedString("messageId", input.messageId);
  const entityVersion = requireVersion(input.entityVersion);
  const actorFingerprint = requireActorFingerprint(input.actorFingerprint);
  const feedback = requireFeedback(input.feedback);
  const suppressUntil = requireDate(input.suppressUntil, "suppressUntil");
  const at = requireDate(input.at, "at");

  const client = await dataSource.connect();
  try {
    await client.query("begin");
    const binding = await client.query<{ kind: unknown; entity_id: unknown }>(
      `
      SELECT candidate.kind, candidate.entity_id
      FROM proactive_signal_delivery_outbox delivery
      JOIN proactive_signal_candidates candidate
        ON candidate.idempotency_key = delivery.candidate_idempotency_key
       AND candidate.group_id = delivery.group_id
      WHERE delivery.id = $1
        AND delivery.candidate_idempotency_key = $2
        AND delivery.group_id = $3
        AND ($4::text IS NULL OR delivery.sent_message_id = $4)
        AND candidate.entity_version = $5
        AND delivery.status = 'sent'
      LIMIT 1
      FOR KEY SHARE OF delivery
      `,
      [deliveryId, candidateIdempotencyKey, groupId, messageId, entityVersion],
    );
    if (binding.rows.length === 0) {
      await client.query("commit");
      return { status: "stale_binding" };
    }

    const inserted = await client.query<{ idempotency_key: unknown }>(
      `
      INSERT INTO proactive_signal_feedback_events (
        idempotency_key, delivery_id, candidate_idempotency_key, group_id, message_id,
        entity_version, actor_fingerprint, feedback, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT DO NOTHING
      RETURNING idempotency_key
      `,
      [
        idempotencyKey,
        deliveryId,
        candidateIdempotencyKey,
        groupId,
        messageId,
        entityVersion,
        actorFingerprint,
        feedback,
        at,
      ],
    );
    if (inserted.rows.length === 0) {
      const existing = await client.query<{ idempotency_key: unknown }>(
        `
        SELECT idempotency_key
        FROM proactive_signal_feedback_events
        WHERE delivery_id = $1
          AND actor_fingerprint = $2
        LIMIT 1
        `,
        [deliveryId, actorFingerprint],
      );
      await client.query("commit");
      return existing.rows.length > 0 ? { status: "already_applied" } : { status: "stale_binding" };
    }

    if (feedback === "irrelevant") {
      const bound = binding.rows[0];
      await client.query(
        `
        INSERT INTO proactive_signal_suppressions (
          group_id, kind, entity_id, suppress_until, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $5)
        ON CONFLICT (group_id, kind, entity_id)
        DO UPDATE SET
          suppress_until = GREATEST(proactive_signal_suppressions.suppress_until, EXCLUDED.suppress_until),
          updated_at = EXCLUDED.updated_at
        `,
        [
          groupId,
          requireSignalKind(bound?.kind),
          requireBoundedString("entityId", bound?.entity_id),
          suppressUntil,
          at,
        ],
      );
    }
    await client.query("commit");
    return { status: "applied" };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getFeedbackSummary(
  queryable: Queryable,
  input: { groupId: string; at: Date },
): Promise<ProactiveSignalFeedbackSummary> {
  const groupId = requireBoundedString("groupId", input.groupId);
  const at = requireDate(input.at, "at");
  const result = await queryable.query<Record<string, unknown>>(
    `
    SELECT
      COUNT(feedback.idempotency_key) AS total_count,
      COUNT(feedback.idempotency_key) FILTER (WHERE feedback.feedback = 'helpful') AS helpful_count,
      COUNT(feedback.idempotency_key) FILTER (WHERE feedback.feedback = 'irrelevant') AS irrelevant_count,
      MAX(feedback.created_at) AS last_feedback_at,
      (
        SELECT COUNT(*)
        FROM proactive_signal_suppressions suppression
        WHERE suppression.group_id = $1
          AND suppression.suppress_until > $2
      ) AS active_suppression_count
    FROM proactive_signal_feedback_events feedback
    WHERE feedback.group_id = $1
    `,
    [groupId, at],
  );
  const row = result.rows[0] ?? {};
  const totalCount = requireNonNegativeInteger(row.total_count ?? 0, "totalCount");
  const helpfulCount = requireNonNegativeInteger(row.helpful_count ?? 0, "helpfulCount");
  const irrelevantCount = requireNonNegativeInteger(row.irrelevant_count ?? 0, "irrelevantCount");
  const activeSuppressionCount = requireNonNegativeInteger(row.active_suppression_count ?? 0, "activeSuppressionCount");
  const lastFeedbackAt = row.last_feedback_at === null || row.last_feedback_at === undefined
    ? undefined
    : requireDateValue(row.last_feedback_at, "lastFeedbackAt");
  return {
    groupId,
    totalCount,
    helpfulCount,
    irrelevantCount,
    helpfulRate: totalCount === 0 ? null : helpfulCount / totalCount,
    activeSuppressionCount,
    ...(lastFeedbackAt === undefined ? {} : { lastFeedbackAt }),
  };
}

async function claimProactiveSignalDelivery(
  dataSource: Queryable,
  input: { workerId: string; at: Date; leaseUntil: Date },
): Promise<ProactiveSignalDeliveryClaim | undefined> {
  const workerId = requireBoundedString("workerId", input.workerId);
  const at = requireDate(input.at, "at");
  const leaseUntil = requireDate(input.leaseUntil, "leaseUntil");
  const result = await dataSource.query<Record<string, unknown>>(
    `
    UPDATE proactive_signal_delivery_outbox delivery
    SET status = 'processing',
        attempt_count = delivery.attempt_count + 1,
        lease_worker_id = $1,
        lease_until = $3,
        updated_at = $2
    WHERE delivery.id = (
      SELECT candidate_delivery.id
      FROM proactive_signal_delivery_outbox candidate_delivery
      JOIN proactive_signal_candidates candidate
        ON candidate.idempotency_key = candidate_delivery.candidate_idempotency_key
       AND candidate.group_id = candidate_delivery.group_id
      WHERE candidate.status = 'pending'
        AND (
          candidate_delivery.status = 'pending'
          OR (candidate_delivery.status = 'failed' AND candidate_delivery.next_attempt_at <= $2)
          OR (
            candidate_delivery.status = 'processing'
            AND candidate_delivery.lease_until IS NOT NULL
            AND candidate_delivery.lease_until <= $2
          )
        )
      ORDER BY candidate.priority DESC, candidate_delivery.next_attempt_at ASC, candidate_delivery.created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING delivery.id, delivery.candidate_idempotency_key, delivery.group_id,
      delivery.status, delivery.attempt_count
    `,
    [workerId, at, leaseUntil],
  );
  if (result.rows.length === 0) return undefined;
  const delivery = mapDeliveryRow(result.rows[0]);
  return { delivery, workerId, leaseUntil, attempts: delivery.attemptCount };
}

async function getProactiveSignalDeliveryContext(
  queryable: Queryable,
  deliveryId: string,
): Promise<ProactiveSignalDeliveryContext | undefined> {
  const safeDeliveryId = requireBoundedString("deliveryId", deliveryId);
  const result = await queryable.query<Record<string, unknown>>(
    `
    SELECT delivery.id,
      delivery.candidate_idempotency_key,
      delivery.group_id AS delivery_group_id,
      delivery.status AS delivery_status,
      delivery.attempt_count,
      candidate.*,
      ARRAY(
        SELECT evidence.conversation_message_id
        FROM proactive_signal_candidate_evidence evidence
        WHERE evidence.idempotency_key = candidate.idempotency_key
          AND evidence.group_id = candidate.group_id
        ORDER BY evidence.created_at ASC, evidence.conversation_message_id ASC
        LIMIT 20
      ) AS evidence_message_ids
    FROM proactive_signal_delivery_outbox delivery
    JOIN proactive_signal_candidates candidate
      ON candidate.idempotency_key = delivery.candidate_idempotency_key
     AND candidate.group_id = delivery.group_id
    WHERE delivery.id = $1
    LIMIT 1
    `,
    [safeDeliveryId],
  );
  if (result.rows.length === 0) return undefined;
  const row = result.rows[0];
  return {
    delivery: {
      id: requireBoundedString("deliveryId", row.id),
      candidateIdempotencyKey: requireBoundedString("candidateIdempotencyKey", row.candidate_idempotency_key),
      groupId: requireBoundedString("groupId", row.delivery_group_id),
      status: requireDeliveryStatus(row.delivery_status),
      attemptCount: requireNonNegativeInteger(row.attempt_count, "attemptCount"),
    },
    candidate: mapCandidateRow(row),
  };
}

async function beginProactiveSignalDeliveryAttempt(
  queryable: Queryable,
  input: { deliveryId: string; workerId: string; at: Date },
): Promise<void> {
  const deliveryId = requireBoundedString("deliveryId", input.deliveryId);
  const workerId = requireBoundedString("workerId", input.workerId);
  const at = requireDate(input.at, "at");
  await queryable.query(
    `
    INSERT INTO proactive_signal_delivery_events (
      id, delivery_id, candidate_idempotency_key, group_id, event_type,
      delivery_status, created_at
    )
    SELECT $2, delivery.id, delivery.candidate_idempotency_key, delivery.group_id,
      'processing', 'processing', $3
    FROM proactive_signal_delivery_outbox delivery
    WHERE delivery.id = $1
      AND delivery.status = 'processing'
      AND delivery.lease_worker_id = $4
    ON CONFLICT (id) DO NOTHING
    `,
    [deliveryId, deliveryEventId(deliveryId, "processing", workerId, at), at, workerId],
  );
}

async function failProactiveSignalDeliveryPreparation(
  queryable: Queryable,
  input: { deliveryId: string; workerId: string; errorCode: string; at: Date },
): Promise<void> {
  await markProactiveSignalDeliveryFailed(queryable, {
    deliveryId: input.deliveryId,
    workerId: input.workerId,
    failureClassification: boundedFailureClassification(input.errorCode),
    status: "failed",
    nextAttemptAt: requireDate(input.at, "at"),
    at: input.at,
  });
}

async function completeProactiveSignalDelivery(
  queryable: Queryable,
  input: { deliveryId: string; workerId: string; messageId: string; at: Date },
): Promise<void> {
  const deliveryId = requireBoundedString("deliveryId", input.deliveryId);
  const workerId = requireBoundedString("workerId", input.workerId);
  const messageId = requireBoundedString("messageId", input.messageId);
  const at = requireDate(input.at, "at");
  await queryable.query(
    `
    WITH updated AS (
      UPDATE proactive_signal_delivery_outbox delivery
      SET status = 'sent',
          sent_message_id = $3,
          failure_classification = NULL,
          updated_at = $4
      WHERE delivery.id = $1
        AND delivery.status = 'processing'
        AND delivery.lease_worker_id = $2
      RETURNING delivery.id, delivery.candidate_idempotency_key, delivery.group_id
    )
    INSERT INTO proactive_signal_delivery_events (
      id, delivery_id, candidate_idempotency_key, group_id, event_type,
      delivery_status, created_at
    )
    SELECT $5, updated.id, updated.candidate_idempotency_key, updated.group_id,
      'sent', 'sent', $4
    FROM updated
    ON CONFLICT (id) DO NOTHING
    `,
    [deliveryId, workerId, messageId, at, deliveryEventId(deliveryId, "sent", workerId, at)],
  );
}

async function failProactiveSignalDelivery(
  queryable: Queryable,
  input: {
    deliveryId: string;
    workerId: string;
    classification: "retryable" | "permanent" | "outcome_unknown";
    errorCode: string;
    retryAt?: Date;
    at: Date;
  },
): Promise<void> {
  const at = requireDate(input.at, "at");
  const retryAt = input.classification === "retryable"
    ? requireDate(input.retryAt ?? at, "retryAt")
    : at;
  await markProactiveSignalDeliveryFailed(queryable, {
    deliveryId: input.deliveryId,
    workerId: input.workerId,
    failureClassification: boundedFailureClassification(input.errorCode),
    status: input.classification === "retryable" ? "pending" : "failed",
    nextAttemptAt: retryAt,
    at,
  });
}

async function dismissCandidate(
  dataSource: ProactiveSignalDataSource,
  input: {
    idempotencyKey: string;
    groupId: string;
    operatorHint: string;
    now: Date;
  },
): Promise<{ status: "dismissed" | "not_found" }> {
  const idempotencyKey = requireBoundedString("idempotencyKey", input.idempotencyKey);
  const groupId = requireBoundedString("groupId", input.groupId);
  requireBoundedString("operatorHint", input.operatorHint);
  const now = requireDate(input.now, "now");
  const client = await dataSource.connect();
  try {
    await client.query("begin");
    const updated = await client.query<{ idempotency_key: unknown }>(
      `
      UPDATE proactive_signal_candidates
      SET status = 'dismissed',
          updated_at = $3
      WHERE idempotency_key = $1
        AND group_id = $2
        AND status = 'pending'
      RETURNING idempotency_key
      `,
      [idempotencyKey, groupId, now],
    );
    if (updated.rows.length === 0) {
      await client.query("commit");
      return { status: "not_found" };
    }
    await client.query(
      `
      INSERT INTO proactive_signal_candidate_events (
        id, idempotency_key, group_id, event_type, candidate_status, created_at
      )
      VALUES ($1, $2, $3, 'dismissed', 'dismissed', $4)
      ON CONFLICT (id) DO NOTHING
      `,
      [`${idempotencyKey}:dismissed`, idempotencyKey, groupId, now],
    );
    await client.query("commit");
    return { status: "dismissed" };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function approveCandidateForDelivery(
  dataSource: ProactiveSignalDataSource,
  input: {
    idempotencyKey: string;
    groupId: string;
    operatorHint: string;
    now: Date;
  },
): Promise<
  | { status: "queued"; deliveryId: string }
  | { status: "already_queued"; deliveryId: string }
  | { status: "not_found" }
> {
  const idempotencyKey = requireBoundedString("idempotencyKey", input.idempotencyKey);
  const groupId = requireBoundedString("groupId", input.groupId);
  requireBoundedString("operatorHint", input.operatorHint);
  const now = requireDate(input.now, "now");
  const deliveryId = buildDeliveryId(idempotencyKey);
  const client = await dataSource.connect();
  try {
    await client.query("begin");
    const inserted = await client.query<{ id: unknown }>(
      `
      INSERT INTO proactive_signal_delivery_outbox (
        id, candidate_idempotency_key, group_id, delivery_channel, status,
        attempt_count, next_attempt_at, created_at, updated_at
      )
      SELECT $3, candidate.idempotency_key, candidate.group_id, 'feishu_group_card',
        'pending', 0, $4, $4, $4
      FROM proactive_signal_candidates candidate
      WHERE candidate.idempotency_key = $1
        AND candidate.group_id = $2
        AND candidate.status = 'pending'
      ON CONFLICT (candidate_idempotency_key, delivery_channel) DO NOTHING
      RETURNING id
      `,
      [idempotencyKey, groupId, deliveryId, now],
    );
    if (inserted.rows.length > 0) {
      const queuedDeliveryId = requireBoundedString("delivery id", inserted.rows[0]?.id);
      await client.query(
        `
        INSERT INTO proactive_signal_delivery_events (
          id, delivery_id, candidate_idempotency_key, group_id, event_type,
          delivery_status, created_at
        )
        VALUES ($1, $2, $3, $4, 'queued', 'pending', $5)
        ON CONFLICT (id) DO NOTHING
        `,
        [`${queuedDeliveryId}:queued`, queuedDeliveryId, idempotencyKey, groupId, now],
      );
      await client.query("commit");
      return { status: "queued", deliveryId: queuedDeliveryId };
    }

    const existing = await client.query<{ id: unknown }>(
      `
      SELECT delivery.id
      FROM proactive_signal_delivery_outbox delivery
      JOIN proactive_signal_candidates candidate
        ON candidate.idempotency_key = delivery.candidate_idempotency_key
      WHERE delivery.candidate_idempotency_key = $1
        AND delivery.group_id = $2
        AND delivery.delivery_channel = 'feishu_group_card'
        AND candidate.status = 'pending'
      LIMIT 1
      `,
      [idempotencyKey, groupId],
    );
    await client.query("commit");
    if (existing.rows.length === 0) return { status: "not_found" };
    return {
      status: "already_queued",
      deliveryId: requireBoundedString("delivery id", existing.rows[0]?.id),
    };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function recordCandidates(
  dataSource: ProactiveSignalDataSource,
  input: { signals: ProactiveSignalCandidate[]; now: Date },
): Promise<ProactiveSignalRecordResult> {
  const signals = normalizeSignals(input.signals);
  const now = requireDate(input.now, "now");
  if (signals.length === 0) {
    return { recordedCount: 0, existingCount: 0, suppressedCount: 0, recordedKeys: [] };
  }

  const client = await dataSource.connect();
  try {
    await client.query("begin");
    const inserted = await insertCandidates(client, signals, now);
    const recordedKeys = inserted.rows
      .filter((row) => requireCandidateRecordOutcome(row.outcome) === "recorded")
      .map((row) => requireBoundedString("idempotency_key", row.idempotency_key));
    const existingCount = inserted.rows.filter((row) => requireCandidateRecordOutcome(row.outcome) === "existing").length;
    const suppressedCount = inserted.rows.filter((row) => requireCandidateRecordOutcome(row.outcome) === "suppressed").length;
    if (recordedKeys.length > 0) {
      await insertCandidateEvidence(client, signals.filter((signal) => recordedKeys.includes(signal.idempotencyKey)), now);
      await insertCandidateEvents(client, signals.filter((signal) => recordedKeys.includes(signal.idempotencyKey)), now);
    }
    await client.query("commit");
    return {
      recordedCount: recordedKeys.length,
      existingCount,
      suppressedCount,
      recordedKeys,
    };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

function insertCandidates(client: Queryable, signals: ProactiveSignalCandidate[], now: Date) {
  const values: unknown[] = [];
  const rows = signals.map((signal, index) => {
    const offset = index * 13;
    values.push(
      signal.idempotencyKey,
      signal.groupId,
      signal.kind,
      signal.priority,
      entityTypeFor(signal.kind),
      signal.entityId,
      signal.entityVersion,
      signal.reasonCode,
      signal.suggestedMode,
      "pending",
      signal.lastRelevantAt,
      now,
      now,
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13})`;
  });

  values.push(now);
  return client.query<{ idempotency_key: unknown; outcome: unknown }>(
    `
    WITH incoming (
      idempotency_key, group_id, kind, priority, entity_type, entity_id,
      entity_version, reason_code, suggested_mode, status, last_relevant_at,
      created_at, updated_at
    ) AS (
      VALUES ${rows.join(", ")}
    ), allowed AS (
      SELECT incoming.*
      FROM incoming
      WHERE NOT EXISTS (
        SELECT 1
        FROM proactive_signal_suppressions suppression
        WHERE suppression.group_id = incoming.group_id
          AND suppression.kind = incoming.kind
          AND suppression.entity_id = incoming.entity_id
          AND suppression.suppress_until > $${values.length}
      )
    ), inserted AS (
      INSERT INTO proactive_signal_candidates (
        idempotency_key, group_id, kind, priority, entity_type, entity_id,
        entity_version, reason_code, suggested_mode, status, last_relevant_at,
        created_at, updated_at
      )
      SELECT
        idempotency_key, group_id, kind, priority, entity_type, entity_id,
        entity_version, reason_code, suggested_mode, status, last_relevant_at,
        created_at, updated_at
      FROM allowed
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING idempotency_key
    )
    SELECT incoming.idempotency_key,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM inserted WHERE inserted.idempotency_key = incoming.idempotency_key
        ) THEN 'recorded'
        WHEN EXISTS (
          SELECT 1 FROM allowed WHERE allowed.idempotency_key = incoming.idempotency_key
        ) THEN 'existing'
        ELSE 'suppressed'
      END AS outcome
    FROM incoming
    ORDER BY incoming.idempotency_key ASC
    `,
    values,
  );
}

function insertCandidateEvidence(client: Queryable, signals: ProactiveSignalCandidate[], now: Date) {
  const values: unknown[] = [];
  const rows: string[] = [];
  for (const signal of signals) {
    for (const evidenceMessageId of signal.evidenceMessageIds) {
      const offset = values.length;
      values.push(signal.idempotencyKey, evidenceMessageId, signal.groupId, now);
      rows.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
    }
  }
  if (rows.length === 0) return Promise.resolve({ rows: [] });
  return client.query(
    `
    INSERT INTO proactive_signal_candidate_evidence (
      idempotency_key, conversation_message_id, group_id, created_at
    )
    VALUES ${rows.join(", ")}
    ON CONFLICT (idempotency_key, conversation_message_id) DO NOTHING
    `,
    values,
  );
}

function insertCandidateEvents(client: Queryable, signals: ProactiveSignalCandidate[], now: Date) {
  const values: unknown[] = [];
  const rows = signals.map((signal, index) => {
    const offset = index * 6;
    values.push(`${signal.idempotencyKey}:created`, signal.idempotencyKey, signal.groupId, "created", "pending", now);
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`;
  });
  return client.query(
    `
    INSERT INTO proactive_signal_candidate_events (
      id, idempotency_key, group_id, event_type, candidate_status, created_at
    )
    VALUES ${rows.join(", ")}
    ON CONFLICT (id) DO NOTHING
    `,
    values,
  );
}

function normalizeSignals(signals: ProactiveSignalCandidate[]): ProactiveSignalCandidate[] {
  if (!Array.isArray(signals) || signals.length > MAX_BATCH_SIZE) {
    throw new Error("proactive signal batch is invalid");
  }
  const seen = new Set<string>();
  return signals.map((signal) => {
    const normalized = {
      ...signal,
      idempotencyKey: requireBoundedString("idempotencyKey", signal.idempotencyKey),
      groupId: requireBoundedString("groupId", signal.groupId),
      entityId: requireBoundedString("entityId", signal.entityId),
      entityVersion: requireVersion(signal.entityVersion),
      lastRelevantAt: requireDate(signal.lastRelevantAt, "lastRelevantAt"),
      evidenceMessageIds: signal.evidenceMessageIds.map((id) => requireBoundedString("evidenceMessageId", id)),
    };
    if (seen.has(normalized.idempotencyKey)) {
      throw new Error("duplicate proactive signal idempotency key");
    }
    seen.add(normalized.idempotencyKey);
    return normalized;
  });
}

function mapCandidateRow(row: Record<string, unknown>): PersistedProactiveSignalCandidate {
  const kind = requireSignalKind(row.kind);
  return {
    idempotencyKey: requireBoundedString("idempotencyKey", row.idempotency_key),
    groupId: requireBoundedString("groupId", row.group_id),
    kind,
    priority: requirePriority(row.priority),
    entityType: requireEntityType(row.entity_type),
    entityId: requireBoundedString("entityId", row.entity_id),
    entityVersion: requireVersion(row.entity_version),
    reasonCode: requireReasonCode(row.reason_code),
    suggestedMode: requireSuggestedMode(row.suggested_mode),
    status: requireStatus(row.status),
    lastRelevantAt: requireDateValue(row.last_relevant_at, "lastRelevantAt"),
    createdAt: requireDateValue(row.created_at, "createdAt"),
    updatedAt: requireDateValue(row.updated_at, "updatedAt"),
    evidenceMessageIds: requireStringArray(row.evidence_message_ids),
  };
}

function mapDeliveryRow(row: Record<string, unknown>): ProactiveSignalDelivery {
  return {
    id: requireBoundedString("deliveryId", row.id),
    candidateIdempotencyKey: requireBoundedString("candidateIdempotencyKey", row.candidate_idempotency_key),
    groupId: requireBoundedString("groupId", row.group_id),
    status: requireDeliveryStatus(row.status),
    attemptCount: requireNonNegativeInteger(row.attempt_count, "attemptCount"),
  };
}

async function markProactiveSignalDeliveryFailed(
  queryable: Queryable,
  input: {
    deliveryId: string;
    workerId: string;
    failureClassification: string;
    status: Extract<ProactiveSignalDeliveryStatus, "pending" | "failed">;
    nextAttemptAt: Date;
    at: Date;
  },
): Promise<void> {
  const deliveryId = requireBoundedString("deliveryId", input.deliveryId);
  const workerId = requireBoundedString("workerId", input.workerId);
  const at = requireDate(input.at, "at");
  const nextAttemptAt = requireDate(input.nextAttemptAt, "nextAttemptAt");
  await queryable.query(
    `
    WITH updated AS (
      UPDATE proactive_signal_delivery_outbox delivery
      SET status = $3,
          next_attempt_at = $4,
          failure_classification = $5,
          updated_at = $6
      WHERE delivery.id = $1
        AND delivery.status = 'processing'
        AND delivery.lease_worker_id = $2
      RETURNING delivery.id, delivery.candidate_idempotency_key, delivery.group_id, delivery.status
    )
    INSERT INTO proactive_signal_delivery_events (
      id, delivery_id, candidate_idempotency_key, group_id, event_type,
      delivery_status, created_at
    )
    SELECT $7, updated.id, updated.candidate_idempotency_key, updated.group_id,
      'failed', updated.status, $6
    FROM updated
    ON CONFLICT (id) DO NOTHING
    `,
    [
      deliveryId,
      workerId,
      input.status,
      nextAttemptAt,
      input.failureClassification,
      at,
      deliveryEventId(deliveryId, `failed:${input.status}`, workerId, at),
    ],
  );
}

function entityTypeFor(kind: ProactiveSignalCandidate["kind"]): "thread" | "action" {
  return kind === "quiet_open_thread" ? "thread" : "action";
}

function requireBoundedString(label: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > MAX_IDENTIFIER_CHARS) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function requireVersion(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 1) throw new Error("entity version is invalid");
  return Number(parsed);
}

function requireActorFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("actorFingerprint is invalid");
  }
  return value;
}

function requireFeedback(value: unknown): ProactiveSignalFeedback {
  if (value === "helpful" || value === "irrelevant") return value;
  throw new Error("feedback is invalid");
}

function requireDate(value: Date, label: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}

function requireDateValue(value: unknown, label: string): Date {
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}

function requireLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH_SIZE) {
    throw new Error("limit is invalid");
  }
  return value;
}

function requireStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => requireBoundedString("evidenceMessageId", item));
}

function requireSignalKind(value: unknown): ProactiveSignalCandidate["kind"] {
  if (value === "quiet_open_thread" || value === "overdue_action") return value;
  throw new Error("signal kind is invalid");
}

function requirePriority(value: unknown): ProactiveSignalCandidate["priority"] {
  if (value === "medium" || value === "high") return value;
  throw new Error("signal priority is invalid");
}

function requireEntityType(value: unknown): "thread" | "action" {
  if (value === "thread" || value === "action") return value;
  throw new Error("entity type is invalid");
}

function requireReasonCode(value: unknown): ProactiveSignalCandidate["reasonCode"] {
  if (value === "thread_quiet_threshold_elapsed" || value === "action_due_at_elapsed") return value;
  throw new Error("reason code is invalid");
}

function requireSuggestedMode(value: unknown): ProactiveSignalCandidate["suggestedMode"] {
  if (value === "ask_for_thread_update" || value === "ask_for_status") return value;
  throw new Error("suggested mode is invalid");
}

function requireStatus(value: unknown): PersistedProactiveSignalCandidate["status"] {
  if (value === "pending" || value === "dismissed" || value === "superseded") return value;
  throw new Error("candidate status is invalid");
}

function requireDeliveryStatus(value: unknown): ProactiveSignalDeliveryStatus {
  if (
    value === "pending" ||
    value === "processing" ||
    value === "sent" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new Error("delivery status is invalid");
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 0) throw new Error(`${label} is invalid`);
  return Number(parsed);
}

function requireCandidateRecordOutcome(value: unknown): "recorded" | "existing" | "suppressed" {
  if (value === "recorded" || value === "existing" || value === "suppressed") return value;
  throw new Error("candidate record outcome is invalid");
}

function buildDeliveryId(idempotencyKey: string): string {
  return `proactive-delivery:${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

function boundedFailureClassification(value: string): string {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 ? normalized : "internal_error";
}

function deliveryEventId(deliveryId: string, eventType: string, workerId: string, at: Date): string {
  return `proactive-delivery-event:${createHash("sha256")
    .update(`${deliveryId}:${eventType}:${workerId}:${at.toISOString()}`)
    .digest("hex")}`;
}
