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

const DEFAULT_FRAGMENT_LIMIT = 8;
const MAX_FRAGMENT_LIMIT = 12;
const CANDIDATE_FETCH_MULTIPLIER = 3;
const MAX_CANDIDATE_FRAGMENT_LIMIT = MAX_FRAGMENT_LIMIT * CANDIDATE_FETCH_MULTIPLIER;

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
      const fragmentLimit = sanitizeFragmentLimit(input.fragmentLimit);
      if (fragmentLimit === 0) {
        return {
          promptContext: assemblePromptContext({
            backgroundDocuments: [],
            liveChatMessages: input.liveChatMessages,
            liveChatLimit: input.liveChatLimit,
          }),
          allowedFragments: [],
          deniedDocumentIds: [],
          retrievedFragmentCount: 0,
        };
      }

      const queryEmbedding = await embedQuery(input.queryText, embedder);
      const candidateFragmentLimit = computeCandidateFragmentLimit(fragmentLimit);
      const retrievedFragments = await fragments.searchSimilarFragments({
        embeddingProfileId,
        embedding: queryEmbedding,
        limit: candidateFragmentLimit,
      });
      const meaningfulFragments = retrievedFragments.filter((fragment) =>
        fragment.text.trim().length > 0,
      );

      const permissionGuardResult = await filterFragmentsByLivePermission({
        fragments: meaningfulFragments.map(toPermissionGuardFragment),
        canReadDocument,
        auditLog,
      });
      const allowedFragmentIds = new Set(
        permissionGuardResult.allowedFragments.map((fragment) => fragment.id),
      );
      const allowedFragments = meaningfulFragments.filter((fragment) =>
        allowedFragmentIds.has(fragment.id),
      ).slice(0, fragmentLimit);

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
    return DEFAULT_FRAGMENT_LIMIT;
  }

  return Math.min(MAX_FRAGMENT_LIMIT, Math.max(0, Math.floor(value)));
}

function computeCandidateFragmentLimit(fragmentLimit: number): number {
  return Math.min(MAX_CANDIDATE_FRAGMENT_LIMIT, fragmentLimit * CANDIDATE_FETCH_MULTIPLIER);
}

function toPermissionGuardFragment(fragment: RetrievedDocumentFragment): PermissionGuardFragment {
  return {
    id: fragment.id,
    documentId: fragment.documentSourceId,
    text: fragment.text,
  };
}
