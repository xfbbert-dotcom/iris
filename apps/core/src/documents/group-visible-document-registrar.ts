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
      const registeredSources: DocumentSource[] = [];
      for (const link of dedupeLinks(input.links)) {
        registeredSources.push(
          await registry.registerGroupVisibleDocument({
            sourceUri: link.sourceUri,
            originGroupId: input.chatId,
            originMessageId: input.messageId,
            observedByUserId: input.senderId,
            observedAt: input.observedAt,
          }),
        );
      }

      if (registeredSources.length > 0) {
        await syncPlanner?.planRegisteredSources(registeredSources);
      }
    },
  };
}

function dedupeLinks(links: FeishuDocumentLink[]): FeishuDocumentLink[] {
  const seen = new Set<string>();

  return links.flatMap((link) => {
    const sourceUri = link.sourceUri.trim();
    if (seen.has(sourceUri)) {
      return [];
    }
    if (sourceUri.length === 0) {
      return [];
    }
    seen.add(sourceUri);
    return [{ ...link, sourceUri }];
  });
}
