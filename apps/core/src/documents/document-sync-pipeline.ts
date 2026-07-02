import type { DocumentSnapshot } from "./document-snapshot-repository.js";
import type { DocumentSource, DocumentSyncState } from "./document-source-registry.js";

type MaybePromise<T> = T | Promise<T>;

export interface DocumentSyncRegistryReader {
  listSources(): Promise<DocumentSource[]>;
}

export interface DocumentSyncRunnerRegistry {
  findSourceById(id: string): MaybePromise<DocumentSource | undefined>;
  markSyncState(id: string, syncState: DocumentSyncState): MaybePromise<DocumentSource>;
}

export type DocumentBodyFetchResult = {
  bodyText: string;
  sourceVersion?: string;
  fetchedAt: Date;
};

export interface DocumentBodyFetcher {
  fetch(source: DocumentSource): Promise<DocumentBodyFetchResult>;
}

export interface DocumentSyncSnapshotWriter {
  insertSucceededSnapshot(input: {
    documentSourceId: string;
    sourceUri: string;
    bodyText: string;
    sourceVersion?: string;
    fetchedAt: Date;
  }): MaybePromise<DocumentSnapshot>;
  insertFailedSnapshot(input: {
    documentSourceId: string;
    sourceUri: string;
    errorMessage: string;
    fetchedAt: Date;
  }): MaybePromise<DocumentSnapshot>;
}

export interface SyncedSnapshotReindexer {
  enqueueSyncedSnapshotReindex(input: { documentSnapshotId: string }): MaybePromise<void>;
}

export interface DocumentSyncPlanner {
  listSyncCandidates(): Promise<DocumentSource[]>;
}

export interface DocumentSyncRunner {
  syncSourceById(sourceId: string): Promise<DocumentSyncResult>;
}

export type DocumentSyncResult =
  | { status: "synced"; source: DocumentSource; snapshot: DocumentSnapshot }
  | {
      status: "failed";
      source: DocumentSource;
      snapshot: DocumentSnapshot;
      errorMessage: string;
    }
  | {
      status: "skipped";
      source: DocumentSource;
      reason: "already_syncing" | "already_synced";
    }
  | {
      status: "rejected";
      source: DocumentSource;
      reason: "permission_denied" | "capability_disabled";
    }
  | { status: "not_found"; sourceId: string };

export function createDocumentSyncPlanner({
  registry,
}: {
  registry: DocumentSyncRegistryReader;
}): DocumentSyncPlanner {
  return {
    async listSyncCandidates() {
      const sources = await registry.listSources();

      return sources.filter(isSyncCandidate);
    },
  };
}

export function createDocumentSyncRunner({
  registry,
  snapshots,
  fetcher,
  syncedSnapshotReindexer,
  now = () => new Date(),
}: {
  registry: DocumentSyncRunnerRegistry;
  snapshots: DocumentSyncSnapshotWriter;
  fetcher: DocumentBodyFetcher;
  syncedSnapshotReindexer?: SyncedSnapshotReindexer;
  now?: () => Date;
}): DocumentSyncRunner {
  return {
    async syncSourceById(sourceId) {
      const source = await registry.findSourceById(sourceId);

      if (source === undefined) {
        return { status: "not_found", sourceId };
      }

      if (source.permissionState === "denied") {
        return { status: "rejected", source, reason: "permission_denied" };
      }

      if (!source.canUseForAnswering && !source.canUseForKnowledgeDrafts) {
        return { status: "rejected", source, reason: "capability_disabled" };
      }

      if (source.syncState === "syncing") {
        return { status: "skipped", source, reason: "already_syncing" };
      }

      if (source.syncState === "synced") {
        return { status: "skipped", source, reason: "already_synced" };
      }

      await registry.markSyncState(source.id, "syncing");

      let fetchResult: DocumentBodyFetchResult;

      try {
        fetchResult = await fetcher.fetch(source);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        const snapshot = await snapshots.insertFailedSnapshot({
          documentSourceId: source.id,
          sourceUri: source.sourceUri,
          errorMessage,
          fetchedAt: now(),
        });
        await registry.markSyncState(source.id, "failed");

        return { status: "failed", source, snapshot, errorMessage };
      }

      const snapshot = await snapshots.insertSucceededSnapshot({
        documentSourceId: source.id,
        sourceUri: source.sourceUri,
        bodyText: fetchResult.bodyText,
        sourceVersion: fetchResult.sourceVersion,
        fetchedAt: fetchResult.fetchedAt,
      });
      await registry.markSyncState(source.id, "synced");
      await syncedSnapshotReindexer?.enqueueSyncedSnapshotReindex({
        documentSnapshotId: snapshot.id,
      });

      return { status: "synced", source, snapshot };
    },
  };
}

export function isSyncCandidate(source: DocumentSource): boolean {
  return (
    source.syncState === "pending" &&
    source.permissionState !== "denied" &&
    (source.canUseForAnswering || source.canUseForKnowledgeDrafts)
  );
}
