import { describe, expect, it, vi } from "vitest";

import {
  createFeishuDocumentBodyFetcher,
  parseFeishuDocxDocumentId,
} from "../src/documents/feishu-document-body-fetcher.js";
import type { DocumentSource } from "../src/documents/document-source-registry.js";

describe("FeishuDocumentBodyFetcher", () => {
  it("parses docx and docs document ids from Feishu URLs", () => {
    expect(parseFeishuDocxDocumentId("https://docs.feishu.cn/docx/doc_token_1")).toBe(
      "doc_token_1",
    );
    expect(parseFeishuDocxDocumentId("https://acme.feishu.cn/docs/doc_token_2?from=chat")).toBe(
      "doc_token_2",
    );
    expect(parseFeishuDocxDocumentId("https://acme.feishu.cn/wiki/wiki_token")).toBeUndefined();
  });

  it("fetches raw content for docx document sources", async () => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const fetch = vi.fn(async () => jsonResponse({ code: 0, data: { content: "Doc body" } }));
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider,
      fetch,
      now: () => new Date("2026-07-03T03:00:00.000Z"),
    });

    await expect(fetcher.fetch(source())).resolves.toEqual({
      bodyText: "Doc body",
      fetchedAt: new Date("2026-07-03T03:00:00.000Z"),
    });
    expect(tokenProvider.getTenantAccessToken).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/docx/v1/documents/doc_token_1/raw_content",
      {
        method: "GET",
        headers: { authorization: "Bearer tenant-token" },
      },
    );
  });

  it("rejects unsupported source types and URL shapes", async () => {
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(),
    });

    await expect(
      fetcher.fetch(source({ sourceType: "user_submitted_document" })),
    ).rejects.toThrow("unsupported Feishu document source type: user_submitted_document");
    await expect(fetcher.fetch(source({ sourceUri: "https://acme.feishu.cn/wiki/wiki_1" }))).rejects.toThrow(
      "unsupported Feishu docx URL",
    );
  });

  it("throws on non-ok raw content responses", async () => {
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => jsonResponse({ msg: "forbidden" }, { ok: false, status: 403 })),
    });

    await expect(fetcher.fetch(source())).rejects.toThrow(
      "Feishu document raw content request failed with status 403: forbidden",
    );
  });

  it("throws on non-zero Feishu codes and empty content", async () => {
    const nonZero = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => jsonResponse({ code: 999, msg: "bad document token" })),
    });
    await expect(nonZero.fetch(source())).rejects.toThrow(
      "Feishu document raw content request failed: bad document token",
    );

    const empty = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => jsonResponse({ code: 0, data: { content: "   " } })),
    });
    await expect(empty.fetch(source())).rejects.toThrow(
      "Feishu document raw content response did not include content",
    );
  });

  it("throws on invalid raw content JSON", async () => {
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("invalid json");
        },
      } as Response)),
    });

    await expect(fetcher.fetch(source())).rejects.toThrow(
      "Feishu document raw content response was not valid JSON",
    );
  });
});

function source(overrides: Partial<DocumentSource> = {}): DocumentSource {
  const createdAt = new Date("2026-07-03T03:00:00.000Z");

  return {
    id: "source-1",
    sourceType: "group_visible_document",
    sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
    originGroupId: "chat-1",
    originMessageId: "message-1",
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

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}
