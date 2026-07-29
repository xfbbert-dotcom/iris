import { describe, expect, it, vi } from "vitest";

import {
  createFeishuWikiSpaceClient,
  WikiSpaceSyncError,
} from "../src/documents/feishu-wiki-space-client.js";

describe("FeishuWikiSpaceClient", () => {
  it("gets a wiki node with the tenant bearer token and maps its documented fields", async () => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const fetch = vi.fn(async () => jsonResponse({
      code: 0,
      data: { node: node({ node_token: "root", obj_token: "doc-root", space_id: "space-1" }) },
    }));
    const client = createFeishuWikiSpaceClient({
      baseUrl: "https://open.feishu.cn/",
      tokenProvider,
      fetch,
    });

    await expect(client.getNode("root")).resolves.toEqual({
      nodeToken: "root",
      objectToken: "doc-root",
      objectType: "docx",
      spaceId: "space-1",
      title: "Root",
      hasChild: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=root",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer tenant-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("maps a child page and keeps pagination after an empty permission-filtered page", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { items: [], has_more: true, page_token: "next" } }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { items: [node({ node_token: "child", obj_token: "doc-child" })], has_more: false },
      }));
    const client = createFeishuWikiSpaceClient({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
    });

    await expect(client.listChildren({ spaceId: "space 1", parentNodeToken: "root", pageSize: 50 }))
      .resolves.toEqual({ nodes: [], nextPageToken: "next" });
    await expect(client.listChildren({
      spaceId: "space 1",
      parentNodeToken: "root",
      pageToken: "next",
      pageSize: 20,
    })).resolves.toEqual({
      nodes: [{
        nodeToken: "child",
        objectToken: "doc-child",
        objectType: "docx",
        spaceId: "space-1",
        title: "Root",
        hasChild: true,
      }],
    });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://open.feishu.cn/open-apis/wiki/v2/spaces/space%201/nodes?parent_node_token=root&page_size=50",
      expect.anything(),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://open.feishu.cn/open-apis/wiki/v2/spaces/space%201/nodes?parent_node_token=root&page_size=20&page_token=next",
      expect.anything(),
    );
  });

  it.each([
    [401, "unauthorized", false],
    [403, "forbidden", false],
    [404, "not_found", false],
    [429, "rate_limited", true],
    [500, "upstream_unavailable", true],
  ] as const)("classifies HTTP %i without exposing upstream response bodies", async (status, classification, retriable) => {
    const client = createFeishuWikiSpaceClient({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-secret") },
      fetch: vi.fn(async () => jsonResponse({ msg: "raw upstream body tenant-secret" }, { status })),
    });

    const error = await client.getNode("root").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WikiSpaceSyncError);
    expect(error).toMatchObject({ classification, retriable });
    expect(String(error)).not.toContain("tenant-secret");
    expect(String(error)).not.toContain("raw upstream body");
  });

  it("rejects known oversized JSON responses before parsing them", async () => {
    const client = createFeishuWikiSpaceClient({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => jsonResponse({ code: 0 }, { headers: { "content-length": "65537" } })),
      maxResponseBytes: 65_536,
    });

    await expect(client.getNode("root")).rejects.toMatchObject({
      classification: "invalid_response",
      retriable: false,
    });
  });

  it("classifies aborted requests as retryable timeouts", async () => {
    const client = createFeishuWikiSpaceClient({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async (_url, init) => {
        init?.signal?.dispatchEvent(new Event("abort"));
        throw abortError();
      }) as typeof globalThis.fetch,
      timeoutMs: 1,
    });

    await expect(client.getNode("root")).rejects.toMatchObject({
      classification: "timeout",
      retriable: true,
    });
  });
});

function node(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    node_token: "root",
    obj_token: "doc-root",
    obj_type: "docx",
    space_id: "space-1",
    title: "Root",
    has_child: true,
    ...overrides,
  };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function abortError(): Error {
  const error = new Error("request aborted");
  error.name = "AbortError";
  return error;
}
