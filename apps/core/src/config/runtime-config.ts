export type IrisCapability = {
  readGroupContext: boolean;
  replyWhenMentioned: boolean;
  readGroupDocuments: boolean;
  retrieveKnowledgeBase: boolean;
  proactiveSpeech: boolean;
  generateKnowledgeDrafts: boolean;
  writeKnowledgeBase: boolean;
  callExternalTools: boolean;
};

export type RuntimeConfig = {
  globalEnabled: boolean;
  disabledGroupIds: Set<string>;
  capabilities: IrisCapability;
};

export function createDefaultRuntimeConfig(): RuntimeConfig {
  return {
    globalEnabled: true,
    disabledGroupIds: new Set<string>(),
    capabilities: {
      readGroupContext: true,
      replyWhenMentioned: true,
      readGroupDocuments: true,
      retrieveKnowledgeBase: true,
      proactiveSpeech: true,
      generateKnowledgeDrafts: true,
      writeKnowledgeBase: false,
      callExternalTools: false
    }
  };
}
