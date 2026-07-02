import { createHash, randomUUID } from "node:crypto";

import type { DocumentChunk } from "./document-chunker.js";

export type Queryable = {
  query: <T = unknown>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

export type DocumentFragment = {
  id: string;
  documentSourceId: string;
  documentSnapshotId: string;
  sourceUri: string;
  chunkIndex: number;
  text: string;
  contentHash: string;
  embedding: number[];
  createdAt: Date;
};

export type RetrievedDocumentFragment = DocumentFragment & {
  distance?: number;
};

export type ReplaceFragmentsInput = {
  documentSourceId: string;
  documentSnapshotId: string;
  sourceUri: string;
  chunks: DocumentChunk[];
  embeddings: number[][];
};

export type SearchSimilarFragmentsInput = {
  embedding: number[];
  limit: number;
};

export type DocumentFragmentRepositoryDependencies = {
  queryable: Queryable;
  createId?: () => string;
  now?: () => Date;
};

export interface DocumentFragmentRepository {
  replaceFragmentsForSnapshot(input: ReplaceFragmentsInput): Promise<DocumentFragment[]>;
  listFragmentsForSource(documentSourceId: string): Promise<DocumentFragment[]>;
  listFragmentsForSnapshot(documentSnapshotId: string): Promise<DocumentFragment[]>;
  searchSimilarFragments(input: SearchSimilarFragmentsInput): Promise<RetrievedDocumentFragment[]>;
}

type DocumentFragmentRow = {
  id: string;
  document_source_id: string;
  document_snapshot_id: string;
  source_uri: string;
  chunk_index: number;
  text: string;
  content_hash: string;
  embedding: string | number[];
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

      await dependencies.queryable.query(
        `
delete from document_fragments
where document_snapshot_id = $1
`,
        [input.documentSnapshotId],
      );

      const fragments: DocumentFragment[] = [];
      for (const chunk of input.chunks) {
        const embedding = input.embeddings[chunk.chunkIndex];
        if (embedding === undefined) {
          throw new Error(`missing embedding for chunk index ${chunk.chunkIndex}`);
        }

        fragments.push(
          await insertFragment(dependencies.queryable, {
            id: createId(),
            documentSourceId: input.documentSourceId,
            documentSnapshotId: input.documentSnapshotId,
            sourceUri: input.sourceUri,
            chunkIndex: chunk.chunkIndex,
            text: chunk.text,
            contentHash: hashText(chunk.text),
            embedding,
            createdAt: now(),
          }),
        );
      }

      return fragments;
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
      const result = await dependencies.queryable.query<RetrievedDocumentFragmentRow>(
        `
select *, embedding <=> $1::vector as distance
from document_fragments
order by embedding <=> $1::vector asc
limit $2
`,
        [serializeVector(input.embedding), input.limit],
      );

      return result.rows.map(mapRetrievedFragmentRow);
    },
  };
}

export function serializeVector(vector: number[]): string {
  return `[${vector.join(",")}]`;
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
  embedding,
  created_at
)
values ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9)
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
      serializeVector(fragment.embedding),
      fragment.createdAt,
    ],
  );
  const row = result.rows[0];

  if (row === undefined) {
    throw new Error("inserted document fragment was not returned");
  }

  return mapFragmentRow(row);
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
    embedding: parseVector(row.embedding),
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
