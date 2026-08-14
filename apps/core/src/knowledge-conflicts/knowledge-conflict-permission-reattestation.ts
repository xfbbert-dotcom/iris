import type { DocumentSource } from "../documents/document-source-registry.js";
import type { FeishuDocumentPermissionChecker } from
  "../permissions/feishu-document-permission-checker.js";

export type KnowledgeConflictSourceIdentity = {
  documentSourceId: string;
  expectedUpdatedAt: Date;
};

export type KnowledgeConflictPermissionReattestationResult =
  | { status: "attested"; permissionAttestedAt: Date }
  | { status: "permission_blocked" }
  | { status: "stale"; reason: "source_stale"; permissionAttestedAt?: Date };

export class KnowledgeConflictPermissionUnavailableError extends Error {
  constructor() {
    super("knowledge conflict permission validation unavailable");
    this.name = "KnowledgeConflictPermissionUnavailableError";
  }
}

export async function reattestKnowledgeConflictSourcePermissions(input: {
  sources: readonly KnowledgeConflictSourceIdentity[];
  documentSources: { findSourceById(id: string): Promise<DocumentSource | undefined> };
  permissionChecker: FeishuDocumentPermissionChecker;
  now: () => Date;
  isEligibleSource?: (source: DocumentSource) => boolean;
}): Promise<KnowledgeConflictPermissionReattestationResult> {
  if (input.sources.length === 0) throw new KnowledgeConflictPermissionUnavailableError();
  const ordered = [...input.sources].sort((left, right) =>
    left.documentSourceId.localeCompare(right.documentSourceId));
  let sourceIdentityChanged = false;
  for (const identity of ordered) {
    let source: DocumentSource | undefined;
    try {
      source = await input.documentSources.findSourceById(identity.documentSourceId);
    } catch {
      throw new KnowledgeConflictPermissionUnavailableError();
    }
    if (source === undefined
      || source.id !== identity.documentSourceId
      || !validDate(source.updatedAt)
      || !validDate(identity.expectedUpdatedAt)) {
      return { status: "stale", reason: "source_stale" };
    }
    if (source.updatedAt.getTime() !== identity.expectedUpdatedAt.getTime()) {
      sourceIdentityChanged = true;
    }
    if (source.sourceType !== "authorized_wiki_document"
      || source.syncState !== "synced"
      || source.permissionState !== "readable"
      || !source.canUseForKnowledgeDrafts
      || (input.isEligibleSource !== undefined && !input.isEligibleSource(source))) {
      return { status: "permission_blocked" };
    }
    try {
      if (!(await input.permissionChecker.canReadSource(source))) {
        return { status: "permission_blocked" };
      }
    } catch {
      throw new KnowledgeConflictPermissionUnavailableError();
    }
  }
  const permissionAttestedAt = input.now();
  if (!validDate(permissionAttestedAt)) throw new KnowledgeConflictPermissionUnavailableError();
  if (sourceIdentityChanged) {
    return {
      status: "stale",
      reason: "source_stale",
      permissionAttestedAt: new Date(permissionAttestedAt),
    };
  }
  return { status: "attested", permissionAttestedAt: new Date(permissionAttestedAt) };
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}
