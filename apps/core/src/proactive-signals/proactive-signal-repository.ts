import type { ProactiveSignalCandidate } from "./proactive-signal-planner.js";
import { readDatabaseConfig, type DatabaseEnv } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";

export type ProactiveSignalRecordResult = {
  recordedCount: number;
  existingCount: number;
  recordedKeys: string[];
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

export type ProactiveSignalRepository = {
  recordCandidates(input: {
    signals: ProactiveSignalCandidate[];
    now: Date;
  }): Promise<ProactiveSignalRecordResult>;
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
    listPendingCandidates(input) {
      return listPendingCandidates(dataSource, input);
    },
    dismissCandidate(input) {
      return dismissCandidate(dataSource, input);
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

async function recordCandidates(
  dataSource: ProactiveSignalDataSource,
  input: { signals: ProactiveSignalCandidate[]; now: Date },
): Promise<ProactiveSignalRecordResult> {
  const signals = normalizeSignals(input.signals);
  const now = requireDate(input.now, "now");
  if (signals.length === 0) {
    return { recordedCount: 0, existingCount: 0, recordedKeys: [] };
  }

  const client = await dataSource.connect();
  try {
    await client.query("begin");
    const inserted = await insertCandidates(client, signals, now);
    const recordedKeys = inserted.rows.map((row) => requireBoundedString("idempotency_key", row.idempotency_key));
    if (recordedKeys.length > 0) {
      await insertCandidateEvidence(client, signals.filter((signal) => recordedKeys.includes(signal.idempotencyKey)), now);
      await insertCandidateEvents(client, signals.filter((signal) => recordedKeys.includes(signal.idempotencyKey)), now);
    }
    await client.query("commit");
    return {
      recordedCount: recordedKeys.length,
      existingCount: signals.length - recordedKeys.length,
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

  return client.query<{ idempotency_key: unknown }>(
    `
    INSERT INTO proactive_signal_candidates (
      idempotency_key, group_id, kind, priority, entity_type, entity_id,
      entity_version, reason_code, suggested_mode, status, last_relevant_at,
      created_at, updated_at
    )
    VALUES ${rows.join(", ")}
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key
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
