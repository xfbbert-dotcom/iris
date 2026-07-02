import type { DocumentSyncResult, DocumentSyncRunner } from "./document-sync-pipeline.js";
import type { DocumentSyncJob, DocumentSyncQueue } from "./document-sync-queue.js";

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
    };

export type DocumentSyncWorkerDependencies = {
  queue: Pick<DocumentSyncQueue, "dequeueBatch">;
  runner: Pick<DocumentSyncRunner, "syncSourceById">;
};

export function createDocumentSyncWorker(dependencies: DocumentSyncWorkerDependencies) {
  return {
    async processBatch({ limit }: { limit: number }): Promise<DocumentSyncWorkerResult[]> {
      const jobs = await dependencies.queue.dequeueBatch(sanitizeLimit(limit));
      const results: DocumentSyncWorkerResult[] = [];

      for (const job of jobs) {
        results.push(await processJob(job, dependencies.runner));
      }

      return results;
    },
  };
}

async function processJob(
  job: DocumentSyncJob,
  runner: Pick<DocumentSyncRunner, "syncSourceById">,
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
    return {
      status: "failed",
      idempotencyKey: job.idempotencyKey,
      documentSourceId: job.documentSourceId,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}
