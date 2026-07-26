import { createHash } from "node:crypto";

import type {
  KnowledgeDraftTransactionClient,
  PostgresKnowledgeDraftDataSource,
} from "../knowledge-governance/postgres-knowledge-draft-repository.js";

export const AGENT_EXECUTION_LEDGER_SUBJECT_TYPES = [
  "turn",
  "tool_call",
  "action_proposal",
  "action_execution",
  "permission_decision",
  "provider_request",
  "hook",
] as const;

export const AGENT_EXECUTION_LEDGER_EVENT_TYPES = [
  "turn_started",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
  "tool_call_started",
  "tool_call_progress",
  "tool_call_completed",
  "tool_call_failed",
  "tool_call_cancelled",
  "action_proposed",
  "action_approved",
  "action_rejected",
  "action_execution_started",
  "action_execution_completed",
  "action_execution_failed",
  "action_execution_reconciliation_required",
  "permission_allowed",
  "permission_denied",
  "permission_error",
  "provider_request_started",
  "provider_request_completed",
  "provider_request_failed",
  "hook_started",
  "hook_completed",
  "hook_failed",
] as const;

export const AGENT_EXECUTION_LEDGER_PHASES = [
  "idle",
  "context_assembly",
  "sampling",
  "tool_execution",
  "permission_prompt",
  "approval_wait",
  "external_call",
  "completed",
] as const;

export const AGENT_EXECUTION_LEDGER_OUTCOMES = [
  "success",
  "error",
  "cancelled",
  "skipped",
  "denied",
  "unknown",
] as const;

export type AgentExecutionLedgerSubjectType =
  typeof AGENT_EXECUTION_LEDGER_SUBJECT_TYPES[number];
export type AgentExecutionLedgerEventType =
  typeof AGENT_EXECUTION_LEDGER_EVENT_TYPES[number];
export type AgentExecutionLedgerPhase =
  typeof AGENT_EXECUTION_LEDGER_PHASES[number];
export type AgentExecutionLedgerOutcome =
  typeof AGENT_EXECUTION_LEDGER_OUTCOMES[number];

export type AgentExecutionLedgerEvent = {
  id: string;
  tenantKey: string;
  groupId?: string;
  actorOpenId?: string;
  subjectType: AgentExecutionLedgerSubjectType;
  subjectId: string;
  eventType: AgentExecutionLedgerEventType;
  phase?: AgentExecutionLedgerPhase;
  toolCallId?: string;
  toolName?: string;
  modelId?: string;
  provider?: string;
  outcome?: AgentExecutionLedgerOutcome;
  decisionReason?: string;
  operationKey: string;
  metadata: Record<string, unknown>;
  contentFingerprint?: string;
  durationMs?: number;
  createdAt: Date;
};

export type RecordAgentExecutionLedgerEventInput = Omit<
  AgentExecutionLedgerEvent,
  "createdAt"
> & { at: Date };

export type ListAgentExecutionLedgerEventsInput = {
  tenantKey?: string;
  groupId?: string;
  subjectType?: AgentExecutionLedgerSubjectType;
  subjectId?: string;
  toolCallId?: string;
  limit: number;
};

export interface AgentExecutionLedgerRepository {
  recordEvent(input: RecordAgentExecutionLedgerEventInput): Promise<{
    outcome: "applied" | "already_applied";
    event: AgentExecutionLedgerEvent;
  }>;
  listEvents(input: ListAgentExecutionLedgerEventsInput): Promise<AgentExecutionLedgerEvent[]>;
}

export class AgentExecutionLedgerOperationConflictError extends Error {
  constructor() {
    super("agent execution ledger operation conflict");
  }
}

type AgentExecutionLedgerRow = {
  id: string;
  tenant_key: string;
  group_id: string | null;
  actor_open_id: string | null;
  subject_type: AgentExecutionLedgerSubjectType;
  subject_id: string;
  event_type: AgentExecutionLedgerEventType;
  phase: AgentExecutionLedgerPhase | null;
  tool_call_id: string | null;
  tool_name: string | null;
  model_id: string | null;
  provider: string | null;
  outcome: AgentExecutionLedgerOutcome | null;
  decision_reason: string | null;
  operation_key: string;
  operation_fingerprint: string;
  metadata: Record<string, unknown>;
  content_fingerprint: string | null;
  duration_ms: number | null;
  created_at: Date;
};

export function createPostgresAgentExecutionLedgerRepository({
  dataSource,
}: {
  dataSource: PostgresKnowledgeDraftDataSource;
}): AgentExecutionLedgerRepository {
  return {
    async recordEvent(input) {
      const normalized = normalizeRecordEventInput(input);
      const fingerprint = operationFingerprint(normalized);
      return withTransaction(dataSource, async (client) => {
        await lockOperation(client, normalized.operationKey);

        const replay = await client.query<AgentExecutionLedgerRow>(
          `SELECT * FROM agent_execution_ledger_events WHERE operation_key = $1`,
          [normalized.operationKey],
        );
        if (replay.rows[0] !== undefined) {
          if (replay.rows[0].operation_fingerprint !== fingerprint) {
            throw new AgentExecutionLedgerOperationConflictError();
          }
          return {
            outcome: "already_applied" as const,
            event: mapEvent(replay.rows[0]),
          };
        }

        const created = await client.query<AgentExecutionLedgerRow>(
          `
          INSERT INTO agent_execution_ledger_events (
            id, tenant_key, group_id, actor_open_id, subject_type, subject_id,
            event_type, phase, tool_call_id, tool_name, model_id, provider,
            outcome, decision_reason, operation_key, operation_fingerprint,
            metadata, content_fingerprint, duration_ms, created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16,
            $17::jsonb, $18, $19, $20
          )
          RETURNING *
          `,
          [
            normalized.id,
            normalized.tenantKey,
            normalized.groupId ?? null,
            normalized.actorOpenId ?? null,
            normalized.subjectType,
            normalized.subjectId,
            normalized.eventType,
            normalized.phase ?? null,
            normalized.toolCallId ?? null,
            normalized.toolName ?? null,
            normalized.modelId ?? null,
            normalized.provider ?? null,
            normalized.outcome ?? null,
            normalized.decisionReason ?? null,
            normalized.operationKey,
            fingerprint,
            JSON.stringify(normalized.metadata),
            normalized.contentFingerprint ?? null,
            normalized.durationMs ?? null,
            normalized.at,
          ],
        );

        return {
          outcome: "applied" as const,
          event: mapEvent(requireRow(created.rows[0])),
        };
      });
    },

    async listEvents(input) {
      const normalized = normalizeListEventsInput(input);
      const clauses: string[] = ["tenant_key = $1"];
      const values: unknown[] = [normalized.tenantKey];

      if (normalized.groupId !== undefined) {
        values.push(normalized.groupId);
        clauses.push(`group_id = $${values.length}`);
      }
      if (normalized.subjectType !== undefined) {
        values.push(normalized.subjectType);
        clauses.push(`subject_type = $${values.length}`);
      }
      if (normalized.subjectId !== undefined) {
        values.push(normalized.subjectId);
        clauses.push(`subject_id = $${values.length}`);
      }
      if (normalized.toolCallId !== undefined) {
        values.push(normalized.toolCallId);
        clauses.push(`tool_call_id = $${values.length}`);
      }
      values.push(normalized.limit);

      const result = await dataSource.query<AgentExecutionLedgerRow>(
        `
        SELECT *
        FROM agent_execution_ledger_events
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at ASC, id ASC
        LIMIT $${values.length}
        `,
        values,
      );
      return result.rows.map(mapEvent);
    },
  };
}

function normalizeRecordEventInput(input: RecordAgentExecutionLedgerEventInput) {
  return {
    id: requireReference("id", input.id),
    tenantKey: requireReference("tenantKey", input.tenantKey),
    ...(input.groupId === undefined ? {} : { groupId: requireReference("groupId", input.groupId) }),
    ...(input.actorOpenId === undefined
      ? {}
      : { actorOpenId: requireReference("actorOpenId", input.actorOpenId) }),
    subjectType: requireEnum(
      "subjectType",
      input.subjectType,
      AGENT_EXECUTION_LEDGER_SUBJECT_TYPES,
    ),
    subjectId: requireReference("subjectId", input.subjectId),
    eventType: requireEnum("eventType", input.eventType, AGENT_EXECUTION_LEDGER_EVENT_TYPES),
    ...(input.phase === undefined
      ? {}
      : { phase: requireEnum("phase", input.phase, AGENT_EXECUTION_LEDGER_PHASES) }),
    ...(input.toolCallId === undefined
      ? {}
      : { toolCallId: requireReference("toolCallId", input.toolCallId) }),
    ...(input.toolName === undefined
      ? {}
      : { toolName: requireBoundedString("toolName", input.toolName, 512) }),
    ...(input.modelId === undefined
      ? {}
      : { modelId: requireBoundedString("modelId", input.modelId, 256) }),
    ...(input.provider === undefined
      ? {}
      : { provider: requireBoundedString("provider", input.provider, 128) }),
    ...(input.outcome === undefined
      ? {}
      : { outcome: requireEnum("outcome", input.outcome, AGENT_EXECUTION_LEDGER_OUTCOMES) }),
    ...(input.decisionReason === undefined
      ? {}
      : { decisionReason: requireBoundedString("decisionReason", input.decisionReason, 512) }),
    operationKey: requireReference("operationKey", input.operationKey),
    metadata: requireMetadata(input.metadata),
    ...(input.contentFingerprint === undefined
      ? {}
      : { contentFingerprint: requireSha256("contentFingerprint", input.contentFingerprint) }),
    ...(input.durationMs === undefined
      ? {}
      : { durationMs: requireNonnegativeInteger("durationMs", input.durationMs) }),
    at: requireDate(input.at),
  };
}

function normalizeListEventsInput(input: ListAgentExecutionLedgerEventsInput) {
  const hasSubject =
    (input.subjectType === undefined) === (input.subjectId === undefined);
  if (!hasSubject) throw new Error("subject filter is invalid");
  return {
    tenantKey: requireReference("tenantKey", input.tenantKey ?? "default"),
    ...(input.groupId === undefined ? {} : { groupId: requireReference("groupId", input.groupId) }),
    ...(input.subjectType === undefined
      ? {}
      : {
          subjectType: requireEnum(
            "subjectType",
            input.subjectType,
            AGENT_EXECUTION_LEDGER_SUBJECT_TYPES,
          ),
          subjectId: requireReference("subjectId", input.subjectId),
        }),
    ...(input.toolCallId === undefined
      ? {}
      : { toolCallId: requireReference("toolCallId", input.toolCallId) }),
    limit: requireLimit(input.limit),
  };
}

function mapEvent(row: AgentExecutionLedgerRow): AgentExecutionLedgerEvent {
  return {
    id: row.id,
    tenantKey: row.tenant_key,
    ...(row.group_id === null ? {} : { groupId: row.group_id }),
    ...(row.actor_open_id === null ? {} : { actorOpenId: row.actor_open_id }),
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    eventType: row.event_type,
    ...(row.phase === null ? {} : { phase: row.phase }),
    ...(row.tool_call_id === null ? {} : { toolCallId: row.tool_call_id }),
    ...(row.tool_name === null ? {} : { toolName: row.tool_name }),
    ...(row.model_id === null ? {} : { modelId: row.model_id }),
    ...(row.provider === null ? {} : { provider: row.provider }),
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    ...(row.decision_reason === null ? {} : { decisionReason: row.decision_reason }),
    operationKey: row.operation_key,
    metadata: row.metadata,
    ...(row.content_fingerprint === null ? {} : { contentFingerprint: row.content_fingerprint }),
    ...(row.duration_ms === null ? {} : { durationMs: Number(row.duration_ms) }),
    createdAt: requireDate(row.created_at),
  };
}

async function withTransaction<T>(
  dataSource: PostgresKnowledgeDraftDataSource,
  operation: (client: KnowledgeDraftTransactionClient) => Promise<T>,
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

async function lockOperation(
  client: KnowledgeDraftTransactionClient,
  key: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

function operationFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item))
    .digest("hex");
}

function requireRow<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("agent execution ledger row missing");
  return value;
}

function requireEnum<T extends readonly string[]>(
  name: string,
  value: unknown,
  allowed: T,
): T[number] {
  if (!allowed.includes(value as string)) throw new Error(`${name} is invalid`);
  return value as T[number];
}

function requireMetadata(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("metadata is invalid");
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 16_384) {
    throw new Error("metadata is too large");
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function requireReference(name: string, value: unknown): string {
  return requireBoundedString(name, value, 512);
}

function requireBoundedString(name: string, value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if ([...normalized].length < 1 || [...normalized].length > max) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function requireSha256(name: string, value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireNonnegativeInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${name} is invalid`);
  }
  return Number(value);
}

function requireLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 100) {
    throw new Error("limit is invalid");
  }
  return Number(value);
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("date is invalid");
  }
  return new Date(value);
}
