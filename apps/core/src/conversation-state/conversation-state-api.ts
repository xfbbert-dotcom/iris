import type { FastifyInstance, FastifyReply } from "fastify";

import {
  ACTION_ITEM_EVENT_TYPES,
  ACTION_ITEM_OWNER_REF_TYPES,
  ACTION_ITEM_STATUSES,
  DISCUSSION_THREAD_EVENT_TYPES,
  DISCUSSION_THREAD_STATUSES,
  PROJECTION_REPAIR_STATUSES,
  type ActionItem,
  type ActionItemEvent,
  type ConversationStateStatusCounts,
  type DiscussionThread,
  type DiscussionThreadEvent,
} from "./conversation-state-repository.js";
import { readDatabaseConfig, type DatabaseEnv } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";

const MAX_IDENTIFIER_CHARS = 512;
const MAX_LIST_LIMIT = 100;
const MAX_EVIDENCE_IDS = 100;

type Queryable = {
  query<T extends Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export type InspectedDiscussionThread = DiscussionThread & {
  evidenceMessageIds: string[];
};

export type InspectedActionItem = ActionItem & {
  evidenceMessageIds: string[];
};

export type InspectedDiscussionThreadEvent = DiscussionThreadEvent & {
  evidenceMessageIds: string[];
};

export type InspectedActionItemEvent = ActionItemEvent & {
  evidenceMessageIds: string[];
};

export interface ConversationStateInspectionStore {
  getStatus(): Promise<ConversationStateStatusCounts>;
  listThreads(input: { groupId: string; limit: number }): Promise<InspectedDiscussionThread[]>;
  listActions(input: { groupId: string; limit: number }): Promise<InspectedActionItem[]>;
  listThreadEvents(input: {
    threadId: string;
    limit: number;
  }): Promise<InspectedDiscussionThreadEvent[]>;
  listActionEvents(input: {
    actionItemId: string;
    limit: number;
  }): Promise<InspectedActionItemEvent[]>;
}

export type ConversationStateInspectionRuntime = {
  store: ConversationStateInspectionStore;
  close(): Promise<void>;
};

export function createConversationStateInspectionRuntime({
  env = process.env,
  createPool = createPostgresPool,
}: {
  env?: DatabaseEnv;
  createPool?: typeof createPostgresPool;
} = {}): ConversationStateInspectionRuntime | undefined {
  if (env.DATABASE_URL?.trim() === undefined || env.DATABASE_URL.trim().length === 0) {
    return undefined;
  }
  const pool = createPool(readDatabaseConfig(env));
  return {
    store: createPostgresConversationStateInspectionStore({ dataSource: pool as never }),
    close: () => pool.end(),
  };
}

export function registerConversationStateApi(
  app: FastifyInstance,
  store: ConversationStateInspectionStore | undefined,
  { authenticationConfigured }: { authenticationConfigured: boolean },
): void {
  app.get("/internal/conversation-state/status", async (_request, reply) => {
    if (!authenticationConfigured) return authenticationUnavailable(reply);
    if (store === undefined) return unavailable(reply);
    try {
      return { ok: true, ...(await store.getStatus()) };
    } catch {
      return inspectionFailed(reply);
    }
  });

  app.get<{ Params: { groupId: string } }>(
    "/internal/conversation-state/groups/:groupId/threads",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (store === undefined) return unavailable(reply);
      const groupId = readBoundedId(request.params.groupId);
      const limit = readLimit(request.query, 20);
      if (groupId === undefined || limit === undefined) return invalidRequest(reply);
      try {
        return { ok: true, groupId, threads: await store.listThreads({ groupId, limit }) };
      } catch {
        return inspectionFailed(reply);
      }
    },
  );

  app.get<{ Params: { groupId: string } }>(
    "/internal/conversation-state/groups/:groupId/actions",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (store === undefined) return unavailable(reply);
      const groupId = readBoundedId(request.params.groupId);
      const limit = readLimit(request.query, 20);
      if (groupId === undefined || limit === undefined) return invalidRequest(reply);
      try {
        return { ok: true, groupId, actions: await store.listActions({ groupId, limit }) };
      } catch {
        return inspectionFailed(reply);
      }
    },
  );

  app.get<{ Params: { threadId: string } }>(
    "/internal/conversation-state/threads/:threadId/events",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (store === undefined) return unavailable(reply);
      const threadId = readBoundedId(request.params.threadId);
      const limit = readLimit(request.query, 50);
      if (threadId === undefined || limit === undefined) return invalidRequest(reply);
      try {
        return { ok: true, threadId, events: await store.listThreadEvents({ threadId, limit }) };
      } catch {
        return inspectionFailed(reply);
      }
    },
  );

  app.get<{ Params: { actionId: string } }>(
    "/internal/conversation-state/actions/:actionId/events",
    async (request, reply) => {
      if (!authenticationConfigured) return authenticationUnavailable(reply);
      if (store === undefined) return unavailable(reply);
      const actionId = readBoundedId(request.params.actionId);
      const limit = readLimit(request.query, 50);
      if (actionId === undefined || limit === undefined) return invalidRequest(reply);
      try {
        return {
          ok: true,
          actionId,
          events: await store.listActionEvents({ actionItemId: actionId, limit }),
        };
      } catch {
        return inspectionFailed(reply);
      }
    },
  );
}

export function createPostgresConversationStateInspectionStore({
  dataSource,
}: {
  dataSource: Queryable;
}): ConversationStateInspectionStore {
  return {
    async getStatus() {
      const [threads, actions, projectionRepairs] = await Promise.all([
        dataSource.query<{ status: unknown; count: unknown }>(
          "SELECT status, COUNT(*) AS count FROM discussion_threads GROUP BY status",
        ),
        dataSource.query<{ status: unknown; count: unknown }>(
          "SELECT status, COUNT(*) AS count FROM action_items GROUP BY status",
        ),
        dataSource.query<{ status: unknown; count: unknown }>(
          "SELECT status, COUNT(*) AS count FROM conversation_state_projection_repairs GROUP BY status",
        ),
      ]);
      return {
        threads: mapCounts(threads.rows, DISCUSSION_THREAD_STATUSES),
        actions: mapCounts(actions.rows, ACTION_ITEM_STATUSES),
        projectionRepairs: mapCounts(projectionRepairs.rows, PROJECTION_REPAIR_STATUSES),
      };
    },

    async listThreads(input) {
      const groupId = requireBoundedId("groupId", input.groupId);
      const limit = requireLimit(input.limit);
      const result = await dataSource.query<Record<string, unknown>>(
        `
        SELECT thread.*,
          ARRAY(
            SELECT evidence.conversation_message_id
            FROM discussion_thread_evidence evidence
            WHERE evidence.thread_id = thread.id
              AND evidence.group_id = thread.group_id
            ORDER BY evidence.created_at ASC, evidence.conversation_message_id ASC
            LIMIT ${MAX_EVIDENCE_IDS}
          ) AS evidence_message_ids
        FROM discussion_threads thread
        WHERE thread.group_id = $1
          AND thread.status = ANY($3::text[])
        ORDER BY thread.last_activity_at DESC, thread.id ASC
        LIMIT $2
        `,
        [groupId, limit, [...DISCUSSION_THREAD_STATUSES]],
      );
      return result.rows.map(mapThread);
    },

    async listActions(input) {
      const groupId = requireBoundedId("groupId", input.groupId);
      const limit = requireLimit(input.limit);
      const result = await dataSource.query<Record<string, unknown>>(
        `
        SELECT action.*,
          ARRAY(
            SELECT DISTINCT evidence.conversation_message_id
            FROM action_item_events event
            JOIN action_item_event_evidence evidence
              ON evidence.event_id = event.id
              AND evidence.group_id = event.group_id
            WHERE event.action_item_id = action.id
              AND event.group_id = action.group_id
            ORDER BY evidence.conversation_message_id ASC
            LIMIT ${MAX_EVIDENCE_IDS}
          ) AS evidence_message_ids
        FROM action_items action
        WHERE action.group_id = $1
          AND action.status = ANY($3::text[])
        ORDER BY action.updated_at DESC, action.id ASC
        LIMIT $2
        `,
        [groupId, limit, [...ACTION_ITEM_STATUSES]],
      );
      return result.rows.map(mapAction);
    },

    async listThreadEvents(input) {
      const threadId = requireBoundedId("threadId", input.threadId);
      const limit = requireLimit(input.limit);
      const result = await dataSource.query<Record<string, unknown>>(
        `
        SELECT event.*,
          ARRAY(
            SELECT evidence.conversation_message_id
            FROM discussion_thread_event_evidence evidence
            WHERE evidence.event_id = event.id
              AND evidence.group_id = event.group_id
            ORDER BY evidence.conversation_message_id ASC
            LIMIT ${MAX_EVIDENCE_IDS}
          ) AS evidence_message_ids
        FROM discussion_thread_events event
        WHERE event.thread_id = $1
        ORDER BY event.to_version DESC, event.id ASC
        LIMIT $2
        `,
        [threadId, limit],
      );
      return result.rows.map(mapThreadEvent);
    },

    async listActionEvents(input) {
      const actionItemId = requireBoundedId("actionItemId", input.actionItemId);
      const limit = requireLimit(input.limit);
      const result = await dataSource.query<Record<string, unknown>>(
        `
        SELECT event.*,
          ARRAY(
            SELECT evidence.conversation_message_id
            FROM action_item_event_evidence evidence
            WHERE evidence.event_id = event.id
              AND evidence.group_id = event.group_id
            ORDER BY evidence.conversation_message_id ASC
            LIMIT ${MAX_EVIDENCE_IDS}
          ) AS evidence_message_ids
        FROM action_item_events event
        WHERE event.action_item_id = $1
        ORDER BY event.to_version DESC, event.id ASC
        LIMIT $2
        `,
        [actionItemId, limit],
      );
      return result.rows.map(mapActionEvent);
    },
  };
}

function mapThread(row: Record<string, unknown>): InspectedDiscussionThread {
  const status = requireEnum("thread status", row.status, DISCUSSION_THREAD_STATUSES);
  const mergedIntoThreadId = optionalString(row.merged_into_thread_id, "merged thread id");
  const resolvedAt = optionalDate(row.resolved_at, "resolvedAt");
  return {
    id: requireBoundedId("thread id", row.id),
    groupId: requireBoundedId("thread group id", row.group_id),
    title: requireString("thread title", row.title, 512),
    summary: requireString("thread summary", row.summary, 4000),
    status,
    confidence: requireConfidence(row.confidence),
    ...(mergedIntoThreadId === undefined ? {} : { mergedIntoThreadId }),
    version: requireVersion(row.version),
    firstEvidenceAt: requireDate("firstEvidenceAt", row.first_evidence_at),
    lastActivityAt: requireDate("lastActivityAt", row.last_activity_at),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    createdAt: requireDate("createdAt", row.created_at),
    updatedAt: requireDate("updatedAt", row.updated_at),
    evidenceMessageIds: requireEvidenceIds(row.evidence_message_ids),
  };
}

function mapAction(row: Record<string, unknown>): InspectedActionItem {
  const threadId = optionalString(row.thread_id, "action thread id");
  const dueAt = optionalDate(row.due_at, "dueAt");
  const completedAt = optionalDate(row.completed_at, "completedAt");
  const cancelledAt = optionalDate(row.cancelled_at, "cancelledAt");
  return {
    id: requireBoundedId("action id", row.id),
    groupId: requireBoundedId("action group id", row.group_id),
    ...(threadId === undefined ? {} : { threadId }),
    description: requireString("action description", row.description, 4000),
    ownerRefType: requireEnum("owner ref type", row.owner_ref_type, ACTION_ITEM_OWNER_REF_TYPES),
    ownerRef: requireBoundedId("owner ref", row.owner_ref),
    ...(dueAt === undefined ? {} : { dueAt }),
    status: requireEnum("action status", row.status, ACTION_ITEM_STATUSES),
    confidence: requireConfidence(row.confidence),
    version: requireVersion(row.version),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(cancelledAt === undefined ? {} : { cancelledAt }),
    createdAt: requireDate("createdAt", row.created_at),
    updatedAt: requireDate("updatedAt", row.updated_at),
    evidenceMessageIds: requireEvidenceIds(row.evidence_message_ids),
  };
}

function mapThreadEvent(row: Record<string, unknown>): InspectedDiscussionThreadEvent {
  const fromVersion = optionalVersion(row.from_version);
  return {
    id: requireBoundedId("thread event id", row.id),
    threadId: requireBoundedId("thread event thread id", row.thread_id),
    groupId: requireBoundedId("thread event group id", row.group_id),
    eventType: requireEnum("thread event type", row.event_type, DISCUSSION_THREAD_EVENT_TYPES),
    ...(fromVersion === undefined ? {} : { fromVersion }),
    toVersion: requireVersion(row.to_version),
    operationKey: requireBoundedId("thread event operation key", row.operation_key),
    createdAt: requireDate("createdAt", row.created_at),
    evidenceMessageIds: requireEvidenceIds(row.evidence_message_ids),
  };
}

function mapActionEvent(row: Record<string, unknown>): InspectedActionItemEvent {
  const fromVersion = optionalVersion(row.from_version);
  return {
    id: requireBoundedId("action event id", row.id),
    actionItemId: requireBoundedId("action event action id", row.action_item_id),
    groupId: requireBoundedId("action event group id", row.group_id),
    eventType: requireEnum("action event type", row.event_type, ACTION_ITEM_EVENT_TYPES),
    ...(fromVersion === undefined ? {} : { fromVersion }),
    toVersion: requireVersion(row.to_version),
    operationKey: requireBoundedId("action event operation key", row.operation_key),
    createdAt: requireDate("createdAt", row.created_at),
    evidenceMessageIds: requireEvidenceIds(row.evidence_message_ids),
  };
}

function readLimit(value: unknown, fallback: number): number | undefined {
  if (!isRecord(value)) return undefined;
  if (value.limit === undefined) return fallback;
  if (typeof value.limit !== "string" || !/^[1-9]\d*$/u.test(value.limit)) return undefined;
  const parsed = Number(value.limit);
  return Number.isSafeInteger(parsed) && parsed <= MAX_LIST_LIMIT ? parsed : undefined;
}

function readBoundedId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_IDENTIFIER_CHARS
    ? normalized
    : undefined;
}

function requireBoundedId(label: string, value: unknown): string {
  const parsed = readBoundedId(value);
  if (parsed === undefined) throw new Error(`${label} is invalid`);
  return parsed;
}

function requireLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new Error("limit is invalid");
  }
  return value;
}

function requireString(label: string, value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === null || value === undefined ? undefined : requireBoundedId(label, value);
}

function requireDate(label: string, value: unknown): Date {
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}

function optionalDate(value: unknown, label: string): Date | undefined {
  return value === null || value === undefined ? undefined : requireDate(label, value);
}

function requireVersion(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("version is invalid");
  return parsed;
}

function optionalVersion(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : requireVersion(value);
}

function requireConfidence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("confidence is invalid");
  }
  return parsed;
}

function requireEvidenceIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_IDS) {
    throw new Error("evidence ids are invalid");
  }
  return value.map((id) => requireBoundedId("evidence message id", id));
}

function requireEnum<T extends string>(label: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} is invalid`);
  }
  return value as T;
}

function mapCounts<T extends string>(
  rows: Array<{ status: unknown; count: unknown }>,
  statuses: readonly T[],
): Record<T, number> {
  const result = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<T, number>;
  for (const row of rows) {
    const status = requireEnum("count status", row.status, statuses);
    const count = typeof row.count === "number" ? row.count : Number(row.count);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("count is invalid");
    result[status] = count;
  }
  return result;
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({ ok: false, error: "invalid_request" });
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ ok: false, error: "conversation_state_api_unavailable" });
}

function authenticationUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    ok: false,
    error: "conversation_state_api_auth_unavailable",
  });
}

function inspectionFailed(reply: FastifyReply) {
  return reply.code(500).send({ ok: false, error: "conversation_state_inspection_failed" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
