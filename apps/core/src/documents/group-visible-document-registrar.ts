import type {
  DocumentSource,
  RegisterGroupVisibleDocumentInput,
} from "./document-source-registry.js";
import type { FeishuDocumentLink } from "./feishu-document-link-extractor.js";

export type GroupVisibleDocumentRegistrar = {
  registerDiscoveredLinks(input: {
    chatId: string;
    messageId: string;
    senderId?: string;
    observedAt: Date;
    links: FeishuDocumentLink[];
  }): Promise<void>;
};

type GroupVisibleDocumentRegistry = {
  registerGroupVisibleDocument(input: RegisterGroupVisibleDocumentInput): Promise<DocumentSource>;
};

type RegisteredDocumentSyncPlanner = {
  planRegisteredSources(sources: DocumentSource[]): Promise<unknown>;
};

export function createGroupVisibleDocumentRegistrar({
  registry,
  syncPlanner,
}: {
  registry: GroupVisibleDocumentRegistry;
  syncPlanner?: RegisteredDocumentSyncPlanner;
}): GroupVisibleDocumentRegistrar {
  return {
    async registerDiscoveredLinks(input) {
      for (const link of dedupeLinks(input.links)) {
        const source = await registry.registerGroupVisibleDocument({
          sourceUri: link.sourceUri,
          originGroupId: input.chatId,
          originMessageId: input.messageId,
          observedByUserId: input.senderId,
          observedAt: input.observedAt,
        });
        await syncPlanner?.planRegisteredSources([source]);
      }
    },
  };
}

function dedupeLinks(links: FeishuDocumentLink[]): FeishuDocumentLink[] {
  const seen = new Set<string>();

  return links.filter((link) => {
    if (seen.has(link.sourceUri)) {
      return false;
    }
    seen.add(link.sourceUri);
    return true;
  });
}
