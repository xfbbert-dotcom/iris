import type { RegisterGroupVisibleDocumentInput } from "./document-source-registry.js";
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
  registerGroupVisibleDocument(input: RegisterGroupVisibleDocumentInput): Promise<unknown>;
};

export function createGroupVisibleDocumentRegistrar({
  registry,
}: {
  registry: GroupVisibleDocumentRegistry;
}): GroupVisibleDocumentRegistrar {
  return {
    async registerDiscoveredLinks(input) {
      for (const link of input.links) {
        await registry.registerGroupVisibleDocument({
          sourceUri: link.sourceUri,
          originGroupId: input.chatId,
          originMessageId: input.messageId,
          observedByUserId: input.senderId,
          observedAt: input.observedAt,
        });
      }
    },
  };
}
