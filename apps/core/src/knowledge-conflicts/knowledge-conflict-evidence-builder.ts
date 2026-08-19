import type { ActionProposalRepository } from "../action-approvals/action-proposal-repository.js";
import type {
  ConversationMessageEvidence,
  ConversationMessageRepository,
} from "../conversation/conversation-message-repository.js";
import type {
  DocumentFragmentRepository,
  DocumentFragment,
  RetrievedDocumentFragmentCandidate,
  RetrievedDocumentFragment,
} from "../documents/document-fragment-repository.js";
import type {
  DocumentSnapshotMetadata,
  DocumentSnapshotRepository,
} from "../documents/document-snapshot-repository.js";
import type { DocumentSource } from "../documents/document-source-registry.js";
import type { EmbeddingProvider } from "../documents/document-semantic-indexer.js";
import type { FeishuDocumentPermissionChecker } from "../permissions/feishu-document-permission-checker.js";
import type { GroupMemory } from "../memory/group-memory-repository.js";
import { selectSourceAwareFragments } from "../memory/source-aware-fragment-selector.js";
import { KNOWLEDGE_CONFLICT_SUBJECT_MAX_CHARS } from "./knowledge-conflict.js";

const MAX_DOCUMENT_FRAGMENTS = 12;
const MAX_SOURCE_MESSAGES = 10;
const CANDIDATE_FETCH_LIMIT = 36;
const PUBLICATION_TARGET_LIMIT = 100;

export type KnowledgeConflictDetectionInput = {
  subject: {
    referenceId: "M1";
    groupMemoryId: string;
    groupId: string;
    category: GroupMemory["category"];
    content: string;
  };
  groupEvidence: Array<{
    referenceId: `C${number}`;
    conversationMessageId: string;
    sentAt: Date;
    text: string;
  }>;
  documentEvidence: Array<{
    referenceId: `D${number}`;
    documentSourceId: string;
    sourceUri: string;
    sourceTitle?: string;
    authorizedSpaceId: string;
    sourceUpdatedAt: Date;
    documentSnapshotId: string;
    sourceVersion?: string;
    snapshotContentHash: string;
    snapshotFetchedAt: Date;
    documentFragmentId: string;
    fragmentContentHash: string;
    text: string;
  }>;
};

export type CurrentConflictFingerprint = {
  memory: {
    groupMemoryId: string;
    groupId: string;
    updatedAt: Date;
  };
  messages: Array<{
    referenceId: `C${number}`;
    conversationMessageId: string;
    chatId: string;
    sentAt: Date;
  }>;
  documents: Array<{
    referenceId: `D${number}`;
    documentSourceId: string;
    sourceUpdatedAt: Date;
    documentSnapshotId: string;
    sourceVersion?: string;
    snapshotContentHash: string;
    snapshotFetchedAt: Date;
    documentFragmentId: string;
    fragmentContentHash: string;
  }>;
  publicationTarget: {
    id: string;
    version: number;
    spaceId: string;
  };
  permissionAttestedAt: Date;
};

export type KnowledgeConflictEvidenceBuildResult =
  | {
      outcome: "ready";
      input: KnowledgeConflictDetectionInput;
      fingerprint: CurrentConflictFingerprint;
    }
  | { outcome: "insufficient_evidence"; reasonCode: string }
  | { outcome: "permission_blocked"; reasonCode: string }
  | { outcome: "retryable_failure"; reasonCode: string };

export type KnowledgeConflictEvidenceBuilderDependencies = {
  embeddingProfileId: string;
  embedder: Pick<EmbeddingProvider, "embedTexts">;
  fragments: Pick<
    DocumentFragmentRepository,
    "searchSimilarFragmentCandidates" | "findFragmentsByIds"
  >;
  messages: Pick<ConversationMessageRepository, "findByIds">;
  documentSources: {
    findSourceById(id: string): Promise<DocumentSource | undefined>;
  };
  snapshots: Pick<DocumentSnapshotRepository, "findLatestSnapshotMetadataForSources">;
  publicationTargets: Pick<ActionProposalRepository, "listTargetPolicies">;
  permissionChecker: FeishuDocumentPermissionChecker;
  now?: () => Date;
};

export type KnowledgeConflictEvidenceBuilder = {
  build(input: { memory: GroupMemory }): Promise<KnowledgeConflictEvidenceBuildResult>;
};

export function createKnowledgeConflictEvidenceBuilder(
  dependencies: KnowledgeConflictEvidenceBuilderDependencies,
): KnowledgeConflictEvidenceBuilder {
  const now = dependencies.now ?? (() => new Date());

  return {
    async build({ memory }) {
      const memoryContent = normalizeMemoryContent(memory.content);
      if (!isEligibleMemory(memory) || memoryContent === undefined) {
        return insufficient("memory_ineligible");
      }
      if (memoryContent.length > KNOWLEDGE_CONFLICT_SUBJECT_MAX_CHARS) {
        return insufficient("subject_unbounded");
      }
      const evidenceMessageIds = [...new Set(memory.evidenceMessageIds)].sort();
      if (evidenceMessageIds.length === 0 || evidenceMessageIds.length > MAX_SOURCE_MESSAGES) {
        return insufficient("chronology_unproven");
      }

      let messages: ConversationMessageEvidence[];
      try {
        messages = await dependencies.messages.findByIds({
          chatId: memory.groupId,
          ids: evidenceMessageIds,
        });
      } catch {
        return retryable("message_lookup_failed");
      }
      if (!validSourceMessages(messages, evidenceMessageIds, memory.groupId)) {
        return insufficient("chronology_unproven");
      }

      let policies: Awaited<ReturnType<typeof dependencies.publicationTargets.listTargetPolicies>>;
      try {
        policies = await dependencies.publicationTargets.listTargetPolicies({
          enabled: true,
          limit: PUBLICATION_TARGET_LIMIT,
        });
      } catch {
        return retryable("target_policy_lookup_failed");
      }
      const matchingPolicies = policies.filter((policy) =>
        policy.enabled
        && policy.allowedGroupIds.includes(memory.groupId)
        && policy.allowedRiskLevels.includes("medium"));
      if (policies.length === PUBLICATION_TARGET_LIMIT) {
        return insufficient("target_policy_ambiguous");
      }
      if (matchingPolicies.length !== 1) {
        return insufficient("target_policy_unavailable");
      }
      const publicationTarget = matchingPolicies[0]!;

      let embedding: number[];
      try {
        const embeddings = await dependencies.embedder.embedTexts([memoryContent]);
        embedding = embeddings[0] ?? [];
        if (embeddings.length !== 1 || !validEmbedding(embedding)) {
          return retryable("embedding_invalid");
        }
      } catch {
        return retryable("embedding_failed");
      }

      let rankedCandidates: RetrievedDocumentFragmentCandidate[];
      try {
        rankedCandidates = await dependencies.fragments.searchSimilarFragmentCandidates({
          embeddingProfileId: dependencies.embeddingProfileId,
          embedding,
          limit: CANDIDATE_FETCH_LIMIT,
          sourceTypes: ["authorized_wiki_document"],
          usage: "knowledge_drafts",
          authorizedSpaceId: publicationTarget.spaceId,
        });
      } catch {
        return retryable("fragment_search_failed");
      }
      if (rankedCandidates.length === 0) {
        return insufficient("no_authorized_document_evidence");
      }

      const sources = await loadSources(dependencies.documentSources, rankedCandidates);
      if (sources === undefined) {
        return retryable("source_lookup_failed");
      }
      const eligibleSourceIds = new Set([...sources.entries()]
        .filter(([, source]) => sourceEligible(source, publicationTarget.spaceId))
        .map(([id]) => id));
      const sourceEligibleCandidates = rankedCandidates.filter((candidate) =>
        eligibleSourceIds.has(candidate.documentSourceId));
      if (sourceEligibleCandidates.length === 0) {
        return insufficient("no_authorized_document_evidence");
      }

      let snapshots: DocumentSnapshotMetadata[];
      try {
        snapshots = await dependencies.snapshots.findLatestSnapshotMetadataForSources(
          [...eligibleSourceIds].sort(),
        );
      } catch {
        return retryable("snapshot_lookup_failed");
      }
      const snapshotBySourceId = new Map(snapshots.map((item) => [item.documentSourceId, item]));
      const currentChronologicalCandidates = sourceEligibleCandidates.filter((candidate) => {
        const snapshot = snapshotBySourceId.get(candidate.documentSourceId);
        return snapshot !== undefined
          && snapshot.fetchStatus === "succeeded"
          && snapshot.contentHash !== undefined
          && snapshot.documentSourceId === candidate.documentSourceId
          && snapshot.id === candidate.documentSnapshotId
          && validDate(snapshot.fetchedAt)
          && messages.every((message) => message.sentAt.getTime() > snapshot.fetchedAt.getTime());
      });
      if (currentChronologicalCandidates.length === 0) {
        return insufficient("chronology_unproven");
      }

      const permissionSourceIds = uniqueSourceIds(currentChronologicalCandidates);
      const readableSourceIds = new Set<string>();
      for (const sourceId of permissionSourceIds) {
        const source = sources.get(sourceId)!;
        try {
          if (await dependencies.permissionChecker.canReadSource(source)) {
            readableSourceIds.add(sourceId);
          }
        } catch {
          return retryable("permission_check_failed");
        }
      }
      if (readableSourceIds.size === 0) {
        return permissionBlocked("permission_denied");
      }
      const permissionApprovedCandidates = currentChronologicalCandidates.filter((candidate) =>
        readableSourceIds.has(candidate.documentSourceId));
      const permissionAttestedAt = now();
      if (!validDate(permissionAttestedAt)) {
        return retryable("permission_attestation_invalid");
      }

      let materializedFragments: RetrievedDocumentFragment[];
      try {
        const loaded = await dependencies.fragments.findFragmentsByIds({
          ids: permissionApprovedCandidates.map((candidate) => candidate.id),
        });
        const loadedById = new Map(loaded.map((fragment) => [fragment.id, fragment]));
        materializedFragments = [];
        for (const candidate of permissionApprovedCandidates) {
          const fragment = loadedById.get(candidate.id);
          if (fragment === undefined || !sameFragmentIdentity(candidate, fragment)) {
            return insufficient("document_evidence_stale");
          }
          materializedFragments.push({
            ...fragment,
            ...(candidate.sourceTitle === undefined ? {} : { sourceTitle: candidate.sourceTitle }),
            sourceType: candidate.sourceType,
            ...(candidate.distance === undefined ? {} : { distance: candidate.distance }),
          });
        }
      } catch {
        return retryable("fragment_lookup_failed");
      }

      const meaningfulFragments = materializedFragments.filter((fragment) =>
        fragment.text.trim().length > 0);
      const selectedFragments = await selectSourceAwareFragments({
        queryText: memoryContent,
        rankedFragments: meaningfulFragments,
        fragmentLimit: MAX_DOCUMENT_FRAGMENTS,
      });
      if (selectedFragments.length === 0) {
        return insufficient("no_authorized_document_evidence");
      }

      const groupEvidence = messages.map((message, index) => ({
        referenceId: `C${index + 1}` as `C${number}`,
        conversationMessageId: message.id,
        sentAt: new Date(message.sentAt),
        text: message.text!.normalize("NFC").trim(),
      }));
      const documentEvidence = selectedFragments.map((fragment, index) => {
        const referenceId = `D${index + 1}` as `D${number}`;
        const source = sources.get(fragment.documentSourceId)!;
        const snapshot = snapshotBySourceId.get(fragment.documentSourceId)!;
        return {
          referenceId,
          documentSourceId: source.id,
          sourceUri: source.sourceUri,
          ...(source.title === undefined ? {} : { sourceTitle: source.title }),
          authorizedSpaceId: source.authorizedSpaceId!,
          sourceUpdatedAt: new Date(source.updatedAt),
          documentSnapshotId: snapshot.id,
          ...(snapshot.sourceVersion === undefined ? {} : { sourceVersion: snapshot.sourceVersion }),
          snapshotContentHash: snapshot.contentHash!,
          snapshotFetchedAt: new Date(snapshot.fetchedAt),
          documentFragmentId: fragment.id,
          fragmentContentHash: fragment.contentHash,
          text: fragment.text.normalize("NFC").trim(),
        };
      });

      return {
        outcome: "ready",
        input: {
          subject: {
            referenceId: "M1",
            groupMemoryId: memory.id,
            groupId: memory.groupId,
            category: memory.category,
            content: memoryContent,
          },
          groupEvidence,
          documentEvidence,
        },
        fingerprint: {
          memory: {
            groupMemoryId: memory.id,
            groupId: memory.groupId,
            updatedAt: new Date(memory.updatedAt),
          },
          messages: messages.map((message, index) => ({
            referenceId: `C${index + 1}` as `C${number}`,
            conversationMessageId: message.id,
            chatId: message.chatId,
            sentAt: new Date(message.sentAt),
          })),
          documents: documentEvidence.map((item) => ({
            referenceId: item.referenceId,
            documentSourceId: item.documentSourceId,
            sourceUpdatedAt: new Date(item.sourceUpdatedAt),
            documentSnapshotId: item.documentSnapshotId,
            ...(item.sourceVersion === undefined ? {} : { sourceVersion: item.sourceVersion }),
            snapshotContentHash: item.snapshotContentHash,
            snapshotFetchedAt: new Date(item.snapshotFetchedAt),
            documentFragmentId: item.documentFragmentId,
            fragmentContentHash: item.fragmentContentHash,
          })),
          publicationTarget: {
            id: publicationTarget.id,
            version: publicationTarget.version,
            spaceId: publicationTarget.spaceId,
          },
          permissionAttestedAt: new Date(permissionAttestedAt),
        },
      };
    },
  };
}

function normalizeMemoryContent(value: string): string | undefined {
  const normalized = value.normalize("NFC").trim();
  return normalized.length === 0 ? undefined : normalized;
}

function isEligibleMemory(memory: GroupMemory): boolean {
  return memory.status === "active"
    && memory.scope === "group"
    && ["decision", "workflow", "term"].includes(memory.category)
    && memory.confidence >= 0.8
    && memory.importance >= 3
    && validDate(memory.updatedAt);
}

function validSourceMessages(
  messages: readonly ConversationMessageEvidence[],
  expectedIds: readonly string[],
  groupId: string,
): boolean {
  if (messages.length !== expectedIds.length) return false;
  return messages.every((message, index) =>
    message.id === expectedIds[index]
    && message.chatId === groupId
    && !message.tombstoned
    && validDate(message.sentAt)
    && message.text !== undefined
    && message.text.normalize("NFC").trim().length > 0);
}

async function loadSources(
  repository: KnowledgeConflictEvidenceBuilderDependencies["documentSources"],
  fragments: readonly Pick<RetrievedDocumentFragmentCandidate, "documentSourceId">[],
): Promise<Map<string, DocumentSource> | undefined> {
  const result = new Map<string, DocumentSource>();
  try {
    for (const id of uniqueSourceIds(fragments)) {
      const source = await repository.findSourceById(id);
      if (source !== undefined && source.id === id) result.set(id, source);
    }
    return result;
  } catch {
    return undefined;
  }
}

function sourceEligible(source: DocumentSource, targetSpaceId: string): boolean {
  return source.sourceType === "authorized_wiki_document"
    && source.syncState === "synced"
    && (source.permissionState === "readable" || source.permissionState === "unknown")
    && source.canUseForKnowledgeDrafts
    && source.authorizedSpaceId === targetSpaceId
    && validDate(source.updatedAt);
}

function uniqueSourceIds(
  fragments: readonly Pick<RetrievedDocumentFragmentCandidate, "documentSourceId">[],
): string[] {
  return [...new Set(fragments.map((fragment) => fragment.documentSourceId))].sort();
}

function sameFragmentIdentity(
  candidate: RetrievedDocumentFragmentCandidate,
  fragment: DocumentFragment,
): boolean {
  return fragment.id === candidate.id
    && fragment.documentSourceId === candidate.documentSourceId
    && fragment.documentSnapshotId === candidate.documentSnapshotId
    && fragment.sourceUri === candidate.sourceUri
    && fragment.chunkIndex === candidate.chunkIndex
    && fragment.contentHash === candidate.contentHash
    && fragment.embeddingProfileId === candidate.embeddingProfileId;
}

function validEmbedding(embedding: readonly number[]): boolean {
  return embedding.length > 0 && embedding.every((value) => Number.isFinite(value));
}

function validDate(value: Date): boolean {
  return !Number.isNaN(value.getTime());
}

function insufficient(reasonCode: string): KnowledgeConflictEvidenceBuildResult {
  return { outcome: "insufficient_evidence", reasonCode };
}

function permissionBlocked(reasonCode: string): KnowledgeConflictEvidenceBuildResult {
  return { outcome: "permission_blocked", reasonCode };
}

function retryable(reasonCode: string): KnowledgeConflictEvidenceBuildResult {
  return { outcome: "retryable_failure", reasonCode };
}
