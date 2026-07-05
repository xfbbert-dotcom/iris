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

  it("returns false when Feishu returns a known permission-denied code in a successful response", async () => {
    const checker = createFeishuDocumentPermissionChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => jsonResponse({ code: 99991663, msg: "permission denied" })),
    });

    await expect(
      checker.canReadSource(
        source({ sourceUri: "https://example.feishu.cn/docx/doccnDeniedCode" }),
      ),
    ).resolves.toBe(false);
  });

  it("throws when successful document metadata responses contain unknown non-zero codes", async () => {
    const checker = createFeishuDocumentPermissionChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => jsonResponse({ code: 1900001, msg: "tenant token invalid" })),
    });

    await expect(
      checker.canReadSource(
        source({ sourceUri: "https://example.feishu.cn/docx/doccnUnknownCode" }),
      ),
    ).rejects.toThrow("Feishu document permission request failed: tenant token invalid");
  });

  it("throws when Feishu document metadata has a transient server failure", async () => {
    const checker = createFeishuDocumentPermissionChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => jsonResponse({ code: 999, msg: "upstream unavailable" }, 500)),
    });

    await expect(
      checker.canReadSource(source({ sourceUri: "https://example.feishu.cn/docx/doccnTransient" })),
    ).rejects.toThrow(
      "Feishu document permission request failed with status 500: upstream unavailable",
    );
  });

  it("throws when successful document metadata responses omit the Feishu code", async () => {
    const checker = createFeishuDocumentPermissionChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => jsonResponse({ data: { document: { title: "Spec" } } })),
    });

    await expect(
      checker.canReadSource(
        source({ sourceUri: "https://example.feishu.cn/docx/doccnMalformed" }),
      ),
    ).rejects.toThrow("Feishu document permission response did not include code");
  });

  it("rejects oversized document metadata responses before allowing reads", async () => {
    const checker = createFeishuDocumentPermissionChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: { document: { title: "Spec" }, padding: "x".repeat(70_000) },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    });

    await expect(
      checker.canReadSource(
        source({ sourceUri: "https://example.feishu.cn/docx/doccnOversized" }),
      ),
    ).rejects.toThrow("Feishu document permission response exceeds 65536 bytes");
  });

  it("throws before metadata checks when successful wiki node responses omit the Feishu code", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        data: { node: { obj_type: "docx", obj_token: "doccnWikiDocument" } },
      }),
    );
    const checker = createFeishuDocumentPermissionChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
    });

    await expect(
      checker.canReadSource(source({ sourceUri: "https://example.feishu.cn/wiki/wikcnNode" })),
    ).rejects.toThrow("Feishu document permission response did not include code");
    expect(fetch).toHaveBeenCalledTimes(1);
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
    await expect(
      checker.canReadSource(source({ sourceUri: "http://example.feishu.cn/docx/doccnDirectToken" })),
    ).resolves.toBe(false);
    expect(tokenProvider.getTenantAccessToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns false when wiki node document tokens are oversized", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        code: 0,
        data: { node: { obj_type: "docx", obj_token: "d".repeat(513) } },
      }),
    );
    const checker = createFeishuDocumentPermissionChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
    });

    await expect(
      checker.canReadSource(source({ sourceUri: "https://example.feishu.cn/wiki/wiki-node" })),
    ).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns false for contaminated wiki node document tokens before metadata checks", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: { node: { obj_type: "docx", obj_token: "doccnWiki%2Fcontaminated" } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, data: { document: { title: "Should not read" } } }),
      );
    const checker = createFeishuDocumentPermissionChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
    });

    await expect(
      checker.canReadSource(source({ sourceUri: "https://example.feishu.cn/wiki/wiki-node" })),
    ).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
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
