import { createHash, randomUUID } from "node:crypto";

import {
  DocumentSourceGroupGrantConflictError,
  DocumentSourceGroupGrantNotFoundError,
  DocumentSourceGroupGrantValidationError,
  type DocumentSourceGroupGrant,
  type DocumentSourceGroupGrantMutationResult,
  type DocumentSourceGroupGrantRepository,
  type DocumentSourceGroupGrantState,
} from "./document-source-group-grant.js";

export {
  DocumentSourceGroupGrantConflictError,
  DocumentSourceGroupGrantNotFoundError,
  DocumentSourceGroupGrantValidationError,
} from "./document-source-group-grant.js";

export type PostgresDocumentSourceGroupGrantQueryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export type PostgresDocumentSourceGroupGrantTransactionClient =
  PostgresDocumentSourceGroupGrantQueryable & { release(): void };

export type PostgresDocumentSourceGroupGrantDataSource =
  PostgresDocumentSourceGroupGrantQueryable & {
    connect(): Promise<PostgresDocumentSourceGroupGrantTransactionClient>;
  };

type GrantRow = {
  id: string;
  document_source_id: string;
  grantor_group_id: string;
  grantee_group_id: string;
  state: DocumentSourceGroupGrantState;
  version: string | number;
  created_by: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type GrantEventRow = {
  grant_id: string;
  event_type: "granted" | "revoked";
  operation_fingerprint: string;
};

type NormalizedGrantInput = {
  documentSourceId: string;
  grantorGroupId: string;
  granteeGroupId: string;
  expectedVersion: number;
  operationKey: string;
  actorRef: string;
  at: Date;
};

type NormalizedRevokeInput = {
  grantId: string;
  expectedVersion: number;
  operationKey: string;
  actorRef: string;
  at: Date;
};

const MAX_REFERENCE_CHARS = 512;

export function createPostgresDocumentSourceGroupGrantRepository({
  dataSource,
  createId = randomUUID,
}: {
  dataSource: PostgresDocumentSourceGroupGrantDataSource;
  createId?: () => string;
}): DocumentSourceGroupGrantRepository {
  return {
    grant: async (input) => grant(dataSource, createId, normalizeGrantInput(input)),
    revoke: async (input) => revoke(dataSource, createId, normalizeRevokeInput(input)),
    findActiveForSourceAndGrantee: async (input) => findActiveForSourceAndGrantee(dataSource, {
      documentSourceId: requireReference("documentSourceId", input.documentSourceId),
      granteeGroupId: requireReference("granteeGroupId", input.granteeGroupId),
    }),
    listForSource: async (input) => listForSource(dataSource, {
      documentSourceId: requireReference("documentSourceId", input.documentSourceId),
      limit: requireListLimit(input.limit),
    }),
    findById: async (grantId) => findById(dataSource, requireReference("grantId", grantId)),
    validateExact: async (input) => validateExact(dataSource, {
      grantId: requireReference("grantId", input.grantId),
      version: requirePositiveVersion("version", input.version),
      documentSourceId: requireReference("documentSourceId", input.documentSourceId),
      grantorGroupId: requireReference("grantorGroupId", input.grantorGroupId),
      granteeGroupId: requireReference("granteeGroupId", input.granteeGroupId),
    }),
  };
}

async function grant(
  dataSource: PostgresDocumentSourceGroupGrantDataSource,
  createId: () => string,
  input: NormalizedGrantInput,
): Promise<DocumentSourceGroupGrantMutationResult> {
  const fingerprint = operationFingerprint("grant", {
    documentSourceId: input.documentSourceId,
    grantorGroupId: input.grantorGroupId,
    granteeGroupId: input.granteeGroupId,
    expectedVersion: input.expectedVersion,
    actorRef: input.actorRef,
  });
  return withTransaction(dataSource, async (client) => {
    await lockOperationKey(client, input.operationKey);
    const replay = await loadOperation(client, input.operationKey);
    if (replay !== undefined) {
      return replayOperation(client, replay, "granted", fingerprint);
    }

    const source = await lockSource(client, input.documentSourceId);
    if (source.source_type !== "group_visible_document") {
      throw new DocumentSourceGroupGrantConflictError(
        "only group-visible document sources can be granted",
      );
    }
    await requireGrantorEvidence(client, input.documentSourceId, input.grantorGroupId);
    const existing = await lockGrantForSourceAndGrantee(
      client,
      input.documentSourceId,
      input.granteeGroupId,
    );
    if (existing === undefined) {
      if (input.expectedVersion !== 0) throw new DocumentSourceGroupGrantConflictError();
      const grantId = requireReference("grant id", createId());
      const inserted = await client.query<GrantRow>(
        `INSERT INTO document_source_group_grants (
           id, document_source_id, grantor_group_id, grantee_group_id,
           state, version, created_by, updated_by, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'active', 1, $5, $5, $6, $6)
         RETURNING *`,
        [
          grantId,
          input.documentSourceId,
          input.grantorGroupId,
          input.granteeGroupId,
          input.actorRef,
          input.at,
        ],
      );
      const row = requireGrantRow(inserted.rows[0]);
      await insertEvent(client, createId, {
        grantId: row.id,
        eventType: "granted",
        fromVersion: undefined,
        toVersion: 1,
        operationKey: input.operationKey,
        operationFingerprint: fingerprint,
        actorRef: input.actorRef,
        at: input.at,
      });
      return { outcome: "applied", grant: mapGrant(row) };
    }

    const version = requirePositiveVersion("grant version", existing.version);
    if (version !== input.expectedVersion || existing.state !== "revoked") {
      throw new DocumentSourceGroupGrantConflictError();
    }
    const updated = await client.query<GrantRow>(
      `UPDATE document_source_group_grants
       SET grantor_group_id = $2, state = 'active', version = version + 1,
           updated_by = $3, updated_at = $4
       WHERE id = $1 AND version = $5 AND state = 'revoked'
       RETURNING *`,
      [existing.id, input.grantorGroupId, input.actorRef, input.at, input.expectedVersion],
    );
    const row = requireGrantRow(updated.rows[0]);
    await insertEvent(client, createId, {
      grantId: row.id,
      eventType: "granted",
      fromVersion: version,
      toVersion: version + 1,
      operationKey: input.operationKey,
      operationFingerprint: fingerprint,
      actorRef: input.actorRef,
      at: input.at,
    });
    return { outcome: "applied", grant: mapGrant(row) };
  });
}

async function revoke(
  dataSource: PostgresDocumentSourceGroupGrantDataSource,
  createId: () => string,
  input: NormalizedRevokeInput,
): Promise<DocumentSourceGroupGrantMutationResult> {
  const fingerprint = operationFingerprint("revoke", {
    grantId: input.grantId,
    expectedVersion: input.expectedVersion,
    actorRef: input.actorRef,
  });
  return withTransaction(dataSource, async (client) => {
    await lockOperationKey(client, input.operationKey);
    const replay = await loadOperation(client, input.operationKey);
    if (replay !== undefined) {
      return replayOperation(client, replay, "revoked", fingerprint);
    }
    const existing = await lockGrant(client, input.grantId);
    const version = requirePositiveVersion("grant version", existing.version);
    if (version !== input.expectedVersion || existing.state !== "active") {
      throw new DocumentSourceGroupGrantConflictError();
    }
    const activeAnswers = await client.query<{ id: string }>(
      `SELECT delivery.id
       FROM answer_reply_source_traces trace
       JOIN answer_reply_deliveries delivery ON delivery.id = trace.delivery_id
       WHERE trace.cross_group_grant_id = $1
         AND delivery.state IN ('sending', 'reconciliation_required')
       ORDER BY delivery.id
       FOR UPDATE OF delivery`,
      [input.grantId],
    );
    if (activeAnswers.rows.length > 0) {
      throw new DocumentSourceGroupGrantConflictError("grant has an active answer attempt");
    }
    const updated = await client.query<GrantRow>(
      `UPDATE document_source_group_grants
       SET state = 'revoked', version = version + 1, updated_by = $2, updated_at = $3
       WHERE id = $1 AND version = $4 AND state = 'active'
       RETURNING *`,
      [input.grantId, input.actorRef, input.at, input.expectedVersion],
    );
    const row = requireGrantRow(updated.rows[0]);
    await insertEvent(client, createId, {
      grantId: row.id,
      eventType: "revoked",
      fromVersion: version,
      toVersion: version + 1,
      operationKey: input.operationKey,
      operationFingerprint: fingerprint,
      actorRef: input.actorRef,
      at: input.at,
    });
    return { outcome: "applied", grant: mapGrant(row) };
  });
}

async function findActiveForSourceAndGrantee(
  queryable: PostgresDocumentSourceGroupGrantQueryable,
  input: { documentSourceId: string; granteeGroupId: string },
): Promise<DocumentSourceGroupGrant | undefined> {
  const result = await queryable.query<GrantRow>(
    `SELECT grant.*
     FROM document_source_group_grants grant
     JOIN document_sources source ON source.id = grant.document_source_id
     WHERE grant.document_source_id = $1
       AND grant.grantee_group_id = $2
       AND grant.state = 'active'
       AND source.source_type = 'group_visible_document'
       AND (
         source.origin_group_id = grant.grantor_group_id
         OR EXISTS (
           SELECT 1 FROM document_source_evidence evidence
           WHERE evidence.document_source_id = source.id
             AND evidence.kind = 'group_message'
             AND evidence.group_id = grant.grantor_group_id
         )
       )`,
    [input.documentSourceId, input.granteeGroupId],
  );
  return result.rows[0] === undefined ? undefined : mapGrant(result.rows[0]);
}

async function listForSource(
  queryable: PostgresDocumentSourceGroupGrantQueryable,
  input: { documentSourceId: string; limit: number },
): Promise<DocumentSourceGroupGrant[]> {
  if (input.limit === 0) return [];
  const result = await queryable.query<GrantRow>(
    `SELECT * FROM document_source_group_grants
     WHERE document_source_id = $1
     ORDER BY updated_at DESC, id ASC
     LIMIT $2`,
    [input.documentSourceId, input.limit],
  );
  return result.rows.map(mapGrant);
}

async function findById(
  queryable: PostgresDocumentSourceGroupGrantQueryable,
  grantId: string,
): Promise<DocumentSourceGroupGrant | undefined> {
  const result = await queryable.query<GrantRow>(
    "SELECT * FROM document_source_group_grants WHERE id = $1",
    [grantId],
  );
  return result.rows[0] === undefined ? undefined : mapGrant(result.rows[0]);
}

async function validateExact(
  queryable: PostgresDocumentSourceGroupGrantQueryable,
  input: {
    grantId: string;
    version: number;
    documentSourceId: string;
    grantorGroupId: string;
    granteeGroupId: string;
  },
): Promise<boolean> {
  const result = await queryable.query<{ valid: boolean }>(
    `SELECT TRUE AS valid
     FROM document_source_group_grants grant
     JOIN document_sources source ON source.id = grant.document_source_id
     WHERE grant.id = $1
       AND grant.version = $2
       AND grant.document_source_id = $3
       AND grant.grantor_group_id = $4
       AND grant.grantee_group_id = $5
       AND grant.state = 'active'
       AND source.source_type = 'group_visible_document'
       AND (
         source.origin_group_id = grant.grantor_group_id
         OR EXISTS (
           SELECT 1 FROM document_source_evidence evidence
           WHERE evidence.document_source_id = source.id
             AND evidence.kind = 'group_message'
             AND evidence.group_id = grant.grantor_group_id
         )
       )`,
    [
      input.grantId,
      input.version,
      input.documentSourceId,
      input.grantorGroupId,
      input.granteeGroupId,
    ],
  );
  return result.rows[0]?.valid === true;
}

async function replayOperation(
  client: PostgresDocumentSourceGroupGrantTransactionClient,
  replay: GrantEventRow,
  eventType: GrantEventRow["event_type"],
  fingerprint: string,
): Promise<DocumentSourceGroupGrantMutationResult> {
  if (replay.event_type !== eventType || replay.operation_fingerprint !== fingerprint) {
    throw new DocumentSourceGroupGrantConflictError("operation key fingerprint conflict");
  }
  const result = await client.query<GrantRow>(
    "SELECT * FROM document_source_group_grants WHERE id = $1",
    [replay.grant_id],
  );
  if (result.rows[0] === undefined) throw new DocumentSourceGroupGrantNotFoundError();
  return { outcome: "already_applied", grant: mapGrant(result.rows[0]) };
}

async function lockSource(
  client: PostgresDocumentSourceGroupGrantTransactionClient,
  documentSourceId: string,
): Promise<{ id: string; source_type: string; origin_group_id: string | null }> {
  const result = await client.query<{
    id: string;
    source_type: string;
    origin_group_id: string | null;
  }>(
    `SELECT id, source_type, origin_group_id
     FROM document_sources WHERE id = $1 FOR UPDATE`,
    [documentSourceId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new DocumentSourceGroupGrantNotFoundError("document source not found");
  return row;
}

async function requireGrantorEvidence(
  client: PostgresDocumentSourceGroupGrantTransactionClient,
  documentSourceId: string,
  grantorGroupId: string,
): Promise<void> {
  const result = await client.query<{ authorized: boolean }>(
    `SELECT (
       source.origin_group_id = $2
       OR EXISTS (
         SELECT 1 FROM document_source_evidence evidence
         WHERE evidence.document_source_id = source.id
           AND evidence.kind = 'group_message'
           AND evidence.group_id = $2
       )
     ) AS authorized
     FROM document_sources source WHERE source.id = $1`,
    [documentSourceId, grantorGroupId],
  );
  if (result.rows[0]?.authorized !== true) {
    throw new DocumentSourceGroupGrantConflictError("grantor group is not evidenced on source");
  }
}

async function lockGrantForSourceAndGrantee(
  client: PostgresDocumentSourceGroupGrantTransactionClient,
  documentSourceId: string,
  granteeGroupId: string,
): Promise<GrantRow | undefined> {
  const result = await client.query<GrantRow>(
    `SELECT * FROM document_source_group_grants
     WHERE document_source_id = $1 AND grantee_group_id = $2
     FOR UPDATE`,
    [documentSourceId, granteeGroupId],
  );
  return result.rows[0];
}

async function lockGrant(
  client: PostgresDocumentSourceGroupGrantTransactionClient,
  grantId: string,
): Promise<GrantRow> {
  const result = await client.query<GrantRow>(
    "SELECT * FROM document_source_group_grants WHERE id = $1 FOR UPDATE",
    [grantId],
  );
  if (result.rows[0] === undefined) throw new DocumentSourceGroupGrantNotFoundError();
  return result.rows[0];
}

async function loadOperation(
  client: PostgresDocumentSourceGroupGrantTransactionClient,
  operationKey: string,
): Promise<GrantEventRow | undefined> {
  const result = await client.query<GrantEventRow>(
    `SELECT grant_id, event_type, operation_fingerprint
     FROM document_source_group_grant_events WHERE operation_key = $1`,
    [operationKey],
  );
  return result.rows[0];
}

async function lockOperationKey(
  client: PostgresDocumentSourceGroupGrantTransactionClient,
  operationKey: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`document-source-group-grant:${operationKey}`],
  );
}

async function insertEvent(
  client: PostgresDocumentSourceGroupGrantTransactionClient,
  createId: () => string,
  input: {
    grantId: string;
    eventType: GrantEventRow["event_type"];
    fromVersion?: number;
    toVersion: number;
    operationKey: string;
    operationFingerprint: string;
    actorRef: string;
    at: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO document_source_group_grant_events (
       id, grant_id, event_type, from_version, to_version, operation_key,
       operation_fingerprint, actor_ref, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      requireReference("grant event id", createId()),
      input.grantId,
      input.eventType,
      input.fromVersion ?? null,
      input.toVersion,
      input.operationKey,
      input.operationFingerprint,
      input.actorRef,
      input.at,
    ],
  );
}

async function withTransaction<T>(
  dataSource: PostgresDocumentSourceGroupGrantDataSource,
  work: (client: PostgresDocumentSourceGroupGrantTransactionClient) => Promise<T>,
): Promise<T> {
  const client = await dataSource.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function normalizeGrantInput(input: {
  documentSourceId: string;
  grantorGroupId: string;
  granteeGroupId: string;
  expectedVersion: number;
  operationKey: string;
  actorRef: string;
  at: Date;
}): NormalizedGrantInput {
  const grantorGroupId = requireReference("grantorGroupId", input.grantorGroupId);
  const granteeGroupId = requireReference("granteeGroupId", input.granteeGroupId);
  if (grantorGroupId === granteeGroupId) {
    throw new DocumentSourceGroupGrantValidationError("grantor and grantee groups must be distinct");
  }
  return {
    documentSourceId: requireReference("documentSourceId", input.documentSourceId),
    grantorGroupId,
    granteeGroupId,
    expectedVersion: requireNonNegativeVersion("expectedVersion", input.expectedVersion),
    operationKey: requireReference("operationKey", input.operationKey),
    actorRef: requireReference("actorRef", input.actorRef),
    at: requireDate("at", input.at),
  };
}

function normalizeRevokeInput(input: {
  grantId: string;
  expectedVersion: number;
  operationKey: string;
  actorRef: string;
  at: Date;
}): NormalizedRevokeInput {
  return {
    grantId: requireReference("grantId", input.grantId),
    expectedVersion: requirePositiveVersion("expectedVersion", input.expectedVersion),
    operationKey: requireReference("operationKey", input.operationKey),
    actorRef: requireReference("actorRef", input.actorRef),
    at: requireDate("at", input.at),
  };
}

function mapGrant(row: GrantRow): DocumentSourceGroupGrant {
  return {
    id: requireReference("grant id", row.id),
    documentSourceId: requireReference("document source id", row.document_source_id),
    grantorGroupId: requireReference("grantor group id", row.grantor_group_id),
    granteeGroupId: requireReference("grantee group id", row.grantee_group_id),
    state: requireGrantState(row.state),
    version: requirePositiveVersion("grant version", row.version),
    createdBy: requireReference("created by", row.created_by),
    updatedBy: requireReference("updated by", row.updated_by),
    createdAt: requireDateValue("created at", row.created_at),
    updatedAt: requireDateValue("updated at", row.updated_at),
  };
}

function requireGrantRow(row: GrantRow | undefined): GrantRow {
  if (row === undefined) throw new DocumentSourceGroupGrantConflictError();
  return row;
}

function requireGrantState(value: unknown): DocumentSourceGroupGrantState {
  if (value !== "active" && value !== "revoked") {
    throw new DocumentSourceGroupGrantValidationError("invalid grant state");
  }
  return value;
}

function requireReference(name: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new DocumentSourceGroupGrantValidationError(`${name} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_REFERENCE_CHARS) {
    throw new DocumentSourceGroupGrantValidationError(
      `${name} must contain between 1 and ${MAX_REFERENCE_CHARS} characters`,
    );
  }
  return normalized;
}

function requireNonNegativeVersion(name: string, value: unknown): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new DocumentSourceGroupGrantValidationError(`${name} must be a non-negative integer`);
  }
  return numeric;
}

function requireListLimit(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 100) {
    throw new DocumentSourceGroupGrantValidationError(
      "limit must be an integer between 0 and 100",
    );
  }
  return numeric;
}

function requirePositiveVersion(name: string, value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) {
    throw new DocumentSourceGroupGrantValidationError(`${name} must be a positive integer`);
  }
  return numeric;
}

function requireDate(name: string, value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DocumentSourceGroupGrantValidationError(`${name} must be a valid date`);
  }
  return new Date(value.getTime());
}

function requireDateValue(name: string, value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new DocumentSourceGroupGrantValidationError(`${name} must be a valid date`);
  }
  return new Date(date.getTime());
}

function operationFingerprint(action: "grant" | "revoke", input: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify({ action, ...input }))
    .digest("hex");
}
