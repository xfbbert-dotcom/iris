import { describe, expect, it, vi } from "vitest";

import { createFeishuDocumentPermissionChecker } from "../src/permissions/feishu-document-permission-checker.js";
import type { DocumentSource } from "../src/documents/document-source-registry.js";

describe("createFeishuDocumentPermissionChecker", () => {
  it("checks direct Feishu docx document metadata with a tenant token", async () => {
    const fetch = vi.fn(async () => jsonResponse({ code: 0, data: { document: { title: "Spec" } } }));
    const checker = createFeishuDocumentPermissionChecker({
      baseUrl: "https://open.feishu.cn/",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
      timeoutMs: 5000,
    });

    await expect(
      checker.canReadSource(
        source({ sourceUri: "https://example.feishu.cn/docx/doccnDirectToken" }),
      ),
    ).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/docx/v1/documents/doccnDirectToken",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer tenant-token" },
      }),
    );
  });

  it("resolves Feishu wiki nodes before checking document metadata", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: { node: { obj_type: "docx", obj_token: "doccnWikiDocument" } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { document: { title: "Wiki" } } }));
    const checker = createFeishuDocumentPermissionChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
    });

    await expect(
      checker.canReadSource(source({ sourceUri: "https://example.feishu.cn/wiki/wikcnNode" })),
    ).resolves.toBe(true);

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=wikcnNode",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://open.feishu.cn/open-apis/docx/v1/documents/doccnWikiDocument",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns false when Feishu denies document metadata access", async () => {
    const checker = createFeishuDocumentPermissionChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => jsonResponse({ code: 99991663, msg: "permission denied" }, 403)),
    });

    await expect(
      checker.canReadSource(source({ sourceUri: "https://example.feishu.cn/docx/doccnDenied" })),
    ).resolves.toBe(false);
  });

  it("returns false for unsupported document URLs", async () => {
    const fetch = vi.fn();
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const checker = createFeishuDocumentPermissionChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider,
      fetch,
    });

    await expect(
      checker.canReadSource(source({ sourceUri: "https://example.com/not-feishu" })),
    ).resolves.toBe(false);
    expect(tokenProvider.getTenantAccessToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unsafe timeout values before checking permissions", () => {
    expect(() =>
      createFeishuDocumentPermissionChecker({
        baseUrl: "https://open.feishu.cn",
        tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
        timeoutMs: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow("Feishu document permission timeoutMs must be a positive safe integer");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function source(overrides: Partial<DocumentSource> = {}): DocumentSource {
  return {
    id: "source-1",
    sourceType: "group_visible_document",
    sourceUri: "https://example.feishu.cn/docx/doccnDirectToken",
    permissionState: "readable",
    syncState: "synced",
    canUseForAnswering: true,
    canUseForKnowledgeDrafts: true,
    createdAt: new Date("2026-07-01T01:00:00.000Z"),
    updatedAt: new Date("2026-07-01T01:00:00.000Z"),
    evidence: [],
    ...overrides,
  };
}
