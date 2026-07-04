import { describe, expect, it, vi } from "vitest";

import { createGroupVisibleDocumentRegistrar } from "../src/documents/group-visible-document-registrar.js";
import type { DocumentSource } from "../src/documents/document-source-registry.js";

describe("GroupVisibleDocumentRegistrar", () => {
  it("registers discovered links as group-visible documents with evidence", async () => {
    const registry = {
      registerGroupVisibleDocument: vi.fn(async () => source()),
    };
    const registrar = createGroupVisibleDocumentRegistrar({ registry });

    await registrar.registerDiscoveredLinks({
      chatId: "oc_1",
      messageId: "om_1",
      senderId: "ou_1",
      observedAt: new Date("2026-07-02T10:00:00.000Z"),
      links: [
        { sourceUri: "https://docs.feishu.cn/docx/a" },
        { sourceUri: "https://acme.larksuite.com/wiki/b" },
      ],
    });

    expect(registry.registerGroupVisibleDocument).toHaveBeenCalledTimes(2);
    expect(registry.registerGroupVisibleDocument).toHaveBeenNthCalledWith(1, {
      sourceUri: "https://docs.feishu.cn/docx/a",
      originGroupId: "oc_1",
      originMessageId: "om_1",
      observedByUserId: "ou_1",
      observedAt: new Date("2026-07-02T10:00:00.000Z"),
    });
  });

  it("plans sync for registered document sources", async () => {
    const registered = source({ id: "source-1" });
    const registry = {
      registerGroupVisibleDocument: vi.fn(async () => registered),
    };
    const syncPlanner = {
      planRegisteredSources: vi.fn(async () => ({ enqueuedCount: 1, skippedCount: 0 })),
    };
    const registrar = createGroupVisibleDocumentRegistrar({ registry, syncPlanner });

    await registrar.registerDiscoveredLinks({
      chatId: "oc_1",
      messageId: "om_1",
      observedAt: new Date("2026-07-02T10:00:00.000Z"),
      links: [{ sourceUri: "https://docs.feishu.cn/docx/a" }],
    });

    expect(syncPlanner.planRegisteredSources).toHaveBeenCalledWith([registered]);
  });

  it("plans sync once with every registered document from a message", async () => {
    const first = source({ id: "source-1", sourceUri: "https://docs.feishu.cn/docx/a" });
    const second = source({ id: "source-2", sourceUri: "https://docs.feishu.cn/docx/b" });
    const registry = {
      registerGroupVisibleDocument: vi.fn(async (input: { sourceUri: string }) =>
        input.sourceUri.endsWith("/a") ? first : second,
      ),
    };
    const syncPlanner = {
      planRegisteredSources: vi.fn(async () => ({ enqueuedCount: 2, skippedCount: 0 })),
    };
    const registrar = createGroupVisibleDocumentRegistrar({ registry, syncPlanner });

    await registrar.registerDiscoveredLinks({
      chatId: "oc_1",
      messageId: "om_1",
      observedAt: new Date("2026-07-02T10:00:00.000Z"),
      links: [
        { sourceUri: "https://docs.feishu.cn/docx/a" },
        { sourceUri: "https://docs.feishu.cn/docx/b" },
      ],
    });

    expect(syncPlanner.planRegisteredSources).toHaveBeenCalledTimes(1);
    expect(syncPlanner.planRegisteredSources).toHaveBeenCalledWith([first, second]);
  });

  it("deduplicates repeated links before registration and sync planning", async () => {
    const registered = source({ id: "source-1" });
    const registry = {
      registerGroupVisibleDocument: vi.fn(async () => registered),
    };
    const syncPlanner = {
      planRegisteredSources: vi.fn(async () => ({ enqueuedCount: 1, skippedCount: 0 })),
    };
    const registrar = createGroupVisibleDocumentRegistrar({ registry, syncPlanner });

    await registrar.registerDiscoveredLinks({
      chatId: "oc_1",
      messageId: "om_1",
      observedAt: new Date("2026-07-02T10:00:00.000Z"),
      links: [
        { sourceUri: "https://docs.feishu.cn/docx/a" },
        { sourceUri: "https://docs.feishu.cn/docx/a" },
      ],
    });

    expect(registry.registerGroupVisibleDocument).toHaveBeenCalledTimes(1);
    expect(syncPlanner.planRegisteredSources).toHaveBeenCalledTimes(1);
  });

  it("deduplicates links by trimmed sourceUri before registration", async () => {
    const registered = source({ id: "source-1" });
    const registry = {
      registerGroupVisibleDocument: vi.fn(async () => registered),
    };
    const syncPlanner = {
      planRegisteredSources: vi.fn(async () => ({ enqueuedCount: 1, skippedCount: 0 })),
    };
    const registrar = createGroupVisibleDocumentRegistrar({ registry, syncPlanner });

    await registrar.registerDiscoveredLinks({
      chatId: "oc_1",
      messageId: "om_1",
      observedAt: new Date("2026-07-02T10:00:00.000Z"),
      links: [
        { sourceUri: " https://docs.feishu.cn/docx/a " },
        { sourceUri: "https://docs.feishu.cn/docx/a" },
      ],
    });

    expect(registry.registerGroupVisibleDocument).toHaveBeenCalledTimes(1);
    expect(registry.registerGroupVisibleDocument).toHaveBeenCalledWith({
      sourceUri: "https://docs.feishu.cn/docx/a",
      originGroupId: "oc_1",
      originMessageId: "om_1",
      observedByUserId: undefined,
      observedAt: new Date("2026-07-02T10:00:00.000Z"),
    });
    expect(syncPlanner.planRegisteredSources).toHaveBeenCalledTimes(1);
  });

  it("bounds discovered links from one message before registration and sync planning", async () => {
    const registry = {
      registerGroupVisibleDocument: vi.fn(async (input: { sourceUri: string }) =>
        source({ id: input.sourceUri.split("/").at(-1), sourceUri: input.sourceUri }),
      ),
    };
    const syncPlanner = {
      planRegisteredSources: vi.fn(async (_sources: DocumentSource[]) => ({
        enqueuedCount: 20,
        skippedCount: 0,
      })),
    };
    const registrar = createGroupVisibleDocumentRegistrar({ registry, syncPlanner });
    const links = Array.from({ length: 25 }, (_, index) => ({
      sourceUri: `https://docs.feishu.cn/docx/token-${index}`,
    }));

    await registrar.registerDiscoveredLinks({
      chatId: "oc_1",
      messageId: "om_1",
      observedAt: new Date("2026-07-02T10:00:00.000Z"),
      links,
    });

    expect(registry.registerGroupVisibleDocument).toHaveBeenCalledTimes(20);
    expect(registry.registerGroupVisibleDocument).toHaveBeenLastCalledWith({
      sourceUri: "https://docs.feishu.cn/docx/token-19",
      originGroupId: "oc_1",
      originMessageId: "om_1",
      observedByUserId: undefined,
      observedAt: new Date("2026-07-02T10:00:00.000Z"),
    });
    expect(syncPlanner.planRegisteredSources).toHaveBeenCalledTimes(1);
    expect(syncPlanner.planRegisteredSources).toHaveBeenCalledWith(
      expect.arrayContaining([
        source({ id: "token-19", sourceUri: "https://docs.feishu.cn/docx/token-19" }),
      ]),
    );
    const plannedSources = syncPlanner.planRegisteredSources.mock.calls[0]?.[0];
    expect(plannedSources).toHaveLength(20);
  });

  it("rejects when sync planning fails", async () => {
    const registry = {
      registerGroupVisibleDocument: vi.fn(async () => source({ id: "source-1" })),
    };
    const syncPlanner = {
      planRegisteredSources: vi.fn(async () => {
        throw new Error("sync queue unavailable");
      }),
    };
    const registrar = createGroupVisibleDocumentRegistrar({ registry, syncPlanner });

    await expect(
      registrar.registerDiscoveredLinks({
        chatId: "oc_1",
        messageId: "om_1",
        observedAt: new Date("2026-07-02T10:00:00.000Z"),
        links: [{ sourceUri: "https://docs.feishu.cn/docx/a" }],
      }),
    ).rejects.toThrow("sync queue unavailable");
  });

  it("does nothing when there are no discovered links", async () => {
    const registry = {
      registerGroupVisibleDocument: vi.fn(async () => source()),
    };
    const registrar = createGroupVisibleDocumentRegistrar({ registry });

    await registrar.registerDiscoveredLinks({
      chatId: "oc_1",
      messageId: "om_1",
      observedAt: new Date("2026-07-02T10:00:00.000Z"),
      links: [],
    });

    expect(registry.registerGroupVisibleDocument).not.toHaveBeenCalled();
  });
});

function source(overrides: Partial<DocumentSource> = {}): DocumentSource {
  const createdAt = new Date("2026-07-02T10:00:00.000Z");

  return {
    id: "source-1",
    sourceType: "group_visible_document",
    sourceUri: "https://docs.feishu.cn/docx/a",
    originGroupId: "oc_1",
    originMessageId: "om_1",
    submittedByUserId: undefined,
    authorizedSpaceId: undefined,
    permissionState: "unknown",
    syncState: "pending",
    canUseForAnswering: true,
    canUseForKnowledgeDrafts: true,
    createdAt,
    updatedAt: createdAt,
    evidence: [],
    ...overrides,
  };
}
