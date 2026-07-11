import {
  MAX_DOCUMENT_SYNC_JOB_ID_CHARS,
  createDocumentSyncIdempotencyKey,
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
}: {
  registry: ManualDocumentSyncPlannerRegistry;
  queue: Pick<DocumentSyncQueue, "enqueue">;
  now?: () => Date;
}): ManualDocumentSyncPlanner {
  return {
    async enqueueSource({ documentSourceId }) {
      const normalizedDocumentSourceId = normalizeDocumentSourceId(documentSourceId);
      const source = await registry.findSourceById(normalizedDocumentSourceId);

      if (source === undefined) {
        return { status: "not_found", documentSourceId: normalizedDocumentSourceId };
      }

      if (source.permissionState === "denied") {
        if (source.syncState === "syncing") {
          await registry.markSyncState(normalizedDocumentSourceId, "pending");
        }

        return {
          status: "rejected",
          documentSourceId: normalizedDocumentSourceId,
          reason: "permission_denied",
        };
      }

      if (!source.canUseForAnswering && !source.canUseForKnowledgeDrafts) {
        if (source.syncState === "syncing") {
          await registry.markSyncState(normalizedDocumentSourceId, "pending");
        }

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

      const previousSyncState = source.syncState;
      if (previousSyncState !== "pending") {
        await registry.markSyncState(normalizedDocumentSourceId, "pending");
      }

      try {
        await queue.enqueue({
          idempotencyKey: createDocumentSyncIdempotencyKey({
            documentSourceId: normalizedDocumentSourceId,
          }),
          documentSourceId: normalizedDocumentSourceId,
          reason: "manual_source_sync",
          enqueuedAt: now(),
          attempts: 0,
        });
      } catch (error) {
        if (previousSyncState !== "pending") {
          await restoreSyncStateAfterFailedEnqueue(
            registry,
            normalizedDocumentSourceId,
            previousSyncState,
          );
        }
        throw error;
      }

      return { status: "enqueued", documentSourceId: normalizedDocumentSourceId };
    },
  };
}

async function restoreSyncStateAfterFailedEnqueue(
  registry: ManualDocumentSyncPlannerRegistry,
  documentSourceId: string,
  syncState: DocumentSyncState,
): Promise<void> {
  try {
    await registry.markSyncState(documentSourceId, syncState);
  } catch {
    // Preserve the queue failure that prevented a real sync job from existing.
  }
}

function normalizeDocumentSourceId(documentSourceId: string): string {
  const normalized = documentSourceId.trim();
  if (normalized.length === 0) {
    throw new Error("documentSourceId must be nonblank");
  }
  if (normalized.length > MAX_DOCUMENT_SYNC_JOB_ID_CHARS) {
    throw new Error(
      `documentSourceId must be at most ${MAX_DOCUMENT_SYNC_JOB_ID_CHARS} characters`,
    );
  }

  return normalized;
}
