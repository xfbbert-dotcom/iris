import type { RuntimeConfig } from "../config/runtime-config.js";

export class RuntimeController {
  constructor(private readonly config: RuntimeConfig) {}

  disableGlobal(): void {
    this.config.globalEnabled = false;
  }

  enableGlobal(): void {
    this.config.globalEnabled = true;
  }

  disableGroup(groupId: string): void {
    this.config.disabledGroupIds.add(groupId);
  }

  enableGroup(groupId: string): void {
    this.config.disabledGroupIds.delete(groupId);
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
    return this.config.globalEnabled && !this.config.disabledGroupIds.has(groupId);
  }

  canReplyWhenMentioned(groupId: string): boolean {
    return this.canProcessGroupMessage(groupId) && this.config.capabilities.replyWhenMentioned;
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
