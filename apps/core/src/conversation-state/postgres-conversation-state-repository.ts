import { randomUUID } from "node:crypto";

import {
  ACTION_ITEM_EVENT_TYPES,
  ACTION_ITEM_OWNER_REF_TYPES,
  ACTION_ITEM_STATUSES,
  CONVERSATION_STATE_ENTITY_TYPES,
  DISCUSSION_THREAD_EVENT_TYPES,
  DISCUSSION_THREAD_STATUSES,
  PROJECTION_REPAIR_STATUSES,
  type ActionItem,
  type ActionItemEvent,
  type ApplyConversationStateOperationsInput,
  type ConversationStateOperation,
  type ConversationStateRepository,
  type ConversationStateStatusCounts,
  type DiscussionThread,
  type DiscussionThreadEvent,
  type ProjectionRepair,
} from "./conversation-state-repository.js";
import {
  selectCanonicalMergeTarget,
  validateActionTransition,
  validateThreadTransition,
} from "./conversation-state-machine.js";

export type Queryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export type TransactionClient = Queryable & { release(): void };

export type PostgresConversationStateDataSource = Queryable & {
  connect(): Promise<TransactionClient>;
};

export class ConversationStateVersionConflictError extends Error {
  constructor() {
    super("conversation state version conflict");
    this.name = "ConversationStateVersionConflictError";
  }
}

export class ConversationStateIdempotencyConflictError extends Error {
  constructor() {
    super("conversation state operation key conflict");
    this.name = "ConversationStateIdempotencyConflictError";
  }
}

const MAX_IDENTIFIER_CHARS = 512;
const MAX_TITLE_CHARS = 512;
const MAX_SUMMARY_CHARS = 4000;
const MAX_DESCRIPTION_CHARS = 4000;
const MAX_CLASSIFICATION_CHARS = 128;
const MAX_LIST_LIMIT = 100;
const MAX_PROJECTION_REPAIR_ATTEMPTS = 5;
const ADVISORY_LOCK_NAMESPACE = "conversation-state";

type ThreadRow = Record<string, unknown>;
type ActionRow = Record<string, unknown>;
type RepairRow = Record<string, unknown>;
type ThreadWithEvidence = DiscussionThread & { evidenceCount: number };
type ExistingEvent = {
  kind: "thread" | "action";
  id: string;
  entityId: string;
  groupId: string;
  eventType: string;
  fromVersion?: number;
  toVersion: number;
  operationKey: string;
  createdAt: Date;
  evidenceMessageIds: string[];
};

const threadColumns = `
  id, group_id, title, summary, status, confidence, merged_into_thread_id,
  version, first_evidence_at, last_activity_at, resolved_at, created_at, updated_at
`;

const actionColumns = `
  id, group_id, thread_id, description, owner_ref_type, owner_ref, due_at,
  status, confidence, version, completed_at, cancelled_at, created_at, updated_at
`;

export function createPostgresConversationStateRepository({
  dataSource,
}: {
  dataSource: PostgresConversationStateDataSource;
}): ConversationStateRepository {
  return {
    async loadExtractionContext(input) {
      const groupId = requireBoundedString("groupId", input.groupId, MAX_IDENTIFIER_CHARS);
      const [threads, actions] = await Promise.all([
        listThreads(dataSource, groupId, input.threadLimit, ["candidate", "open", "resolved"]),
        listActions(dataSource, groupId, input.actionLimit, ["open"], undefined, false),
      ]);
      return { threads, actions };
    },

    async applyOperations(rawInput) {
      const input = normalizeApplyInput(rawInput);
      return withTransaction(dataSource, async (client) => applyOperations(client, input));
    },

    async listRelevantThreads(input) {
      const groupId = requireBoundedString("groupId", input.groupId, MAX_IDENTIFIER_CHARS);
      const requested = input.statuses === undefined
        ? ["open", "resolved"] as const
        : input.statuses
            .map((status) => requireEnum("thread status", status, DISCUSSION_THREAD_STATUSES))
            .filter((status) => status !== "candidate" && status !== "merged");
      return listThreads(dataSource, groupId, input.limit, requested);
    },

    async listRelevantActions(input) {
      const groupId = requireBoundedString("groupId", input.groupId, MAX_IDENTIFIER_CHARS);
      const threadId = input.threadId === undefined
        ? undefined
        : requireBoundedString("threadId", input.threadId, MAX_IDENTIFIER_CHARS);
      const statuses = input.statuses === undefined
        ? undefined
        : input.statuses.map((status) => requireEnum("action status", status, ACTION_ITEM_STATUSES));
      return listActions(dataSource, groupId, input.limit, statuses, threadId, true);
    },

    async claimProjectionRepairs(input) {
      const limit = sanitizeLimit(input.limit);
      const now = requireDate("now", input.now);
      const result = await dataSource.query<RepairRow>(
        `
        WITH claimed AS (
          SELECT id
          FROM conversation_state_projection_repairs
          WHERE status IN ('pending', 'failed')
            AND next_attempt_at <= $1
            AND attempt_count < $3
          ORDER BY next_attempt_at ASC, created_at ASC, id ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        UPDATE conversation_state_projection_repairs repair
        SET status = 'processing',
            attempt_count = repair.attempt_count + 1,
            failure_classification = NULL,
            updated_at = NOW()
        FROM claimed
        WHERE repair.id = claimed.id
        RETURNING repair.*
        `,
        [now, limit, MAX_PROJECTION_REPAIR_ATTEMPTS],
      );
      return result.rows.map(mapRepairRow);
    },

    async completeProjectionRepair(input) {
      const id = requireBoundedString("repair id", input.id, MAX_IDENTIFIER_CHARS);
      const memoryId = input.memoryId === undefined
        ? undefined
        : requireBoundedString("memoryId", input.memoryId, MAX_IDENTIFIER_CHARS);
      await withTransaction(dataSource, async (client) => {
        const result = await client.query<RepairRow>(
          `
          UPDATE conversation_state_projection_repairs
          SET status = 'completed', updated_at = NOW()
          WHERE id = $1 AND status = 'processing'
          RETURNING *
          `,
          [id],
        );
        const repair = onlyRow(result.rows, "projection repair not claimed");
        await client.query(
          `
          INSERT INTO conversation_state_memory_projections (
            entity_type, entity_id, group_id, projected_version, memory_id, updated_at
          ) VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (entity_type, entity_id) DO UPDATE
          SET group_id = EXCLUDED.group_id,
              projected_version = EXCLUDED.projected_version,
              memory_id = EXCLUDED.memory_id,
              updated_at = EXCLUDED.updated_at
          WHERE conversation_state_memory_projections.projected_version
            < EXCLUDED.projected_version
          `,
          [
            requireEnum("repair entity type", repair.entity_type, CONVERSATION_STATE_ENTITY_TYPES),
            requireBoundedString("repair entity id", repair.entity_id, MAX_IDENTIFIER_CHARS),
            requireBoundedString("repair group id", repair.group_id, MAX_IDENTIFIER_CHARS),
            requirePersistedVersion(repair.entity_version),
            memoryId ?? null,
          ],
        );
      });
    },

    async failProjectionRepair(input) {
      const id = requireBoundedString("repair id", input.id, MAX_IDENTIFIER_CHARS);
      const retryAt = requireDate("retryAt", input.retryAt);
      const classification = requireBoundedString(
        "classification",
        input.classification,
        MAX_CLASSIFICATION_CHARS,
      );
      const result = await dataSource.query<{ id: unknown }>(
        `
        UPDATE conversation_state_projection_repairs
        SET status = 'failed', next_attempt_at = $2, failure_classification = $3, updated_at = NOW()
        WHERE id = $1 AND status = 'processing'
        RETURNING id
        `,
        [id, retryAt, classification],
      );
      onlyRow(result.rows, "projection repair not claimed");
    },

    async getStatusCounts() {
      const [threads, actions, repairs] = await Promise.all([
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
        threads: counts(threads.rows, DISCUSSION_THREAD_STATUSES),
        actions: counts(actions.rows, ACTION_ITEM_STATUSES),
        projectionRepairs: counts(repairs.rows, PROJECTION_REPAIR_STATUSES),
      };
    },
  };
}

async function applyOperations(
  client: TransactionClient,
  input: ApplyConversationStateOperationsInput,
): Promise<{ status: "applied" | "already_applied"; threadIds: string[]; actionItemIds: string[] }> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`${ADVISORY_LOCK_NAMESPACE}:${input.groupId}`],
  );
  const actionIds = input.operations.flatMap((operation) => operation.action === undefined
    ? []
    : [operation.action.id]);
  const lockedThreads = await lockThreads(client, input.groupId);
  const lockedActions = await lockActions(client, input.groupId, dedupe(actionIds));
  const operationKeys = input.operations.map((operation) => operation.operationKey);
  const existingThreadEvents = await client.query<Record<string, unknown>>(
    `
    SELECT event.id, event.thread_id, event.group_id, event.event_type,
           event.from_version, event.to_version, event.operation_key, event.created_at,
           COALESCE((
             SELECT array_agg(evidence.conversation_message_id ORDER BY evidence.conversation_message_id)
             FROM discussion_thread_event_evidence evidence
             WHERE evidence.event_id = event.id AND evidence.group_id = event.group_id
           ), ARRAY[]::text[]) AS evidence_message_ids
    FROM discussion_thread_events event
    WHERE event.group_id = $1 AND event.operation_key = ANY($2::text[])
    `,
    [input.groupId, operationKeys],
  );
  const existingActionEvents = await client.query<Record<string, unknown>>(
    `
    SELECT event.id, event.action_item_id, event.group_id, event.event_type,
           event.from_version, event.to_version, event.operation_key, event.created_at,
           COALESCE((
             SELECT array_agg(evidence.conversation_message_id ORDER BY evidence.conversation_message_id)
             FROM action_item_event_evidence evidence
             WHERE evidence.event_id = event.id AND evidence.group_id = event.group_id
           ), ARRAY[]::text[]) AS evidence_message_ids
    FROM action_item_events event
    WHERE event.group_id = $1 AND event.operation_key = ANY($2::text[])
    `,
    [input.groupId, operationKeys],
  );

  const threads = new Map<string, DiscussionThread>(lockedThreads.map((thread) => [thread.id, thread]));
  const actions = new Map(lockedActions.map((action) => [action.id, action]));
  const replayed = classifyOperationReplays(
    input.operations,
    [
      ...existingThreadEvents.rows.map((row) => mapExistingEvent(row, "thread")),
      ...existingActionEvents.rows.map((row) => mapExistingEvent(row, "action")),
    ],
    threads,
    actions,
  );
  if (replayed) {
    return { status: "already_applied", threadIds: [], actionItemIds: [] };
  }
  const createdThreadIds = new Set(input.operations.flatMap((operation) => operation.kind === "create" && operation.thread !== undefined
    ? [operation.thread.id]
    : []));
  const evidenceCounts = new Map(lockedThreads.map((thread) => [thread.id, thread.evidenceCount]));
  prevalidateOperations(input.operations, threads, actions, createdThreadIds, evidenceCounts);
  const evidenceIds = dedupe(input.operations.flatMap((operation) => operation.evidenceMessageIds));
  if (evidenceIds.length > 0) {
    await verifyEvidence(client, input.groupId, evidenceIds);
  }

  const changedThreadIds: string[] = [];
  const changedActionIds: string[] = [];
  for (const operation of input.operations.filter((candidate) => candidate.thread !== undefined)) {
    const thread = operation.thread!;
    const event = operation.threadEvent!;
    if (operation.kind === "create") {
      await createThread(client, thread);
    } else {
      await updateThread(client, thread, operation.expectedVersion);
    }
    await insertThreadEvidence(client, thread.id, input.groupId, operation.evidenceMessageIds);
    await insertThreadEvent(client, event);
    await insertThreadEventEvidence(client, event.id, input.groupId, operation.evidenceMessageIds);
    if (thread.status !== "candidate") {
      await insertProjectionRepair(client, "thread", thread.id, input.groupId, thread.version);
    }
    threads.set(thread.id, thread);
    changedThreadIds.push(thread.id);
  }

  for (const operation of input.operations.filter((candidate) => candidate.action !== undefined)) {
    const action = operation.action!;
    const event = operation.actionEvent!;
    if (action.threadId !== undefined && !threads.has(action.threadId) && !createdThreadIds.has(action.threadId)) {
      throw new Error("action item thread not found");
    }
    if (operation.kind === "create") {
      await createAction(client, action);
    } else {
      await updateAction(client, action, operation.expectedVersion);
    }
    await insertActionEvent(client, event);
    await insertActionEventEvidence(client, event.id, input.groupId, operation.evidenceMessageIds);
    await insertProjectionRepair(client, "action", action.id, input.groupId, action.version);
    actions.set(action.id, action);
    changedActionIds.push(action.id);
  }
  return { status: "applied", threadIds: changedThreadIds, actionItemIds: changedActionIds };
}

function classifyOperationReplays(
  operations: ConversationStateOperation[],
  existingEvents: ExistingEvent[],
  threads: Map<string, DiscussionThread>,
  actions: Map<string, ActionItem>,
): boolean {
  let replayCount = 0;
  for (const operation of operations) {
    const matches = existingEvents.filter((event) => event.operationKey === operation.operationKey);
    if (matches.length === 0) continue;
    if (matches.length !== 1 || !isExactReplay(operation, matches[0]!, threads, actions)) {
      throw new ConversationStateIdempotencyConflictError();
    }
    replayCount += 1;
  }
  if (replayCount > 0 && replayCount !== operations.length) {
    throw new ConversationStateIdempotencyConflictError();
  }
  return replayCount === operations.length;
}

function isExactReplay(
  operation: ConversationStateOperation,
  existing: ExistingEvent,
  threads: Map<string, DiscussionThread>,
  actions: Map<string, ActionItem>,
): boolean {
  const evidenceMatches = haveSameStrings(existing.evidenceMessageIds, operation.evidenceMessageIds);
  if (operation.thread !== undefined && operation.threadEvent !== undefined) {
    const event = operation.threadEvent;
    const current = threads.get(operation.thread.id);
    return existing.kind === "thread"
      && existing.id === event.id
      && existing.entityId === operation.thread.id
      && existing.groupId === event.groupId
      && existing.eventType === event.eventType
      && existing.fromVersion === event.fromVersion
      && existing.toVersion === event.toVersion
      && existing.createdAt.getTime() === event.createdAt.getTime()
      && evidenceMatches
      && current !== undefined
      && haveSameThread(current, operation.thread);
  }
  if (operation.action !== undefined && operation.actionEvent !== undefined) {
    const event = operation.actionEvent;
    const current = actions.get(operation.action.id);
    return existing.kind === "action"
      && existing.id === event.id
      && existing.entityId === operation.action.id
      && existing.groupId === event.groupId
      && existing.eventType === event.eventType
      && existing.fromVersion === event.fromVersion
      && existing.toVersion === event.toVersion
      && existing.createdAt.getTime() === event.createdAt.getTime()
      && evidenceMatches
      && current !== undefined
      && haveSameAction(current, operation.action);
  }
  return false;
}

function mapExistingEvent(row: Record<string, unknown>, kind: "thread" | "action"): ExistingEvent {
  const fromVersion = row.from_version === null
    ? undefined
    : requirePersistedVersion(row.from_version);
  return {
    kind,
    id: requireBoundedString("event id", row.id, MAX_IDENTIFIER_CHARS),
    entityId: requireBoundedString(
      "event entity id",
      kind === "thread" ? row.thread_id : row.action_item_id,
      MAX_IDENTIFIER_CHARS,
    ),
    groupId: requireBoundedString("event group id", row.group_id, MAX_IDENTIFIER_CHARS),
    eventType: requireBoundedString("event type", row.event_type, MAX_IDENTIFIER_CHARS),
    ...(fromVersion === undefined ? {} : { fromVersion }),
    toVersion: requirePersistedVersion(row.to_version),
    operationKey: requireBoundedString("operation key", row.operation_key, MAX_IDENTIFIER_CHARS),
    createdAt: requireDate("event createdAt", row.created_at),
    evidenceMessageIds: requirePersistedStringArray("event evidence", row.evidence_message_ids),
  };
}

function haveSameThread(left: DiscussionThread, right: DiscussionThread): boolean {
  return left.id === right.id
    && left.groupId === right.groupId
    && left.title === right.title
    && left.summary === right.summary
    && left.status === right.status
    && left.confidence === right.confidence
    && left.mergedIntoThreadId === right.mergedIntoThreadId
    && left.version === right.version
    && sameDate(left.firstEvidenceAt, right.firstEvidenceAt)
    && sameDate(left.lastActivityAt, right.lastActivityAt)
    && sameOptionalDate(left.resolvedAt, right.resolvedAt)
    && sameDate(left.createdAt, right.createdAt)
    && sameDate(left.updatedAt, right.updatedAt);
}

function haveSameAction(left: ActionItem, right: ActionItem): boolean {
  return left.id === right.id
    && left.groupId === right.groupId
    && left.threadId === right.threadId
    && left.description === right.description
    && left.ownerRefType === right.ownerRefType
    && left.ownerRef === right.ownerRef
    && sameOptionalDate(left.dueAt, right.dueAt)
    && left.status === right.status
    && left.confidence === right.confidence
    && left.version === right.version
    && sameOptionalDate(left.completedAt, right.completedAt)
    && sameOptionalDate(left.cancelledAt, right.cancelledAt)
    && sameDate(left.createdAt, right.createdAt)
    && sameDate(left.updatedAt, right.updatedAt);
}

function sameDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function sameOptionalDate(left: Date | undefined, right: Date | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && sameDate(left, right);
}

function prevalidateOperations(
  operations: ConversationStateOperation[],
  threads: Map<string, DiscussionThread>,
  actions: Map<string, ActionItem>,
  createdThreadIds: Set<string>,
  evidenceCounts: Map<string, number>,
): void {
  const createdActionIds = new Set<string>();
  for (const operation of operations) {
    if (operation.thread !== undefined) {
      if (operation.kind === "create") {
        if (threads.has(operation.thread.id)) throw new Error("discussion thread already exists");
        threads.set(operation.thread.id, operation.thread);
        evidenceCounts.set(operation.thread.id, operation.evidenceMessageIds.length);
        continue;
      }
      const current = threads.get(operation.thread.id);
      if (current === undefined) throw new Error("discussion thread not found");
      validateThreadMutation(
        operation as Extract<ConversationStateOperation, { kind: "mutation" }> & { thread: DiscussionThread },
        current,
        threads,
        evidenceCounts,
      );
      threads.set(operation.thread.id, operation.thread);
      continue;
    }
    const action = operation.action!;
    if (action.threadId !== undefined && !threads.has(action.threadId) && !createdThreadIds.has(action.threadId)) {
      throw new Error("action item thread not found");
    }
    if (operation.kind === "create") {
      if (actions.has(action.id) || createdActionIds.has(action.id)) throw new Error("action item already exists");
      createdActionIds.add(action.id);
      actions.set(action.id, action);
      continue;
    }
    const current = actions.get(action.id);
    if (current === undefined) throw new Error("action item not found");
    validateActionMutation(operation as Extract<ConversationStateOperation, { kind: "mutation" }> & { action: ActionItem }, current);
    actions.set(action.id, action);
  }
}

function validateThreadMutation(
  operation: Extract<ConversationStateOperation, { kind: "mutation" }> & { thread: DiscussionThread },
  current: DiscussionThread,
  threads: Map<string, DiscussionThread>,
  evidenceCounts: Map<string, number>,
): void {
  if (current.version !== operation.expectedVersion) throw new ConversationStateVersionConflictError();
  const event = operation.threadEvent!;
  const transition = validateThreadTransition({
    from: current.status,
    to: operation.thread.status,
    eventType: event.eventType,
  });
  if (!transition.ok) throw new Error(transition.code);
  if (operation.thread.status === "merged") {
    const target = operation.thread.mergedIntoThreadId!;
    const terminalTarget = resolveMergeTarget(operation.thread.id, target, threads);
    const canonicalTargetId = selectCanonicalMergeTarget([
      {
        id: current.id,
        status: current.status,
        evidenceCount: evidenceCounts.get(current.id) ?? 0,
        createdAt: current.createdAt,
      },
      {
        id: terminalTarget.id,
        status: terminalTarget.status,
        evidenceCount: evidenceCounts.get(terminalTarget.id) ?? 0,
        createdAt: terminalTarget.createdAt,
      },
    ]);
    if (terminalTarget.id !== target || canonicalTargetId !== target) {
      throw new Error("merge target is not canonical");
    }
  }
}

function validateActionMutation(
  operation: Extract<ConversationStateOperation, { kind: "mutation" }> & { action: ActionItem },
  current: ActionItem,
): void {
  if (current.version !== operation.expectedVersion) throw new ConversationStateVersionConflictError();
  const transition = validateActionTransition({
    from: current.status,
    to: operation.action.status,
    eventType: operation.actionEvent!.eventType,
    evidenceCount: operation.evidenceMessageIds.length,
  });
  if (!transition.ok) throw new Error(transition.code);
}

function resolveMergeTarget(
  sourceId: string,
  initialTargetId: string,
  threads: Map<string, DiscussionThread>,
): DiscussionThread {
  const visited = new Set<string>([sourceId]);
  let targetId = initialTargetId;
  while (true) {
    if (visited.has(targetId)) throw new Error("merge chain contains a cycle");
    visited.add(targetId);
    const target = threads.get(targetId);
    if (target === undefined) throw new Error("merge target not found");
    if (target.status !== "merged") return target;
    targetId = target.mergedIntoThreadId!;
  }
}

function normalizeApplyInput(input: ApplyConversationStateOperationsInput): ApplyConversationStateOperationsInput {
  const groupId = requireBoundedString("groupId", input.groupId, MAX_IDENTIFIER_CHARS);
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    throw new Error("operations must not be empty");
  }
  const operations = input.operations.map((operation) => normalizeOperation(operation, groupId));
  const keys = operations.map((operation) => operation.operationKey);
  if (new Set(keys).size !== keys.length) throw new Error("operation keys must be unique");
  return { groupId, operations };
}

function normalizeOperation(operation: ConversationStateOperation, groupId: string): ConversationStateOperation {
  const operationKey = requireBoundedString("operationKey", operation.operationKey, MAX_IDENTIFIER_CHARS);
  const evidenceMessageIds = normalizeEvidence(operation.evidenceMessageIds);
  const hasThread = operation.thread !== undefined || operation.threadEvent !== undefined;
  const hasAction = operation.action !== undefined || operation.actionEvent !== undefined;
  if (hasThread === hasAction || operation.thread === undefined !== (operation.threadEvent === undefined) || operation.action === undefined !== (operation.actionEvent === undefined)) {
    throw new Error("operation must contain exactly one entity and matching event");
  }
  if (operation.thread !== undefined) {
    const thread = normalizeThread(operation.thread, groupId);
    const event = normalizeThreadEvent(operation.threadEvent!, groupId, operationKey);
    if (event.threadId !== thread.id) throw new Error("thread event must reference operation thread");
    validateOperationVersion(operation, thread.version, event.fromVersion, event.toVersion);
    if (operation.kind === "create" && event.eventType !== "created") throw new Error("create thread event must be created");
    if (operation.kind === "create" && thread.status === "merged") throw new Error("new discussion thread must not be merged");
    if (operation.kind === "create") {
      const { fromVersion: _fromVersion, ...createEvent } = event;
      return { kind: "create", operationKey, thread, threadEvent: createEvent, evidenceMessageIds };
    }
    return {
      kind: "mutation", operationKey, expectedVersion: requireVersion(operation.expectedVersion), thread,
      threadEvent: { ...event, fromVersion: event.fromVersion! }, evidenceMessageIds,
    };
  }
  const action = normalizeAction(operation.action!, groupId);
  const event = normalizeActionEvent(operation.actionEvent!, groupId, operationKey);
  if (event.actionItemId !== action.id) throw new Error("action event must reference operation action");
  validateOperationVersion(operation, action.version, event.fromVersion, event.toVersion);
  if (operation.kind === "create" && event.eventType !== "created") throw new Error("create action event must be created");
  if (operation.kind === "create" && action.status !== "open") throw new Error("new action item must be open");
  if (operation.kind === "create") {
    const { fromVersion: _fromVersion, ...createEvent } = event;
    return { kind: "create", operationKey, action, actionEvent: createEvent, evidenceMessageIds };
  }
  return {
    kind: "mutation", operationKey, expectedVersion: requireVersion(operation.expectedVersion), action,
    actionEvent: { ...event, fromVersion: event.fromVersion! }, evidenceMessageIds,
  };
}

function validateOperationVersion(
  operation: ConversationStateOperation,
  entityVersion: number,
  fromVersion: number | undefined,
  toVersion: number,
): void {
  if (operation.kind === "create") {
    if (entityVersion !== 1 || fromVersion !== undefined || toVersion !== 1) {
      throw new Error("create operation must initialize version one");
    }
    return;
  }
  if (entityVersion !== operation.expectedVersion + 1 || fromVersion !== operation.expectedVersion || toVersion !== entityVersion) {
    throw new Error("mutation must increment version exactly once");
  }
}

function normalizeThread(thread: DiscussionThread, groupId: string): DiscussionThread {
  const status = requireEnum("thread status", thread.status, DISCUSSION_THREAD_STATUSES);
  const mergedIntoThreadId = thread.mergedIntoThreadId === undefined
    ? undefined
    : requireBoundedString("mergedIntoThreadId", thread.mergedIntoThreadId, MAX_IDENTIFIER_CHARS);
  const resolvedAt = thread.resolvedAt === undefined ? undefined : requireDate("resolvedAt", thread.resolvedAt);
  if ((status === "merged") !== (mergedIntoThreadId !== undefined)) throw new Error("merged thread target is invalid");
  if ((status === "resolved") !== (resolvedAt !== undefined)) throw new Error("resolved thread timestamp is invalid");
  return {
    id: requireBoundedString("thread id", thread.id, MAX_IDENTIFIER_CHARS), groupId: requireSameGroup(thread.groupId, groupId),
    title: requireBoundedString("thread title", thread.title, MAX_TITLE_CHARS), summary: requireBoundedString("thread summary", thread.summary, MAX_SUMMARY_CHARS),
    status, confidence: requireConfidence(thread.confidence), ...(mergedIntoThreadId === undefined ? {} : { mergedIntoThreadId }),
    version: requireVersion(thread.version), firstEvidenceAt: requireDate("firstEvidenceAt", thread.firstEvidenceAt), lastActivityAt: requireDate("lastActivityAt", thread.lastActivityAt),
    ...(resolvedAt === undefined ? {} : { resolvedAt }), createdAt: requireDate("createdAt", thread.createdAt), updatedAt: requireDate("updatedAt", thread.updatedAt),
  };
}

function normalizeAction(action: ActionItem, groupId: string): ActionItem {
  const status = requireEnum("action status", action.status, ACTION_ITEM_STATUSES);
  const completedAt = action.completedAt === undefined ? undefined : requireDate("completedAt", action.completedAt);
  const cancelledAt = action.cancelledAt === undefined ? undefined : requireDate("cancelledAt", action.cancelledAt);
  if ((status === "completed") !== (completedAt !== undefined) || (status === "cancelled") !== (cancelledAt !== undefined)) {
    throw new Error("action item status timestamp is invalid");
  }
  const threadId = action.threadId === undefined ? undefined : requireBoundedString("threadId", action.threadId, MAX_IDENTIFIER_CHARS);
  const dueAt = action.dueAt === undefined ? undefined : requireDate("dueAt", action.dueAt);
  return {
    id: requireBoundedString("action id", action.id, MAX_IDENTIFIER_CHARS), groupId: requireSameGroup(action.groupId, groupId),
    ...(threadId === undefined ? {} : { threadId }), description: requireBoundedString("action description", action.description, MAX_DESCRIPTION_CHARS),
    ownerRefType: requireEnum("ownerRefType", action.ownerRefType, ACTION_ITEM_OWNER_REF_TYPES), ownerRef: requireBoundedString("ownerRef", action.ownerRef, MAX_IDENTIFIER_CHARS),
    ...(dueAt === undefined ? {} : { dueAt }), status, confidence: requireConfidence(action.confidence), version: requireVersion(action.version),
    ...(completedAt === undefined ? {} : { completedAt }), ...(cancelledAt === undefined ? {} : { cancelledAt }),
    createdAt: requireDate("createdAt", action.createdAt), updatedAt: requireDate("updatedAt", action.updatedAt),
  };
}

function normalizeThreadEvent(event: DiscussionThreadEvent, groupId: string, operationKey: string): DiscussionThreadEvent {
  return {
    id: requireBoundedString("thread event id", event.id, MAX_IDENTIFIER_CHARS), threadId: requireBoundedString("thread event thread id", event.threadId, MAX_IDENTIFIER_CHARS),
    groupId: requireSameGroup(event.groupId, groupId), eventType: requireEnum("thread event type", event.eventType, DISCUSSION_THREAD_EVENT_TYPES),
    ...(event.fromVersion === undefined ? {} : { fromVersion: requireVersion(event.fromVersion) }), toVersion: requireVersion(event.toVersion),
    operationKey: requireSameOperationKey(event.operationKey, operationKey), createdAt: requireDate("thread event createdAt", event.createdAt),
  };
}

function normalizeActionEvent(event: ActionItemEvent, groupId: string, operationKey: string): ActionItemEvent {
  return {
    id: requireBoundedString("action event id", event.id, MAX_IDENTIFIER_CHARS), actionItemId: requireBoundedString("action event action id", event.actionItemId, MAX_IDENTIFIER_CHARS),
    groupId: requireSameGroup(event.groupId, groupId), eventType: requireEnum("action event type", event.eventType, ACTION_ITEM_EVENT_TYPES),
    ...(event.fromVersion === undefined ? {} : { fromVersion: requireVersion(event.fromVersion) }), toVersion: requireVersion(event.toVersion),
    operationKey: requireSameOperationKey(event.operationKey, operationKey), createdAt: requireDate("action event createdAt", event.createdAt),
  };
}

async function lockThreads(client: TransactionClient, groupId: string): Promise<ThreadWithEvidence[]> {
  const result = await client.query<ThreadRow>(
    `
    SELECT thread.*, COALESCE(evidence.evidence_count, 0) AS evidence_count
    FROM discussion_threads thread
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS evidence_count
      FROM discussion_thread_evidence item
      WHERE item.thread_id = thread.id AND item.group_id = thread.group_id
    ) evidence ON TRUE
    WHERE thread.group_id = $1
    FOR UPDATE OF thread
    `,
    [groupId],
  );
  return result.rows.map((row) => ({
    ...mapThreadRow(row),
    evidenceCount: requireNonNegativeInteger("thread evidence count", Number(row.evidence_count)),
  }));
}

async function lockActions(client: TransactionClient, groupId: string, ids: string[]): Promise<ActionItem[]> {
  const result = await client.query<ActionRow>(
    `SELECT ${actionColumns} FROM action_items WHERE group_id = $1 AND id = ANY($2::text[]) FOR UPDATE`,
    [groupId, ids],
  );
  return result.rows.map(mapActionRow);
}

async function verifyEvidence(client: TransactionClient, groupId: string, messageIds: string[]): Promise<void> {
  const result = await client.query<{ id: unknown }>(
    `SELECT id FROM conversation_messages WHERE id = ANY($1::text[]) AND chat_id = $2 FOR UPDATE`,
    [messageIds, groupId],
  );
  if (result.rows.length !== messageIds.length) throw new Error("evidence must belong to the same group");
}

async function createThread(client: TransactionClient, thread: DiscussionThread): Promise<void> {
  await client.query(
    `INSERT INTO discussion_threads (${threadColumns}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [thread.id, thread.groupId, thread.title, thread.summary, thread.status, thread.confidence, thread.mergedIntoThreadId ?? null, thread.version, thread.firstEvidenceAt, thread.lastActivityAt, thread.resolvedAt ?? null, thread.createdAt, thread.updatedAt],
  );
}

async function updateThread(client: TransactionClient, thread: DiscussionThread, expectedVersion: number): Promise<void> {
  const result = await client.query<{ id: unknown }>(
    `
    UPDATE discussion_threads
    SET title = $3, summary = $4, status = $5, confidence = $6, merged_into_thread_id = $7,
        version = $8, first_evidence_at = $9, last_activity_at = $10, resolved_at = $11, updated_at = $12
    WHERE id = $1 AND group_id = $2 AND version = $13
    RETURNING id
    `,
    [thread.id, thread.groupId, thread.title, thread.summary, thread.status, thread.confidence, thread.mergedIntoThreadId ?? null, thread.version, thread.firstEvidenceAt, thread.lastActivityAt, thread.resolvedAt ?? null, thread.updatedAt, expectedVersion],
  );
  onlyRow(result.rows, "discussion thread version changed during update");
}

async function createAction(client: TransactionClient, action: ActionItem): Promise<void> {
  await client.query(
    `INSERT INTO action_items (${actionColumns}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [action.id, action.groupId, action.threadId ?? null, action.description, action.ownerRefType, action.ownerRef, action.dueAt ?? null, action.status, action.confidence, action.version, action.completedAt ?? null, action.cancelledAt ?? null, action.createdAt, action.updatedAt],
  );
}

async function updateAction(client: TransactionClient, action: ActionItem, expectedVersion: number): Promise<void> {
  const result = await client.query<{ id: unknown }>(
    `
    UPDATE action_items
    SET thread_id = $3, description = $4, owner_ref_type = $5, owner_ref = $6, due_at = $7,
        status = $8, confidence = $9, version = $10, completed_at = $11, cancelled_at = $12, updated_at = $13
    WHERE id = $1 AND group_id = $2 AND version = $14
    RETURNING id
    `,
    [action.id, action.groupId, action.threadId ?? null, action.description, action.ownerRefType, action.ownerRef, action.dueAt ?? null, action.status, action.confidence, action.version, action.completedAt ?? null, action.cancelledAt ?? null, action.updatedAt, expectedVersion],
  );
  onlyRow(result.rows, "action item version changed during update");
}

async function insertThreadEvidence(client: TransactionClient, threadId: string, groupId: string, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  await client.query(
    `INSERT INTO discussion_thread_evidence (thread_id, group_id, conversation_message_id) SELECT $1, $2, message_id FROM UNNEST($3::text[]) AS message_id ON CONFLICT DO NOTHING`,
    [threadId, groupId, messageIds],
  );
}

async function insertThreadEvent(client: TransactionClient, event: DiscussionThreadEvent): Promise<void> {
  await client.query(
    `INSERT INTO discussion_thread_events (id, thread_id, group_id, event_type, from_version, to_version, operation_key, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [event.id, event.threadId, event.groupId, event.eventType, event.fromVersion ?? null, event.toVersion, event.operationKey, event.createdAt],
  );
}

async function insertThreadEventEvidence(client: TransactionClient, eventId: string, groupId: string, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  await client.query(
    `INSERT INTO discussion_thread_event_evidence (event_id, group_id, conversation_message_id) SELECT $1, $2, message_id FROM UNNEST($3::text[]) AS message_id`,
    [eventId, groupId, messageIds],
  );
}

async function insertActionEvent(client: TransactionClient, event: ActionItemEvent): Promise<void> {
  await client.query(
    `INSERT INTO action_item_events (id, action_item_id, group_id, event_type, from_version, to_version, operation_key, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [event.id, event.actionItemId, event.groupId, event.eventType, event.fromVersion ?? null, event.toVersion, event.operationKey, event.createdAt],
  );
}

async function insertActionEventEvidence(client: TransactionClient, eventId: string, groupId: string, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  await client.query(
    `INSERT INTO action_item_event_evidence (event_id, group_id, conversation_message_id) SELECT $1, $2, message_id FROM UNNEST($3::text[]) AS message_id`,
    [eventId, groupId, messageIds],
  );
}

async function insertProjectionRepair(
  client: TransactionClient,
  entityType: "thread" | "action",
  entityId: string,
  groupId: string,
  entityVersion: number,
): Promise<void> {
  await client.query(
    `INSERT INTO conversation_state_projection_repairs (id, entity_type, entity_id, group_id, entity_version, status, attempt_count, next_attempt_at) VALUES ($1, $2, $3, $4, $5, 'pending', 0, NOW())`,
    [randomUUID(), entityType, entityId, groupId, entityVersion],
  );
}

async function listThreads(queryable: Queryable, groupId: string, rawLimit: number, statuses: readonly string[]): Promise<DiscussionThread[]> {
  const limit = sanitizeLimit(rawLimit);
  if (statuses.length === 0 || limit === 0) return [];
  const result = await queryable.query<ThreadRow>(
    `SELECT ${threadColumns} FROM discussion_threads WHERE group_id = $1 AND status = ANY($2::text[]) ORDER BY last_activity_at DESC, id ASC LIMIT $3`,
    [groupId, statuses, limit],
  );
  return result.rows.map(mapThreadRow);
}

async function listActions(
  queryable: Queryable,
  groupId: string,
  rawLimit: number,
  statuses?: readonly string[],
  threadId?: string,
  excludeCandidateThreads = false,
): Promise<ActionItem[]> {
  const limit = sanitizeLimit(rawLimit);
  if (limit === 0 || (statuses !== undefined && statuses.length === 0)) return [];
  const result = await queryable.query<ActionRow>(
    `
    SELECT ${actionColumns}
    FROM action_items action
    WHERE action.group_id = $1
      AND ($2::text[] IS NULL OR action.status = ANY($2::text[]))
      AND ($3::text IS NULL OR action.thread_id = $3)
      ${excludeCandidateThreads ? `AND NOT EXISTS (
        SELECT 1
        FROM discussion_threads thread
        WHERE thread.id = action.thread_id
          AND thread.group_id = action.group_id
          AND thread.status = 'candidate'
      )` : ""}
    ORDER BY action.updated_at DESC, action.id ASC
    LIMIT $4
    `,
    [groupId, statuses ?? null, threadId ?? null, limit],
  );
  return result.rows.map(mapActionRow);
}

function mapThreadRow(row: ThreadRow): DiscussionThread {
  const status = requireEnum("thread status", row.status, DISCUSSION_THREAD_STATUSES);
  const mergedIntoThreadId = row.merged_into_thread_id === null ? undefined : requireBoundedString("merged thread id", row.merged_into_thread_id, MAX_IDENTIFIER_CHARS);
  const resolvedAt = row.resolved_at === null ? undefined : requireDate("resolvedAt", row.resolved_at);
  if ((status === "merged") !== (mergedIntoThreadId !== undefined) || (status === "resolved") !== (resolvedAt !== undefined)) {
    throw new Error("persisted discussion thread is invalid");
  }
  return { id: requireBoundedString("thread id", row.id, MAX_IDENTIFIER_CHARS), groupId: requireBoundedString("thread group id", row.group_id, MAX_IDENTIFIER_CHARS), title: requireBoundedString("thread title", row.title, MAX_TITLE_CHARS), summary: requireBoundedString("thread summary", row.summary, MAX_SUMMARY_CHARS), status, confidence: requireConfidence(Number(row.confidence)), ...(mergedIntoThreadId === undefined ? {} : { mergedIntoThreadId }), version: requirePersistedVersion(row.version), firstEvidenceAt: requireDate("firstEvidenceAt", row.first_evidence_at), lastActivityAt: requireDate("lastActivityAt", row.last_activity_at), ...(resolvedAt === undefined ? {} : { resolvedAt }), createdAt: requireDate("createdAt", row.created_at), updatedAt: requireDate("updatedAt", row.updated_at) };
}

function mapActionRow(row: ActionRow): ActionItem {
  const status = requireEnum("action status", row.status, ACTION_ITEM_STATUSES);
  const completedAt = row.completed_at === null ? undefined : requireDate("completedAt", row.completed_at);
  const cancelledAt = row.cancelled_at === null ? undefined : requireDate("cancelledAt", row.cancelled_at);
  if ((status === "completed") !== (completedAt !== undefined) || (status === "cancelled") !== (cancelledAt !== undefined)) throw new Error("persisted action item is invalid");
  const threadId = row.thread_id === null ? undefined : requireBoundedString("action thread id", row.thread_id, MAX_IDENTIFIER_CHARS);
  const dueAt = row.due_at === null ? undefined : requireDate("dueAt", row.due_at);
  return { id: requireBoundedString("action id", row.id, MAX_IDENTIFIER_CHARS), groupId: requireBoundedString("action group id", row.group_id, MAX_IDENTIFIER_CHARS), ...(threadId === undefined ? {} : { threadId }), description: requireBoundedString("action description", row.description, MAX_DESCRIPTION_CHARS), ownerRefType: requireEnum("ownerRefType", row.owner_ref_type, ACTION_ITEM_OWNER_REF_TYPES), ownerRef: requireBoundedString("ownerRef", row.owner_ref, MAX_IDENTIFIER_CHARS), ...(dueAt === undefined ? {} : { dueAt }), status, confidence: requireConfidence(Number(row.confidence)), version: requirePersistedVersion(row.version), ...(completedAt === undefined ? {} : { completedAt }), ...(cancelledAt === undefined ? {} : { cancelledAt }), createdAt: requireDate("createdAt", row.created_at), updatedAt: requireDate("updatedAt", row.updated_at) };
}

function mapRepairRow(row: RepairRow): ProjectionRepair {
  const failureClassification = row.failure_classification === null ? undefined : requireBoundedString("failureClassification", row.failure_classification, MAX_CLASSIFICATION_CHARS);
  return { id: requireBoundedString("repair id", row.id, MAX_IDENTIFIER_CHARS), entityType: requireEnum("repair entity type", row.entity_type, CONVERSATION_STATE_ENTITY_TYPES), entityId: requireBoundedString("repair entity id", row.entity_id, MAX_IDENTIFIER_CHARS), groupId: requireBoundedString("repair group id", row.group_id, MAX_IDENTIFIER_CHARS), entityVersion: requirePersistedVersion(row.entity_version), status: requireEnum("repair status", row.status, PROJECTION_REPAIR_STATUSES), attemptCount: requireNonNegativeInteger("repair attempt count", row.attempt_count), nextAttemptAt: requireDate("repair nextAttemptAt", row.next_attempt_at), ...(failureClassification === undefined ? {} : { failureClassification }), createdAt: requireDate("repair createdAt", row.created_at), updatedAt: requireDate("repair updatedAt", row.updated_at) };
}

async function withTransaction<T>(dataSource: PostgresConversationStateDataSource, operation: (client: TransactionClient) => Promise<T>): Promise<T> {
  const client = await dataSource.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
    throw error;
  } finally {
    client.release();
  }
}

function normalizeEvidence(value: string[]): string[] {
  if (!Array.isArray(value)) throw new Error("evidenceMessageIds must be an array");
  return dedupe(value.map((id) => requireBoundedString("evidenceMessageId", id, MAX_IDENTIFIER_CHARS)));
}

function requirePersistedStringArray(field: string, value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item) => requireBoundedString(field, item, MAX_IDENTIFIER_CHARS));
}

function haveSameStrings(left: string[], right: string[]): boolean {
  const leftValues = [...new Set(left)].sort();
  const rightValues = [...new Set(right)].sort();
  return leftValues.length === rightValues.length
    && leftValues.every((value, index) => value === rightValues[index]);
}

function dedupe(values: string[]): string[] { return [...new Set(values)]; }

function requireSameGroup(value: unknown, groupId: string): string {
  const normalized = requireBoundedString("entity groupId", value, MAX_IDENTIFIER_CHARS);
  if (normalized !== groupId) throw new Error("entity must belong to the requested group");
  return normalized;
}

function requireSameOperationKey(value: unknown, operationKey: string): string {
  const normalized = requireBoundedString("event operationKey", value, MAX_IDENTIFIER_CHARS);
  if (normalized !== operationKey) throw new Error("event operation key must match operation key");
  return normalized;
}

function requireBoundedString(field: string, value: unknown, maxChars: number): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must not be blank`);
  if (value.length > maxChars) throw new Error(`${field} must be at most ${maxChars} characters`);
  return value.trim();
}

function requireEnum<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${field} is invalid`);
  return value as T;
}

function requireConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("confidence must be a finite number from 0 to 1");
  return value;
}

function requireVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("version must be a positive safe integer");
  return value;
}

function requirePersistedVersion(value: unknown): number {
  return requireVersion(Number(value));
}

function requireNonNegativeInteger(field: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

function requireDate(field: string, value: unknown): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(`${field} must be a valid Date`);
  return new Date(value);
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new Error("limit must be a finite safe-magnitude number");
  return Math.min(MAX_LIST_LIMIT, Math.max(0, Math.floor(value)));
}

function onlyRow<T>(rows: T[], message: string): T {
  if (rows.length !== 1) throw new Error(message);
  return rows[0]!;
}

function counts<T extends string>(rows: { status: unknown; count: unknown }[], statuses: readonly T[]): Record<T, number> {
  const result = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<T, number>;
  for (const row of rows) result[requireEnum("status", row.status, statuses)] = requireNonNegativeInteger("count", Number(row.count));
  return result;
}
