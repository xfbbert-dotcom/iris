import type {
  DocumentFragmentRepository,
  RetrievedDocumentFragment,
} from "../documents/document-fragment-repository.js";
import type { DocumentSourceType } from "../documents/document-source-registry.js";
import type { EmbeddingProvider } from "../documents/document-semantic-indexer.js";
import type { AuditLog } from "../audit/audit-log.js";
import {
  filterFragmentsByLivePermission,
  type RetrievedDocumentFragment as PermissionGuardFragment,
} from "../permissions/permission-guard.js";
import {
  assemblePromptContext,
  type LiveChatMessage,
  type PromptGroupMemory,
} from "./context-assembly.js";
import type { GroupMemoryContextProvider } from "./group-memory-context-provider.js";

const DEFAULT_FRAGMENT_LIMIT = 8;
const MAX_FRAGMENT_LIMIT = 12;
const CANDIDATE_FETCH_MULTIPLIER = 3;
const MAX_CANDIDATE_FRAGMENT_LIMIT = MAX_FRAGMENT_LIMIT * CANDIDATE_FETCH_MULTIPLIER;
const MAX_QUERY_TEXT_CHARS = 4000;

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
  usedGroupMemories: PromptGroupMemory[];
};

export interface DocumentRetrievalContextBuilder {
  buildContext(input: DocumentRetrievalContextInput): Promise<DocumentRetrievalContextResult>;
}

export function createDocumentRetrievalContextBuilder({
  embeddingProfileId,
  embedder,
  fragments,
  sourceTypes,
  groupId,
  memoryGroupId,
  groupMemoryContextProvider,
  canReadDocument,
  auditLog,
}: {
  embeddingProfileId: string;
  embedder: QueryEmbeddingProvider;
  fragments: Pick<DocumentFragmentRepository, "searchSimilarFragments">;
  sourceTypes?: DocumentSourceType[];
  groupId?: string;
  memoryGroupId?: string;
  groupMemoryContextProvider?: GroupMemoryContextProvider;
  canReadDocument: (documentId: string) => Promise<boolean>;
  auditLog?: AuditLog;
}): DocumentRetrievalContextBuilder {
  return {
    async buildContext(input) {
      const queryText = sanitizeQueryText(input.queryText);
      const fragmentLimit = sanitizeFragmentLimit(input.fragmentLimit);
      const usedGroupMemories = await loadGroupMemories({
        groupId: memoryGroupId,
        provider: groupMemoryContextProvider,
      });
      if (fragmentLimit === 0) {
        return {
          promptContext: assemblePromptContext({
            backgroundDocuments: [],
            groupMemories: usedGroupMemories,
            liveChatMessages: input.liveChatMessages,
            liveChatLimit: input.liveChatLimit,
          }),
          allowedFragments: [],
          deniedDocumentIds: [],
          retrievedFragmentCount: 0,
          usedGroupMemories: clonePromptGroupMemories(usedGroupMemories),
        };
      }

      const queryEmbedding = await embedQuery(queryText, embedder);
      const candidateFragmentLimit = computeCandidateFragmentLimit(fragmentLimit);
      const retrievedFragments = await fragments.searchSimilarFragments({
        embeddingProfileId,
        embedding: queryEmbedding,
        limit: candidateFragmentLimit,
        ...(sourceTypes === undefined ? {} : { sourceTypes }),
        ...(groupId === undefined ? {} : { groupId }),
      });
      const meaningfulFragments = retrievedFragments.filter((fragment) =>
        fragment.text.trim().length > 0,
      );

      const permissionGuardResult = await filterFragmentsByLivePermission({
        fragments: meaningfulFragments.map(toPermissionGuardFragment),
        canReadDocument,
        auditLog,
      });
      const allowedFragmentKeys = new Set(
        permissionGuardResult.allowedFragments.map(createPermissionGuardFragmentKey),
      );
      const allowedFragments = meaningfulFragments.filter((fragment) =>
        allowedFragmentKeys.has(createRetrievedFragmentKey(fragment)),
      ).slice(0, fragmentLimit);

      return {
        promptContext: assemblePromptContext({
          backgroundDocuments: allowedFragments.map((fragment) => ({
            source: `${fragment.sourceUri}#chunk-${fragment.chunkIndex}`,
            text: fragment.text,
          })),
          groupMemories: usedGroupMemories,
          liveChatMessages: input.liveChatMessages,
          liveChatLimit: input.liveChatLimit,
        }),
        allowedFragments,
        deniedDocumentIds: permissionGuardResult.deniedDocumentIds,
        retrievedFragmentCount: retrievedFragments.length,
        usedGroupMemories: clonePromptGroupMemories(usedGroupMemories),
      };
    },
  };
}

async function loadGroupMemories({
  groupId,
  provider,
}: {
  groupId: string | undefined;
  provider: GroupMemoryContextProvider | undefined;
}): Promise<PromptGroupMemory[]> {
  if (groupId === undefined || provider === undefined) {
    return [];
  }
  return provider.loadActiveMemories({ groupId, limit: 8 });
}

function clonePromptGroupMemories(memories: PromptGroupMemory[]): PromptGroupMemory[] {
  return memories.map((memory) => ({
    ...memory,
    evidenceMessageIds: [...memory.evidenceMessageIds],
  }));
}

function sanitizeQueryText(value: string): string {
  if (value.length > MAX_QUERY_TEXT_CHARS) {
    throw new Error(`queryText must be at most ${MAX_QUERY_TEXT_CHARS} characters`);
  }

  return value;
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
  if (embedding.length === 0) {
    throw new Error("query embedding must not be empty");
  }

  for (const value of embedding) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("query embedding contains invalid value");
    }
  }

  return embedding;
}

function sanitizeFragmentLimit(value: number | undefined): number {
  if (
    value !== undefined &&
    (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("fragmentLimit must be a finite safe-magnitude number");
  }
  if (value === undefined) {
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

function createRetrievedFragmentKey(fragment: RetrievedDocumentFragment): string {
  return `${fragment.id}\u0000${fragment.documentSourceId}`;
}

function createPermissionGuardFragmentKey(fragment: PermissionGuardFragment): string {
  return `${fragment.id}\u0000${fragment.documentId}`;
}
