import {
  createConflictEvidencePlan,
  type ConflictEvidencePlan,
} from "../agent/evidence-plan.js";
import type { RetrievedDocumentFragment } from
  "../documents/document-fragment-repository.js";
import type {
  AsyncDocumentSourceRegistry,
} from "../documents/postgres-document-source-registry.js";
import type { DocumentSource } from "../documents/document-source-registry.js";
import type { PromptGroupMemory } from "../memory/context-assembly.js";
import type { KnowledgeConflictCandidate } from "./knowledge-conflict.js";
import type { KnowledgeConflictRepository } from "./knowledge-conflict-repository.js";

const CURRENT_CANDIDATE_STATUSES = new Set<KnowledgeConflictCandidate["status"]>([
  "pending_review",
  "approved_for_delivery",
  "delivered",
  "draft_created",
]);
const MAX_PREMISE_CHARS = 1200;
const MAX_EXPLANATION_COMPONENT_CHARS = 1800;
const TRUNCATION_MARKER = " ... [truncated]";

export type KnowledgeConflictAnswerProvider = {
  findConflictPlan(input: {
    groupId: string;
    usedGroupMemories: readonly PromptGroupMemory[];
    allowedFragments: readonly RetrievedDocumentFragment[];
  }): Promise<ConflictEvidencePlan | undefined>;
};

export function createKnowledgeConflictAnswerProvider({
  repository,
  documentSources,
  permissionChecker,
  now = () => new Date(),
}: {
  repository: Pick<KnowledgeConflictRepository, "findCurrentOverlap">;
  documentSources: Pick<AsyncDocumentSourceRegistry, "findSourceById">;
  permissionChecker: { canReadSource(source: DocumentSource): Promise<boolean> };
  now?: () => Date;
}): KnowledgeConflictAnswerProvider {
  return {
    async findConflictPlan(input) {
      const groupId = normalizeReference(input.groupId);
      if (groupId === undefined) {
        return undefined;
      }
      const memories = input.usedGroupMemories.slice(0, 8);
      const memoryIds = uniqueMemoryIds(memories);
      if (memoryIds.length === 0) {
        return undefined;
      }

      const permittedDocuments: Array<{
        sourceId: string;
        snapshotId: string;
        fragment: RetrievedDocumentFragment;
      }> = [];
      const seenDocuments = new Set<string>();
      for (const fragment of input.allowedFragments.slice(0, 12)) {
        const sourceId = normalizeReference(fragment.documentSourceId);
        const snapshotId = normalizeReference(fragment.documentSnapshotId);
        if (sourceId === undefined || snapshotId === undefined) {
          continue;
        }
        const key = JSON.stringify([sourceId, snapshotId]);
        if (seenDocuments.has(key)) {
          continue;
        }
        seenDocuments.add(key);
        const source = await documentSources.findSourceById(sourceId);
        if (
          source === undefined
          || source.id !== sourceId
          || !isLocallyCurrentAnswerSource(source)
        ) {
          continue;
        }
        let permitted = false;
        try {
          permitted = await permissionChecker.canReadSource(source);
        } catch {
          permitted = false;
        }
        if (permitted) {
          permittedDocuments.push({ sourceId, snapshotId, fragment });
        }
      }
      if (permittedDocuments.length === 0) {
        return undefined;
      }

      const at = now();
      const candidate = await repository.findCurrentOverlap({
        groupId,
        groupMemoryIds: memoryIds,
        documents: permittedDocuments.map(({ sourceId, snapshotId }) => ({
          sourceId,
          snapshotId,
        })),
        permissionAttestedAt: at,
        at,
      });
      if (candidate === undefined || !CURRENT_CANDIDATE_STATUSES.has(candidate.status)) {
        return undefined;
      }

      const knowledgeBaseStatement = candidate.plan.knowledgeBaseStatement;
      const groupConclusionStatement = candidate.plan.groupConclusionStatement;
      const difference = candidate.plan.difference;
      const confidence = candidate.plan.confidence;
      if (
        candidate.plan.outcome !== "conflict"
        || knowledgeBaseStatement === null
        || groupConclusionStatement === null
        || difference === null
        || (confidence !== "high" && confidence !== "medium")
      ) {
        return undefined;
      }

      const memoryIndex = memories.findIndex(({ id }) => id === candidate.groupMemoryId);
      const documentIndex = permittedDocuments.findIndex(({ sourceId, snapshotId }) => (
        sourceId === candidate.targetDocumentSourceId
        && snapshotId === candidate.targetSnapshotId
      ));
      if (
        candidate.groupId !== groupId
        || memoryIndex < 0
        || documentIndex < 0
      ) {
        return undefined;
      }

      return createConflictEvidencePlan({
        candidateId: candidate.id,
        groupPremise: {
          citationRef: `M${memoryIndex + 1}`,
          statement: truncate(groupConclusionStatement, MAX_PREMISE_CHARS),
        },
        knowledgePremise: {
          citationRef: documentCitationRef(input.allowedFragments, permittedDocuments[documentIndex]!),
          statement: truncate(knowledgeBaseStatement, MAX_PREMISE_CHARS),
        },
        proposedAnswer: buildConflictExplanation({
          knowledgeBaseStatement,
          groupConclusionStatement,
          difference,
        }),
        confidence,
      });
    },
  };
}

function uniqueMemoryIds(memories: readonly PromptGroupMemory[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const memory of memories) {
    const id = normalizeReference(memory.id);
    if (id !== undefined && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function documentCitationRef(
  allowedFragments: readonly RetrievedDocumentFragment[],
  document: { sourceId: string; snapshotId: string; fragment: RetrievedDocumentFragment },
): string {
  const index = allowedFragments.findIndex((fragment) => (
    fragment === document.fragment
    || (
      fragment.documentSourceId === document.sourceId
      && fragment.documentSnapshotId === document.snapshotId
    )
  ));
  if (index < 0 || index >= 12) {
    throw new Error("knowledge conflict document is outside the answer evidence window");
  }
  return `D${index + 1}`;
}

function isLocallyCurrentAnswerSource(source: DocumentSource): boolean {
  return source.sourceType === "authorized_wiki_document"
    && source.canUseForAnswering
    && source.syncState === "synced"
    && (source.permissionState === "readable" || source.permissionState === "unknown");
}

function buildConflictExplanation(input: {
  knowledgeBaseStatement: string;
  groupConclusionStatement: string;
  difference: string;
}): string {
  return [
    "Possible conflict.",
    `The current synchronized knowledge says: ${truncate(
      input.knowledgeBaseStatement,
      MAX_EXPLANATION_COMPONENT_CHARS,
    )}`,
    `The newer group conclusion says: ${truncate(
      input.groupConclusionStatement,
      MAX_EXPLANATION_COMPONENT_CHARS,
    )}`,
    `Material difference: ${truncate(
      input.difference,
      MAX_EXPLANATION_COMPONENT_CHARS,
    )}`,
    "This does not select a winner; a reviewed update draft can be created.",
  ].join(" ");
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - TRUNCATION_MARKER.length).trimEnd()}${
    TRUNCATION_MARKER
  }`;
}

function normalizeReference(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 512 ? normalized : undefined;
}
