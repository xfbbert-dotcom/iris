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
  observedAt: Date;
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

export interface DocumentSourceRegistry {
  registerGroupVisibleDocument(input: RegisterGroupVisibleDocumentInput): DocumentSource;
  registerAuthorizedWikiDocument(input: RegisterAuthorizedWikiDocumentInput): DocumentSource;
  registerUserSubmittedDocument(input: RegisterUserSubmittedDocumentInput): DocumentSource;
  markPermissionState(id: string, permissionState: DocumentPermissionState): DocumentSource;
  markSyncState(id: string, syncState: DocumentSyncState): DocumentSource;
  setAnsweringEnabled(id: string, enabled: boolean): DocumentSource;
  setKnowledgeDraftsEnabled(id: string, enabled: boolean): DocumentSource;
  listSources(): DocumentSource[];
  listSourcesByType(sourceType: DocumentSourceType): DocumentSource[];
  findSourceById(id: string): DocumentSource | undefined;
  findSourceByUri(sourceUri: string): DocumentSource | undefined;
  listSourcesUsableForAnswering(): DocumentSource[];
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

  return {
    registerGroupVisibleDocument(input) {
      const sourceUri = requireNonBlank("sourceUri", input.sourceUri);
      const originGroupId = requireNonBlank("originGroupId", input.originGroupId);
      const originMessageId = requireNonBlank("originMessageId", input.originMessageId);
      const source = registerSource(
        sourcesById,
        sourcesByUri,
        resolvedDependencies,
        {
          sourceType: "group_visible_document",
          sourceUri,
          title: normalizeOptional(input.title),
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
            userId: undefined,
            spaceId: undefined,
            observedAt: new Date(input.observedAt),
          },
        },
      );

      return cloneSource(source);
    },

    registerAuthorizedWikiDocument(input) {
      const sourceUri = requireNonBlank("sourceUri", input.sourceUri);
      const authorizedSpaceId = requireNonBlank("authorizedSpaceId", input.authorizedSpaceId);
      const source = registerSource(
        sourcesById,
        sourcesByUri,
        resolvedDependencies,
        {
          sourceType: "authorized_wiki_document",
          sourceUri,
          title: normalizeOptional(input.title),
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
            observedAt: new Date(input.observedAt),
          },
        },
      );

      return cloneSource(source);
    },

    registerUserSubmittedDocument(input) {
      const sourceUri = requireNonBlank("sourceUri", input.sourceUri);
      const submittedByUserId = requireNonBlank("submittedByUserId", input.submittedByUserId);
      const source = registerSource(
        sourcesById,
        sourcesByUri,
        resolvedDependencies,
        {
          sourceType: "user_submitted_document",
          sourceUri,
          title: normalizeOptional(input.title),
          originGroupId: undefined,
          originMessageId: undefined,
          submittedByUserId,
          authorizedSpaceId: undefined,
          canUseForAnswering: true,
          canUseForKnowledgeDrafts: false,
          evidence: {
            kind: "user_submission",
            sourceUri,
            groupId: undefined,
            messageId: undefined,
            userId: submittedByUserId,
            spaceId: undefined,
            observedAt: new Date(input.observedAt),
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
      return cloneSources(
        sortSources(
          Array.from(sourcesById.values()).filter((source) => source.canUseForAnswering),
        ),
      );
    },

    listSourcesByGroupId(groupId) {
      return cloneSources(
        sortSources(
          Array.from(sourcesById.values()).filter((source) => source.originGroupId === groupId),
        ),
      );
    },

    listSourcesByAuthorizedSpaceId(spaceId) {
      return cloneSources(
        sortSources(
          Array.from(sourcesById.values()).filter((source) => source.authorizedSpaceId === spaceId),
        ),
      );
    },

    listSourcesBySubmittingUserId(userId) {
      return cloneSources(
        sortSources(
          Array.from(sourcesById.values()).filter((source) => source.submittedByUserId === userId),
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

function registerSource(
  sourcesById: Map<string, DocumentSource>,
  sourcesByUri: Map<string, DocumentSource>,
  dependencies: Required<DocumentSourceRegistryDependencies>,
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

  const merged: DocumentSource = {
    ...existing,
    sourceType: higherPrioritySourceType(existing.sourceType, next.sourceType),
    title: existing.title ?? next.title,
    originGroupId: existing.originGroupId ?? next.originGroupId,
    originMessageId: existing.originMessageId ?? next.originMessageId,
    submittedByUserId: existing.submittedByUserId ?? next.submittedByUserId,
    authorizedSpaceId: existing.authorizedSpaceId ?? next.authorizedSpaceId,
    createdAt: new Date(existing.createdAt),
    updatedAt: now,
    evidence: evidenceExists(existing.evidence, next.evidence)
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

function requireNonBlank(fieldName: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new DocumentSourceValidationError(`${fieldName} must not be blank`);
  }

  return normalized;
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
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
