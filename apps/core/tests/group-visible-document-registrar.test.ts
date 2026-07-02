import { describe, expect, it, vi } from "vitest";

import { createGroupVisibleDocumentRegistrar } from "../src/documents/group-visible-document-registrar.js";

describe("GroupVisibleDocumentRegistrar", () => {
  it("registers discovered links as group-visible documents with evidence", async () => {
    const registry = {
      registerGroupVisibleDocument: vi.fn(async () => undefined),
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

  it("does nothing when there are no discovered links", async () => {
    const registry = {
      registerGroupVisibleDocument: vi.fn(async () => undefined),
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
