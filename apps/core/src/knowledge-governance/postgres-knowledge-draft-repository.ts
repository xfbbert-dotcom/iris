import { createHash, randomUUID } from "node:crypto";

import {
  KNOWLEDGE_DRAFT_ORIGIN_KINDS,
  KNOWLEDGE_DRAFT_REASON_MAX_CHARS,
  KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS,
  KNOWLEDGE_DRAFT_RISK_LEVELS,
  KNOWLEDGE_DRAFT_STATUSES,
  normalizeKnowledgeDraftRevisionInput,
  type KnowledgeDraftEvidenceReference,
  type KnowledgeDraftOriginKind,
  type KnowledgeDraftRiskLevel,
  type KnowledgeDraftStatus,
} from "./knowledge-draft.js";
import {
  findInvalidKnowledgeDraftEvidence,
  KnowledgeDraftEvidenceError,
  type KnowledgeDraftEvidenceQueryable,
  validateCurrentKnowledgeDraftEvidence,
} from "./postgres-knowledge-draft-evidence.js";
import {
  type CreateKnowledgeDraftInput,
  type KnowledgeDraft,
  type KnowledgeDraftEvent,
  type KnowledgeDraftMutationResult,
  type KnowledgeDraftRepository,
  type KnowledgeDraftRevisionView,
  type KnowledgeDraftStatusCounts,
  type ReviseKnowledgeDraftInput,
  type TransitionKnowledgeDraftInput,
} from "./knowledge-draft-repository.js";
import {
  initialKnowledgeDraftStatus,
  validateKnowledgeDraftTransition,
} from "./knowledge-draft-state-machine.js";

export { KnowledgeDraftEvidenceError } from "./postgres-knowledge-draft-evidence.js";

export type KnowledgeDraftTransactionClient = KnowledgeDraftEvidenceQueryable & { release(): void };
export type PostgresKnowledgeDraftDataSource = KnowledgeDraftEvidenceQueryable & {
  connect(): Promise<KnowledgeDraftTransactionClient>;
};

type DraftRevisionRow = {
  id: string;
  source_group_id: string | null;
  origin_kind: KnowledgeDraftOriginKind;
  status: KnowledgeDraftStatus;
  current_revision_number: string | number;
  version: string | number;
  created_by: string;
  rejected_at: Date | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  created_at: Date;
  updated_at: Date;
  title: string;
  content: string;
  risk_level: KnowledgeDraftRiskLevel;
  reviewer_type: "feishu_user" | "text_label" | "admin_role" | null;
  reviewer_ref: string | null;
  suggested_space_id: string | null;
  suggested_parent_node_token: string | null;
  revision_author: string;
  revision_created_at: Date;
};

type DraftHeaderRow = Pick<
  DraftRevisionRow,
  "id" | "source_group_id" | "status" | "current_revision_number" | "version"
>;

type EvidenceRow = {
  evidence_type: "conversation_message" | "discussion_thread" | "action_item" | "document_source";
  reference_id: string;
  source_group_id: string | null;
  entity_version: string | number | null;
  source_updated_at: Date | null;
};

type EventRow = {
  id: string;
  draft_id: string;
  event_type: "created" | "revised" | "revision_requested" | "rejected";
  from_version: string | number | null;
  to_version: string | number;
  operation_key: string;
  operation_fingerprint: string;
  actor: string;
  reason: string | null;
  revision_number: string | number;
  created_at: Date;
};

type CountRow = { status: KnowledgeDraftStatus; count: string | number };

export class KnowledgeDraftVersionConflictError extends Error {
  constructor() {
    super("knowledge draft version conflict");
    this.name = "KnowledgeDraftVersionConflictError";
  }
}

export class KnowledgeDraftOperationConflictError extends Error {
  constructor() {
    super("knowledge draft operation conflict");
    this.name = "KnowledgeDraftOperationConflictError";
  }
}

export class KnowledgeDraftNotFoundError extends Error {
  constructor() {
    super("knowledge draft not found");
    this.name = "KnowledgeDraftNotFoundError";
  }
}

export class KnowledgeDraftTransitionError extends Error {
  constructor() {
    super("knowledge draft transition is invalid");
    this.name = "KnowledgeDraftTransitionError";
  }
}

export function createPostgresKnowledgeDraftRepository({
  dataSource,
}: {
  dataSource: PostgresKnowledgeDraftDataSource;
}): KnowledgeDraftRepository {
  return {
    createDraft(input) {
      return createDraft(dataSource, input);
    },
    reviseDraft(input) {
      return reviseDraft(dataSource, input);
    },
    requestRevision(input) {
      return transitionDraft(dataSource, input, "revision_requested");
    },
    rejectDraft(input) {
      return transitionDraft(dataSource, input, "rejected");
    },
    getDraft(id) {
      return loadDraft(dataSource, requireReference("id", id));
    },
    async listDrafts(input) {
      const sourceGroupId = normalizeOptionalReference("sourceGroupId", input.sourceGroupId);
      const statuses = normalizeFilter("statuses", input.statuses, KNOWLEDGE_DRAFT_STATUSES);
      const riskLevels = normalizeFilter("riskLevels", input.riskLevels, KNOWLEDGE_DRAFT_RISK_LEVELS);
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
      return await Promise.all(result.rows.map((row) => mapDraft(dataSource, row)));
    },
    async listEvents(id) {
      const result = await dataSource.query<EventRow>(
        `SELECT * FROM knowledge_draft_events
         WHERE draft_id = $1 ORDER BY created_at ASC, id ASC`,
        [requireReference("id", id)],
      );
      return result.rows.map(mapEvent);
    },
    async getStatusCounts() {
      const result = await dataSource.query<CountRow>(
        "SELECT status, count(*) AS count FROM knowledge_drafts GROUP BY status",
      );
      const counts = Object.fromEntries(
        KNOWLEDGE_DRAFT_STATUSES.map((status) => [status, 0]),
      ) as KnowledgeDraftStatusCounts;
      for (const row of result.rows) counts[row.status] = Number(row.count);
      return counts;
    },
  };
}

async function createDraft(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: CreateKnowledgeDraftInput,
): Promise<KnowledgeDraftMutationResult> {
  const id = requireReference("id", input.id);
  const operationKey = requireReference("operationKey", input.operationKey);
  const createdBy = requireReference("createdBy", input.createdBy);
  const at = requireDate(input.at);
  const originKind = requireOriginKind(input.originKind);
  const revision = normalizeKnowledgeDraftRevisionInput(input.revision);
  const fingerprint = operationFingerprint({
    operation: "create",
    id,
    operationKey,
    originKind,
    createdBy,
    at,
    revision,
  });

  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, operationKey);
    const replay = await replayOperation(client, operationKey, fingerprint);
    if (replay !== undefined) return replay;
    const existing = await client.query("SELECT 1 FROM knowledge_drafts WHERE id = $1", [id]);
    if (existing.rows.length > 0) throw new KnowledgeDraftOperationConflictError();
    await validateCurrentKnowledgeDraftEvidence({
      queryable: client,
      sourceGroupId: revision.sourceGroupId,
      evidence: revision.evidence,
    });
    const status = initialKnowledgeDraftStatus({ sourceGroupId: revision.sourceGroupId });
    await client.query(
      `INSERT INTO knowledge_drafts (
        id, source_group_id, origin_kind, status, current_revision_number,
        version, created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 1, 1, $5, $6, $6)`,
      [id, revision.sourceGroupId ?? null, originKind, status, createdBy, at],
    );
    await insertRevision(client, id, 1, createdBy, at, revision);
    await insertEvent(client, {
      draftId: id,
      eventType: "created",
      toVersion: 1,
      operationKey,
      fingerprint,
      actor: createdBy,
      revisionNumber: 1,
      at,
    });
    return { outcome: "applied", draft: await requireDraft(client, id) };
  });
}

async function reviseDraft(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: ReviseKnowledgeDraftInput,
): Promise<KnowledgeDraftMutationResult> {
  const normalized = normalizeMutationBase(input);
  const revision = normalizeKnowledgeDraftRevisionInput(input.revision);
  const fingerprint = operationFingerprint({
    operation: "revise",
    ...normalized,
    revision,
  });

  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await replayOperation(client, normalized.operationKey, fingerprint);
    if (replay !== undefined) return replay;
    const header = await lockDraft(client, normalized.id);
    requireExpectedVersion(header, normalized.expectedVersion);
    const sourceGroupId = header.source_group_id ?? undefined;
    if (revision.sourceGroupId !== sourceGroupId) {
      throw new KnowledgeDraftEvidenceError("group_scope_mismatch");
    }
    const toStatus = initialKnowledgeDraftStatus({ sourceGroupId });
    requireTransition({
      from: header.status,
      to: toStatus,
      eventType: "revised",
      sourceGroupId,
    });
    await validateCurrentKnowledgeDraftEvidence({
      queryable: client,
      sourceGroupId,
      evidence: revision.evidence,
    });
    const revisionNumber = Number(header.current_revision_number) + 1;
    const toVersion = normalized.expectedVersion + 1;
    await insertRevision(client, normalized.id, revisionNumber, normalized.actor, normalized.at, revision);
    await client.query(
      `UPDATE knowledge_drafts
       SET status = $2, current_revision_number = $3, version = $4, updated_at = $5
       WHERE id = $1 AND version = $6`,
      [normalized.id, toStatus, revisionNumber, toVersion, normalized.at, normalized.expectedVersion],
    );
    await insertEvent(client, {
      draftId: normalized.id,
      eventType: "revised",
      fromVersion: normalized.expectedVersion,
      toVersion,
      operationKey: normalized.operationKey,
      fingerprint,
      actor: normalized.actor,
      revisionNumber,
      at: normalized.at,
    });
    return { outcome: "applied", draft: await requireDraft(client, normalized.id) };
  });
}

async function transitionDraft(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: TransitionKnowledgeDraftInput,
  eventType: "revision_requested" | "rejected",
): Promise<KnowledgeDraftMutationResult> {
  const normalized = normalizeTransitionInput(input);
  const fingerprint = operationFingerprint({ operation: eventType, ...normalized });
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await replayOperation(client, normalized.operationKey, fingerprint);
    if (replay !== undefined) return replay;
    const header = await lockDraft(client, normalized.id);
    requireExpectedVersion(header, normalized.expectedVersion);
    const toStatus = eventType === "revision_requested" ? "needs_revision" : "rejected";
    requireTransition({
      from: header.status,
      to: toStatus,
      eventType,
      sourceGroupId: header.source_group_id ?? undefined,
    });
    const toVersion = normalized.expectedVersion + 1;
    if (eventType === "rejected") {
      await client.query(
        `UPDATE knowledge_drafts
         SET status = 'rejected', version = $2, rejected_at = $3,
             rejected_by = $4, rejection_reason = $5, updated_at = $3
         WHERE id = $1 AND version = $6`,
        [
          normalized.id,
          toVersion,
          normalized.at,
          normalized.actor,
          normalized.reason,
          normalized.expectedVersion,
        ],
      );
    } else {
      await client.query(
        `UPDATE knowledge_drafts
         SET status = 'needs_revision', version = $2, updated_at = $3
         WHERE id = $1 AND version = $4`,
        [normalized.id, toVersion, normalized.at, normalized.expectedVersion],
      );
    }
    await insertEvent(client, {
      draftId: normalized.id,
      eventType,
      fromVersion: normalized.expectedVersion,
      toVersion,
      operationKey: normalized.operationKey,
      fingerprint,
      actor: normalized.actor,
      reason: normalized.reason,
      revisionNumber: Number(header.current_revision_number),
      at: normalized.at,
    });
    return { outcome: "applied", draft: await requireDraft(client, normalized.id) };
  });
}

async function insertRevision(
  client: KnowledgeDraftEvidenceQueryable,
  draftId: string,
  revisionNumber: number,
  author: string,
  at: Date,
  revision: ReturnType<typeof normalizeKnowledgeDraftRevisionInput>,
): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_draft_revisions (
      draft_id, revision_number, title, content, risk_level,
      reviewer_type, reviewer_ref, suggested_space_id,
      suggested_parent_node_token, author, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      draftId,
      revisionNumber,
      revision.title,
      revision.content,
      revision.riskLevel,
      revision.reviewer?.type ?? null,
      revision.reviewer?.ref ?? null,
      revision.suggestedPublication?.spaceId ?? null,
      revision.suggestedPublication?.parentNodeToken ?? null,
      author,
      at,
    ],
  );
  for (const evidence of revision.evidence) {
    await client.query(
      `INSERT INTO knowledge_draft_revision_evidence (
        draft_id, revision_number, evidence_type, reference_id,
        source_group_id, entity_version, source_updated_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        draftId,
        revisionNumber,
        evidence.type,
        evidence.id,
        "groupId" in evidence ? evidence.groupId : null,
        "entityVersion" in evidence ? evidence.entityVersion : null,
        "expectedUpdatedAt" in evidence ? evidence.expectedUpdatedAt : null,
        at,
      ],
    );
  }
}

async function insertEvent(
  client: KnowledgeDraftEvidenceQueryable,
  input: {
    draftId: string;
    eventType: "created" | "revised" | "revision_requested" | "rejected";
    fromVersion?: number;
    toVersion: number;
    operationKey: string;
    fingerprint: string;
    actor: string;
    reason?: string;
    revisionNumber: number;
    at: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_draft_events (
      id, draft_id, event_type, from_version, to_version, operation_key,
      operation_fingerprint, actor, reason, revision_number, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      randomUUID(),
      input.draftId,
      input.eventType,
      input.fromVersion ?? null,
      input.toVersion,
      input.operationKey,
      input.fingerprint,
      input.actor,
      input.reason ?? null,
      input.revisionNumber,
      input.at,
    ],
  );
}

async function replayOperation(
  client: KnowledgeDraftEvidenceQueryable,
  operationKey: string,
  fingerprint: string,
): Promise<KnowledgeDraftMutationResult | undefined> {
  const result = await client.query<Pick<EventRow, "draft_id" | "operation_fingerprint">>(
    "SELECT draft_id, operation_fingerprint FROM knowledge_draft_events WHERE operation_key = $1",
    [operationKey],
  );
  const event = result.rows[0];
  if (event === undefined) return undefined;
  if (event.operation_fingerprint !== fingerprint) throw new KnowledgeDraftOperationConflictError();
  return { outcome: "already_applied", draft: await requireDraft(client, event.draft_id) };
}

async function lockOperation(
  client: KnowledgeDraftEvidenceQueryable,
  operationKey: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [operationKey]);
}

async function lockDraft(
  client: KnowledgeDraftEvidenceQueryable,
  id: string,
): Promise<DraftHeaderRow> {
  const result = await client.query<DraftHeaderRow>(
    `SELECT id, source_group_id, status, current_revision_number, version
     FROM knowledge_drafts WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new KnowledgeDraftNotFoundError();
  return row;
}

async function loadDraft(
  queryable: KnowledgeDraftEvidenceQueryable,
  id: string,
): Promise<KnowledgeDraft | undefined> {
  const result = await queryable.query<DraftRevisionRow>(
    `${draftRevisionSelect()} WHERE draft.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : await mapDraft(queryable, row);
}

async function requireDraft(
  queryable: KnowledgeDraftEvidenceQueryable,
  id: string,
): Promise<KnowledgeDraft> {
  const draft = await loadDraft(queryable, id);
  if (draft === undefined) throw new KnowledgeDraftNotFoundError();
  return draft;
}

function draftRevisionSelect(): string {
  return `
    SELECT
      draft.*,
      revision.title,
      revision.content,
      revision.risk_level,
      revision.reviewer_type,
      revision.reviewer_ref,
      revision.suggested_space_id,
      revision.suggested_parent_node_token,
      revision.author AS revision_author,
      revision.created_at AS revision_created_at
    FROM knowledge_drafts draft
    JOIN knowledge_draft_revisions revision
      ON revision.draft_id = draft.id
      AND revision.revision_number = draft.current_revision_number
  `;
}

async function mapDraft(
  queryable: KnowledgeDraftEvidenceQueryable,
  row: DraftRevisionRow,
): Promise<KnowledgeDraft> {
  const revisionNumber = Number(row.current_revision_number);
  const evidence = await loadEvidence(queryable, row.id, revisionNumber);
  const invalidReason = await findInvalidKnowledgeDraftEvidence({
    queryable,
    sourceGroupId: row.source_group_id ?? undefined,
    evidence,
  });
  const revisionBase = {
    revisionNumber,
    riskLevel: row.risk_level,
    author: row.revision_author,
    createdAt: requireDate(row.revision_created_at),
  };
  const currentRevision: KnowledgeDraftRevisionView = invalidReason === undefined
    ? {
        ...revisionBase,
        evidenceState: { status: "current" },
        title: row.title,
        content: row.content,
        ...(row.reviewer_type === null || row.reviewer_ref === null
          ? {}
          : { reviewer: { type: row.reviewer_type, ref: row.reviewer_ref } }),
        ...(row.suggested_space_id === null && row.suggested_parent_node_token === null
          ? {}
          : {
              suggestedPublication: {
                ...(row.suggested_space_id === null ? {} : { spaceId: row.suggested_space_id }),
                ...(row.suggested_parent_node_token === null
                  ? {}
                  : { parentNodeToken: row.suggested_parent_node_token }),
              },
            }),
        evidence,
      }
    : { ...revisionBase, evidenceState: { status: "invalidated", reason: invalidReason } };
  return {
    id: row.id,
    ...(row.source_group_id === null ? {} : { sourceGroupId: row.source_group_id }),
    originKind: row.origin_kind,
    status: row.status,
    currentRevisionNumber: revisionNumber,
    version: Number(row.version),
    createdBy: row.created_by,
    ...(row.rejected_at === null ? {} : { rejectedAt: requireDate(row.rejected_at) }),
    ...(row.rejected_by === null ? {} : { rejectedBy: row.rejected_by }),
    ...(row.rejection_reason === null ? {} : { rejectionReason: row.rejection_reason }),
    createdAt: requireDate(row.created_at),
    updatedAt: requireDate(row.updated_at),
    currentRevision,
  };
}

async function loadEvidence(
  queryable: KnowledgeDraftEvidenceQueryable,
  draftId: string,
  revisionNumber: number,
): Promise<KnowledgeDraftEvidenceReference[]> {
  const result = await queryable.query<EvidenceRow>(
    `SELECT evidence_type, reference_id, source_group_id, entity_version, source_updated_at
     FROM knowledge_draft_revision_evidence
     WHERE draft_id = $1 AND revision_number = $2
     ORDER BY evidence_type ASC, reference_id ASC`,
    [draftId, revisionNumber],
  );
  return result.rows.map((row) => {
    if (row.evidence_type === "conversation_message") {
      return {
        type: "conversation_message",
        id: row.reference_id,
        groupId: requireDatabaseValue(row.source_group_id),
      };
    }
    if (row.evidence_type === "discussion_thread" || row.evidence_type === "action_item") {
      return {
        type: row.evidence_type,
        id: row.reference_id,
        groupId: requireDatabaseValue(row.source_group_id),
        entityVersion: Number(requireDatabaseValue(row.entity_version)),
      };
    }
    return {
      type: "document_source",
      id: row.reference_id,
      expectedUpdatedAt: requireDate(requireDatabaseValue(row.source_updated_at)),
    };
  });
}

function mapEvent(row: EventRow): KnowledgeDraftEvent {
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

function normalizeMutationBase(input: ReviseKnowledgeDraftInput) {
  return {
    id: requireReference("id", input.id),
    expectedVersion: requireVersion(input.expectedVersion),
    operationKey: requireReference("operationKey", input.operationKey),
    actor: requireReference("actor", input.actor),
    at: requireDate(input.at),
  };
}

function normalizeTransitionInput(input: TransitionKnowledgeDraftInput) {
  return {
    id: requireReference("id", input.id),
    expectedVersion: requireVersion(input.expectedVersion),
    operationKey: requireReference("operationKey", input.operationKey),
    actor: requireReference("actor", input.actor),
    reason: requireString("reason", input.reason, KNOWLEDGE_DRAFT_REASON_MAX_CHARS),
    at: requireDate(input.at),
  };
}

function requireExpectedVersion(row: DraftHeaderRow, expectedVersion: number): void {
  if (Number(row.version) !== expectedVersion) throw new KnowledgeDraftVersionConflictError();
}

function requireTransition(input: Parameters<typeof validateKnowledgeDraftTransition>[0]): void {
  if (!validateKnowledgeDraftTransition(input).ok) throw new KnowledgeDraftTransitionError();
}

function requireOriginKind(value: unknown): KnowledgeDraftOriginKind {
  if (!KNOWLEDGE_DRAFT_ORIGIN_KINDS.includes(value as KnowledgeDraftOriginKind)) {
    throw new Error("originKind is invalid");
  }
  return value as KnowledgeDraftOriginKind;
}

function requireVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("expectedVersion is invalid");
  return Number(value);
}

function requireLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 100) {
    throw new Error("limit is invalid");
  }
  return Number(value);
}

function requireReference(name: string, value: unknown): string {
  return requireString(name, value, KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS);
}

function normalizeOptionalReference(name: string, value: unknown): string | undefined {
  return value === undefined ? undefined : requireReference(name, value);
}

function requireString(name: string, value: unknown, maxChars: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxChars) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("date is invalid");
  return new Date(value);
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

function operationFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item))
    .digest("hex");
}

function requireDatabaseValue<T>(value: T | null): T {
  if (value === null) throw new Error("knowledge draft database row is invalid");
  return value;
}
