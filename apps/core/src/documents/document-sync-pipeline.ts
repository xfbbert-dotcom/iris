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
  }): MaybePromise<unknown>;
  insertFailedSnapshot(input: {
    documentSourceId: string;
    sourceUri: string;
    errorMessage: string;
    fetchedAt: Date;
  }): MaybePromise<unknown>;
}

export interface DocumentSyncPlanner {
  listSyncCandidates(): Promise<DocumentSource[]>;
}

export interface DocumentSyncRunner {
  syncSource(sourceId: string): Promise<DocumentSyncResult>;
}

export type DocumentSyncResult =
  | { status: "synced"; sourceId: string }
  | { status: "failed"; sourceId: string; errorMessage: string }
  | { status: "skipped"; reason: "already_syncing" | "already_synced" }
  | { status: "rejected"; reason: "permission_denied" | "capability_disabled" }
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
  now = () => new Date(),
}: {
  registry: DocumentSyncRunnerRegistry;
  snapshots: DocumentSyncSnapshotWriter;
  fetcher: DocumentBodyFetcher;
  now?: () => Date;
}): DocumentSyncRunner {
  return {
    async syncSource(sourceId) {
      const source = await registry.findSourceById(sourceId);

      if (source === undefined) {
        return { status: "not_found", sourceId };
      }

      if (source.permissionState === "denied") {
        return { status: "rejected", reason: "permission_denied" };
      }

      if (!source.canUseForAnswering && !source.canUseForKnowledgeDrafts) {
        return { status: "rejected", reason: "capability_disabled" };
      }

      if (source.syncState === "syncing") {
        return { status: "skipped", reason: "already_syncing" };
      }

      if (source.syncState === "synced") {
        return { status: "skipped", reason: "already_synced" };
      }

      await registry.markSyncState(source.id, "syncing");

      try {
        const fetchResult = await fetcher.fetch(source);

        await snapshots.insertSucceededSnapshot({
          documentSourceId: source.id,
          sourceUri: source.sourceUri,
          bodyText: fetchResult.bodyText,
          sourceVersion: fetchResult.sourceVersion,
          fetchedAt: fetchResult.fetchedAt,
        });
        await registry.markSyncState(source.id, "synced");

        return { status: "synced", sourceId: source.id };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        await snapshots.insertFailedSnapshot({
          documentSourceId: source.id,
          sourceUri: source.sourceUri,
          errorMessage,
          fetchedAt: now(),
        });
        await registry.markSyncState(source.id, "failed");

        return { status: "failed", sourceId: source.id, errorMessage };
      }
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
