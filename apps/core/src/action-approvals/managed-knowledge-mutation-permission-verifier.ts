import type { DocumentSource } from "../documents/document-source-registry.js";
import type { FeishuDocumentPermissionChecker } from
  "../permissions/feishu-document-permission-checker.js";

export interface ManagedKnowledgeMutationPermissionVerifier {
  verify(input: {
    documentSourceId: string;
    authorizationGroupId: string;
  }): Promise<boolean>;
}

export function createManagedKnowledgeMutationPermissionVerifier({
  documentSources,
  permissionChecker,
}: {
  documentSources: { findSourceById(id: string): Promise<DocumentSource | undefined> };
  permissionChecker: Pick<FeishuDocumentPermissionChecker, "canReadSource">;
}): ManagedKnowledgeMutationPermissionVerifier {
  return {
    async verify(input) {
      const documentSourceId = identifier("documentSourceId", input.documentSourceId);
      identifier("authorizationGroupId", input.authorizationGroupId);
      const source = await documentSources.findSourceById(documentSourceId);
      if (source === undefined || source.id !== documentSourceId ||
        source.sourceType !== "authorized_wiki_document" ||
        source.permissionState !== "readable" || source.syncState !== "synced" ||
        !source.canUseForAnswering || !source.canUseForKnowledgeDrafts) return false;
      return permissionChecker.canReadSource(source);
    },
  };
}

function identifier(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 512) throw new Error(`${name} is invalid`);
  return normalized;
}
