import { randomUUID } from "node:crypto";

export type WikiSpaceScanState =
  | "pending"
  | "scanning"
  | "synced"
  | "retry_wait"
  | "dead_letter"
  | "disabled";

export type WikiSpaceAuthorization = {
  id: string;
  rootSourceUri: string;
  rootNodeToken: string;
  spaceId?: string;
  title?: string;
  enabled: boolean;
  scanState: WikiSpaceScanState;
  attemptCount: number;
  nextScanAt: Date;
  leaseExpiresAt?: Date;
  lastScanStartedAt?: Date;
  lastScanCompletedAt?: Date;
  lastSuccessAt?: Date;
  lastErrorClassification?: string;
  discoveredNodeCount: number;
  registeredDocumentCount: number;
  skippedNodeCount: number;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

export type WikiSpaceAuthorizationRepository = {
  register(input: {
    rootSourceUri: string;
    rootNodeToken: string;
    at: Date;
  }): Promise<{ authorization: WikiSpaceAuthorization; created: boolean }>;
  list(input: { limit: number }): Promise<WikiSpaceAuthorization[]>;
  claimNext(input: {
    at: Date;
    leaseExpiresAt: Date;
    maxAttempts: number;
  }): Promise<WikiSpaceAuthorization | undefined>;
  complete(input: {
    id: string;
    revision: number;
    at: Date;
    nextScanAt: Date;
    spaceId: string;
    title?: string;
    discoveredNodeCount: number;
    registeredDocumentCount: number;
    skippedNodeCount: number;
  }): Promise<WikiSpaceAuthorization>;
  fail(input: {
    id: string;
    revision: number;
    at: Date;
    classification: string;
    retryAt?: Date;
  }): Promise<WikiSpaceAuthorization>;
  requestScan(input: { id: string; at: Date }): Promise<WikiSpaceAuthorization | undefined>;
  setEnabled(input: {
    id: string;
    enabled: boolean;
    at: Date;
  }): Promise<WikiSpaceAuthorization | undefined>;
  getStatusCounts(): Promise<Record<WikiSpaceScanState, number>>;
};

export type WikiSpaceAuthorizationQueryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export type WikiSpaceAuthorizationDataSource = WikiSpaceAuthorizationQueryable;

const MAX_IDENTIFIER_CHARS = 512;
const MAX_SOURCE_URI_CHARS = 2048;
const MAX_LIST_LIMIT = 100;
const MAX_ATTEMPTS = 1_000;
const scanStates: WikiSpaceScanState[] = [
  "pending",
  "scanning",
  "synced",
  "retry_wait",
  "dead_letter",
  "disabled",
];

export function createPostgresWikiSpaceAuthorizationRepository({
  dataSource,
}: {
  dataSource: WikiSpaceAuthorizationDataSource;
}): WikiSpaceAuthorizationRepository {
  return {
    register: (input) => register(dataSource, input),
    list: (input) => list(dataSource, input),
    claimNext: (input) => claimNext(dataSource, input),
    complete: (input) => complete(dataSource, input),
    fail: (input) => fail(dataSource, input),
    requestScan: (input) => requestScan(dataSource, input),
    setEnabled: (input) => setEnabled(dataSource, input),
    getStatusCounts: () => getStatusCounts(dataSource),
  };
}

async function register(
  queryable: WikiSpaceAuthorizationQueryable,
  input: { rootSourceUri: string; rootNodeToken: string; at: Date },
): Promise<{ authorization: WikiSpaceAuthorization; created: boolean }> {
  const rootSourceUri = requireString("rootSourceUri", input.rootSourceUri, MAX_SOURCE_URI_CHARS);
  const rootNodeToken = requireString("rootNodeToken", input.rootNodeToken, MAX_IDENTIFIER_CHARS);
  const at = requireDate(input.at, "at");
  const inserted = await queryable.query(
    `
    INSERT INTO wiki_space_authorizations (
      id, root_source_uri, root_node_token, enabled, scan_state, attempt_count,
      next_scan_at, discovered_node_count, registered_document_count,
      skipped_node_count, revision, created_at, updated_at
    )
    VALUES ($1, $2, $3, TRUE, 'pending', 0, $4, 0, 0, 0, 1, $4, $4)
    ON CONFLICT (root_source_uri) DO NOTHING
    RETURNING *
    `,
    [randomUUID(), rootSourceUri, rootNodeToken, at],
  );
  if (inserted.rows.length > 0) {
    return { authorization: mapRow(inserted.rows[0]), created: true };
  }
  const existing = await queryable.query(
    "SELECT * FROM wiki_space_authorizations WHERE root_source_uri = $1",
    [rootSourceUri],
  );
  const authorization = existing.rows[0];
  if (authorization === undefined) {
    throw new Error("wiki space authorization registration did not return a row");
  }
  return { authorization: mapRow(authorization), created: false };
}

async function list(
  queryable: WikiSpaceAuthorizationQueryable,
  input: { limit: number },
): Promise<WikiSpaceAuthorization[]> {
  const limit = requireLimit(input.limit, "limit", MAX_LIST_LIMIT);
  const result = await queryable.query(
    `
    SELECT *
    FROM wiki_space_authorizations
    ORDER BY updated_at DESC, id ASC
    LIMIT $1
    `,
    [limit],
  );
  return result.rows.map(mapRow);
}

async function claimNext(
  queryable: WikiSpaceAuthorizationQueryable,
  input: { at: Date; leaseExpiresAt: Date; maxAttempts: number },
): Promise<WikiSpaceAuthorization | undefined> {
  const at = requireDate(input.at, "at");
  const leaseExpiresAt = requireDate(input.leaseExpiresAt, "leaseExpiresAt");
  if (leaseExpiresAt <= at) throw new Error("leaseExpiresAt must be after at");
  const maxAttempts = requireLimit(input.maxAttempts, "maxAttempts", MAX_ATTEMPTS);
  const result = await queryable.query(
    `
    WITH candidate AS (
      SELECT id
      FROM wiki_space_authorizations
      WHERE enabled = TRUE
        AND scan_state NOT IN ('disabled', 'dead_letter')
        AND attempt_count < $3
        AND (
          (scan_state IN ('pending', 'retry_wait') AND next_scan_at <= $1)
          OR (scan_state = 'scanning' AND lease_expires_at <= $1)
        )
      ORDER BY next_scan_at ASC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE wiki_space_authorizations authorization
    SET scan_state = 'scanning',
        attempt_count = authorization.attempt_count + 1,
        lease_expires_at = $2,
        last_scan_started_at = $1,
        updated_at = $1,
        revision = authorization.revision + 1
    WHERE authorization.id = (SELECT id FROM candidate)
    RETURNING authorization.*
    `,
    [at, leaseExpiresAt, maxAttempts],
  );
  return result.rows[0] === undefined ? undefined : mapRow(result.rows[0]);
}

async function complete(
  queryable: WikiSpaceAuthorizationQueryable,
  input: {
    id: string;
    revision: number;
    at: Date;
    nextScanAt: Date;
    spaceId: string;
    title?: string;
    discoveredNodeCount: number;
    registeredDocumentCount: number;
    skippedNodeCount: number;
  },
): Promise<WikiSpaceAuthorization> {
  const id = requireString("id", input.id, MAX_IDENTIFIER_CHARS);
  const revision = requirePositiveInteger(input.revision, "revision");
  const at = requireDate(input.at, "at");
  const nextScanAt = requireDate(input.nextScanAt, "nextScanAt");
  const spaceId = requireString("spaceId", input.spaceId, MAX_IDENTIFIER_CHARS);
  const title = input.title === undefined ? undefined : requireString("title", input.title, MAX_IDENTIFIER_CHARS);
  const discoveredNodeCount = requireNonNegativeInteger(input.discoveredNodeCount, "discoveredNodeCount");
  const registeredDocumentCount = requireNonNegativeInteger(input.registeredDocumentCount, "registeredDocumentCount");
  const skippedNodeCount = requireNonNegativeInteger(input.skippedNodeCount, "skippedNodeCount");
  const result = await queryable.query(
    `
    UPDATE wiki_space_authorizations
    SET scan_state = 'synced',
        next_scan_at = $4,
        lease_expires_at = NULL,
        last_scan_completed_at = $3,
        last_success_at = $3,
        last_error_classification = NULL,
        space_id = $5,
        title = $6,
        discovered_node_count = $7,
        registered_document_count = $8,
        skipped_node_count = $9,
        updated_at = $3,
        revision = revision + 1
    WHERE id = $1
      AND revision = $2
      AND scan_state = 'scanning'
    RETURNING *
    `,
    [id, revision, at, nextScanAt, spaceId, title, discoveredNodeCount, registeredDocumentCount, skippedNodeCount],
  );
  return requireUpdatedAuthorization(result.rows[0]);
}

async function fail(
  queryable: WikiSpaceAuthorizationQueryable,
  input: { id: string; revision: number; at: Date; classification: string; retryAt?: Date },
): Promise<WikiSpaceAuthorization> {
  const id = requireString("id", input.id, MAX_IDENTIFIER_CHARS);
  const revision = requirePositiveInteger(input.revision, "revision");
  const at = requireDate(input.at, "at");
  const classification = requireString("classification", input.classification, MAX_IDENTIFIER_CHARS);
  const retryAt = input.retryAt === undefined ? undefined : requireDate(input.retryAt, "retryAt");
  const scanState: WikiSpaceScanState = retryAt === undefined ? "dead_letter" : "retry_wait";
  const nextScanAt = retryAt ?? at;
  const result = await queryable.query(
    `
    UPDATE wiki_space_authorizations
    SET scan_state = $4,
        next_scan_at = $5,
        lease_expires_at = NULL,
        last_scan_completed_at = $3,
        last_error_classification = $6,
        updated_at = $3,
        revision = revision + 1
    WHERE id = $1
      AND revision = $2
      AND scan_state = 'scanning'
    RETURNING *
    `,
    [id, revision, at, scanState, nextScanAt, classification],
  );
  return requireUpdatedAuthorization(result.rows[0]);
}

async function requestScan(
  queryable: WikiSpaceAuthorizationQueryable,
  input: { id: string; at: Date },
): Promise<WikiSpaceAuthorization | undefined> {
  const id = requireString("id", input.id, MAX_IDENTIFIER_CHARS);
  const at = requireDate(input.at, "at");
  const result = await queryable.query(
    `
    UPDATE wiki_space_authorizations
    SET scan_state = 'pending',
        next_scan_at = $2,
        lease_expires_at = NULL,
        updated_at = $2,
        revision = revision + 1
    WHERE id = $1
      AND enabled = TRUE
    RETURNING *
    `,
    [id, at],
  );
  return result.rows[0] === undefined ? undefined : mapRow(result.rows[0]);
}

async function setEnabled(
  queryable: WikiSpaceAuthorizationQueryable,
  input: { id: string; enabled: boolean; at: Date },
): Promise<WikiSpaceAuthorization | undefined> {
  const id = requireString("id", input.id, MAX_IDENTIFIER_CHARS);
  if (typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean");
  const at = requireDate(input.at, "at");
  const result = await queryable.query(
    `
    UPDATE wiki_space_authorizations
    SET enabled = $2,
        scan_state = CASE WHEN $2 THEN 'pending' ELSE 'disabled' END,
        next_scan_at = CASE WHEN $2 THEN $3 ELSE next_scan_at END,
        lease_expires_at = NULL,
        updated_at = $3,
        revision = revision + 1
    WHERE id = $1
    RETURNING *
    `,
    [id, input.enabled, at],
  );
  return result.rows[0] === undefined ? undefined : mapRow(result.rows[0]);
}

async function getStatusCounts(
  queryable: WikiSpaceAuthorizationQueryable,
): Promise<Record<WikiSpaceScanState, number>> {
  const result = await queryable.query<{ scan_state: unknown; count: unknown }>(
    "SELECT scan_state, COUNT(*) AS count FROM wiki_space_authorizations GROUP BY scan_state",
  );
  const counts: Record<WikiSpaceScanState, number> = {
    pending: 0,
    scanning: 0,
    synced: 0,
    retry_wait: 0,
    dead_letter: 0,
    disabled: 0,
  };
  for (const row of result.rows) {
    const state = requireScanState(row.scan_state);
    counts[state] = requireNonNegativeInteger(row.count, `count for ${state}`);
  }
  return counts;
}

function requireUpdatedAuthorization(row: Record<string, unknown> | undefined): WikiSpaceAuthorization {
  if (row === undefined) throw new Error("stale wiki space authorization");
  return mapRow(row);
}

function mapRow(row: Record<string, unknown>): WikiSpaceAuthorization {
  return {
    id: requireString("id", row.id, MAX_IDENTIFIER_CHARS),
    rootSourceUri: requireString("root_source_uri", row.root_source_uri, MAX_SOURCE_URI_CHARS),
    rootNodeToken: requireString("root_node_token", row.root_node_token, MAX_IDENTIFIER_CHARS),
    ...(optionalString("space_id", row.space_id) === undefined ? {} : { spaceId: optionalString("space_id", row.space_id) }),
    ...(optionalString("title", row.title) === undefined ? {} : { title: optionalString("title", row.title) }),
    enabled: requireBoolean(row.enabled, "enabled"),
    scanState: requireScanState(row.scan_state),
    attemptCount: requireNonNegativeInteger(row.attempt_count, "attempt_count"),
    nextScanAt: requireDateValue(row.next_scan_at, "next_scan_at"),
    ...(optionalDate("lease_expires_at", row.lease_expires_at) === undefined ? {} : { leaseExpiresAt: optionalDate("lease_expires_at", row.lease_expires_at) }),
    ...(optionalDate("last_scan_started_at", row.last_scan_started_at) === undefined ? {} : { lastScanStartedAt: optionalDate("last_scan_started_at", row.last_scan_started_at) }),
    ...(optionalDate("last_scan_completed_at", row.last_scan_completed_at) === undefined ? {} : { lastScanCompletedAt: optionalDate("last_scan_completed_at", row.last_scan_completed_at) }),
    ...(optionalDate("last_success_at", row.last_success_at) === undefined ? {} : { lastSuccessAt: optionalDate("last_success_at", row.last_success_at) }),
    ...(optionalString("last_error_classification", row.last_error_classification) === undefined ? {} : { lastErrorClassification: optionalString("last_error_classification", row.last_error_classification) }),
    discoveredNodeCount: requireNonNegativeInteger(row.discovered_node_count, "discovered_node_count"),
    registeredDocumentCount: requireNonNegativeInteger(row.registered_document_count, "registered_document_count"),
    skippedNodeCount: requireNonNegativeInteger(row.skipped_node_count, "skipped_node_count"),
    revision: requirePositiveInteger(row.revision, "revision"),
    createdAt: requireDateValue(row.created_at, "created_at"),
    updatedAt: requireDateValue(row.updated_at, "updated_at"),
  };
}

function requireString(name: string, value: unknown, maxChars: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${name} must not be blank`);
  if (normalized.length > maxChars) throw new Error(`${name} must be at most ${maxChars} characters`);
  return normalized;
}

function optionalString(name: string, value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requireString(name, value, MAX_IDENTIFIER_CHARS);
}

function requireDate(value: unknown, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${name} must be a valid date`);
  }
  return value;
}

function requireDateValue(value: unknown, name: string): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} must be a valid date`);
  return date;
}

function optionalDate(name: string, value: unknown): Date | undefined {
  if (value === null || value === undefined) return undefined;
  return requireDateValue(value, name);
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function requireScanState(value: unknown): WikiSpaceScanState {
  if (typeof value !== "string" || !scanStates.includes(value as WikiSpaceScanState)) {
    throw new Error("scan_state must be a valid wiki space scan state");
  }
  return value as WikiSpaceScanState;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return numeric;
}

function requirePositiveInteger(value: unknown, name: string): number {
  const numeric = requireNonNegativeInteger(value, name);
  if (numeric === 0) throw new Error(`${name} must be greater than zero`);
  return numeric;
}

function requireLimit(value: unknown, name: string, maximum: number): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
    throw new Error(`${name} must be a finite integer`);
  }
  if (numeric < 1 || numeric > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return numeric;
}
