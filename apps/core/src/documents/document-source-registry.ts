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
  groupId: string;
  messageId: string;
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

export interface DocumentSourceRegistryDependencies {
  createId: () => string;
  now: () => Date;
}

export class DocumentSourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentSourceValidationError";
  }
}

export interface DocumentSourceRegistry {
  registerGroupVisibleDocument(input: RegisterGroupVisibleDocumentInput): DocumentSource;
}

export function createDocumentSourceRegistry(
  dependencies: Partial<DocumentSourceRegistryDependencies> = {},
): DocumentSourceRegistry {
  const resolvedDependencies: DocumentSourceRegistryDependencies = {
    createId: dependencies.createId ?? randomUUID,
    now: dependencies.now ?? (() => new Date()),
  };
  const sources = new Map<string, DocumentSource>();

  return {
    registerGroupVisibleDocument(input) {
      const sourceUri = requireNonBlank("sourceUri", input.sourceUri);
      const originGroupId = requireNonBlank("originGroupId", input.originGroupId);
      const originMessageId = requireNonBlank("originMessageId", input.originMessageId);
      const createdAt = new Date(resolvedDependencies.now());
      const source: DocumentSource = {
        id: resolvedDependencies.createId(),
        sourceType: "group_visible_document",
        sourceUri,
        title: normalizeOptional(input.title),
        originGroupId,
        originMessageId,
        submittedByUserId: undefined,
        authorizedSpaceId: undefined,
        permissionState: "unknown",
        syncState: "pending",
        canUseForAnswering: true,
        canUseForKnowledgeDrafts: true,
        createdAt,
        updatedAt: new Date(createdAt),
        evidence: [
          {
            kind: "group_message",
            sourceUri,
            groupId: originGroupId,
            messageId: originMessageId,
            userId: undefined,
            spaceId: undefined,
            observedAt: new Date(input.observedAt),
          },
        ],
      };

      sources.set(source.id, cloneSource(source));

      return cloneSource(source);
    },
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
    evidence: source.evidence.map((evidence) => ({
      ...evidence,
      observedAt: new Date(evidence.observedAt),
    })),
  };
}
