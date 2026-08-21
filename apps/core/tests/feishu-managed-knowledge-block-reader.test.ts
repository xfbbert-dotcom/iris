import { describe, expect, it, vi } from "vitest";

import { createFeishuManagedKnowledgeBlockReader } from "../src/action-approvals/feishu-managed-knowledge-block-reader.js";

describe("FeishuManagedKnowledgeBlockReader", () => {
  it("reads the exact plain-text block at the exact positive document revision", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/documents/docx_managed")) {
        return jsonResponse({ code: 0, data: { document: { revision_id: 12 } } });
      }
      expect(url.pathname).toBe(
        "/open-apis/docx/v1/documents/docx_managed/blocks/blk_body",
      );
      expect(url.searchParams.get("document_revision_id")).toBe("12");
      return jsonResponse({
        code: 0,
        data: {
          block: {
            block_id: "blk_body",
            block_type: 2,
            text: {
              elements: [
                { text_run: { content: "Approved " } },
                { text_run: { content: "body" } },
              ],
            },
          },
        },
      });
    });
    const reader = createFeishuManagedKnowledgeBlockReader({
      baseUrl: "https://open.example.com/",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(reader.readManagedBlock({
      remoteDocumentToken: "docx_managed",
      managedBodyBlockId: "blk_body",
    })).resolves.toEqual({
      revision: 12,
      blockType: "text",
      body: "Approved body",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({
        method: "GET",
        headers: { authorization: "Bearer tenant-token" },
      });
    }
  });

  it.each([
    {
      name: "missing block",
      document: { code: 0, data: { document: { revision_id: 12 } } },
      block: { code: 0, data: {} },
      message: "did not include the requested block",
    },
    {
      name: "unsupported block type",
      document: { code: 0, data: { document: { revision_id: 12 } } },
      block: { code: 0, data: { block: { block_id: "blk_body", block_type: 3 } } },
      message: "unsupported block type",
    },
    {
      name: "invalid revision",
      document: { code: 0, data: { document: { revision_id: 0 } } },
      block: undefined,
      message: "invalid revision",
    },
  ])("rejects $name", async ({ document, block, message }) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(document))
      .mockResolvedValueOnce(jsonResponse(block));
    const reader = createFeishuManagedKnowledgeBlockReader({
      baseUrl: "https://open.example.com",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(reader.readManagedBlock({
      remoteDocumentToken: "docx_managed",
      managedBodyBlockId: "blk_body",
    })).rejects.toThrow(message);
  });

  it.each([
    { name: "boolean", value: true },
    { name: "float", value: 1.5 },
    { name: "unsafe integer", value: Number.MAX_SAFE_INTEGER + 1 },
    { name: "digit string", value: "12" },
    { name: "exponent string", value: "1e2" },
    { name: "positive signed string", value: "+12" },
    { name: "negative signed string", value: "-12" },
    { name: "leading-whitespace string", value: " 12" },
    { name: "trailing-whitespace string", value: "12 " },
    { name: "blank string", value: "" },
    { name: "null", value: null },
  ])("rejects a $name document revision", async ({ value }) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { document: { revision_id: value } },
      }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: {} }));
    const reader = createFeishuManagedKnowledgeBlockReader({
      baseUrl: "https://open.example.com",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(reader.readManagedBlock({
      remoteDocumentToken: "docx_managed",
      managedBodyBlockId: "blk_body",
    })).rejects.toThrow("invalid revision");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects oversized block responses before parsing JSON", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { document: { revision_id: 12 } },
      }))
      .mockResolvedValueOnce(new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": "1000001",
        },
      }));
    const reader = createFeishuManagedKnowledgeBlockReader({
      baseUrl: "https://open.example.com",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(reader.readManagedBlock({
      remoteDocumentToken: "docx_managed",
      managedBodyBlockId: "blk_body",
    })).rejects.toThrow("response exceeds 1000000 bytes");
  });

  it("rejects a non-HTTPS base URL before requesting a token", () => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };

    expect(() => createFeishuManagedKnowledgeBlockReader({
      baseUrl: "http://open.example.com",
      tokenProvider,
    })).toThrow("baseUrl must be HTTPS");
    expect(tokenProvider.getTenantAccessToken).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
