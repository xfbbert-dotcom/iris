import type { DocumentSnapshot } from "../documents/document-snapshot-repository.js";
import {
  createDocumentReindexIdempotencyKey,
  type DocumentReindexQueue,
} from "./document-reindex-queue.js";

const MAX_DOCUMENT_REINDEX_PLAN_LIMIT = 100;

export type PlanDocumentProfileReindexInput = {
  embeddingProfileId: string;
  limit: number;
};

export type EnqueueSyncedSnapshotReindexInput = {
  embeddingProfileId: string;
  documentSnapshotId: string;
};

export type DocumentReindexPlanResult = {
  enqueuedCount: number;
  skippedCount: number;
};

export type DocumentReindexPlannerDependencies = {
  snapshots: {
    listSuccessfulSnapshotsMissingProfile(input: {
      embeddingProfileId: string;
      limit: number;
    }): Promise<DocumentSnapshot[]>;
  };
  queue: Pick<DocumentReindexQueue, "enqueue">;
  now?: () => Date;
};

export function createDocumentReindexPlanner({
  snapshots,
  queue,
  now = () => new Date(),
}: DocumentReindexPlannerDependencies) {
  return {
    async planDocumentProfileReindex(
      input: PlanDocumentProfileReindexInput,
    ): Promise<DocumentReindexPlanResult> {
      const limit = sanitizeLimit(input.limit);
      const missingSnapshots = await snapshots.listSuccessfulSnapshotsMissingProfile({
        embeddingProfileId: input.embeddingProfileId,
        limit,
      });

      for (const snapshot of missingSnapshots) {
        await queue.enqueue({
          idempotencyKey: createDocumentReindexIdempotencyKey({
            embeddingProfileId: input.embeddingProfileId,
            documentSnapshotId: snapshot.id,
          }),
          embeddingProfileId: input.embeddingProfileId,
          documentSnapshotId: snapshot.id,
          reason: "manual_profile_reindex",
          enqueuedAt: now(),
          attempts: 0,
        });
      }

      return { enqueuedCount: missingSnapshots.length, skippedCount: 0 };
    },

    enqueueSyncedSnapshotReindex(input: EnqueueSyncedSnapshotReindexInput): Promise<void> {
      return queue.enqueue({
        idempotencyKey: createDocumentReindexIdempotencyKey(input),
        embeddingProfileId: input.embeddingProfileId,
        documentSnapshotId: input.documentSnapshotId,
        reason: "document_synced",
        enqueuedAt: now(),
        attempts: 0,
      });
    },
  };
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
    return 0;
  }

  return Math.min(MAX_DOCUMENT_REINDEX_PLAN_LIMIT, Math.max(0, Math.floor(value)));
}
