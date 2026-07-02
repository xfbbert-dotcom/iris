import type {
  DocumentFragmentRepository,
  RetrievedDocumentFragment,
} from "../documents/document-fragment-repository.js";
import type { EmbeddingProvider } from "../documents/document-semantic-indexer.js";
import type { AuditLog } from "../audit/audit-log.js";
import {
  filterFragmentsByLivePermission,
  type RetrievedDocumentFragment as PermissionGuardFragment,
} from "../permissions/permission-guard.js";
import { assemblePromptContext, type LiveChatMessage } from "./context-assembly.js";

export type QueryEmbeddingProvider = Pick<EmbeddingProvider, "embedTexts">;

export type DocumentRetrievalContextInput = {
  queryText: string;
  liveChatMessages: LiveChatMessage[];
  fragmentLimit?: number;
  liveChatLimit?: number;
};

export type DocumentRetrievalContextResult = {
  promptContext: string;
  allowedFragments: RetrievedDocumentFragment[];
  deniedDocumentIds: string[];
  retrievedFragmentCount: number;
};

export interface DocumentRetrievalContextBuilder {
  buildContext(input: DocumentRetrievalContextInput): Promise<DocumentRetrievalContextResult>;
}

export function createDocumentRetrievalContextBuilder({
  embeddingProfileId,
  embedder,
  fragments,
  canReadDocument,
  auditLog,
}: {
  embeddingProfileId: string;
  embedder: QueryEmbeddingProvider;
  fragments: Pick<DocumentFragmentRepository, "searchSimilarFragments">;
  canReadDocument: (documentId: string) => Promise<boolean>;
  auditLog?: AuditLog;
}): DocumentRetrievalContextBuilder {
  return {
    async buildContext(input) {
      const queryEmbedding = await embedQuery(input.queryText, embedder);
      const fragmentLimit = sanitizeFragmentLimit(input.fragmentLimit);
      const retrievedFragments = await fragments.searchSimilarFragments({
        embeddingProfileId,
        embedding: queryEmbedding,
        limit: fragmentLimit,
      });

      const permissionGuardResult = await filterFragmentsByLivePermission({
        fragments: retrievedFragments.map(toPermissionGuardFragment),
        canReadDocument,
        auditLog,
      });
      const allowedFragmentIds = new Set(
        permissionGuardResult.allowedFragments.map((fragment) => fragment.id),
      );
      const allowedFragments = retrievedFragments.filter((fragment) =>
        allowedFragmentIds.has(fragment.id),
      );

      return {
        promptContext: assemblePromptContext({
          backgroundDocuments: allowedFragments.map((fragment) => ({
            source: `${fragment.sourceUri}#chunk-${fragment.chunkIndex}`,
            text: fragment.text,
          })),
          liveChatMessages: input.liveChatMessages,
          liveChatLimit: input.liveChatLimit,
        }),
        allowedFragments,
        deniedDocumentIds: permissionGuardResult.deniedDocumentIds,
        retrievedFragmentCount: retrievedFragments.length,
      };
    },
  };
}

async function embedQuery(queryText: string, embedder: QueryEmbeddingProvider): Promise<number[]> {
  const embeddings = await embedder.embedTexts([queryText]);

  if (embeddings.length !== 1) {
    throw new Error("query embedding provider must return exactly one vector");
  }

  const embedding = embeddings[0];
  if (embedding === undefined) {
    throw new Error("query embedding provider must return exactly one vector");
  }

  for (const value of embedding) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("query embedding contains invalid value");
    }
  }

  return embedding;
}

function sanitizeFragmentLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 8;
  }

  return Math.max(0, Math.floor(value));
}

function toPermissionGuardFragment(fragment: RetrievedDocumentFragment): PermissionGuardFragment {
  return {
    id: fragment.id,
    documentId: fragment.documentSourceId,
    text: fragment.text,
  };
}
