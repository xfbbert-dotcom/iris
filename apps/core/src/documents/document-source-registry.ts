import { randomUUID } from "node:crypto";

export type DocumentSourceType =
  | "group_visible_document"
  | "authorized_wiki_document"
  | "user_submitted_document";

export type DocumentPermissionState = "unknown" | "readable" | "denied" | "stale";

export type DocumentSyncState = "pending" | "syncing" | "synced" | "failed";

export type DocumentSourceEvidenceKind =
  | "group_message"
  | "admin_authorization"
  | "user_submission";

export interface DocumentSourceEvidence {
  kind: DocumentSourceEvidenceKind;
  sourceUri: string;
  groupId?: string;
  messageId?: string;
  userId?: string;
  spaceId?: string;
  observedAt: Date;
}

export interface DocumentSource {
  id: string;
  sourceType: DocumentSourceType;
  sourceUri: string;
  title?: string;
  originGroupId?: string;
  originMessageId?: string;
  submittedByUserId?: string;
  authorizedSpaceId?: string;
  permissionState: DocumentPermissionState;
  syncState: DocumentSyncState;
  canUseForAnswering: boolean;
  canUseForKnowledgeDrafts: boolean;
  createdAt: Date;
  updatedAt: Date;
  evidence: DocumentSourceEvidence[];
}

export interface RegisterGroupVisibleDocumentInput {
  sourceUri: string;
  title?: string;
  originGroupId: string;
  originMessageId: string;
  observedByUserId?: string;
  observedAt: Date;
}

export interface RegisterAuthorizedWikiDocumentInput {
  sourceUri: string;
  title?: string;
  authorizedSpaceId: string;
  observedAt: Date;
}

export interface RegisterUserSubmittedDocumentInput {
  sourceUri: string;
  title?: string;
  submittedByUserId: string;
  submissionGroupId?: string;
  submissionMessageId?: string;
  observedAt: Date;
}

export interface UpdateDocumentSourcePolicyInput {
  canUseForAnswering?: boolean;
  canUseForKnowledgeDrafts?: boolean;
}

export interface DocumentSourceRegistryDependencies {
  createId?: () => string;
  now?: () => Date;
}

export class DocumentSourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentSourceValidationError";
  }
}

export const DOCUMENT_SOURCE_URI_MAX_CHARS = 2048;
export const DOCUMENT_SOURCE_METADATA_MAX_CHARS = 512;

export interface DocumentSourceRegistry {
  registerGroupVisibleDocument(input: RegisterGroupVisibleDocumentInput): DocumentSource;
  registerAuthorizedWikiDocument(input: RegisterAuthorizedWikiDocumentInput): DocumentSource;
  registerUserSubmittedDocument(input: RegisterUserSubmittedDocumentInput): DocumentSource;
  markPermissionState(id: string, permissionState: DocumentPermissionState): DocumentSource;
  markSyncState(id: string, syncState: DocumentSyncState): DocumentSource;
  setAnsweringEnabled(id: string, enabled: boolean): DocumentSource;
  setKnowledgeDraftsEnabled(id: string, enabled: boolean): DocumentSource;
  updatePolicy(id: string, policy: UpdateDocumentSourcePolicyInput): DocumentSource;
  listSources(): DocumentSource[];
  listSourcesByType(sourceType: DocumentSourceType): DocumentSource[];
  findSourceById(id: string): DocumentSource | undefined;
  findSourceByUri(sourceUri: string): DocumentSource | undefined;
  listSourcesUsableForAnswering(): DocumentSource[];
  listSourcesByAnsweringEnabled(enabled: boolean): DocumentSource[];
  listSourcesByGroupId(groupId: string): DocumentSource[];
  listSourcesByAuthorizedSpaceId(spaceId: string): DocumentSource[];
  listSourcesBySubmittingUserId(userId: string): DocumentSource[];
}

export function createDocumentSourceRegistry(
  dependencies: DocumentSourceRegistryDependencies = {},
): DocumentSourceRegistry {
  const resolvedDependencies: Required<DocumentSourceRegistryDependencies> = {
    createId: dependencies.createId ?? randomUUID,
    now: dependencies.now ?? (() => new Date()),
  };
  const sourcesById = new Map<string, DocumentSource>();
  const sourcesByUri = new Map<string, DocumentSource>();
  const knowledgeDraftsPolicyOverriddenById = new Set<string>();

  const listSourcesByAnsweringEnabled = (enabled: boolean): DocumentSource[] =>
    cloneSources(
      sortSources(
        Array.from(sourcesById.values()).filter(
          (source) => source.canUseForAnswering === enabled,
        ),
      ),
    );

  return {
    registerGroupVisibleDocument(input) {
      const sourceUri = requireNonBlank(
        "sourceUri",
        input.sourceUri,
        DOCUMENT_SOURCE_URI_MAX_CHARS,
      );
      const originGroupId = requireNonBlank("originGroupId", input.originGroupId);
      const originMessageId = requireNonBlank("originMessageId", input.originMessageId);
      const observedByUserId = normalizeOptional("observedByUserId", input.observedByUserId);
      const source = registerSource(
        sourcesById,
        sourcesByUri,
        resolvedDependencies,
        knowledgeDraftsPolicyOverriddenById,
        {
          sourceType: "group_visible_document",
          sourceUri,
          title: normalizeOptional("title", input.title),
          originGroupId,
          originMessageId,
          submittedByUserId: undefined,
          authorizedSpaceId: undefined,
          canUseForAnswering: true,
          canUseForKnowledgeDrafts: true,
          evidence: {
            kind: "group_message",
            sourceUri,
            groupId: originGroupId,
            messageId: originMessageId,
            userId: observedByUserId,
            spaceId: undefined,
            observedAt: normalizeDocumentSourceDate("observedAt", input.observedAt),
          },
        },
      );

      return cloneSource(source);
    },

    registerAuthorizedWikiDocument(input) {
      const sourceUri = requireNonBlank(
        "sourceUri",
        input.sourceUri,
        DOCUMENT_SOURCE_URI_MAX_CHARS,
      );
      const authorizedSpaceId = requireNonBlank("authorizedSpaceId", input.authorizedSpaceId);
      const source = registerSource(
        sourcesById,
        sourcesByUri,
        resolvedDependencies,
        knowledgeDraftsPolicyOverriddenById,
        {
          sourceType: "authorized_wiki_document",
          sourceUri,
          title: normalizeOptional("title", input.title),
          originGroupId: undefined,
          originMessageId: undefined,
          submittedByUserId: undefined,
          authorizedSpaceId,
          canUseForAnswering: true,
          canUseForKnowledgeDrafts: true,
          evidence: {
            kind: "admin_authorization",
            sourceUri,
            groupId: undefined,
            messageId: undefined,
            userId: undefined,
            spaceId: authorizedSpaceId,
            observedAt: normalizeDocumentSourceDate("observedAt", input.observedAt),
          },
        },
      );

      return cloneSource(source);
    },

    registerUserSubmittedDocument(input) {
      const sourceUri = requireNonBlank(
        "sourceUri",
        input.sourceUri,
        DOCUMENT_SOURCE_URI_MAX_CHARS,
      );
      const submittedByUserId = requireNonBlank("submittedByUserId", input.submittedByUserId);
      const submissionGroupId = normalizeOptional(
        "submissionGroupId",
        input.submissionGroupId,
      );
      const submissionMessageId = normalizeOptional(
        "submissionMessageId",
        input.submissionMessageId,
      );
      requirePairedSubmissionProvenance(submissionGroupId, submissionMessageId);
      const source = registerSource(
        sourcesById,
        sourcesByUri,
        resolvedDependencies,
        knowledgeDraftsPolicyOverriddenById,
        {
          sourceType: "user_submitted_document",
          sourceUri,
          title: normalizeOptional("title", input.title),
          originGroupId: undefined,
          originMessageId: undefined,
          submittedByUserId,
          authorizedSpaceId: undefined,
          canUseForAnswering: true,
          canUseForKnowledgeDrafts: false,
          evidence: {
            kind: "user_submission",
            sourceUri,
            groupId: submissionGroupId,
            messageId: submissionMessageId,
            userId: submittedByUserId,
            spaceId: undefined,
            observedAt: normalizeDocumentSourceDate("observedAt", input.observedAt),
          },
        },
      );

      return cloneSource(source);
    },

    markPermissionState(id, permissionState) {
      const source = updateSourceById(sourcesById, sourcesByUri, resolvedDependencies, id, {
        permissionState,
      });

      return cloneSource(source);
    },

    markSyncState(id, syncState) {
      const source = updateSourceById(sourcesById, sourcesByUri, resolvedDependencies, id, {
        syncState,
      });

      return cloneSource(source);
    },

    setAnsweringEnabled(id, enabled) {
      const source = updateSourceById(sourcesById, sourcesByUri, resolvedDependencies, id, {
        canUseForAnswering: enabled,
      });

      return cloneSource(source);
    },

    setKnowledgeDraftsEnabled(id, enabled) {
      const source = updateSourceById(sourcesById, sourcesByUri, resolvedDependencies, id, {
        canUseForKnowledgeDrafts: enabled,
      });
      knowledgeDraftsPolicyOverriddenById.add(source.id);

      return cloneSource(source);
    },

    updatePolicy(id, policy) {
      const source = updateSourceById(sourcesById, sourcesByUri, resolvedDependencies, id, {
        ...(policy.canUseForAnswering === undefined
          ? {}
          : { canUseForAnswering: policy.canUseForAnswering }),
        ...(policy.canUseForKnowledgeDrafts === undefined
          ? {}
          : { canUseForKnowledgeDrafts: policy.canUseForKnowledgeDrafts }),
      });
      if (policy.canUseForKnowledgeDrafts !== undefined) {
        knowledgeDraftsPolicyOverriddenById.add(source.id);
      }

      return cloneSource(source);
    },

    listSources() {
      return cloneSources(sortSources(Array.from(sourcesById.values())));
    },

    listSourcesByType(sourceType) {
      return cloneSources(
        sortSources(Array.from(sourcesById.values()).filter((source) => source.sourceType === sourceType)),
      );
    },

    findSourceById(id) {
      return cloneSourceIfFound(sourcesById.get(id));
    },

    findSourceByUri(sourceUri) {
      return cloneSourceIfFound(sourcesByUri.get(sourceUri.trim()));
    },

    listSourcesUsableForAnswering() {
      return listSourcesByAnsweringEnabled(true);
    },

    listSourcesByAnsweringEnabled,

    listSourcesByGroupId(groupId) {
      const normalizedGroupId = normalizeOptional("groupId", groupId);
      if (normalizedGroupId === undefined) {
        return [];
      }

      return cloneSources(
        sortSources(
          Array.from(sourcesById.values()).filter(
            (source) =>
              source.originGroupId === normalizedGroupId ||
              source.evidence.some((evidence) => evidence.groupId === normalizedGroupId),
          ),
        ),
      );
    },

    listSourcesByAuthorizedSpaceId(spaceId) {
      const normalizedSpaceId = normalizeOptional("spaceId", spaceId);
      if (normalizedSpaceId === undefined) {
        return [];
      }

      return cloneSources(
        sortSources(
          Array.from(sourcesById.values()).filter(
            (source) =>
              source.authorizedSpaceId === normalizedSpaceId ||
              source.evidence.some((evidence) => evidence.spaceId === normalizedSpaceId),
          ),
        ),
      );
    },

    listSourcesBySubmittingUserId(userId) {
      const normalizedUserId = normalizeOptional("userId", userId);
      if (normalizedUserId === undefined) {
        return [];
      }

      return cloneSources(
        sortSources(
          Array.from(sourcesById.values()).filter(
            (source) =>
              source.submittedByUserId === normalizedUserId ||
              source.evidence.some((evidence) => evidence.userId === normalizedUserId),
          ),
        ),
      );
    },
  };
}

interface NextDocumentSource {
  sourceType: DocumentSourceType;
  sourceUri: string;
  title?: string;
  originGroupId?: string;
  originMessageId?: string;
  submittedByUserId?: string;
  authorizedSpaceId?: string;
  canUseForAnswering: boolean;
  canUseForKnowledgeDrafts: boolean;
  evidence: DocumentSourceEvidence;
}

const sourceTypePriority: Record<DocumentSourceType, number> = {
  user_submitted_document: 1,
  group_visible_document: 2,
  authorized_wiki_document: 3,
};

export function documentSourceTypePriority(sourceType: DocumentSourceType): number {
  return sourceTypePriority[sourceType];
}

export function higherPriorityDocumentSourceType(
  first: DocumentSourceType,
  second: DocumentSourceType,
): DocumentSourceType {
  return higherPrioritySourceType(first, second);
}

export function mergeDocumentSourceType(
  existingSourceType: DocumentSourceType,
  nextSourceType: DocumentSourceType,
  existingEvidence: readonly DocumentSourceEvidence[],
  nextEvidence: DocumentSourceEvidence,
): DocumentSourceType {
  const priorityResult = higherPrioritySourceType(existingSourceType, nextSourceType);
  if (priorityResult === "authorized_wiki_document") {
    return priorityResult;
  }
  if (
    !isSameMessageExplicitDocumentSubmission(
      existingSourceType,
      nextSourceType,
      existingEvidence,
      nextEvidence,
    )
  ) {
    return priorityResult;
  }

  return "user_submitted_document";
}

export function isSameMessageExplicitDocumentSubmission(
  existingSourceType: DocumentSourceType,
  nextSourceType: DocumentSourceType,
  existingEvidence: readonly DocumentSourceEvidence[],
  nextEvidence: DocumentSourceEvidence,
): boolean {
  return (
    hasSourceTypePair(
      existingSourceType,
      nextSourceType,
      "user_submitted_document",
      "group_visible_document",
    ) && hasOnlyExplicitSubmissionGroupEvidence(existingEvidence, nextEvidence)
  );
}

export function documentSourceEvidenceKey(evidence: DocumentSourceEvidence): string {
  return evidenceKey(evidence);
}

function registerSource(
  sourcesById: Map<string, DocumentSource>,
  sourcesByUri: Map<string, DocumentSource>,
  dependencies: Required<DocumentSourceRegistryDependencies>,
  knowledgeDraftsPolicyOverriddenById: Set<string>,
  next: NextDocumentSource,
): DocumentSource {
  const now = new Date(dependencies.now());
  const existing = sourcesByUri.get(next.sourceUri);

  if (existing === undefined) {
    const source: DocumentSource = {
      id: dependencies.createId(),
      sourceType: next.sourceType,
      sourceUri: next.sourceUri,
      title: next.title,
      originGroupId: next.originGroupId,
      originMessageId: next.originMessageId,
      submittedByUserId: next.submittedByUserId,
      authorizedSpaceId: next.authorizedSpaceId,
      permissionState: "unknown",
      syncState: "pending",
      canUseForAnswering: next.canUseForAnswering,
      canUseForKnowledgeDrafts: next.canUseForKnowledgeDrafts,
      createdAt: now,
      updatedAt: new Date(now),
      evidence: [cloneEvidence(next.evidence)],
    };

    sourcesById.set(source.id, source);
    sourcesByUri.set(source.sourceUri, source);

    return source;
  }

  const hasExistingEvidence = evidenceExists(existing.evidence, next.evidence);
  const mergedSourceType = mergeDocumentSourceType(
    existing.sourceType,
    next.sourceType,
    existing.evidence,
    next.evidence,
  );
  const mergedTitle = existing.title ?? next.title;
  const mergedOriginGroupId = existing.originGroupId ?? next.originGroupId;
  const mergedOriginMessageId = existing.originMessageId ?? next.originMessageId;
  const mergedSubmittedByUserId = existing.submittedByUserId ?? next.submittedByUserId;
  const mergedAuthorizedSpaceId = existing.authorizedSpaceId ?? next.authorizedSpaceId;
  const mergedSyncState =
    existing.syncState === "failed" && !hasExistingEvidence ? "pending" : existing.syncState;
  const mergedCanUseForKnowledgeDrafts = shouldUseKnowledgeDrafts(
    existing,
    next,
    knowledgeDraftsPolicyOverriddenById.has(existing.id),
    mergedSourceType,
  );
  const shouldRefreshUpdatedAt =
    !hasExistingEvidence ||
    mergedSourceType !== existing.sourceType ||
    mergedTitle !== existing.title ||
    mergedOriginGroupId !== existing.originGroupId ||
    mergedOriginMessageId !== existing.originMessageId ||
    mergedSubmittedByUserId !== existing.submittedByUserId ||
    mergedAuthorizedSpaceId !== existing.authorizedSpaceId ||
    mergedSyncState !== existing.syncState ||
    mergedCanUseForKnowledgeDrafts !== existing.canUseForKnowledgeDrafts;
  const merged: DocumentSource = {
    ...existing,
    sourceType: mergedSourceType,
    title: mergedTitle,
    originGroupId: mergedOriginGroupId,
    originMessageId: mergedOriginMessageId,
    submittedByUserId: mergedSubmittedByUserId,
    authorizedSpaceId: mergedAuthorizedSpaceId,
    syncState: mergedSyncState,
    canUseForAnswering: existing.canUseForAnswering,
    canUseForKnowledgeDrafts: mergedCanUseForKnowledgeDrafts,
    createdAt: new Date(existing.createdAt),
    updatedAt: shouldRefreshUpdatedAt ? now : new Date(existing.updatedAt),
    evidence: hasExistingEvidence
      ? existing.evidence.map(cloneEvidence)
      : [...existing.evidence.map(cloneEvidence), cloneEvidence(next.evidence)],
  };

  sourcesById.set(merged.id, merged);
  sourcesByUri.set(merged.sourceUri, merged);

  return merged;
}

function getSourceById(sourcesById: Map<string, DocumentSource>, id: string): DocumentSource {
  const source = sourcesById.get(id);
  if (source === undefined) {
    throw new DocumentSourceValidationError(`document source not found: ${id}`);
  }

  return source;
}

function updateSourceById(
  sourcesById: Map<string, DocumentSource>,
  sourcesByUri: Map<string, DocumentSource>,
  dependencies: Required<DocumentSourceRegistryDependencies>,
  id: string,
  changes: Partial<
    Pick<
      DocumentSource,
      "permissionState" | "syncState" | "canUseForAnswering" | "canUseForKnowledgeDrafts"
    >
  >,
): DocumentSource {
  const existing = getSourceById(sourcesById, id);
  const updated: DocumentSource = {
    ...existing,
    ...changes,
    createdAt: new Date(existing.createdAt),
    updatedAt: new Date(dependencies.now()),
    evidence: existing.evidence.map(cloneEvidence),
  };
  if (updated.permissionState === "denied") {
    updated.canUseForAnswering = false;
    updated.canUseForKnowledgeDrafts = false;
  }

  sourcesById.set(updated.id, updated);
  sourcesByUri.set(updated.sourceUri, updated);

  return updated;
}

function higherPrioritySourceType(
  first: DocumentSourceType,
  second: DocumentSourceType,
): DocumentSourceType {
  return sourceTypePriority[first] >= sourceTypePriority[second] ? first : second;
}

function shouldUseKnowledgeDrafts(
  existing: DocumentSource,
  next: NextDocumentSource,
  knowledgeDraftsPolicyOverridden: boolean,
  mergedSourceType: DocumentSourceType,
): boolean {
  if (existing.permissionState === "denied") {
    return false;
  }

  if (knowledgeDraftsPolicyOverridden) {
    return existing.canUseForKnowledgeDrafts;
  }

  if (
    mergedSourceType === "user_submitted_document" &&
    isSameMessageExplicitDocumentSubmission(
      existing.sourceType,
      next.sourceType,
      existing.evidence,
      next.evidence,
    )
  ) {
    return false;
  }

  if (existing.canUseForKnowledgeDrafts) {
    return true;
  }

  return existing.sourceType === "user_submitted_document" && next.canUseForKnowledgeDrafts;
}

function hasOnlyExplicitSubmissionGroupEvidence(
  existingEvidence: readonly DocumentSourceEvidence[],
  nextEvidence: DocumentSourceEvidence,
): boolean {
  const combinedEvidence = [...existingEvidence, nextEvidence];
  const groupEvidence = combinedEvidence.filter(
    (evidence) => evidence.kind === "group_message",
  );
  const userSubmissionEvidence = combinedEvidence.filter(
    (evidence) => evidence.kind === "user_submission",
  );

  return (
    groupEvidence.length > 0 &&
    groupEvidence.every((groupObservation) =>
      userSubmissionEvidence.some((submission) =>
        isSameSubmissionMessage(groupObservation, submission),
      ),
    )
  );
}

function isSameSubmissionMessage(
  groupObservation: DocumentSourceEvidence,
  submission: DocumentSourceEvidence,
): boolean {
  return (
    groupObservation.sourceUri === submission.sourceUri &&
    groupObservation.groupId !== undefined &&
    groupObservation.groupId === submission.groupId &&
    groupObservation.messageId !== undefined &&
    groupObservation.messageId === submission.messageId
  );
}

function hasSourceTypePair(
  first: DocumentSourceType,
  second: DocumentSourceType,
  expectedFirst: DocumentSourceType,
  expectedSecond: DocumentSourceType,
): boolean {
  return (
    (first === expectedFirst && second === expectedSecond) ||
    (first === expectedSecond && second === expectedFirst)
  );
}

function evidenceExists(
  evidenceList: DocumentSourceEvidence[],
  candidate: DocumentSourceEvidence,
): boolean {
  return evidenceList.some((evidence) => evidenceKey(evidence) === evidenceKey(candidate));
}

function evidenceKey(evidence: DocumentSourceEvidence): string {
  return [
    evidence.kind,
    evidence.sourceUri,
    evidence.groupId ?? "",
    evidence.messageId ?? "",
    evidence.userId ?? "",
    evidence.spaceId ?? "",
  ].join("\u0000");
}

function cloneEvidence(evidence: DocumentSourceEvidence): DocumentSourceEvidence {
  return {
    ...evidence,
    observedAt: new Date(evidence.observedAt),
  };
}

export function normalizeDocumentSourceRequiredString(
  fieldName: string,
  value: string,
  maxLength = DOCUMENT_SOURCE_METADATA_MAX_CHARS,
): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new DocumentSourceValidationError(`${fieldName} must not be blank`);
  }
  if (normalized.length > maxLength) {
    throw new DocumentSourceValidationError(
      `${fieldName} must be at most ${maxLength} characters`,
    );
  }

  return normalized;
}

export function normalizeDocumentSourceOptionalString(
  fieldName: string,
  value: string | undefined,
  maxLength = DOCUMENT_SOURCE_METADATA_MAX_CHARS,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new DocumentSourceValidationError(
      `${fieldName} must be at most ${maxLength} characters`,
    );
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeDocumentSourceDate(fieldName: string, value: Date): Date {
  const normalized = new Date(value);
  if (Number.isNaN(normalized.getTime())) {
    throw new DocumentSourceValidationError(`${fieldName} must be a valid date`);
  }

  return normalized;
}

function requireNonBlank(fieldName: string, value: string, maxLength?: number): string {
  return normalizeDocumentSourceRequiredString(fieldName, value, maxLength);
}

function normalizeOptional(
  fieldName: string,
  value: string | undefined,
  maxLength?: number,
): string | undefined {
  return normalizeDocumentSourceOptionalString(fieldName, value, maxLength);
}

function requirePairedSubmissionProvenance(
  submissionGroupId: string | undefined,
  submissionMessageId: string | undefined,
): void {
  if ((submissionGroupId === undefined) !== (submissionMessageId === undefined)) {
    throw new DocumentSourceValidationError(
      "submissionGroupId and submissionMessageId must be provided together",
    );
  }
}

function cloneSource(source: DocumentSource): DocumentSource {
  return {
    ...source,
    createdAt: new Date(source.createdAt),
    updatedAt: new Date(source.updatedAt),
    evidence: source.evidence.map(cloneEvidence),
  };
}

function cloneSourceIfFound(source: DocumentSource | undefined): DocumentSource | undefined {
  return source ? cloneSource(source) : undefined;
}

function cloneSources(sources: DocumentSource[]): DocumentSource[] {
  return sources.map(cloneSource);
}

function sortSources(sources: DocumentSource[]): DocumentSource[] {
  return [...sources].sort((left, right) => {
    const updatedDelta = right.updatedAt.getTime() - left.updatedAt.getTime();
    if (updatedDelta !== 0) {
      return updatedDelta;
    }

    return left.id.localeCompare(right.id);
  });
}
