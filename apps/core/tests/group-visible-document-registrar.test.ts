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
