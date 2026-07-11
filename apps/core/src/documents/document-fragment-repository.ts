import { createHash, randomUUID } from "node:crypto";

import type { DocumentChunk } from "./document-chunker.js";
import type { DocumentSourceType } from "./document-source-registry.js";

const MAX_FRAGMENT_SEARCH_LIMIT = 100;
const MAX_GROUP_ID_CHARS = 512;

export type Queryable = {
  query: <T = unknown>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

type TransactionClient = Queryable & {
  release(): void;
};

type TransactionalQueryable = Queryable & {
  connect(): Promise<TransactionClient>;
};

export type EmbeddingProfileLookup = {
  getProfileById(id: string): Promise<{ id: string; dimensions: number }>;
};

type EmbeddingTable = "document_fragment_embeddings_6" | "document_fragment_embeddings_1536";

export type DocumentFragment = {
  id: string;
  documentSourceId: string;
  documentSnapshotId: string;
  sourceUri: string;
  chunkIndex: number;
  text: string;
  contentHash: string;
  embedding: number[];
  embeddingProfileId: string;
  createdAt: Date;
};

export type RetrievedDocumentFragment = DocumentFragment & {
  distance?: number;
};

export type ReplaceFragmentsInput = {
  documentSourceId: string;
  documentSnapshotId: string;
  sourceUri: string;
  embeddingProfileId: string;
  chunks: DocumentChunk[];
  embeddings: number[][];
};

export type SearchSimilarFragmentsInput = {
  embeddingProfileId: string;
  embedding: number[];
  limit: number;
  sourceTypes?: DocumentSourceType[];
  groupId?: string;
};

export type DocumentFragmentRepositoryDependencies = {
  queryable: Queryable;
  embeddingProfiles: EmbeddingProfileLookup;
  createId?: () => string;
  now?: () => Date;
};

export interface DocumentFragmentRepository {
  replaceFragmentsForSnapshot(input: ReplaceFragmentsInput): Promise<DocumentFragment[]>;
  listFragmentsForSource(documentSourceId: string): Promise<DocumentFragment[]>;
  listFragmentsForSnapshot(documentSnapshotId: string): Promise<DocumentFragment[]>;
  searchSimilarFragments(input: SearchSimilarFragmentsInput): Promise<RetrievedDocumentFragment[]>;
  hasFragmentsForSnapshotProfile(input: {
    documentSnapshotId: string;
    embeddingProfileId: string;
  }): Promise<boolean>;
}

type DocumentFragmentRow = {
  id: string;
  document_source_id: string;
  document_snapshot_id: string;
  source_uri: string;
  chunk_index: number;
  text: string;
  content_hash: string;
  embedding?: string | number[] | null;
  embedding_profile_id: string;
  created_at: Date;
};

type RetrievedDocumentFragmentRow = DocumentFragmentRow & {
  distance?: number | string;
};

export function createDocumentFragmentRepository(
  dependencies: DocumentFragmentRepositoryDependencies,
): DocumentFragmentRepository {
  const createId = dependencies.createId ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());

  return {
    async replaceFragmentsForSnapshot(input) {
      if (input.chunks.length !== input.embeddings.length) {
        throw new Error("chunk and embedding counts must match");
      }
      const profile = await dependencies.embeddingProfiles.getProfileById(input.embeddingProfileId);
      const embeddingTable = resolveEmbeddingTable(profile.dimensions);
      validateReplacementEmbeddings(input.chunks, input.embeddings, profile.dimensions);

      return withTransactionIfSupported(dependencies.queryable, async (queryable) => {
        await queryable.query(
          `
delete from document_fragments
where document_snapshot_id = $1
  and embedding_profile_id = $2
`,
          [input.documentSnapshotId, input.embeddingProfileId],
        );

        const fragments: DocumentFragment[] = [];
        for (const chunk of input.chunks) {
          const embedding = input.embeddings[chunk.chunkIndex];
          if (embedding === undefined) {
            throw new Error(`missing embedding for chunk index ${chunk.chunkIndex}`);
          }
          validateVectorDimension(embedding, profile.dimensions);

          const inserted = await insertFragment(queryable, {
            id: createId(),
            documentSourceId: input.documentSourceId,
            documentSnapshotId: input.documentSnapshotId,
            sourceUri: input.sourceUri,
            chunkIndex: chunk.chunkIndex,
            text: chunk.text,
            contentHash: hashText(chunk.text),
            embedding: [],
            embeddingProfileId: input.embeddingProfileId,
            createdAt: now(),
          });
          await insertFragmentEmbedding(queryable, embeddingTable, {
            documentFragmentId: inserted.id,
            embeddingProfileId: input.embeddingProfileId,
            embedding,
            createdAt: inserted.createdAt,
          });
          fragments.push({ ...inserted, embedding });
        }

        return fragments;
      });
    },

    async listFragmentsForSource(documentSourceId) {
      const result = await dependencies.queryable.query<DocumentFragmentRow>(
        `
select *
from document_fragments
where document_source_id = $1
order by chunk_index asc, id asc
`,
        [documentSourceId],
      );

      return result.rows.map(mapFragmentRow);
    },

    async listFragmentsForSnapshot(documentSnapshotId) {
      const result = await dependencies.queryable.query<DocumentFragmentRow>(
        `
select *
from document_fragments
where document_snapshot_id = $1
order by chunk_index asc, id asc
`,
        [documentSnapshotId],
      );

      return result.rows.map(mapFragmentRow);
    },

    async searchSimilarFragments(input) {
      const limit = sanitizeLimit(input.limit);
      if (limit === 0) {
        return [];
      }
      const sourceTypes = sanitizeSourceTypes(input.sourceTypes);
      if (sourceTypes !== undefined && sourceTypes.length === 0) {
        return [];
      }
      const groupId = sanitizeGroupId(input.groupId);

      const profile = await dependencies.embeddingProfiles.getProfileById(input.embeddingProfileId);
      const embeddingTable = resolveEmbeddingTable(profile.dimensions);
      validateVectorDimension(input.embedding, profile.dimensions);
      const values: unknown[] = [input.embeddingProfileId, serializeVector(input.embedding), limit];
      let sourceTypeClause = "";
      if (sourceTypes !== undefined) {
        values.push(sourceTypes);
        sourceTypeClause = `  and ds.source_type = any($${values.length}::text[])\n`;
      }
      let groupScopeClause = "";
      if (groupId !== undefined) {
        values.push(groupId);
        const groupIdParameter = `$${values.length}`;
        groupScopeClause = `  and (
    ds.source_type <> 'group_visible_document'
    or ds.origin_group_id = ${groupIdParameter}
    or exists (
      select 1
      from document_source_evidence evidence
      where evidence.document_source_id = ds.id
        and evidence.group_id = ${groupIdParameter}
    )
  )
`;
      }

      const result = await dependencies.queryable.query<RetrievedDocumentFragmentRow>(
        `
with latest_snapshots as (
  select distinct on (document_source_id) id
  from document_snapshots
  where fetch_status = 'succeeded'
  order by document_source_id asc, fetched_at desc, id asc
)
select
  f.*,
  e.embedding,
  e.embedding <=> $2::vector as distance
from document_fragments f
join latest_snapshots
  on f.document_snapshot_id = latest_snapshots.id
join document_sources ds
  on ds.id = f.document_source_id
  and ds.can_use_for_answering = true
  and ds.permission_state in ('unknown', 'readable')
${sourceTypeClause}${groupScopeClause}join ${embeddingTable} e
  on e.document_fragment_id = f.id
where f.embedding_profile_id = $1
  and e.embedding_profile_id = $1
order by e.embedding <=> $2::vector asc, f.document_source_id asc, f.chunk_index asc, f.id asc
limit $3
`,
        values,
      );

      return result.rows.map(mapRetrievedFragmentRow);
    },

    async hasFragmentsForSnapshotProfile(input) {
      const result = await dependencies.queryable.query<{ exists: boolean }>(
        `
select exists (
  select 1
  from document_fragments
  where document_snapshot_id = $1
    and embedding_profile_id = $2
) as exists
`,
        [input.documentSnapshotId, input.embeddingProfileId],
      );

      return result.rows[0]?.exists === true;
    },
  };
}

async function withTransactionIfSupported<T>(
  queryable: Queryable,
  operation: (queryable: Queryable) => Promise<T>,
): Promise<T> {
  if (!supportsTransactions(queryable)) {
    return operation(queryable);
  }

  const client = await queryable.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Preserve the original mutation failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

function supportsTransactions(queryable: Queryable): queryable is TransactionalQueryable {
  return "connect" in queryable && typeof queryable.connect === "function";
}

function validateReplacementEmbeddings(
  chunks: DocumentChunk[],
  embeddings: number[][],
  dimension: number,
): void {
  for (const chunk of chunks) {
    const embedding = embeddings[chunk.chunkIndex];
    if (embedding === undefined) {
      throw new Error(`missing embedding for chunk index ${chunk.chunkIndex}`);
    }
    validateVectorDimension(embedding, dimension);
  }
}

export function serializeVector(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error("fragment search limit must be a finite safe-magnitude number");
  }

  return Math.min(MAX_FRAGMENT_SEARCH_LIMIT, Math.max(0, Math.floor(value)));
}

function sanitizeSourceTypes(
  sourceTypes: DocumentSourceType[] | undefined,
): DocumentSourceType[] | undefined {
  if (sourceTypes === undefined) {
    return undefined;
  }

  return [...new Set(sourceTypes)];
}

function sanitizeGroupId(groupId: string | undefined): string | undefined {
  if (groupId === undefined) {
    return undefined;
  }

  const normalized = groupId.trim();
  if (normalized.length === 0) {
    throw new Error("groupId must not be blank");
  }
  if (normalized.length > MAX_GROUP_ID_CHARS) {
    throw new Error(`groupId must be at most ${MAX_GROUP_ID_CHARS} characters`);
  }

  return normalized;
}

async function insertFragment(
  queryable: Queryable,
  fragment: DocumentFragment,
): Promise<DocumentFragment> {
  const result = await queryable.query<DocumentFragmentRow>(
    `
insert into document_fragments (
  id,
  document_source_id,
  document_snapshot_id,
  source_uri,
  chunk_index,
  text,
  content_hash,
  embedding_profile_id,
  created_at
)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
returning *
`,
    [
      fragment.id,
      fragment.documentSourceId,
      fragment.documentSnapshotId,
      fragment.sourceUri,
      fragment.chunkIndex,
      fragment.text,
      fragment.contentHash,
      fragment.embeddingProfileId,
      fragment.createdAt,
    ],
  );
  const row = result.rows[0];

  if (row === undefined) {
    throw new Error("inserted document fragment was not returned");
  }

  return mapFragmentRow(row);
}

async function insertFragmentEmbedding(
  queryable: Queryable,
  table: EmbeddingTable,
  input: {
    documentFragmentId: string;
    embeddingProfileId: string;
    embedding: number[];
    createdAt: Date;
  },
): Promise<void> {
  await queryable.query(
    `
insert into ${table} (
  document_fragment_id,
  embedding_profile_id,
  embedding,
  created_at
)
values ($1, $2, $3::vector, $4)
on conflict (document_fragment_id)
do update set
  embedding_profile_id = excluded.embedding_profile_id,
  embedding = excluded.embedding,
  created_at = excluded.created_at
`,
    [
      input.documentFragmentId,
      input.embeddingProfileId,
      serializeVector(input.embedding),
      input.createdAt,
    ],
  );
}

function mapRetrievedFragmentRow(row: RetrievedDocumentFragmentRow): RetrievedDocumentFragment {
  return {
    ...mapFragmentRow(row),
    distance: row.distance === undefined ? undefined : Number(row.distance),
  };
}

function mapFragmentRow(row: DocumentFragmentRow): DocumentFragment {
  return {
    id: row.id,
    documentSourceId: row.document_source_id,
    documentSnapshotId: row.document_snapshot_id,
    sourceUri: row.source_uri,
    chunkIndex: row.chunk_index,
    text: row.text,
    contentHash: row.content_hash,
    embedding: row.embedding === undefined || row.embedding === null ? [] : parseVector(row.embedding),
    embeddingProfileId: row.embedding_profile_id,
    createdAt: row.created_at,
  };
}

function parseVector(vector: string | number[]): number[] {
  if (Array.isArray(vector)) {
    return vector;
  }

  const trimmed = vector.trim();
  if (trimmed.length === 0) {
    return [];
  }

  return trimmed
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .filter((value) => value.trim().length > 0)
    .map((value) => Number(value));
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function resolveEmbeddingTable(dimension: number): EmbeddingTable {
  if (dimension === 6) {
    return "document_fragment_embeddings_6";
  }
  if (dimension === 1536) {
    return "document_fragment_embeddings_1536";
  }

  throw new Error(`Unsupported embedding dimension: ${dimension}`);
}

function validateVectorDimension(vector: number[], dimension: number): void {
  if (vector.length !== dimension) {
    throw new Error(
      `embedding vector length ${vector.length} does not match profile dimension ${dimension}`,
    );
  }
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("embedding vector contains invalid value");
    }
  }
}
