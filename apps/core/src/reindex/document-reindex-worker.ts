import type { DocumentSemanticIndexResult } from "../documents/document-semantic-indexer.js";
import type { DocumentSnapshot } from "../documents/document-snapshot-repository.js";
import { normalizeWorkerErrorMessage } from "../workers/worker-error-message.js";
import type {
  DocumentReindexJob,
  DocumentReindexQueue,
  FailedDocumentReindexJobResult,
} from "./document-reindex-queue.js";

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
  queue: Pick<DocumentReindexQueue, "dequeueBatch" | "handleProcessedJob" | "handleFailedJob">;
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

const MAX_DOCUMENT_REINDEX_WORKER_BATCH_LIMIT = 100;
const MAX_FAILURE_HANDLER_ATTEMPTS = 3;

export function createDocumentReindexWorker(dependencies: DocumentReindexWorkerDependencies) {
  return {
    async processBatch({ limit }: { limit: number }): Promise<DocumentReindexJobResult[]> {
      const jobs = await dependencies.queue.dequeueBatch(sanitizeLimit(limit));
      const results: DocumentReindexJobResult[] = [];

      for (const job of jobs) {
        try {
          const result = await processJob(dependencies, job);
          await dependencies.queue.handleProcessedJob(job);
          results.push(result);
        } catch (error) {
          const errorMessage = normalizeWorkerErrorMessage(error);
          const retryResult = await handleFailedJobWithRetry({
            queue: dependencies.queue,
            job,
            errorMessage,
          });
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

async function handleFailedJobWithRetry({
  queue,
  job,
  errorMessage,
}: {
  queue: Pick<DocumentReindexQueue, "handleFailedJob">;
  job: DocumentReindexJob;
  errorMessage: string;
}): Promise<FailedDocumentReindexJobResult> {
  let latestError: unknown;
  for (let attempt = 1; attempt <= MAX_FAILURE_HANDLER_ATTEMPTS; attempt += 1) {
    try {
      return await queue.handleFailedJob({ job, errorMessage });
    } catch (error) {
      latestError = error;
    }
  }

  throw latestError;
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error("document reindex worker batch limit must be a finite safe-magnitude number");
  }

  return Math.min(MAX_DOCUMENT_REINDEX_WORKER_BATCH_LIMIT, Math.max(0, Math.floor(value)));
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
