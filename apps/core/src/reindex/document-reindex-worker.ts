import type { DocumentSemanticIndexResult } from "../documents/document-semantic-indexer.js";
import type { DocumentSnapshot } from "../documents/document-snapshot-repository.js";
import { normalizeWorkerErrorMessage } from "../workers/worker-error-message.js";
import type { DocumentReindexJob, DocumentReindexQueue } from "./document-reindex-queue.js";

export type DocumentReindexJobResult =
  | { status: "indexed"; documentSnapshotId: string; embeddingProfileId: string; fragmentCount: number }
  | {
      status: "skipped";
      documentSnapshotId: string;
      embeddingProfileId: string;
      reason: "already_indexed" | "snapshot_not_successful" | "snapshot_not_found";
    }
  | {
      status: "failed";
      documentSnapshotId: string;
      embeddingProfileId: string;
      reason: "processing_error";
      errorMessage: string;
      retryAction: "requeued" | "dead_lettered";
      attempts: number;
    };

export type DocumentReindexWorkerDependencies = {
  queue: Pick<DocumentReindexQueue, "dequeueBatch" | "handleFailedJob">;
  snapshots: {
    findSnapshotById(id: string): Promise<DocumentSnapshot | undefined>;
  };
  fragments: {
    hasFragmentsForSnapshotProfile(input: {
      documentSnapshotId: string;
      embeddingProfileId: string;
    }): Promise<boolean>;
  };
  indexer: {
    indexSnapshot(snapshot: DocumentSnapshot): Promise<DocumentSemanticIndexResult>;
  };
};

export function createDocumentReindexWorker(dependencies: DocumentReindexWorkerDependencies) {
  return {
    async processBatch({ limit }: { limit: number }): Promise<DocumentReindexJobResult[]> {
      const jobs = await dependencies.queue.dequeueBatch(sanitizeLimit(limit));
      const results: DocumentReindexJobResult[] = [];

      for (const job of jobs) {
        try {
          results.push(await processJob(dependencies, job));
        } catch (error) {
          const errorMessage = normalizeWorkerErrorMessage(error);
          const retryResult = await dependencies.queue.handleFailedJob({ job, errorMessage });
          results.push({
            status: "failed",
            documentSnapshotId: job.documentSnapshotId,
            embeddingProfileId: job.embeddingProfileId,
            reason: "processing_error",
            errorMessage,
            retryAction: retryResult.action,
            attempts: retryResult.attempts,
          });
        }
      }

      return results;
    },
  };
}

function sanitizeLimit(value: number): number {
  if (Number.isFinite(value) && Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error("document reindex worker batch limit must be a finite safe-magnitude number");
  }

  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

async function processJob(
  dependencies: DocumentReindexWorkerDependencies,
  job: DocumentReindexJob,
): Promise<DocumentReindexJobResult> {
  const snapshot = await dependencies.snapshots.findSnapshotById(job.documentSnapshotId);
  if (snapshot === undefined) {
    return skipped(job, "snapshot_not_found");
  }
  if (snapshot.fetchStatus !== "succeeded") {
    return skipped(job, "snapshot_not_successful");
  }

  const alreadyIndexed = await dependencies.fragments.hasFragmentsForSnapshotProfile({
    documentSnapshotId: job.documentSnapshotId,
    embeddingProfileId: job.embeddingProfileId,
  });
  if (alreadyIndexed) {
    return skipped(job, "already_indexed");
  }

  const indexResult = await dependencies.indexer.indexSnapshot(snapshot);
  if (indexResult.status === "skipped") {
    return skipped(job, "snapshot_not_successful");
  }

  return {
    status: "indexed",
    documentSnapshotId: job.documentSnapshotId,
    embeddingProfileId: job.embeddingProfileId,
    fragmentCount: indexResult.fragmentCount,
  };
}

function skipped(
  job: DocumentReindexJob,
  reason: "already_indexed" | "snapshot_not_successful" | "snapshot_not_found",
): DocumentReindexJobResult {
  return {
    status: "skipped",
    documentSnapshotId: job.documentSnapshotId,
    embeddingProfileId: job.embeddingProfileId,
    reason,
  };
}
