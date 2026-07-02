import type { DocumentSource } from "./document-source-registry.js";
import {
  createDocumentSyncIdempotencyKey,
  type DocumentSyncQueue,
} from "./document-sync-queue.js";
import { isSyncCandidate } from "./document-sync-pipeline.js";

export type DiscoveredDocumentSyncPlanResult = {
  enqueuedCount: number;
  skippedCount: number;
};

export type DiscoveredDocumentSyncPlanner = {
  planRegisteredSources(sources: DocumentSource[]): Promise<DiscoveredDocumentSyncPlanResult>;
};

export function createDiscoveredDocumentSyncPlanner({
  queue,
  now = () => new Date(),
}: {
  queue: Pick<DocumentSyncQueue, "enqueue">;
  now?: () => Date;
}): DiscoveredDocumentSyncPlanner {
  return {
    async planRegisteredSources(sources) {
      let enqueuedCount = 0;
      let skippedCount = 0;

      for (const source of sources) {
        if (!isSyncCandidate(source)) {
          skippedCount += 1;
          continue;
        }

        await queue.enqueue({
          idempotencyKey: createDocumentSyncIdempotencyKey({
            documentSourceId: source.id,
          }),
          documentSourceId: source.id,
          reason: "discovered_group_document",
          enqueuedAt: now(),
          attempts: 0,
        });
        enqueuedCount += 1;
      }

      return { enqueuedCount, skippedCount };
    },
  };
}
