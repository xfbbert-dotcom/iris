import { describe, expect, it, vi } from "vitest";

import {
  createFeishuDocumentBodyFetcher,
  parseFeishuDocxDocumentId,
  parseFeishuWikiNodeToken,
} from "../src/documents/feishu-document-body-fetcher.js";
import type { DocumentSource } from "../src/documents/document-source-registry.js";

describe("FeishuDocumentBodyFetcher", () => {
  it("parses docx and docs document ids from Feishu URLs", () => {
    expect(parseFeishuDocxDocumentId("https://docs.feishu.cn/docx/doc_token_1")).toBe(
      "doc_token_1",
    );
    expect(parseFeishuDocxDocumentId("https://docs.feishu.cn/DOCX/doc_token_upper")).toBe(
      "doc_token_upper",
    );
    expect(parseFeishuDocxDocumentId("https://acme.feishu.cn/docs/doc_token_2?from=chat")).toBe(
      "doc_token_2",
    );
    expect(parseFeishuDocxDocumentId("https://acme.feishu.cn/wiki/wiki_token")).toBeUndefined();
    expect(parseFeishuDocxDocumentId("https://evil.com/docx/doc_token_3")).toBeUndefined();
    expect(parseFeishuDocxDocumentId("http://docs.feishu.cn/docx/doc_token_http")).toBeUndefined();
    expect(
      parseFeishuDocxDocumentId("https://user:pass@docs.feishu.cn/docx/doc_token_1"),
    ).toBeUndefined();
    expect(
      parseFeishuDocxDocumentId("https://acme.feishu.cn/minutes/docx/doc_token_4"),
    ).toBeUndefined();
    expect(
      parseFeishuDocxDocumentId(`https://docs.feishu.cn/docx/${"d".repeat(513)}`),
    ).toBeUndefined();
  });

  it("parses wiki node tokens from Feishu URLs", () => {
    expect(parseFeishuWikiNodeToken("https://acme.feishu.cn/wiki/wiki_token_1")).toBe(
      "wiki_token_1",
    );
    expect(parseFeishuWikiNodeToken("https://acme.feishu.cn/WIKI/wiki_token_upper")).toBe(
      "wiki_token_upper",
    );
    expect(parseFeishuWikiNodeToken("https://acme.feishu.cn/wiki/wiki_token_2?from=chat")).toBe(
      "wiki_token_2",
    );
    expect(parseFeishuWikiNodeToken("https://docs.feishu.cn/docx/doc_token_1")).toBeUndefined();
    expect(parseFeishuWikiNodeToken("https://evil.com/wiki/wiki_token_3")).toBeUndefined();
    expect(parseFeishuWikiNodeToken("http://acme.feishu.cn/wiki/wiki_token_http")).toBeUndefined();
    expect(
      parseFeishuWikiNodeToken("https://user@acme.feishu.cn/wiki/wiki_token_1"),
    ).toBeUndefined();
    expect(
      parseFeishuWikiNodeToken("https://acme.feishu.cn/drive/wiki/wiki_token_4"),
    ).toBeUndefined();
    expect(
      parseFeishuWikiNodeToken(`https://acme.feishu.cn/wiki/${"w".repeat(513)}`),
    ).toBeUndefined();
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
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer tenant-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("fetches raw content for user-submitted document sources", async () => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const fetch = vi.fn(async () =>
      jsonResponse({ code: 0, data: { content: "User submitted body" } }),
    );
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider,
      fetch,
      now: () => new Date("2026-07-03T03:20:00.000Z"),
    });

    await expect(
      fetcher.fetch(
        source({
          sourceType: "user_submitted_document",
          submittedByUserId: "ou_1",
          originGroupId: undefined,
          originMessageId: undefined,
        }),
      ),
    ).resolves.toEqual({
      bodyText: "User submitted body",
      fetchedAt: new Date("2026-07-03T03:20:00.000Z"),
    });
    expect(tokenProvider.getTenantAccessToken).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/docx/v1/documents/doc_token_1/raw_content",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer tenant-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("resolves Feishu wiki document nodes before fetching raw content", async () => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: { node: { obj_token: "doc_token_from_wiki", obj_type: "docx" } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { content: "Wiki doc body" } }));
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn/",
      tokenProvider,
      fetch,
      now: () => new Date("2026-07-03T03:30:00.000Z"),
    });

    await expect(
      fetcher.fetch(
        source({
          sourceType: "authorized_wiki_document",
          sourceUri: "https://acme.feishu.cn/wiki/wiki_token_1",
          originGroupId: undefined,
          originMessageId: undefined,
          authorizedSpaceId: "space-1",
        }),
      ),
    ).resolves.toEqual({
      bodyText: "Wiki doc body",
      fetchedAt: new Date("2026-07-03T03:30:00.000Z"),
    });
    expect(tokenProvider.getTenantAccessToken).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=wiki_token_1",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer tenant-token" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://open.feishu.cn/open-apis/docx/v1/documents/doc_token_from_wiki/raw_content",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer tenant-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("times out raw content requests", async () => {
    const fetch = vi.fn(async (_url, init) => {
      if (init?.signal === undefined) {
        throw new Error("missing abort signal");
      }
      init.signal.dispatchEvent(new Event("abort"));
      throw abortError();
    }) as typeof globalThis.fetch;
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
      timeoutMs: 1,
    });

    await expect(fetcher.fetch(source())).rejects.toThrow(
      "Feishu document raw content request timed out",
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/docx/v1/documents/doc_token_1/raw_content",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("treats aborted raw content response body reads as request timeouts", async () => {
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => abortingJsonResponse()),
      timeoutMs: 1,
    });

    await expect(fetcher.fetch(source())).rejects.toThrow(
      "Feishu document raw content request timed out",
    );
  });

  it("times out wiki node requests", async () => {
    const fetch = vi.fn(async (_url, init) => {
      if (init?.signal === undefined) {
        throw new Error("missing abort signal");
      }
      init.signal.dispatchEvent(new Event("abort"));
      throw abortError();
    }) as typeof globalThis.fetch;
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
      timeoutMs: 1,
    });

    await expect(
      fetcher.fetch(
        source({
          sourceType: "authorized_wiki_document",
          sourceUri: "https://acme.feishu.cn/wiki/wiki_token_1",
          originGroupId: undefined,
          originMessageId: undefined,
          authorizedSpaceId: "space-1",
        }),
      ),
    ).rejects.toThrow("Feishu wiki node request timed out");
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=wiki_token_1",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("treats aborted wiki node response body reads as request timeouts", async () => {
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => abortingJsonResponse()),
      timeoutMs: 1,
    });

    await expect(
      fetcher.fetch(
        source({
          sourceType: "authorized_wiki_document",
          sourceUri: "https://acme.feishu.cn/wiki/wiki_token_1",
          originGroupId: undefined,
          originMessageId: undefined,
          authorizedSpaceId: "space-1",
        }),
      ),
    ).rejects.toThrow("Feishu wiki node request timed out");
  });

  it("rejects unsupported source types and URL shapes", async () => {
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(),
    });

    await expect(
      fetcher.fetch(source({ sourceUri: "https://acme.feishu.cn/file/file_1" })),
    ).rejects.toThrow("unsupported Feishu docx URL");
  });

  it("rejects unsupported URL shapes before requesting a tenant token", async () => {
    const tokenProvider = {
      getTenantAccessToken: vi.fn(async () => {
        throw new Error("tenant token should not be requested");
      }),
    };
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider,
      fetch: vi.fn(),
    });

    await expect(
      fetcher.fetch(source({ sourceUri: "https://acme.feishu.cn/file/file_1" })),
    ).rejects.toThrow("unsupported Feishu docx URL");
    expect(tokenProvider.getTenantAccessToken).not.toHaveBeenCalled();
  });

  it("throws on unsupported wiki object types", async () => {
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () =>
        jsonResponse({
          code: 0,
          data: { node: { obj_token: "sheet_token_1", obj_type: "sheet" } },
        }),
      ),
    });

    await expect(
      fetcher.fetch(source({ sourceUri: "https://acme.feishu.cn/wiki/wiki_1" })),
    ).rejects.toThrow("unsupported Feishu wiki object type: sheet");
  });

  it("throws before raw content fetches when wiki node document tokens are oversized", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        code: 0,
        data: { node: { obj_token: "d".repeat(513), obj_type: "docx" } },
      }),
    );
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
    });

    await expect(
      fetcher.fetch(source({ sourceUri: "https://acme.feishu.cn/wiki/wiki_1" })),
    ).rejects.toThrow("Feishu wiki node response did not include document token");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized wiki node responses before raw content fetches", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              node: { obj_token: "doc_token_from_wiki", obj_type: "docx" },
              padding: "x".repeat(70_000),
            },
          }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { content: "Doc body" } }));
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
    });

    await expect(
      fetcher.fetch(source({ sourceUri: "https://acme.feishu.cn/wiki/wiki_1" })),
    ).rejects.toThrow("Feishu wiki node response exceeds 65536 bytes");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("throws when raw content responses omit the Feishu code", async () => {
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => jsonResponse({ data: { content: "Doc body" } })),
    });

    await expect(fetcher.fetch(source())).rejects.toThrow(
      "Feishu document raw content response did not include code",
    );
  });

  it("throws before raw content fetches when wiki node responses omit the Feishu code", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        data: { node: { obj_token: "doc_token_from_wiki", obj_type: "docx" } },
      }),
    );
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
    });

    await expect(
      fetcher.fetch(
        source({
          sourceType: "authorized_wiki_document",
          sourceUri: "https://acme.feishu.cn/wiki/wiki_token_1",
          originGroupId: undefined,
          originMessageId: undefined,
          authorizedSpaceId: "space-1",
        }),
      ),
    ).rejects.toThrow("Feishu wiki node response did not include code");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("throws on non-ok wiki node responses", async () => {
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => jsonResponse({ msg: "forbidden" }, { ok: false, status: 403 })),
    });

    await expect(
      fetcher.fetch(source({ sourceUri: "https://acme.feishu.cn/wiki/wiki_1" })),
    ).rejects.toThrow("Feishu wiki node request failed with status 403: forbidden");
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

  it("rejects raw content that exceeds the configured content size", async () => {
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => jsonResponse({ code: 0, data: { content: "123456" } })),
      maxContentChars: 5,
    });

    await expect(fetcher.fetch(source())).rejects.toThrow(
      "Feishu document raw content exceeds 5 characters",
    );
  });

  it("rejects oversized raw content responses before parsing JSON when content-length is known", async () => {
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "4102" }),
        json: async () => {
          throw new Error("json should not be read");
        },
      } as unknown as Response)),
      maxContentChars: 5,
    });

    await expect(fetcher.fetch(source())).rejects.toThrow(
      "Feishu document raw content response exceeds 4101 bytes",
    );
  });

  it("rejects oversized raw content responses while streaming when content-length is unknown", async () => {
    const fetcher = createFeishuDocumentBodyFetcher({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ code: 0, data: { content: "x".repeat(5000) } })),
      ),
      maxContentChars: 5,
    });

    await expect(fetcher.fetch(source())).rejects.toThrow(
      "Feishu document raw content response exceeds 4101 bytes",
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
      } as unknown as Response)),
    });

    await expect(fetcher.fetch(source())).rejects.toThrow(
      "Feishu document raw content response was not valid JSON",
    );
  });

  it("rejects invalid timeout configuration before document requests can start", () => {
    for (const timeoutMs of [
      0,
      1.5,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      9007199254740992,
    ]) {
      expect(() =>
        createFeishuDocumentBodyFetcher({
          baseUrl: "https://open.feishu.cn",
          tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
          fetch: vi.fn(),
          timeoutMs,
        }),
      ).toThrow("Feishu document fetch timeoutMs must be a positive safe integer");
    }
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
  } as unknown as Response;
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function abortingJsonResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw abortError();
    },
  } as unknown as Response;
}
