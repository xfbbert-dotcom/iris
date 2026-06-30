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

  canProcessGroupMessage(groupId: string): boolean {
    return this.config.globalEnabled && !this.config.disabledGroupIds.has(groupId);
  }

  canReplyWhenMentioned(groupId: string): boolean {
    return this.canProcessGroupMessage(groupId) && this.config.capabilities.replyWhenMentioned;
  }

  canProactivelySpeak(groupId: string): boolean {
    return this.canProcessGroupMessage(groupId) && this.config.capabilities.proactiveSpeech;
  }

  canReadDocuments(): boolean {
    return this.config.globalEnabled && this.config.capabilities.readGroupDocuments;
  }

  canWriteKnowledgeBase(): boolean {
    return this.config.globalEnabled && this.config.capabilities.writeKnowledgeBase;
  }
}
