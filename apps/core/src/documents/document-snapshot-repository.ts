import { createHash, randomUUID } from "node:crypto";

export type DocumentFetchStatus = "succeeded" | "failed";

export interface DocumentSnapshot {
  id: string;
  documentSourceId: string;
  sourceUri: string;
  fetchStatus: DocumentFetchStatus;
  bodyText?: string;
  contentHash?: string;
  sourceVersion?: string;
  fetchedAt: Date;
  errorMessage?: string;
  createdAt: Date;
}

export type Queryable = {
  query: <T = unknown>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

export type DocumentSnapshotRepositoryDependencies = {
  queryable: Queryable;
  createId?: () => string;
  now?: () => Date;
};

export type InsertSucceededSnapshotInput = {
  documentSourceId: string;
  sourceUri: string;
  bodyText: string;
  contentHash?: string;
  sourceVersion?: string;
  fetchedAt: Date;
};

export type InsertFailedSnapshotInput = {
  documentSourceId: string;
  sourceUri: string;
  errorMessage: string;
  fetchedAt: Date;
};

export interface DocumentSnapshotRepository {
  insertSucceededSnapshot(input: InsertSucceededSnapshotInput): Promise<DocumentSnapshot>;
  insertFailedSnapshot(input: InsertFailedSnapshotInput): Promise<DocumentSnapshot>;
  listSnapshotsForSource(documentSourceId: string): Promise<DocumentSnapshot[]>;
  findLatestSnapshotForSource(documentSourceId: string): Promise<DocumentSnapshot | undefined>;
}

type DocumentSnapshotRow = {
  id: string;
  document_source_id: string;
  source_uri: string;
  fetch_status: DocumentFetchStatus;
  body_text: string | null;
  content_hash: string | null;
  source_version: string | null;
  fetched_at: Date;
  error_message: string | null;
  created_at: Date;
};

type NextDocumentSnapshot = {
  id: string;
  documentSourceId: string;
  sourceUri: string;
  fetchStatus: DocumentFetchStatus;
  bodyText?: string;
  contentHash?: string;
  sourceVersion?: string;
  fetchedAt: Date;
  errorMessage?: string;
  createdAt: Date;
};

export function createDocumentSnapshotRepository(
  dependencies: DocumentSnapshotRepositoryDependencies,
): DocumentSnapshotRepository {
  const createId = dependencies.createId ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());

  return {
    insertSucceededSnapshot(input) {
      return insertSnapshot(dependencies.queryable, {
        id: createId(),
        documentSourceId: input.documentSourceId,
        sourceUri: input.sourceUri,
        fetchStatus: "succeeded",
        bodyText: input.bodyText,
        contentHash: input.contentHash ?? hashBody(input.bodyText),
        sourceVersion: input.sourceVersion,
        fetchedAt: input.fetchedAt,
        errorMessage: undefined,
        createdAt: now(),
      });
    },

    insertFailedSnapshot(input) {
      return insertSnapshot(dependencies.queryable, {
        id: createId(),
        documentSourceId: input.documentSourceId,
        sourceUri: input.sourceUri,
        fetchStatus: "failed",
        bodyText: undefined,
        contentHash: undefined,
        sourceVersion: undefined,
        fetchedAt: input.fetchedAt,
        errorMessage: input.errorMessage,
        createdAt: now(),
      });
    },

    async listSnapshotsForSource(documentSourceId) {
      const result = await dependencies.queryable.query<DocumentSnapshotRow>(
        `
select *
from document_snapshots
where document_source_id = $1
order by fetched_at desc, id asc
`,
        [documentSourceId],
      );

      return result.rows.map(mapSnapshotRow);
    },

    async findLatestSnapshotForSource(documentSourceId) {
      const snapshots = await this.listSnapshotsForSource(documentSourceId);
      return snapshots[0];
    },
  };
}

async function insertSnapshot(
  queryable: Queryable,
  snapshot: NextDocumentSnapshot,
): Promise<DocumentSnapshot> {
  const result = await queryable.query<DocumentSnapshotRow>(
    `
insert into document_snapshots (
  id,
  document_source_id,
  source_uri,
  fetch_status,
  body_text,
  content_hash,
  source_version,
  fetched_at,
  error_message,
  created_at
)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
returning *
`,
    [
      snapshot.id,
      snapshot.documentSourceId,
      snapshot.sourceUri,
      snapshot.fetchStatus,
      snapshot.bodyText ?? null,
      snapshot.contentHash ?? null,
      snapshot.sourceVersion ?? null,
      snapshot.fetchedAt,
      snapshot.errorMessage ?? null,
      snapshot.createdAt,
    ],
  );
  const row = result.rows[0];

  if (row === undefined) {
    throw new Error("inserted document snapshot was not returned");
  }

  return mapSnapshotRow(row);
}

function mapSnapshotRow(row: DocumentSnapshotRow): DocumentSnapshot {
  return {
    id: row.id,
    documentSourceId: row.document_source_id,
    sourceUri: row.source_uri,
    fetchStatus: row.fetch_status,
    bodyText: row.body_text ?? undefined,
    contentHash: row.content_hash ?? undefined,
    sourceVersion: row.source_version ?? undefined,
    fetchedAt: row.fetched_at,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
  };
}

function hashBody(bodyText: string): string {
  return createHash("sha256").update(bodyText).digest("hex");
}
