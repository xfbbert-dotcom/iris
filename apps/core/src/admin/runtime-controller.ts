import type { RuntimeConfig } from "../config/runtime-config.js";

export type RuntimeControllerSnapshot = {
  globalEnabled: boolean;
  disabledGroupIds: string[];
  capabilities: RuntimeConfig["capabilities"];
};
export type RuntimeCapabilityName = keyof RuntimeConfig["capabilities"];

export class RuntimeController {
  constructor(private readonly config: RuntimeConfig) {}

  getSnapshot(): RuntimeControllerSnapshot {
    return {
      globalEnabled: this.config.globalEnabled,
      disabledGroupIds: [...this.config.disabledGroupIds].sort(),
      capabilities: { ...this.config.capabilities },
    };
  }

  disableGlobal(): void {
    this.config.globalEnabled = false;
  }

  enableGlobal(): void {
    this.config.globalEnabled = true;
  }

  disableGroup(groupId: string): void {
    const normalized = normalizeGroupId(groupId);
    if (normalized === undefined) {
      return;
    }

    this.config.disabledGroupIds.add(normalized);
  }

  enableGroup(groupId: string): void {
    const normalized = normalizeGroupId(groupId);
    if (normalized === undefined) {
      return;
    }

    this.config.disabledGroupIds.delete(normalized);
  }

  setCapability(capability: RuntimeCapabilityName, enabled: boolean): void {
    this.config.capabilities[capability] = enabled;
  }

  pauseProactiveBehavior(): void {
    this.config.capabilities.proactiveSpeech = false;
  }

  pauseDocumentReading(): void {
    this.config.capabilities.readGroupDocuments = false;
  }

  pauseKnowledgeBaseWriting(): void {
    this.config.capabilities.writeKnowledgeBase = false;
  }

  pauseExternalToolCalls(): void {
    this.config.capabilities.callExternalTools = false;
  }

  canProcessGroupMessage(groupId: string): boolean {
    const normalized = normalizeGroupId(groupId);
    return (
      normalized !== undefined &&
      this.config.globalEnabled &&
      !this.config.disabledGroupIds.has(normalized)
    );
  }

  canProcessIncomingEvent(input: { groupId?: string }): boolean {
    if (!this.config.globalEnabled) {
      return false;
    }
    if (input.groupId === undefined) {
      return true;
    }

    const normalized = normalizeGroupId(input.groupId);
    return normalized !== undefined && !this.config.disabledGroupIds.has(normalized);
  }

  canReplyWhenMentioned(groupId: string): boolean {
    return this.canProcessGroupMessage(groupId) && this.config.capabilities.replyWhenMentioned;
  }

  canGenerateAnswerDraft(input: { groupId?: string }): boolean {
    if (!this.config.globalEnabled || !this.config.capabilities.replyWhenMentioned) {
      return false;
    }
    if (input.groupId === undefined) {
      return true;
    }

    return this.canProcessGroupMessage(input.groupId);
  }

  canProactivelySpeak(groupId: string): boolean {
    return this.canProcessGroupMessage(groupId) && this.config.capabilities.proactiveSpeech;
  }

  canReadGroupContext(groupId: string): boolean {
    return this.canProcessGroupMessage(groupId) && this.config.capabilities.readGroupContext;
  }

  canReadDocuments(): boolean {
    return this.config.globalEnabled && this.config.capabilities.readGroupDocuments;
  }

  canRetrieveKnowledgeBase(): boolean {
    return this.config.globalEnabled && this.config.capabilities.retrieveKnowledgeBase;
  }

  canGenerateKnowledgeDrafts(): boolean {
    return this.config.globalEnabled && this.config.capabilities.generateKnowledgeDrafts;
  }

  canWriteKnowledgeBase(): boolean {
    return this.config.globalEnabled && this.config.capabilities.writeKnowledgeBase;
  }

  canCallExternalTools(): boolean {
    return this.config.globalEnabled && this.config.capabilities.callExternalTools;
  }
}

function normalizeGroupId(groupId: string): string | undefined {
  const normalized = groupId.trim();
  return normalized.length > 0 ? normalized : undefined;
}
