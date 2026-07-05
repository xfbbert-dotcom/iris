import type { DocumentSyncResult, DocumentSyncRunner } from "./document-sync-pipeline.js";
import type {
  DocumentSyncJob,
  DocumentSyncQueue,
  FailedDocumentSyncJobResult,
} from "./document-sync-queue.js";
import { normalizeWorkerErrorMessage } from "../workers/worker-error-message.js";

export type DocumentSyncWorkerResult =
  | {
      status: "processed";
      idempotencyKey: string;
      documentSourceId: string;
      syncStatus: DocumentSyncResult["status"];
    }
  | {
      status: "failed";
      idempotencyKey: string;
      documentSourceId: string;
      errorMessage: string;
      retryAction: "requeued" | "dead_lettered";
      attempts: number;
    };

export type DocumentSyncWorkerDependencies = {
  queue: Pick<DocumentSyncQueue, "dequeueBatch" | "handleFailedJob">;
  runner: Pick<DocumentSyncRunner, "syncSourceById">;
};

const MAX_DOCUMENT_SYNC_WORKER_BATCH_LIMIT = 100;
const MAX_FAILURE_HANDLER_ATTEMPTS = 3;

export function createDocumentSyncWorker(dependencies: DocumentSyncWorkerDependencies) {
  return {
    async processBatch({ limit }: { limit: number }): Promise<DocumentSyncWorkerResult[]> {
      const jobs = await dependencies.queue.dequeueBatch(sanitizeLimit(limit));
      const results: DocumentSyncWorkerResult[] = [];

      for (const job of jobs) {
        results.push(await processJob(job, dependencies.runner, dependencies.queue));
      }

      return results;
    },
  };
}

async function processJob(
  job: DocumentSyncJob,
  runner: Pick<DocumentSyncRunner, "syncSourceById">,
  queue: Pick<DocumentSyncQueue, "handleFailedJob">,
): Promise<DocumentSyncWorkerResult> {
  try {
    const result = await runner.syncSourceById(job.documentSourceId);
    return {
      status: "processed",
      idempotencyKey: job.idempotencyKey,
      documentSourceId: job.documentSourceId,
      syncStatus: result.status,
    };
  } catch (error) {
    const errorMessage = normalizeWorkerErrorMessage(error);
    const failureResult = await handleFailedJobWithRetry({ queue, job, errorMessage });

    return {
      status: "failed",
      idempotencyKey: job.idempotencyKey,
      documentSourceId: job.documentSourceId,
      errorMessage,
      retryAction: failureResult.action,
      attempts: failureResult.attempts,
    };
  }
}

async function handleFailedJobWithRetry({
  queue,
  job,
  errorMessage,
}: {
  queue: Pick<DocumentSyncQueue, "handleFailedJob">;
  job: DocumentSyncJob;
  errorMessage: string;
}): Promise<FailedDocumentSyncJobResult> {
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
    throw new Error("document sync worker batch limit must be a finite safe-magnitude number");
  }

  return Math.min(MAX_DOCUMENT_SYNC_WORKER_BATCH_LIMIT, Math.max(0, Math.floor(value)));
}
