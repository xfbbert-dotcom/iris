import type { DocumentSource } from "../documents/document-source-registry.js";
import type { FeishuExactDocumentPermissionChecker } from
  "../permissions/feishu-document-permission-checker.js";
import type { ManagedKnowledgePageRepository } from "./managed-knowledge-page-repository.js";

export interface ManagedKnowledgeMutationPermissionVerifier {
  verify(input: {
    managedPageId: string;
    documentSourceId: string;
    authorizationGroupId: string;
    remoteNodeToken: string;
    remoteDocumentToken: string;
    managedBodyBlockId: string;
  }): Promise<boolean>;
}

export function createManagedKnowledgeMutationPermissionVerifier({
  managedPages,
  documentSources,
  permissionChecker,
}: {
  managedPages: Pick<ManagedKnowledgePageRepository, "findByRemoteIdentity">;
  documentSources: { findSourceById(id: string): Promise<DocumentSource | undefined> };
  permissionChecker: FeishuExactDocumentPermissionChecker;
}): ManagedKnowledgeMutationPermissionVerifier {
  return {
    async verify(input) {
      const managedPageId = identifier("managedPageId", input.managedPageId);
      const documentSourceId = identifier("documentSourceId", input.documentSourceId);
      const authorizationGroupId = identifier(
        "authorizationGroupId",
        input.authorizationGroupId,
      );
      const remoteNodeToken = identifier("remoteNodeToken", input.remoteNodeToken);
      const remoteDocumentToken = identifier(
        "remoteDocumentToken",
        input.remoteDocumentToken,
      );
      const managedBodyBlockId = identifier("managedBodyBlockId", input.managedBodyBlockId);
      const page = await managedPages.findByRemoteIdentity({ remoteDocumentToken });
      if (page === undefined || page.id !== managedPageId ||
        page.authorizationGroupId !== authorizationGroupId ||
        page.linkedDocumentSourceId !== documentSourceId ||
        page.remoteNodeToken !== remoteNodeToken ||
        page.remoteDocumentToken !== remoteDocumentToken ||
        page.managedBodyBlockId !== managedBodyBlockId) return false;
      const source = await documentSources.findSourceById(documentSourceId);
      if (source === undefined || source.id !== documentSourceId ||
        source.sourceType !== "authorized_wiki_document" ||
        source.permissionState !== "readable" || source.syncState !== "synced" ||
        !source.canUseForAnswering || !source.canUseForKnowledgeDrafts) return false;
      return permissionChecker.canReadExactSource({
        source,
        remoteWikiNodeToken: remoteNodeToken,
        remoteDocumentToken,
      });
    },
  };
}

function identifier(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 512) throw new Error(`${name} is invalid`);
  return normalized;
}
