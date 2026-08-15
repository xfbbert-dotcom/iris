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
import { createKnowledgeConflictCurrentValidator } from
  "./knowledge-conflict-current-validator.js";
import {
  KnowledgeConflictStaleEvidenceError,
  type KnowledgeConflictRepository,
} from "./knowledge-conflict-repository.js";

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
  validateForSend?(input: KnowledgeConflictAnswerValidationInput): Promise<
    KnowledgeConflictAnswerValidationResult
  >;
};

export type KnowledgeConflictAnswerSourceIdentity = {
  documentSourceId: string;
  documentSnapshotId: string;
  fragmentId: string;
  contentHash: string;
};

export type KnowledgeConflictAnswerValidationInput = {
  candidateId: string;
  groupId: string;
  sources: readonly KnowledgeConflictAnswerSourceIdentity[];
};

export type KnowledgeConflictAnswerValidationResult =
  | { status: "current"; permissionAttestedAt: Date }
  | { status: "blocked" };

export function createKnowledgeConflictAnswerProvider({
  repository,
  documentSources,
  permissionChecker,
  now = () => new Date(),
}: {
  repository: Pick<
    KnowledgeConflictRepository,
    "findCurrentOverlap" | "getCandidate" | "validateCandidateCurrentState"
  >;
  documentSources: Pick<AsyncDocumentSourceRegistry, "findSourceById">;
  permissionChecker: { canReadSource(source: DocumentSource): Promise<boolean> };
  now?: () => Date;
}): KnowledgeConflictAnswerProvider & Required<Pick<
  KnowledgeConflictAnswerProvider,
  "validateForSend"
>> {
  const currentValidator = createKnowledgeConflictCurrentValidator({
    repository,
    documentSources,
    permissionChecker,
    now,
    isEligibleSource: isLocallyCurrentAnswerSource,
  });

  async function validateForSend(
    input: KnowledgeConflictAnswerValidationInput,
  ): Promise<KnowledgeConflictAnswerValidationResult> {
    const candidateId = normalizeReference(input.candidateId);
    const groupId = normalizeReference(input.groupId);
    const sources = normalizeAnswerSourceIdentities(input.sources);
    if (candidateId === undefined || groupId === undefined || sources === undefined) {
      return { status: "blocked" };
    }

    // Do not load any candidate statement until every receipt-bound source is live-readable.
    for (const identity of sources) {
      try {
        const source = await documentSources.findSourceById(identity.documentSourceId);
        if (
          source === undefined
          || source.id !== identity.documentSourceId
          || !isLocallyCurrentAnswerSource(source)
          || !(await permissionChecker.canReadSource(source))
        ) {
          return { status: "blocked" };
        }
        const permissionCompletedAt = now();
        if (!validDate(permissionCompletedAt)) {
          return { status: "blocked" };
        }
      } catch {
        return { status: "blocked" };
      }
    }

    try {
      const candidate = await repository.getCandidate(candidateId);
      if (
        candidate === undefined
        || candidate.id !== candidateId
        || candidate.groupId !== groupId
        || !CURRENT_CANDIDATE_STATUSES.has(candidate.status)
        || !hasExactCandidateSource(candidate, sources)
      ) {
        return { status: "blocked" };
      }
      const validation = await currentValidator.validate({
        candidate,
        expectedVersion: candidate.version,
      });
      if (
        validation.status !== "current"
        || validation.candidate.id !== candidateId
        || validation.candidate.groupId !== groupId
        || !CURRENT_CANDIDATE_STATUSES.has(validation.candidate.status)
        || !hasExactCandidateSource(validation.candidate, sources)
        || !validDate(validation.permissionAttestedAt)
      ) {
        return { status: "blocked" };
      }
      return {
        status: "current",
        permissionAttestedAt: new Date(validation.permissionAttestedAt),
      };
    } catch {
      return { status: "blocked" };
    }
  }

  return {
    validateForSend,
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
        permissionAttestedAt: Date;
      }> = [];
      const documentPermissions = new Map<string, Date | undefined>();
      for (const fragment of input.allowedFragments.slice(0, 12)) {
        const sourceId = normalizeReference(fragment.documentSourceId);
        const snapshotId = normalizeReference(fragment.documentSnapshotId);
        if (sourceId === undefined || snapshotId === undefined) {
          continue;
        }
        const key = JSON.stringify([sourceId, snapshotId]);
        if (documentPermissions.has(key)) {
          const permissionAttestedAt = documentPermissions.get(key);
          if (permissionAttestedAt !== undefined) {
            permittedDocuments.push({
              sourceId,
              snapshotId,
              fragment,
              permissionAttestedAt: new Date(permissionAttestedAt),
            });
          }
          continue;
        }
        const source = await documentSources.findSourceById(sourceId);
        if (
          source === undefined
          || source.id !== sourceId
          || !isLocallyCurrentAnswerSource(source)
        ) {
          documentPermissions.set(key, undefined);
          continue;
        }
        let permitted = false;
        try {
          permitted = await permissionChecker.canReadSource(source);
        } catch {
          permitted = false;
        }
        if (permitted) {
          const permissionAttestedAt = now();
          if (!validDate(permissionAttestedAt)) {
            return undefined;
          }
          const captured = new Date(permissionAttestedAt);
          documentPermissions.set(key, captured);
          permittedDocuments.push({ sourceId, snapshotId, fragment,
            permissionAttestedAt: captured });
        } else {
          documentPermissions.set(key, undefined);
        }
      }
      if (permittedDocuments.length === 0) {
        return undefined;
      }

      const permissionAttestedAt = earliestPermissionAttestation(permittedDocuments);
      const at = now();
      if (!validDate(at)) {
        return undefined;
      }
      let candidate: KnowledgeConflictCandidate | undefined;
      try {
        candidate = await repository.findCurrentOverlap({
          groupId,
          groupMemoryIds: memoryIds,
          documents: uniqueDocumentIdentities(permittedDocuments),
          permissionAttestedAt,
          at,
        });
      } catch (error) {
        if (
          error instanceof KnowledgeConflictStaleEvidenceError
          && error.reasonCode === "permission_stale"
        ) {
          return undefined;
        }
        throw error;
      }
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
      const documentIndex = permittedDocuments.findIndex((document) =>
        isExactCandidateDocument(candidate, document));
      if (
        candidate.groupId !== groupId
        || memoryIndex < 0
        || documentIndex < 0
      ) {
        return undefined;
      }

      const document = permittedDocuments[documentIndex]!;
      const finalValidation = await validateForSend({
        candidateId: candidate.id,
        groupId,
        sources: [{
          documentSourceId: document.sourceId,
          documentSnapshotId: document.snapshotId,
          fragmentId: document.fragment.id,
          contentHash: document.fragment.contentHash,
        }],
      });
      if (finalValidation.status !== "current") {
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

function normalizeAnswerSourceIdentities(
  values: readonly KnowledgeConflictAnswerSourceIdentity[],
): KnowledgeConflictAnswerSourceIdentity[] | undefined {
  if (!Array.isArray(values) || values.length === 0 || values.length > 12) {
    return undefined;
  }
  const result: KnowledgeConflictAnswerSourceIdentity[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const documentSourceId = normalizeReference(value.documentSourceId);
    const documentSnapshotId = normalizeReference(value.documentSnapshotId);
    const fragmentId = normalizeReference(value.fragmentId);
    const contentHash = normalizeContentHash(value.contentHash);
    if (
      documentSourceId === undefined
      || documentSnapshotId === undefined
      || fragmentId === undefined
      || contentHash === undefined
    ) {
      return undefined;
    }
    const key = JSON.stringify([documentSourceId, documentSnapshotId, fragmentId, contentHash]);
    if (seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    result.push({ documentSourceId, documentSnapshotId, fragmentId, contentHash });
  }
  return result;
}

function hasExactCandidateSource(
  candidate: KnowledgeConflictCandidate,
  sources: readonly KnowledgeConflictAnswerSourceIdentity[],
): boolean {
  return sources.some((source) => isExactCandidateSource(candidate, source));
}

function isExactCandidateSource(
  candidate: KnowledgeConflictCandidate,
  source: KnowledgeConflictAnswerSourceIdentity,
): boolean {
  return source.documentSourceId === candidate.targetDocumentSourceId
    && source.documentSnapshotId === candidate.targetSnapshotId
    && candidate.evidence.some((evidence) => (
      evidence.type === "document_snapshot"
      && evidence.documentSourceId === source.documentSourceId
      && evidence.documentSnapshotId === source.documentSnapshotId
      && evidence.contentHash === candidate.targetContentHash
    ))
    && candidate.evidence.some((evidence) => (
      evidence.type === "document_fragment"
      && evidence.documentSourceId === source.documentSourceId
      && evidence.documentSnapshotId === source.documentSnapshotId
      && evidence.documentFragmentId === source.fragmentId
      && evidence.snapshotContentHash === candidate.targetContentHash
      && evidence.contentHash === source.contentHash
    ));
}

function isExactCandidateDocument(
  candidate: KnowledgeConflictCandidate,
  document: {
    sourceId: string;
    snapshotId: string;
    fragment: RetrievedDocumentFragment;
  },
): boolean {
  return isExactCandidateSource(candidate, {
    documentSourceId: document.sourceId,
    documentSnapshotId: document.snapshotId,
    fragmentId: document.fragment.id,
    contentHash: document.fragment.contentHash,
  });
}

function earliestPermissionAttestation(
  documents: readonly { permissionAttestedAt: Date }[],
): Date {
  return new Date(Math.min(...documents.map(({ permissionAttestedAt }) =>
    permissionAttestedAt.getTime())));
}

function uniqueDocumentIdentities(
  documents: readonly { sourceId: string; snapshotId: string }[],
): Array<{ sourceId: string; snapshotId: string }> {
  const seen = new Set<string>();
  return documents.flatMap(({ sourceId, snapshotId }) => {
    const key = JSON.stringify([sourceId, snapshotId]);
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ sourceId, snapshotId }];
  });
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
      fragment.id === document.fragment.id
      && fragment.documentSourceId === document.sourceId
      && fragment.documentSnapshotId === document.snapshotId
      && fragment.contentHash === document.fragment.contentHash
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

function normalizeContentHash(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}
