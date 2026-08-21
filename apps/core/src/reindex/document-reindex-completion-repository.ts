import { createHash } from "node:crypto";

export type SuccessfulDocumentReindexCompletion = {
  documentSnapshotId: string;
  embeddingProfileId: string;
  completionKind: "indexed" | "already_indexed";
  fragmentCount: number;
  completedAt: Date;
};

export interface DocumentReindexCompletionRepository {
  recordSuccessfulCompletion(input: SuccessfulDocumentReindexCompletion): Promise<void>;
}

export type DocumentReindexCompletionQueryable = {
  query<T = unknown>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
};

export function createDocumentReindexCompletionRepository({
  queryable,
}: {
  queryable: DocumentReindexCompletionQueryable;
}): DocumentReindexCompletionRepository {
  return {
    async recordSuccessfulCompletion(input) {
      const documentSnapshotId = identifier("documentSnapshotId", input.documentSnapshotId);
      const embeddingProfileId = identifier("embeddingProfileId", input.embeddingProfileId);
      if (input.completionKind !== "indexed" && input.completionKind !== "already_indexed") {
        throw new Error("completionKind is invalid");
      }
      if (!Number.isSafeInteger(input.fragmentCount) || input.fragmentCount < 0) {
        throw new Error("fragmentCount is invalid");
      }
      if (!(input.completedAt instanceof Date) || Number.isNaN(input.completedAt.getTime())) {
        throw new Error("completedAt is invalid");
      }
      const id = `reindex-completion:${createHash("sha256").update(JSON.stringify([
        documentSnapshotId,
        embeddingProfileId,
      ])).digest("hex")}`;
      const result = await queryable.query<{
        completion_kind: string;
        fragment_count: string | number;
      }>(
        `INSERT INTO document_snapshot_reindex_completions (
           id,document_snapshot_id,embedding_profile_id,completion_kind,
           fragment_count,completed_at,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$6)
         ON CONFLICT (document_snapshot_id,embedding_profile_id) DO NOTHING
         RETURNING completion_kind,fragment_count`,
        [id, documentSnapshotId, embeddingProfileId, input.completionKind,
          input.fragmentCount, new Date(input.completedAt)],
      );
      if (result.rows.length === 1) return;
      const replay = await queryable.query<{
        completion_kind: string;
        fragment_count: string | number;
      }>(
        `SELECT completion_kind,fragment_count
           FROM document_snapshot_reindex_completions
          WHERE document_snapshot_id = $1 AND embedding_profile_id = $2`,
        [documentSnapshotId, embeddingProfileId],
      );
      const row = replay.rows[0];
      if (row === undefined) {
        throw new Error("document reindex completion operation conflict");
      }
    },
  };
}

function identifier(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 512) throw new Error(`${name} is invalid`);
  return normalized;
}
