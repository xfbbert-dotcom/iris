import type { RuntimeConfig } from "../config/runtime-config.js";

export type RuntimeControllerSnapshot = {
  globalEnabled: boolean;
  disabledGroupIds: string[];
  capabilities: RuntimeConfig["capabilities"];
};
export type RuntimeCapabilityName = keyof RuntimeConfig["capabilities"];

export interface RuntimeControlStore {
  load(defaultSnapshot: RuntimeControllerSnapshot): Promise<RuntimeControllerSnapshot>;
  setGlobalEnabled(enabled: boolean): Promise<void>;
  setGroupEnabled(groupId: string, enabled: boolean): Promise<void>;
  setCapabilities(updates: Partial<Record<RuntimeCapabilityName, boolean>>): Promise<void>;
}

export type RuntimeControlMutation = {
  previousEnabled: boolean;
  snapshot: RuntimeControllerSnapshot;
};
export type RuntimeControlCapabilitiesMutation = {
  previousEnabled: Partial<Record<RuntimeCapabilityName, boolean>>;
  snapshot: RuntimeControllerSnapshot;
};

export class RuntimeController {
  private mutationTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: RuntimeConfig,
    private readonly store?: RuntimeControlStore,
  ) {}

  async hydrate(): Promise<void> {
    if (this.store === undefined) {
      return;
    }

    const snapshot = await this.store.load(this.getSnapshot());
    this.applySnapshot(snapshot);
  }

  getSnapshot(): RuntimeControllerSnapshot {
    return {
      globalEnabled: this.config.globalEnabled,
      disabledGroupIds: [...this.config.disabledGroupIds].sort(),
      capabilities: { ...this.config.capabilities },
    };
  }

  disableGlobal(): Promise<RuntimeControlMutation> {
    return this.setGlobalEnabled(false);
  }

  enableGlobal(): Promise<RuntimeControlMutation> {
    return this.setGlobalEnabled(true);
  }

  disableGroup(groupId: string): Promise<RuntimeControlMutation> {
    return this.setGroupEnabled(groupId, false);
  }

  enableGroup(groupId: string): Promise<RuntimeControlMutation> {
    return this.setGroupEnabled(groupId, true);
  }

  setCapability(
    capability: RuntimeCapabilityName,
    enabled: boolean,
  ): Promise<RuntimeControlMutation> {
    return this.setCapabilities({ [capability]: enabled }).then((mutation) => ({
      previousEnabled: mutation.previousEnabled[capability] ?? enabled,
      snapshot: mutation.snapshot,
    }));
  }

  setCapabilities(
    updates: Partial<Record<RuntimeCapabilityName, boolean>>,
  ): Promise<RuntimeControlCapabilitiesMutation> {
    return this.enqueueMutation(async () => {
      const previousEnabled: Partial<Record<RuntimeCapabilityName, boolean>> = {};
      for (const capability of Object.keys(updates) as RuntimeCapabilityName[]) {
        previousEnabled[capability] = this.config.capabilities[capability];
      }
      await this.store?.setCapabilities(updates);
      Object.assign(this.config.capabilities, updates);
      return { previousEnabled, snapshot: this.getSnapshot() };
    });
  }

  pauseProactiveBehavior(): Promise<RuntimeControlMutation> {
    return this.setCapability("proactiveSpeech", false);
  }

  pauseDocumentReading(): Promise<RuntimeControlMutation> {
    return this.setCapability("readGroupDocuments", false);
  }

  pauseKnowledgeBaseWriting(): Promise<RuntimeControlMutation> {
    return this.setCapability("writeKnowledgeBase", false);
  }

  pauseExternalToolCalls(): Promise<RuntimeControlMutation> {
    return this.setCapability("callExternalTools", false);
  }

  private setGlobalEnabled(enabled: boolean): Promise<RuntimeControlMutation> {
    return this.enqueueMutation(async () => {
      const previousEnabled = this.config.globalEnabled;
      await this.store?.setGlobalEnabled(enabled);
      this.config.globalEnabled = enabled;
      return { previousEnabled, snapshot: this.getSnapshot() };
    });
  }

  private setGroupEnabled(
    groupId: string,
    enabled: boolean,
  ): Promise<RuntimeControlMutation> {
    const normalized = normalizeGroupId(groupId);
    if (normalized === undefined) {
      return Promise.resolve({
        previousEnabled: false,
        snapshot: this.getSnapshot(),
      });
    }

    return this.enqueueMutation(async () => {
      const previousEnabled = !this.config.disabledGroupIds.has(normalized);
      await this.store?.setGroupEnabled(normalized, enabled);
      if (enabled) {
        this.config.disabledGroupIds.delete(normalized);
      } else {
        this.config.disabledGroupIds.add(normalized);
      }
      return { previousEnabled, snapshot: this.getSnapshot() };
    });
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

  private applySnapshot(snapshot: RuntimeControllerSnapshot): void {
    this.config.globalEnabled = snapshot.globalEnabled;
    this.config.disabledGroupIds = new Set(snapshot.disabledGroupIds);
    this.config.capabilities = { ...snapshot.capabilities };
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.catch(() => undefined).then(operation);
    this.mutationTail = result;
    return result;
  }
}

function normalizeGroupId(groupId: string): string | undefined {
  const normalized = groupId.trim();
  return normalized.length > 0 ? normalized : undefined;
}
