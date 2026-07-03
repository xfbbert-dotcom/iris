import {
  type DocumentSyncQueue,
} from "./document-sync-queue.js";
import type { DocumentSource, DocumentSyncState } from "./document-source-registry.js";

type MaybePromise<T> = T | Promise<T>;

export type ManualDocumentSyncPlannerRegistry = {
  findSourceById(id: string): MaybePromise<DocumentSource | undefined>;
  markSyncState(id: string, syncState: DocumentSyncState): MaybePromise<DocumentSource>;
};

export type ManualDocumentSyncEnqueueResult =
  | { status: "enqueued"; documentSourceId: string }
  | { status: "not_found"; documentSourceId: string }
  | {
      status: "rejected";
      documentSourceId: string;
      reason: "permission_denied" | "capability_disabled";
    }
  | { status: "skipped"; documentSourceId: string; reason: "already_syncing" };

export type ManualDocumentSyncPlanner = {
  enqueueSource(input: { documentSourceId: string }): Promise<ManualDocumentSyncEnqueueResult>;
};

export function createManualDocumentSyncPlanner({
  registry,
  queue,
  now = () => new Date(),
  requestId = defaultRequestId,
}: {
  registry: ManualDocumentSyncPlannerRegistry;
  queue: Pick<DocumentSyncQueue, "enqueue">;
  now?: () => Date;
  requestId?: () => string;
}): ManualDocumentSyncPlanner {
  return {
    async enqueueSource({ documentSourceId }) {
      const normalizedDocumentSourceId = documentSourceId.trim();
      const source = await registry.findSourceById(normalizedDocumentSourceId);

      if (source === undefined) {
        return { status: "not_found", documentSourceId: normalizedDocumentSourceId };
      }

      if (source.permissionState === "denied") {
        return {
          status: "rejected",
          documentSourceId: normalizedDocumentSourceId,
          reason: "permission_denied",
        };
      }

      if (!source.canUseForAnswering && !source.canUseForKnowledgeDrafts) {
        return {
          status: "rejected",
          documentSourceId: normalizedDocumentSourceId,
          reason: "capability_disabled",
        };
      }

      if (source.syncState === "syncing") {
        return {
          status: "skipped",
          documentSourceId: normalizedDocumentSourceId,
          reason: "already_syncing",
        };
      }

      if (source.syncState !== "pending") {
        await registry.markSyncState(normalizedDocumentSourceId, "pending");
      }

      await queue.enqueue({
        idempotencyKey: `manual-source-sync:${normalizedDocumentSourceId}:${requestId()}`,
        documentSourceId: normalizedDocumentSourceId,
        reason: "manual_source_sync",
        enqueuedAt: now(),
        attempts: 0,
      });

      return { status: "enqueued", documentSourceId: normalizedDocumentSourceId };
    },
  };
}

function defaultRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
