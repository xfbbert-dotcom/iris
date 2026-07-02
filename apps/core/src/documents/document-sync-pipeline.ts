import type { DocumentSource } from "./document-source-registry.js";

export interface DocumentSyncRegistryReader {
  listSources(): Promise<DocumentSource[]>;
}

export interface DocumentSyncPlanner {
  listSyncCandidates(): Promise<DocumentSource[]>;
}

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

export function isSyncCandidate(source: DocumentSource): boolean {
  return (
    source.syncState === "pending" &&
    source.permissionState !== "denied" &&
    (source.canUseForAnswering || source.canUseForKnowledgeDrafts)
  );
}
