import type {
  DocumentFragmentRepository,
  RetrievedDocumentFragment,
} from "../documents/document-fragment-repository.js";
import type { DocumentSourceType } from "../documents/document-source-registry.js";
import type { DocumentSourceGroupGrantRepository } from
  "../documents/document-source-group-grant.js";
import type { EmbeddingProvider } from "../documents/document-semantic-indexer.js";
import type { AuditLog } from "../audit/audit-log.js";
import {
  filterFragmentsByLivePermission,
  type PermissionGuardDecision,
  type RetrievedDocumentFragment as PermissionGuardFragment,
} from "../permissions/permission-guard.js";
import {
  assemblePromptContext,
  type LiveChatMessage,
  type PromptActionItem,
  type PromptDiscussionThread,
  type PromptGroupMemory,
} from "./context-assembly.js";
import type { GroupMemoryContextProvider } from "./group-memory-context-provider.js";
import type { ConversationStateContextProvider } from "../conversation-state/conversation-state-context-provider.js";
import { fuseRetrievedDocumentFragments } from "./retrieval-candidate-fusion.js";
import { selectSourceAwareFragments } from "./source-aware-fragment-selector.js";

const DEFAULT_FRAGMENT_LIMIT = 8;
const MAX_FRAGMENT_LIMIT = 12;
const CANDIDATE_FETCH_MULTIPLIER = 3;
const MAX_CANDIDATE_FRAGMENT_LIMIT = MAX_FRAGMENT_LIMIT * CANDIDATE_FETCH_MULTIPLIER;
const MAX_QUERY_TEXT_CHARS = 4000;

export type QueryEmbeddingProvider = Pick<EmbeddingProvider, "embedTexts">;

export type DocumentRetrievalContextInput = {
  queryText: string;
  supplementalQueryText?: string;
  liveChatMessages: LiveChatMessage[];
  fragmentLimit?: number;
  liveChatLimit?: number;
  askerId?: string;
};

export type DocumentRetrievalContextResult = {
  promptContext: string;
  allowedFragments: RetrievedDocumentFragment[];
  deniedDocumentIds: string[];
  retrievedFragmentCount: number;
  liveChatMessages?: LiveChatMessage[];
  usedGroupMemories: PromptGroupMemory[];
  usedDiscussionThreads?: PromptDiscussionThread[];
  usedActionItems?: PromptActionItem[];
};

export interface DocumentRetrievalContextBuilder {
  buildContext(input: DocumentRetrievalContextInput): Promise<DocumentRetrievalContextResult>;
}

export type DocumentAccessContext = {
  hasCrossGroupGrantBinding: boolean;
  crossGroupGrantValidated: boolean;
};

export function createDocumentRetrievalContextBuilder({
  embeddingProfileId,
  embedder,
  fragments,
  sourceTypes,
  groupId,
  memoryGroupId,
  groupMemoryContextProvider,
  conversationStateGroupId,
  conversationStateContextProvider,
  crossGroupGrantValidator,
  canReadDocument,
  onPermissionDecision,
  auditLog,
}: {
  embeddingProfileId: string;
  embedder: QueryEmbeddingProvider;
  fragments: Pick<DocumentFragmentRepository, "searchSimilarFragments">
    & Partial<Pick<DocumentFragmentRepository, "listFragmentsForSnapshot">>;
  sourceTypes?: DocumentSourceType[];
  groupId?: string;
  memoryGroupId?: string;
  groupMemoryContextProvider?: GroupMemoryContextProvider;
  conversationStateGroupId?: string;
  conversationStateContextProvider?: ConversationStateContextProvider;
  crossGroupGrantValidator?: Pick<DocumentSourceGroupGrantRepository, "validateExact">;
  canReadDocument: (
    documentId: string,
    accessContext?: DocumentAccessContext,
  ) => Promise<boolean>;
  onPermissionDecision?: (decision: PermissionGuardDecision) => Promise<void>;
  auditLog?: AuditLog;
}): DocumentRetrievalContextBuilder {
  return {
    async buildContext(input) {
      const queryText = sanitizeQueryText(input.queryText);
      const queryTexts = input.supplementalQueryText === undefined
        ? [queryText]
        : [queryText, sanitizeQueryText(input.supplementalQueryText)];
      const fragmentLimit = sanitizeFragmentLimit(input.fragmentLimit);
      const usedGroupMemories = await loadGroupMemories({
        groupId: memoryGroupId,
        provider: groupMemoryContextProvider,
      });
      const conversationState = await loadConversationState({
        groupId: conversationStateGroupId,
        provider: conversationStateContextProvider,
        queryText,
        askerId: input.askerId,
      });
      if (fragmentLimit === 0) {
        const liveChatMessages = filterAssistantSourceCoverage(input.liveChatMessages, []);
        return {
          promptContext: assemblePromptContext({
            backgroundDocuments: [],
            groupMemories: usedGroupMemories,
            discussionThreads: conversationState.threads,
            actionItems: conversationState.actions,
            liveChatMessages,
            liveChatLimit: input.liveChatLimit,
          }),
          allowedFragments: [],
          deniedDocumentIds: [],
          retrievedFragmentCount: 0,
          liveChatMessages: cloneLiveChatMessages(liveChatMessages),
          usedGroupMemories: clonePromptGroupMemories(usedGroupMemories),
          usedDiscussionThreads: clonePromptDiscussionThreads(conversationState.threads),
          usedActionItems: clonePromptActionItems(conversationState.actions),
        };
      }

      const queryEmbeddings = await embedQueries(queryTexts, embedder);
      const candidateFragmentLimit = computeCandidateFragmentLimit(fragmentLimit);
      const resultSets = await Promise.all(queryEmbeddings.map((embedding) =>
        fragments.searchSimilarFragments({
          embeddingProfileId,
          embedding,
          limit: candidateFragmentLimit,
          ...(sourceTypes === undefined ? {} : { sourceTypes }),
          ...(groupId === undefined ? {} : { groupId }),
        })));
      const retrievedFragments = fuseRetrievedDocumentFragments({
        primary: resultSets[0] ?? [],
        ...(resultSets[1] === undefined ? {} : { supplemental: resultSets[1] }),
      });
      const meaningfulFragments = retrievedFragments.filter((fragment) =>
        fragment.text.trim().length > 0,
      );
      const promptRankedFragments = await selectSourceAwareFragments({
        queryText,
        rankedFragments: meaningfulFragments,
        fragmentLimit,
      });
      const promptRankedDocumentIds = uniqueDocumentSourceIds(promptRankedFragments);

      const grantPolicyByDocumentId = await resolveCrossGroupGrantPolicies({
        fragments: meaningfulFragments,
        currentGroupId: groupId,
        validator: crossGroupGrantValidator,
      });

      const permissionGuardResult = await filterFragmentsByLivePermission({
        fragments: meaningfulFragments.map(toPermissionGuardFragment),
        canReadDocument: async (documentId) => {
          const grantPolicy = grantPolicyByDocumentId.get(documentId);
          if (grantPolicy?.outcome === "denied") {
            if (grantPolicy.error !== undefined) {
              throw grantPolicy.error;
            }
            return false;
          }
          if (grantPolicy?.outcome === "validated") {
            return canReadDocument(documentId, grantPolicy.accessContext);
          }
          return canReadDocument(documentId);
        },
        onPermissionDecision,
        auditLog,
      });
      const allowedFragmentKeys = new Set(
        permissionGuardResult.allowedFragments.map(createPermissionGuardFragmentKey),
      );
      const allowedRankedFragments = meaningfulFragments.filter((fragment) =>
        allowedFragmentKeys.has(createRetrievedFragmentKey(fragment)),
      );
      const allowedFragments = await selectSourceAwareFragments({
        queryText,
        rankedFragments: allowedRankedFragments,
        fragmentLimit,
        ...(fragments.listFragmentsForSnapshot === undefined
          ? {}
          : {
              listFragmentsForSnapshot: (snapshotId: string) =>
                fragments.listFragmentsForSnapshot!(snapshotId),
            }),
      });
      const deniedDocumentIdSet = new Set(permissionGuardResult.deniedDocumentIds);
      const liveChatMessages = filterAssistantSourceCoverage(input.liveChatMessages, allowedFragments);

      return {
        promptContext: assemblePromptContext({
          backgroundDocuments: allowedFragments.map((fragment, index) => ({
            source: `${fragment.sourceUri}#chunk-${fragment.chunkIndex}`,
            citationRef: `D${index + 1}`,
            text: fragment.text,
          })),
          groupMemories: usedGroupMemories,
          discussionThreads: conversationState.threads,
          actionItems: conversationState.actions,
          liveChatMessages,
          liveChatLimit: input.liveChatLimit,
        }),
        allowedFragments,
        deniedDocumentIds: promptRankedDocumentIds.filter((documentSourceId) =>
          deniedDocumentIdSet.has(documentSourceId),
        ),
        retrievedFragmentCount: retrievedFragments.length,
        liveChatMessages: cloneLiveChatMessages(liveChatMessages),
        usedGroupMemories: clonePromptGroupMemories(usedGroupMemories),
        usedDiscussionThreads: clonePromptDiscussionThreads(conversationState.threads),
        usedActionItems: clonePromptActionItems(conversationState.actions),
      };
    },
  };
}

type ExactCrossGroupGrantBinding = {
  grantId: string;
  version: number;
  grantorGroupId: string;
  granteeGroupId: string;
};

type GrantPolicyResolution =
  | { outcome: "unbound" }
  | { outcome: "validated"; accessContext: DocumentAccessContext }
  | { outcome: "denied"; error?: unknown };

async function resolveCrossGroupGrantPolicies({
  fragments,
  currentGroupId,
  validator,
}: {
  fragments: RetrievedDocumentFragment[];
  currentGroupId: string | undefined;
  validator: Pick<DocumentSourceGroupGrantRepository, "validateExact"> | undefined;
}): Promise<Map<string, GrantPolicyResolution>> {
  const fragmentsBySource = new Map<string, RetrievedDocumentFragment[]>();
  for (const fragment of fragments) {
    const sourceFragments = fragmentsBySource.get(fragment.documentSourceId) ?? [];
    sourceFragments.push(fragment);
    fragmentsBySource.set(fragment.documentSourceId, sourceFragments);
  }

  const entries = await Promise.all([...fragmentsBySource].map(async (
    [documentSourceId, items],
  ): Promise<readonly [string, GrantPolicyResolution]> => {
    const bindings = items.map(readCrossGroupGrantBinding);
    if (bindings.every((binding) => binding === undefined)) {
      return [documentSourceId, { outcome: "unbound" }] as const;
    }
    if (bindings.some((binding) => binding === undefined || binding === "invalid")) {
      return [documentSourceId, { outcome: "denied" }] as const;
    }

    const exactBindings = bindings as ExactCrossGroupGrantBinding[];
    const binding = exactBindings[0]!;
    if (
      items.some((fragment) => fragment.sourceType !== "feishu_group_document") ||
      exactBindings.some((candidate) => !sameGrantBinding(candidate, binding)) ||
      currentGroupId === undefined ||
      binding.granteeGroupId !== currentGroupId ||
      binding.grantorGroupId === binding.granteeGroupId ||
      validator === undefined
    ) {
      return [documentSourceId, { outcome: "denied" }] as const;
    }

    try {
      const valid = await validator.validateExact({
        grantId: binding.grantId,
        version: binding.version,
        documentSourceId,
        grantorGroupId: binding.grantorGroupId,
        granteeGroupId: binding.granteeGroupId,
      });
      return [
        documentSourceId,
        valid
          ? {
              outcome: "validated",
              accessContext: {
                hasCrossGroupGrantBinding: true,
                crossGroupGrantValidated: true,
              },
            }
          : { outcome: "denied" },
      ] as const;
    } catch (error) {
      return [documentSourceId, { outcome: "denied", error }] as const;
    }
  }));

  return new Map<string, GrantPolicyResolution>(entries);
}

function readCrossGroupGrantBinding(
  fragment: RetrievedDocumentFragment,
): ExactCrossGroupGrantBinding | "invalid" | undefined {
  const values = [
    fragment.crossGroupGrantId,
    fragment.crossGroupGrantVersion,
    fragment.crossGroupGrantorGroupId,
    fragment.crossGroupGranteeGroupId,
  ];
  if (values.every((value) => value === undefined)) {
    return undefined;
  }
  if (
    !isNonBlankReference(fragment.crossGroupGrantId) ||
    !Number.isSafeInteger(fragment.crossGroupGrantVersion) ||
    fragment.crossGroupGrantVersion === undefined ||
    fragment.crossGroupGrantVersion < 1 ||
    !isNonBlankReference(fragment.crossGroupGrantorGroupId) ||
    !isNonBlankReference(fragment.crossGroupGranteeGroupId)
  ) {
    return "invalid";
  }
  return {
    grantId: fragment.crossGroupGrantId,
    version: fragment.crossGroupGrantVersion,
    grantorGroupId: fragment.crossGroupGrantorGroupId,
    granteeGroupId: fragment.crossGroupGranteeGroupId,
  };
}

function isNonBlankReference(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function sameGrantBinding(
  left: ExactCrossGroupGrantBinding,
  right: ExactCrossGroupGrantBinding,
): boolean {
  return left.grantId === right.grantId &&
    left.version === right.version &&
    left.grantorGroupId === right.grantorGroupId &&
    left.granteeGroupId === right.granteeGroupId;
}

function uniqueDocumentSourceIds(
  fragments: readonly Pick<RetrievedDocumentFragment, "documentSourceId">[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const fragment of fragments) {
    if (!seen.has(fragment.documentSourceId)) {
      seen.add(fragment.documentSourceId);
      result.push(fragment.documentSourceId);
    }
  }
  return result;
}

async function loadConversationState({
  groupId,
  provider,
  queryText,
  askerId,
}: {
  groupId: string | undefined;
  provider: ConversationStateContextProvider | undefined;
  queryText: string;
  askerId: string | undefined;
}): Promise<{ threads: PromptDiscussionThread[]; actions: PromptActionItem[] }> {
  if (groupId === undefined || provider === undefined) {
    return { threads: [], actions: [] };
  }
  return provider.loadRelevant({
    groupId,
    queryText,
    ...(askerId === undefined ? {} : { askerId }),
    limit: 6,
  });
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

function clonePromptDiscussionThreads(
  threads: PromptDiscussionThread[],
): PromptDiscussionThread[] {
  return threads.map((thread) => ({ ...thread, evidenceMessageIds: [...thread.evidenceMessageIds] }));
}

function clonePromptActionItems(actions: PromptActionItem[]): PromptActionItem[] {
  return actions.map((action) => ({
    ...action,
    ...(action.dueAt === undefined ? {} : { dueAt: new Date(action.dueAt) }),
    evidenceMessageIds: [...action.evidenceMessageIds],
  }));
}

function sanitizeQueryText(value: string): string {
  if (value.length > MAX_QUERY_TEXT_CHARS) {
    throw new Error(`queryText must be at most ${MAX_QUERY_TEXT_CHARS} characters`);
  }

  return value;
}

async function embedQueries(
  queryTexts: string[],
  embedder: QueryEmbeddingProvider,
): Promise<number[][]> {
  const embeddings = await embedder.embedTexts(queryTexts);

  if (embeddings.length !== queryTexts.length) {
    throw new Error(queryTexts.length === 1
      ? "query embedding provider must return exactly one vector"
      : `query embedding provider must return exactly ${queryTexts.length} vectors`);
  }

  for (const embedding of embeddings) {
    if (embedding.length === 0) {
      throw new Error("query embedding must not be empty");
    }

    for (const value of embedding) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("query embedding contains invalid value");
      }
    }
  }

  return embeddings;
}

function cloneLiveChatMessages(messages: LiveChatMessage[]): LiveChatMessage[] {
  return messages.map((message) => ({ ...message,
    ...(message.underlyingDocumentSources === undefined ? {} : { underlyingDocumentSources: message.underlyingDocumentSources.map(source => ({ ...source })) }),
  }));
}

// Receipt traces are generated from all current allowed fragments, including uncited ones.
// Require exact coverage before exposing a derived assistant draft so its next receipt retains
// the original permissions and snapshot/grant checks without inventing a factual fragment.
function filterAssistantSourceCoverage(
  messages: LiveChatMessage[],
  allowedFragments: RetrievedDocumentFragment[],
): LiveChatMessage[] {
  return messages.filter(message => {
    if (message.role !== "assistant" || message.underlyingDocumentSources === undefined) return true;
    const sources = message.underlyingDocumentSources;
    return sources.length <= 2000 && sources.every(source => allowedFragments.some(fragment => (
      fragment.documentSourceId === source.documentSourceId
      && fragment.documentSnapshotId === source.documentSnapshotId
      && fragment.crossGroupGrantId === source.crossGroupGrantId
      && fragment.crossGroupGrantVersion === source.crossGroupGrantVersion
      && fragment.crossGroupGrantorGroupId === source.crossGroupGrantorGroupId
      && fragment.crossGroupGranteeGroupId === source.crossGroupGranteeGroupId
    )));
  });
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
