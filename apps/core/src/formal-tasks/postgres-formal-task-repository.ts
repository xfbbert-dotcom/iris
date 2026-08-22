import { createHash, randomUUID } from "node:crypto";

import {
  findInvalidKnowledgeDraftEvidence,
  type KnowledgeDraftEvidenceQueryable,
} from "../knowledge-governance/postgres-knowledge-draft-evidence.js";

import {
  canonicalFormalTaskSpecHash,
  FORMAL_TASK_DRAFT_STATUSES,
  normalizeFormalTaskSpec,
  type FormalTaskDraftStatus,
  type FormalTaskSpec,
} from "./formal-task-draft.js";
import {
  FORMAL_TASK_RISK_LEVELS,
  type CreateFormalTaskDraftInput,
  type DisposeFormalTaskDraftInput,
  type FeishuTaskTargetPolicy,
  type FeishuTaskTargetPolicyMutationResult,
  type FormalTaskDraftEvent,
  type FormalTaskDraftMutationResult,
  type FormalTaskDraftRevisionInput,
  type FormalTaskDraftStatusCounts,
  type FormalTaskDraftView,
  type FormalTaskEvidenceReference,
  type FormalTaskRepository,
  type FormalTaskRiskLevel,
  type ReviseFormalTaskDraftInput,
  type TransitionFormalTaskDraftInput,
  type UpsertFeishuTaskTargetPolicyInput,
} from "./formal-task-repository.js";

type FormalTaskTransactionClient = KnowledgeDraftEvidenceQueryable & { release(): void };
export type PostgresFormalTaskDataSource = KnowledgeDraftEvidenceQueryable & {
  connect(): Promise<FormalTaskTransactionClient>;
};

type PolicyRow = {
  id: string;
  source_group_id: string;
  display_name: string;
  allowed_assignee_open_ids: string[];
  max_due_horizon_days: string | number;
  enabled: boolean;
  version: string | number;
  created_at: Date;
  updated_at: Date;
};

type PolicyOperationRow = {
  operation_fingerprint: string;
  policy_id: string;
  resulting_version: string | number;
};

type DraftRevisionRow = {
  id: string;
  source_group_id: string;
  status: FormalTaskDraftStatus;
  current_revision_number: string | number;
  version: string | number;
  created_by: string;
  current_task_spec_hash: string;
  rejected_at: Date | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  created_at: Date;
  updated_at: Date;
  title: string;
  description: string;
  assignee_open_id: string;
  due_at: Date | null;
  reminder_minutes: string | number | null;
  risk_level: FormalTaskRiskLevel;
  target_policy_id: string;
  target_policy_version: string | number;
  task_spec_hash: string;
  revision_author: string;
  revision_created_at: Date;
};

type DraftHeaderRow = Pick<
  DraftRevisionRow,
  | "id"
  | "source_group_id"
  | "status"
  | "current_revision_number"
  | "version"
  | "current_task_spec_hash"
>;

type EvidenceRow = {
  conversation_message_id: string | null;
  action_item_id: string | null;
  action_item_version: string | number | null;
};

type EventRow = {
  id: string;
  draft_id: string;
  event_type: FormalTaskDraftEvent["eventType"];
  from_version: string | number | null;
  to_version: string | number;
  operation_key: string;
  operation_fingerprint: string;
  actor: string;
  reason: string | null;
  revision_number: string | number;
  created_at: Date;
};

type CountRow = { status: FormalTaskDraftStatus; count: string | number };

type NormalizedRevision = {
  taskSpec: FormalTaskSpec;
  taskSpecHash: string;
  riskLevel: FormalTaskRiskLevel;
  author: string;
  evidence: FormalTaskEvidenceReference[];
};

export class FormalTaskOperationConflictError extends Error {
  constructor() {
    super("formal task operation conflicts with an existing operation");
    this.name = "FormalTaskOperationConflictError";
  }
}

export class FormalTaskVersionConflictError extends Error {
  constructor() {
    super("formal task version conflict");
    this.name = "FormalTaskVersionConflictError";
  }
}

export class FormalTaskPolicyConflictError extends Error {
  constructor() {
    super("formal task target policy is not current or does not allow the task");
    this.name = "FormalTaskPolicyConflictError";
  }
}

export class FormalTaskEvidenceError extends Error {
  constructor(public readonly reason: string) {
    super("formal task evidence is not current");
    this.name = "FormalTaskEvidenceError";
  }
}

export class FormalTaskTransitionError extends Error {
  constructor() {
    super("formal task draft transition is invalid");
    this.name = "FormalTaskTransitionError";
  }
}

export class FormalTaskNotFoundError extends Error {
  constructor() {
    super("formal task draft not found");
    this.name = "FormalTaskNotFoundError";
  }
}

export function createPostgresFormalTaskRepository({
  dataSource,
}: {
  dataSource: PostgresFormalTaskDataSource;
}): FormalTaskRepository {
  return {
    upsertTargetPolicy(input) {
      return upsertTargetPolicy(dataSource, input);
    },
    async getTargetPolicy(id) {
      return loadPolicy(dataSource, requireReference("id", id));
    },
    async getTargetPolicyForGroup(sourceGroupId) {
      const result = await dataSource.query<PolicyRow>(
        `${policySelect()} WHERE source_group_id = $1`,
        [requireReference("sourceGroupId", sourceGroupId)],
      );
      return result.rows[0] === undefined ? undefined : mapPolicy(result.rows[0]);
    },
    createDraft(input) {
      return createDraft(dataSource, input);
    },
    reviseDraft(input) {
      return reviseDraft(dataSource, input);
    },
    confirmDraft(input) {
      return transitionDraft(dataSource, input, "group_confirmed");
    },
    requestRevision(input) {
      return transitionDraft(dataSource, input, "revision_requested");
    },
    rejectDraft(input) {
      return transitionDraft(dataSource, input, "rejected");
    },
    markTaskCreated(input) {
      return transitionDraft(dataSource, input, "task_created");
    },
    getDraft(id) {
      return loadDraft(dataSource, requireReference("id", id), new Date());
    },
    async listDrafts(input) {
      const sourceGroupId = input.sourceGroupId === undefined
        ? undefined
        : requireReference("sourceGroupId", input.sourceGroupId);
      const statuses = normalizeFilter("statuses", input.statuses, FORMAL_TASK_DRAFT_STATUSES);
      const riskLevels = normalizeFilter("riskLevels", input.riskLevels, FORMAL_TASK_RISK_LEVELS);
      const limit = requireLimit(input.limit);
      const result = await dataSource.query<DraftRevisionRow>(
        `${draftRevisionSelect()}
         WHERE ($1::TEXT IS NULL OR draft.source_group_id = $1)
           AND ($2::TEXT[] IS NULL OR draft.status = ANY($2::TEXT[]))
           AND ($3::TEXT[] IS NULL OR revision.risk_level = ANY($3::TEXT[]))
         ORDER BY draft.updated_at DESC, draft.id ASC
         LIMIT $4`,
        [sourceGroupId ?? null, statuses ?? null, riskLevels ?? null, limit],
      );
      const validationAt = new Date();
      return Promise.all(result.rows.map((row) => mapDraft(dataSource, row, validationAt)));
    },
    async listEvents(id) {
      const result = await dataSource.query<EventRow>(
        `SELECT id, draft_id, event_type, from_version, to_version, operation_key,
                operation_fingerprint, actor, reason, revision_number, created_at
         FROM formal_task_draft_events
         WHERE draft_id = $1 ORDER BY created_at ASC, id ASC`,
        [requireReference("id", id)],
      );
      return result.rows.map(mapEvent);
    },
    async getStatusCounts() {
      const result = await dataSource.query<CountRow>(
        "SELECT status, count(*) AS count FROM formal_task_drafts GROUP BY status",
      );
      const counts = Object.fromEntries(
        FORMAL_TASK_DRAFT_STATUSES.map((status) => [status, 0]),
      ) as FormalTaskDraftStatusCounts;
      for (const row of result.rows) counts[row.status] = Number(row.count);
      return counts;
    },
  };
}

async function upsertTargetPolicy(
  dataSource: PostgresFormalTaskDataSource,
  input: UpsertFeishuTaskTargetPolicyInput,
): Promise<FeishuTaskTargetPolicyMutationResult> {
  const normalized = normalizePolicyInput(input);
  const fingerprint = operationFingerprint({ operation: "upsert_task_policy", ...normalized });
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await client.query<PolicyOperationRow>(
      `SELECT operation_fingerprint, policy_id, resulting_version
       FROM feishu_task_target_policy_operations WHERE operation_key = $1`,
      [normalized.operationKey],
    );
    if (replay.rows[0] !== undefined) {
      if (replay.rows[0].operation_fingerprint !== fingerprint) {
        throw new FormalTaskOperationConflictError();
      }
      return {
        outcome: "already_applied",
        policy: await requirePolicy(client, replay.rows[0].policy_id),
      };
    }

    const existing = await client.query<PolicyRow>(
      `${policySelect()} WHERE id = $1 OR source_group_id = $2 FOR UPDATE`,
      [normalized.id, normalized.sourceGroupId],
    );
    const row = existing.rows[0];
    if (
      (row === undefined ? 0 : Number(row.version)) !== normalized.expectedVersion ||
      (row !== undefined && (row.id !== normalized.id ||
        row.source_group_id !== normalized.sourceGroupId))
    ) throw new FormalTaskVersionConflictError();

    const nextVersion = normalized.expectedVersion + 1;
    if (row === undefined) {
      await client.query(
        `INSERT INTO feishu_task_target_policies (
           id, source_group_id, display_name, allowed_assignee_open_ids,
           max_due_horizon_days, enabled, version, operation_key,
           operation_fingerprint, created_by, updated_by, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $9, $10, $10)`,
        [
          normalized.id,
          normalized.sourceGroupId,
          normalized.displayName,
          normalized.allowedAssigneeOpenIds,
          normalized.maxDueHorizonDays,
          normalized.enabled,
          normalized.operationKey,
          fingerprint,
          normalized.operator,
          normalized.at,
        ],
      );
    } else {
      await client.query(
        `UPDATE feishu_task_target_policies
         SET display_name = $2, allowed_assignee_open_ids = $3,
             max_due_horizon_days = $4, enabled = $5, version = version + 1,
             operation_key = $6, operation_fingerprint = $7,
             updated_by = $8, updated_at = $9
         WHERE id = $1 AND version = $10`,
        [
          normalized.id,
          normalized.displayName,
          normalized.allowedAssigneeOpenIds,
          normalized.maxDueHorizonDays,
          normalized.enabled,
          normalized.operationKey,
          fingerprint,
          normalized.operator,
          normalized.at,
          normalized.expectedVersion,
        ],
      );
    }
    await client.query(
      `INSERT INTO feishu_task_target_policy_operations (
         operation_key, operation_fingerprint, policy_id, resulting_version, created_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [normalized.operationKey, fingerprint, normalized.id, nextVersion, normalized.at],
    );
    return { outcome: "applied", policy: await requirePolicy(client, normalized.id) };
  });
}

async function createDraft(
  dataSource: PostgresFormalTaskDataSource,
  input: CreateFormalTaskDraftInput,
): Promise<FormalTaskDraftMutationResult> {
  const id = requireReference("id", input.id);
  const operationKey = requireReference("operationKey", input.operationKey);
  const createdBy = requireReference("createdBy", input.createdBy);
  const at = requireDate(input.at);
  const revision = normalizeRevision(input.revision);
  const fingerprint = operationFingerprint({
    operation: "create_formal_task_draft",
    id,
    operationKey,
    createdBy,
    revision,
    at,
  });

  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, operationKey);
    const replay = await client.query<EventRow>(
      `SELECT id, draft_id, event_type, from_version, to_version, operation_key,
              operation_fingerprint, actor, reason, revision_number, created_at
       FROM formal_task_draft_events WHERE operation_key = $1`,
      [operationKey],
    );
    if (replay.rows[0] !== undefined) {
      if (replay.rows[0].operation_fingerprint !== fingerprint) {
        throw new FormalTaskOperationConflictError();
      }
      return {
        outcome: "already_applied",
        draft: await requireDraft(client, replay.rows[0].draft_id, at),
      };
    }
    const existing = await client.query("SELECT 1 FROM formal_task_drafts WHERE id = $1", [id]);
    if (existing.rows.length > 0) throw new FormalTaskOperationConflictError();

    await validateTaskPolicy(client, revision.taskSpec, at);
    await validateEvidence(client, revision.taskSpec.sourceGroupId, revision.evidence);
    await client.query(
      `INSERT INTO formal_task_drafts (
         id, source_group_id, status, current_revision_number, version, created_by,
         current_task_spec_hash, created_at, updated_at
       ) VALUES ($1, $2, 'pending_confirmation', 1, 1, $3, $4, $5, $5)`,
      [id, revision.taskSpec.sourceGroupId, createdBy, revision.taskSpecHash, at],
    );
    await client.query(
      `INSERT INTO formal_task_draft_revisions (
         draft_id, revision_number, title, description, assignee_open_id, due_at,
         reminder_minutes, risk_level, target_policy_id, target_policy_version,
         task_spec_hash, author, created_at
       ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        revision.taskSpec.title,
        revision.taskSpec.description,
        revision.taskSpec.assigneeOpenId,
        revision.taskSpec.dueAtUtc === undefined ? null : new Date(revision.taskSpec.dueAtUtc),
        revision.taskSpec.reminderMinutes ?? null,
        revision.riskLevel,
        revision.taskSpec.targetPolicyId,
        revision.taskSpec.targetPolicyVersion,
        revision.taskSpecHash,
        revision.author,
        at,
      ],
    );
    await insertEvidence(client, id, 1, revision.taskSpec.sourceGroupId, revision.evidence, at);
    await client.query(
      `INSERT INTO formal_task_draft_events (
         id, draft_id, event_type, from_version, to_version, operation_key,
         operation_fingerprint, actor, revision_number, created_at
       ) VALUES ($1, $2, 'created', NULL, 1, $3, $4, $5, 1, $6)`,
      [randomUUID(), id, operationKey, fingerprint, createdBy, at],
    );
    return { outcome: "applied", draft: await requireDraft(client, id, at) };
  });
}

async function reviseDraft(
  dataSource: PostgresFormalTaskDataSource,
  input: ReviseFormalTaskDraftInput,
): Promise<FormalTaskDraftMutationResult> {
  const base = normalizeMutationBase(input);
  const revision = normalizeRevision(input.revision);
  const fingerprint = operationFingerprint({
    operation: "revise_formal_task_draft",
    ...base,
    revision,
  });
  return withTransaction(dataSource, async (client) => {
    const replay = await lockAndFindReplay(client, base.operationKey, fingerprint);
    if (replay !== undefined) {
      return {
        outcome: "already_applied",
        draft: await requireDraft(client, replay.draft_id, base.at),
      };
    }
    const draft = await lockDraft(client, base.id);
    requireExpectedVersion(draft, base.expectedVersion);
    if (draft.status !== "pending_confirmation" && draft.status !== "needs_revision") {
      throw new FormalTaskTransitionError();
    }
    if (revision.taskSpec.sourceGroupId !== draft.source_group_id) {
      throw new FormalTaskPolicyConflictError();
    }
    await validateTaskPolicy(client, revision.taskSpec, base.at);
    await validateEvidence(client, revision.taskSpec.sourceGroupId, revision.evidence);

    const nextRevision = Number(draft.current_revision_number) + 1;
    const nextVersion = Number(draft.version) + 1;
    await client.query(
      `INSERT INTO formal_task_draft_revisions (
         draft_id, revision_number, title, description, assignee_open_id, due_at,
         reminder_minutes, risk_level, target_policy_id, target_policy_version,
         task_spec_hash, author, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        base.id,
        nextRevision,
        revision.taskSpec.title,
        revision.taskSpec.description,
        revision.taskSpec.assigneeOpenId,
        revision.taskSpec.dueAtUtc === undefined ? null : new Date(revision.taskSpec.dueAtUtc),
        revision.taskSpec.reminderMinutes ?? null,
        revision.riskLevel,
        revision.taskSpec.targetPolicyId,
        revision.taskSpec.targetPolicyVersion,
        revision.taskSpecHash,
        revision.author,
        base.at,
      ],
    );
    await insertEvidence(
      client,
      base.id,
      nextRevision,
      revision.taskSpec.sourceGroupId,
      revision.evidence,
      base.at,
    );
    await client.query(
      `UPDATE formal_task_drafts
       SET status = 'pending_confirmation', current_revision_number = $2,
           current_task_spec_hash = $3, version = $4, updated_at = $5
       WHERE id = $1 AND version = $6`,
      [
        base.id,
        nextRevision,
        revision.taskSpecHash,
        nextVersion,
        base.at,
        base.expectedVersion,
      ],
    );
    await insertDraftEvent(client, {
      draftId: base.id,
      eventType: "revised",
      fromVersion: base.expectedVersion,
      toVersion: nextVersion,
      operationKey: base.operationKey,
      operationFingerprint: fingerprint,
      actor: base.actor,
      revisionNumber: nextRevision,
      at: base.at,
    });
    return { outcome: "applied", draft: await requireDraft(client, base.id, base.at) };
  });
}

async function transitionDraft(
  dataSource: PostgresFormalTaskDataSource,
  input: TransitionFormalTaskDraftInput | DisposeFormalTaskDraftInput,
  eventType: "group_confirmed" | "revision_requested" | "rejected" | "task_created",
): Promise<FormalTaskDraftMutationResult> {
  const normalized = normalizeTransitionInput(input, eventType);
  const fingerprint = operationFingerprint({
    operation: `transition_formal_task_draft:${eventType}`,
    ...normalized,
  });
  return withTransaction(dataSource, async (client) => {
    const replay = await lockAndFindReplay(client, normalized.operationKey, fingerprint);
    if (replay !== undefined) {
      return {
        outcome: "already_applied",
        draft: await requireDraft(client, replay.draft_id, normalized.at),
      };
    }
    const draft = await lockDraft(client, normalized.id);
    requireExpectedVersion(draft, normalized.expectedVersion);
    if (
      Number(draft.current_revision_number) !== normalized.expectedRevision ||
      draft.current_task_spec_hash !== normalized.expectedTaskSpecHash ||
      !transitionAllowed(draft.status, eventType)
    ) throw new FormalTaskTransitionError();

    if (eventType === "group_confirmed" || eventType === "task_created") {
      const current = await requireDraft(client, normalized.id, normalized.at);
      const currentRevision = current.currentRevision;
      if (!("taskSpec" in currentRevision)) {
        throw new FormalTaskEvidenceError(currentRevision.evidenceState.reason);
      }
      await validateTaskPolicy(client, currentRevision.taskSpec, normalized.at);
    }

    const nextStatus = eventType === "group_confirmed"
      ? "pending_review"
      : eventType === "revision_requested"
        ? "needs_revision"
        : eventType === "rejected"
          ? "rejected"
          : "created";
    const nextVersion = normalized.expectedVersion + 1;
    if (eventType === "rejected") {
      await client.query(
        `UPDATE formal_task_drafts
         SET status = 'rejected', version = $2, updated_at = $3,
             rejected_at = $3, rejected_by = $4, rejection_reason = $5
         WHERE id = $1 AND version = $6`,
        [
          normalized.id,
          nextVersion,
          normalized.at,
          normalized.actor,
          normalized.reason,
          normalized.expectedVersion,
        ],
      );
    } else {
      await client.query(
        `UPDATE formal_task_drafts
         SET status = $2, version = $3, updated_at = $4
         WHERE id = $1 AND version = $5`,
        [
          normalized.id,
          nextStatus,
          nextVersion,
          normalized.at,
          normalized.expectedVersion,
        ],
      );
    }
    await insertDraftEvent(client, {
      draftId: normalized.id,
      eventType,
      fromVersion: normalized.expectedVersion,
      toVersion: nextVersion,
      operationKey: normalized.operationKey,
      operationFingerprint: fingerprint,
      actor: normalized.actor,
      reason: normalized.reason,
      revisionNumber: normalized.expectedRevision,
      at: normalized.at,
    });
    return {
      outcome: "applied",
      draft: await requireDraft(client, normalized.id, normalized.at),
    };
  });
}

async function insertDraftEvent(
  queryable: KnowledgeDraftEvidenceQueryable,
  input: {
    draftId: string;
    eventType: FormalTaskDraftEvent["eventType"];
    fromVersion: number;
    toVersion: number;
    operationKey: string;
    operationFingerprint: string;
    actor: string;
    reason?: string;
    revisionNumber: number;
    at: Date;
  },
): Promise<void> {
  await queryable.query(
    `INSERT INTO formal_task_draft_events (
       id, draft_id, event_type, from_version, to_version, operation_key,
       operation_fingerprint, actor, reason, revision_number, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      randomUUID(),
      input.draftId,
      input.eventType,
      input.fromVersion,
      input.toVersion,
      input.operationKey,
      input.operationFingerprint,
      input.actor,
      input.reason ?? null,
      input.revisionNumber,
      input.at,
    ],
  );
}

function transitionAllowed(
  status: FormalTaskDraftStatus,
  eventType: "group_confirmed" | "revision_requested" | "rejected" | "task_created",
): boolean {
  if (eventType === "group_confirmed") return status === "pending_confirmation";
  if (eventType === "revision_requested") {
    return status === "pending_confirmation" || status === "pending_review";
  }
  if (eventType === "rejected") {
    return status === "pending_confirmation" || status === "pending_review" ||
      status === "needs_revision";
  }
  return status === "pending_review";
}

async function validateTaskPolicy(
  queryable: KnowledgeDraftEvidenceQueryable,
  spec: FormalTaskSpec,
  at: Date,
): Promise<void> {
  const result = await queryable.query<PolicyRow>(
    `${policySelect()} WHERE id = $1 FOR SHARE`,
    [spec.targetPolicyId],
  );
  const policy = result.rows[0];
  if (
    policy === undefined ||
    !policy.enabled ||
    policy.source_group_id !== spec.sourceGroupId ||
    Number(policy.version) !== spec.targetPolicyVersion ||
    !policy.allowed_assignee_open_ids.includes(spec.assigneeOpenId)
  ) throw new FormalTaskPolicyConflictError();
  if (spec.dueAtUtc !== undefined) {
    const dueAt = new Date(spec.dueAtUtc);
    const latestDueAt = at.getTime() + Number(policy.max_due_horizon_days) * 86_400_000;
    if (dueAt.getTime() < at.getTime() || dueAt.getTime() > latestDueAt) {
      throw new FormalTaskPolicyConflictError();
    }
  }
}

async function validateEvidence(
  queryable: KnowledgeDraftEvidenceQueryable,
  sourceGroupId: string,
  evidence: FormalTaskEvidenceReference[],
): Promise<void> {
  const reason = await findInvalidKnowledgeDraftEvidence({
    queryable,
    sourceGroupId,
    evidence: evidence.map((reference) => reference.type === "conversation_message"
      ? { type: reference.type, id: reference.id, groupId: sourceGroupId }
      : {
          type: reference.type,
          id: reference.id,
          groupId: sourceGroupId,
          entityVersion: reference.entityVersion,
        }),
  });
  if (reason !== undefined) throw new FormalTaskEvidenceError(reason);
}

async function insertEvidence(
  queryable: KnowledgeDraftEvidenceQueryable,
  draftId: string,
  revisionNumber: number,
  sourceGroupId: string,
  evidence: FormalTaskEvidenceReference[],
  at: Date,
): Promise<void> {
  for (const reference of evidence) {
    await queryable.query(
      `INSERT INTO formal_task_draft_evidence (
         draft_id, revision_number, source_group_id, conversation_message_id,
         action_item_id, action_item_version, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        draftId,
        revisionNumber,
        sourceGroupId,
        reference.type === "conversation_message" ? reference.id : null,
        reference.type === "action_item" ? reference.id : null,
        reference.type === "action_item" ? reference.entityVersion : null,
        at,
      ],
    );
  }
}

async function loadPolicy(
  queryable: KnowledgeDraftEvidenceQueryable,
  id: string,
): Promise<FeishuTaskTargetPolicy | undefined> {
  const result = await queryable.query<PolicyRow>(`${policySelect()} WHERE id = $1`, [id]);
  return result.rows[0] === undefined ? undefined : mapPolicy(result.rows[0]);
}

async function requirePolicy(
  queryable: KnowledgeDraftEvidenceQueryable,
  id: string,
): Promise<FeishuTaskTargetPolicy> {
  const policy = await loadPolicy(queryable, id);
  if (policy === undefined) throw new Error("formal task policy not found after mutation");
  return policy;
}

async function loadDraft(
  queryable: KnowledgeDraftEvidenceQueryable,
  id: string,
  validationAt: Date,
): Promise<FormalTaskDraftView | undefined> {
  const result = await queryable.query<DraftRevisionRow>(
    `${draftRevisionSelect()} WHERE draft.id = $1`,
    [id],
  );
  return result.rows[0] === undefined
    ? undefined
    : mapDraft(queryable, result.rows[0], validationAt);
}

async function requireDraft(
  queryable: KnowledgeDraftEvidenceQueryable,
  id: string,
  validationAt: Date,
): Promise<FormalTaskDraftView> {
  const draft = await loadDraft(queryable, id, validationAt);
  if (draft === undefined) throw new Error("formal task draft not found after mutation");
  return draft;
}

async function mapDraft(
  queryable: KnowledgeDraftEvidenceQueryable,
  row: DraftRevisionRow,
  validationAt: Date,
): Promise<FormalTaskDraftView> {
  const revisionNumber = Number(row.current_revision_number);
  if (row.current_task_spec_hash !== row.task_spec_hash) {
    throw new Error("formal task draft hash binding is invalid");
  }
  const evidence = await loadEvidence(queryable, row.id, revisionNumber);
  const reason = await findInvalidKnowledgeDraftEvidence({
    queryable,
    sourceGroupId: row.source_group_id,
    evidence: evidence.map((reference) => reference.type === "conversation_message"
      ? { type: reference.type, id: reference.id, groupId: row.source_group_id }
      : {
          type: reference.type,
          id: reference.id,
          groupId: row.source_group_id,
          entityVersion: reference.entityVersion,
        }),
  });
  const revisionBase = {
    revisionNumber,
    riskLevel: row.risk_level,
    author: row.revision_author,
    taskSpecHash: row.task_spec_hash,
    createdAt: requireDatabaseDate(row.revision_created_at),
  };
  const currentRevision = reason === undefined
    ? {
        ...revisionBase,
        evidenceState: { status: "current" as const },
        taskSpec: {
          title: row.title,
          description: row.description,
          assigneeOpenId: row.assignee_open_id,
          ...(row.due_at === null
            ? {}
            : { dueAtUtc: requireDatabaseDate(row.due_at).toISOString() }),
          ...(row.reminder_minutes === null
            ? {}
            : { reminderMinutes: Number(row.reminder_minutes) as 0 | 30 | 60 | 1440 }),
          sourceGroupId: row.source_group_id,
          targetPolicyId: row.target_policy_id,
          targetPolicyVersion: Number(row.target_policy_version),
        },
        evidence,
      }
    : {
        ...revisionBase,
        evidenceState: { status: "invalidated" as const, reason },
      };
  void validationAt;
  return {
    id: row.id,
    sourceGroupId: row.source_group_id,
    status: row.status,
    currentRevisionNumber: revisionNumber,
    version: Number(row.version),
    createdBy: row.created_by,
    currentTaskSpecHash: row.current_task_spec_hash,
    ...(row.rejected_at === null ? {} : { rejectedAt: requireDatabaseDate(row.rejected_at) }),
    ...(row.rejected_by === null ? {} : { rejectedBy: row.rejected_by }),
    ...(row.rejection_reason === null ? {} : { rejectionReason: row.rejection_reason }),
    createdAt: requireDatabaseDate(row.created_at),
    updatedAt: requireDatabaseDate(row.updated_at),
    currentRevision,
  };
}

async function loadEvidence(
  queryable: KnowledgeDraftEvidenceQueryable,
  draftId: string,
  revisionNumber: number,
): Promise<FormalTaskEvidenceReference[]> {
  const result = await queryable.query<EvidenceRow>(
    `SELECT conversation_message_id, action_item_id, action_item_version
     FROM formal_task_draft_evidence
     WHERE draft_id = $1 AND revision_number = $2
     ORDER BY conversation_message_id ASC NULLS LAST, action_item_id ASC NULLS LAST`,
    [draftId, revisionNumber],
  );
  return result.rows.map((row) => row.conversation_message_id !== null
    ? { type: "conversation_message", id: row.conversation_message_id }
    : {
        type: "action_item",
        id: requireDatabaseString(row.action_item_id),
        entityVersion: Number(requireDatabaseValue(row.action_item_version)),
      });
}

function mapPolicy(row: PolicyRow): FeishuTaskTargetPolicy {
  return {
    id: row.id,
    sourceGroupId: row.source_group_id,
    displayName: row.display_name,
    allowedAssigneeOpenIds: [...row.allowed_assignee_open_ids],
    maxDueHorizonDays: Number(row.max_due_horizon_days),
    enabled: row.enabled,
    version: Number(row.version),
    createdAt: requireDatabaseDate(row.created_at),
    updatedAt: requireDatabaseDate(row.updated_at),
  };
}

function mapEvent(row: EventRow): FormalTaskDraftEvent {
  return {
    id: row.id,
    draftId: row.draft_id,
    eventType: row.event_type,
    ...(row.from_version === null ? {} : { fromVersion: Number(row.from_version) }),
    toVersion: Number(row.to_version),
    operationKey: row.operation_key,
    actor: row.actor,
    ...(row.reason === null ? {} : { reason: row.reason }),
    revisionNumber: Number(row.revision_number),
    createdAt: requireDatabaseDate(row.created_at),
  };
}

function policySelect(): string {
  return `SELECT id, source_group_id, display_name, allowed_assignee_open_ids,
                 max_due_horizon_days, enabled, version, created_at, updated_at
          FROM feishu_task_target_policies`;
}

function draftRevisionSelect(): string {
  return `SELECT draft.id, draft.source_group_id, draft.status,
                 draft.current_revision_number, draft.version, draft.created_by,
                 draft.current_task_spec_hash, draft.rejected_at, draft.rejected_by,
                 draft.rejection_reason, draft.created_at, draft.updated_at,
                 revision.title, revision.description, revision.assignee_open_id,
                 revision.due_at, revision.reminder_minutes, revision.risk_level,
                 revision.target_policy_id, revision.target_policy_version,
                 revision.task_spec_hash, revision.author AS revision_author,
                 revision.created_at AS revision_created_at
          FROM formal_task_drafts draft
          JOIN formal_task_draft_revisions revision
            ON revision.draft_id = draft.id
           AND revision.revision_number = draft.current_revision_number`;
}

function normalizePolicyInput(input: UpsertFeishuTaskTargetPolicyInput) {
  return {
    id: requireReference("id", input.id),
    sourceGroupId: requireReference("sourceGroupId", input.sourceGroupId),
    displayName: requireBoundedText("displayName", input.displayName, 256),
    allowedAssigneeOpenIds: normalizeReferenceList(
      "allowedAssigneeOpenIds",
      input.allowedAssigneeOpenIds,
      100,
    ),
    maxDueHorizonDays: requireIntegerBetween(
      "maxDueHorizonDays",
      input.maxDueHorizonDays,
      1,
      365,
    ),
    enabled: requireBoolean("enabled", input.enabled),
    expectedVersion: requireIntegerBetween("expectedVersion", input.expectedVersion, 0),
    operationKey: requireReference("operationKey", input.operationKey),
    operator: requireReference("operator", input.operator),
    at: requireDate(input.at),
  };
}

function normalizeRevision(input: FormalTaskDraftRevisionInput): NormalizedRevision {
  const taskSpec = normalizeFormalTaskSpec(input.taskSpec);
  const riskLevel = input.riskLevel;
  if (!FORMAL_TASK_RISK_LEVELS.includes(riskLevel)) throw new Error("riskLevel is invalid");
  const evidence = normalizeEvidence(input.evidence);
  return {
    taskSpec,
    taskSpecHash: canonicalFormalTaskSpecHash(taskSpec),
    riskLevel,
    author: requireReference("author", input.author),
    evidence,
  };
}

function normalizeEvidence(value: unknown): FormalTaskEvidenceReference[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new Error("evidence is invalid");
  }
  const result = value.map((reference): FormalTaskEvidenceReference => {
    if (typeof reference !== "object" || reference === null || Array.isArray(reference)) {
      throw new Error("evidence is invalid");
    }
    const item = reference as Record<string, unknown>;
    const id = requireReference("evidence.id", item.id);
    if (item.type === "conversation_message" && item.entityVersion === undefined) {
      return { type: "conversation_message", id };
    }
    if (item.type === "action_item") {
      return {
        type: "action_item",
        id,
        entityVersion: requireIntegerBetween("entityVersion", item.entityVersion, 1),
      };
    }
    throw new Error("evidence is invalid");
  });
  result.sort((left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id));
  const keys = result.map((reference) => reference.type === "conversation_message"
    ? `${reference.type}:${reference.id}`
    : `${reference.type}:${reference.id}:${reference.entityVersion}`);
  if (new Set(keys).size !== keys.length) throw new Error("evidence is invalid");
  return result;
}

async function lockOperation(
  queryable: KnowledgeDraftEvidenceQueryable,
  operationKey: string,
): Promise<void> {
  await queryable.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [operationKey]);
}

async function lockAndFindReplay(
  queryable: KnowledgeDraftEvidenceQueryable,
  operationKey: string,
  operationFingerprintValue: string,
): Promise<EventRow | undefined> {
  await lockOperation(queryable, operationKey);
  const replay = await queryable.query<EventRow>(
    `SELECT id, draft_id, event_type, from_version, to_version, operation_key,
            operation_fingerprint, actor, reason, revision_number, created_at
     FROM formal_task_draft_events WHERE operation_key = $1`,
    [operationKey],
  );
  if (
    replay.rows[0] !== undefined &&
    replay.rows[0].operation_fingerprint !== operationFingerprintValue
  ) throw new FormalTaskOperationConflictError();
  return replay.rows[0];
}

async function lockDraft(
  queryable: KnowledgeDraftEvidenceQueryable,
  id: string,
): Promise<DraftHeaderRow> {
  const result = await queryable.query<DraftHeaderRow>(
    `SELECT id, source_group_id, status, current_revision_number, version,
            current_task_spec_hash
     FROM formal_task_drafts WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (result.rows[0] === undefined) throw new FormalTaskNotFoundError();
  return result.rows[0];
}

async function withTransaction<T>(
  dataSource: PostgresFormalTaskDataSource,
  operation: (client: FormalTaskTransactionClient) => Promise<T>,
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

function operationFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item))
    .digest("hex");
}

function normalizeMutationBase(input: ReviseFormalTaskDraftInput) {
  return {
    id: requireReference("id", input.id),
    expectedVersion: requireIntegerBetween("expectedVersion", input.expectedVersion, 1),
    operationKey: requireReference("operationKey", input.operationKey),
    actor: requireReference("actor", input.actor),
    at: requireDate(input.at),
  };
}

function normalizeTransitionInput(
  input: TransitionFormalTaskDraftInput | DisposeFormalTaskDraftInput,
  eventType: "group_confirmed" | "revision_requested" | "rejected" | "task_created",
) {
  const reason = "reason" in input
    ? requireBoundedText("reason", input.reason, 2000)
    : undefined;
  if ((eventType === "revision_requested" || eventType === "rejected") !==
    (reason !== undefined)) throw new Error("reason is invalid");
  return {
    id: requireReference("id", input.id),
    expectedVersion: requireIntegerBetween("expectedVersion", input.expectedVersion, 1),
    expectedRevision: requireIntegerBetween("expectedRevision", input.expectedRevision, 1),
    expectedTaskSpecHash: requireHash("expectedTaskSpecHash", input.expectedTaskSpecHash),
    operationKey: requireReference("operationKey", input.operationKey),
    actor: requireReference("actor", input.actor),
    ...(reason === undefined ? {} : { reason }),
    at: requireDate(input.at),
  };
}

function requireExpectedVersion(row: DraftHeaderRow, expectedVersion: number): void {
  if (Number(row.version) !== expectedVersion) throw new FormalTaskVersionConflictError();
}

function requireHash(name: string, value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function normalizeReferenceList(name: string, value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    throw new Error(`${name} is invalid`);
  }
  const normalized = value.map((item) => requireReference(name, item)).sort();
  if (new Set(normalized).size !== normalized.length) throw new Error(`${name} is invalid`);
  return normalized;
}

function normalizeFilter<T extends string>(
  name: string,
  value: readonly T[] | undefined,
  allowed: readonly T[],
): T[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > allowed.length ||
    new Set(value).size !== value.length ||
    value.some((item) => !allowed.includes(item))
  ) throw new Error(`${name} is invalid`);
  return [...value];
}

function requireReference(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (
    [...normalized].length < 1 ||
    [...normalized].length > 512 ||
    /[\u0000-\u001f\u007f\s]/u.test(normalized)
  ) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireBoundedText(name: string, value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (
    [...normalized].length < 1 ||
    [...normalized].length > max ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireIntegerBetween(name: string, value: unknown, min: number, max = Infinity): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} is invalid`);
  }
  return Number(value);
}

function requireLimit(value: unknown): number {
  return requireIntegerBetween("limit", value, 1, 100);
}

function requireBoolean(name: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("date is invalid");
  return new Date(value);
}

function requireDatabaseDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("formal task database date is invalid");
  }
  return new Date(value);
}

function requireDatabaseString(value: unknown): string {
  if (typeof value !== "string" || value.length < 1) {
    throw new Error("formal task database value is invalid");
  }
  return value;
}

function requireDatabaseValue<T>(value: T | null): T {
  if (value === null) throw new Error("formal task database value is invalid");
  return value;
}
