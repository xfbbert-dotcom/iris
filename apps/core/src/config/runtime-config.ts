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

type RuntimeConfigEnv = Record<string, string | undefined>;

export function createDefaultRuntimeConfig(env: RuntimeConfigEnv = process.env): RuntimeConfig {
  return {
    globalEnabled: readOptionalBoolean(
      "IRIS_RUNTIME_GLOBAL_ENABLED",
      env.IRIS_RUNTIME_GLOBAL_ENABLED,
      true,
    ),
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

function readOptionalBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}
