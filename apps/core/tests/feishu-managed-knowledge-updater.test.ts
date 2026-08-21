import { describe, expect, it, vi } from "vitest";

import type { ManagedBlockReader } from "../src/action-approvals/feishu-managed-knowledge-block-reader.js";
import {
  createFeishuManagedKnowledgeUpdater,
} from "../src/action-approvals/feishu-managed-knowledge-updater.js";

const validUpdateInput = {
  remoteDocumentToken: "docx_1",
  managedBodyBlockId: "blk_body",
  expectedRevision: 12,
  proposedBody: "New approved body",
  clientToken: "9d8f9c68-9d9a-5f1c-9f5b-d4fa75c9d4ef",
};

describe("FeishuManagedKnowledgeUpdater", () => {
  it("sends one exact text-element replacement at the bound revision", async () => {
    const fetch = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => jsonResponse({
      code: 0,
      data: { document_revision_id: 13 },
    }));
    const updater = createUpdater({ fetch });

    await expect(updater.update(validUpdateInput)).resolves.toEqual({
      kind: "applied",
      resultingRevision: 13,
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [rawUrl, init] = fetch.mock.calls[0];
    expect(String(rawUrl)).toBe(
      "https://open.feishu.cn/open-apis/docx/v1/documents/docx_1/blocks/batch_update?document_revision_id=12&client_token=9d8f9c68-9d9a-5f1c-9f5b-d4fa75c9d4ef",
    );
    expect(init).toMatchObject({
      method: "PATCH",
      headers: {
        authorization: "Bearer tenant-secret",
        "content-type": "application/json; charset=utf-8",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      requests: [{
        block_id: "blk_body",
        update_text_elements: {
          elements: [{
            text_run: {
              content: "New approved body",
              text_element_style: {},
            },
          }],
        },
      }],
    });
  });

  it("uses the shared managed-body normalization for the replacement text", async () => {
    const fetch = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => jsonResponse({
      code: 0,
      data: { document_revision_id: 13 },
    }));
    const updater = createUpdater({ fetch });

    await updater.update({
      ...validUpdateInput,
      proposedBody: "  First line\r\nSecond line  ",
    });

    const [, init] = fetch.mock.calls[0];
    expect(JSON.parse(String(init?.body)).requests[0].update_text_elements.elements)
      .toEqual([{ text_run: { content: "First line\nSecond line", text_element_style: {} } }]);
  });

  it.each([
    { name: "wildcard", value: -1 },
    { name: "zero", value: 0 },
    { name: "negative", value: -2 },
    { name: "fraction", value: 1.5 },
    { name: "unsafe integer", value: Number.MAX_SAFE_INTEGER + 1 },
    { name: "numeric string", value: "12" },
  ])("rejects a $name revision before requesting a token or fetching", async ({ value }) => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-secret") };
    const fetch = vi.fn();
    const updater = createUpdater({ tokenProvider, fetch });

    await expect(updater.update({
      ...validUpdateInput,
      expectedRevision: value as never,
    })).rejects.toThrow(/revision/iu);
    expect(tokenProvider.getTenantAccessToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { name: "blank document token", field: "remoteDocumentToken", value: " " },
    { name: "oversized block id", field: "managedBodyBlockId", value: "b".repeat(513) },
    { name: "blank client token", field: "clientToken", value: "" },
    { name: "oversized client token", field: "clientToken", value: "t".repeat(65) },
    { name: "blank body", field: "proposedBody", value: " \r\n " },
    { name: "oversized Feishu body", field: "proposedBody", value: "x".repeat(100_001) },
  ])("rejects a $name before requesting a token or fetching", async ({ field, value }) => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-secret") };
    const fetch = vi.fn();
    const updater = createUpdater({ tokenProvider, fetch });

    await expect(updater.update({
      ...validUpdateInput,
      [field]: value,
    })).rejects.toThrow();
    expect(tokenProvider.getTenantAccessToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "stale revision",
      response: jsonResponse({ code: 1770021, msg: "too old document" }, { status: 400 }),
      expected: { kind: "rejected", code: "stale_revision" },
    },
    {
      name: "forbidden",
      response: jsonResponse({ code: 1770032, msg: "forbidden" }, { status: 403 }),
      expected: { kind: "rejected", code: "forbidden" },
    },
    {
      name: "missing document",
      response: jsonResponse({ code: 1770002, msg: "not found" }, { status: 404 }),
      expected: { kind: "rejected", code: "missing" },
    },
    {
      name: "deleted resource",
      response: jsonResponse({ code: 1770003, msg: "resource deleted" }, { status: 400 }),
      expected: { kind: "rejected", code: "missing" },
    },
    {
      name: "invalid request",
      response: jsonResponse({ code: 1770001, msg: "invalid param" }, { status: 400 }),
      expected: { kind: "rejected", code: "invalid" },
    },
    {
      name: "rate limit",
      response: jsonResponse({ code: 99991400, msg: "rate limited" }, { status: 429 }),
      expected: { kind: "not_applied_retryable", code: "rate_limited" },
    },
    {
      name: "server error",
      response: jsonResponse({ code: 1771001, msg: "server error" }, { status: 500 }),
      expected: { kind: "not_applied_retryable", code: "server_error" },
    },
  ])("returns a typed $name outcome", async ({ response, expected }) => {
    const updater = createUpdater({ fetch: vi.fn(async () => response) });

    await expect(updater.update(validUpdateInput)).resolves.toEqual(expected);
  });

  it("fails closed when Feishu status and application code disagree", async () => {
    const updater = createUpdater({
      fetch: vi.fn(async () => jsonResponse({ code: 1770032, msg: "forbidden" })),
    });

    await expect(updater.update(validUpdateInput)).resolves.toEqual({
      kind: "unknown",
      code: "malformed_success",
    });
  });

  it.each([undefined, 0, -1, 1.5, "13", Number.MAX_SAFE_INTEGER + 1])(
    "requires a strict positive resulting revision on success: %s",
    async (documentRevisionId) => {
      const updater = createUpdater({
        fetch: vi.fn(async () => jsonResponse({
          code: 0,
          data: { document_revision_id: documentRevisionId },
        })),
      });

      await expect(updater.update(validUpdateInput)).resolves.toEqual({
        kind: "unknown",
        code: "malformed_success",
      });
    },
  );

  it("returns timeout when the dispatched request is aborted by its deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("secret body", "AbortError"));
          });
        }));
      const updater = createUpdater({ fetch, timeoutMs: 25 });

      const pending = updater.update(validUpdateInput);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(25);

      await expect(pending).resolves.toEqual({ kind: "unknown", code: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the total deadline active while reading the response body", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
        new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("secret body", "AbortError"));
            });
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      const updater = createUpdater({ fetch, timeoutMs: 25 });

      const pending = updater.update(validUpdateInput);
      await vi.advanceTimersByTimeAsync(25);
      const observed = await Promise.race([
        pending,
        Promise.resolve({ kind: "test_pending" as const }),
      ]);

      expect(observed).toEqual({ kind: "unknown", code: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns connection_lost for a network failure after dispatch", async () => {
    const updater = createUpdater({
      fetch: vi.fn(async () => {
        throw new TypeError("tenant-secret New approved body upstream response");
      }),
    });

    await expect(updater.update(validUpdateInput)).resolves.toEqual({
      kind: "unknown",
      code: "connection_lost",
    });
  });

  it.each([
    {
      name: "oversized success response",
      response: new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "65537" },
      }),
    },
    {
      name: "invalid JSON success response",
      response: new Response("not-json tenant-secret New approved body", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    },
  ])("returns malformed_success for an $name", async ({ response }) => {
    const updater = createUpdater({ fetch: vi.fn(async () => response) });

    await expect(updater.update(validUpdateInput)).resolves.toEqual({
      kind: "unknown",
      code: "malformed_success",
    });
  });

  it("preflight returns only revision, type, and the shared canonical hash", async () => {
    const blockReader: ManagedBlockReader = {
      readManagedBlock: vi.fn(async () => ({
        revision: 12,
        blockType: "text" as const,
        body: "  Approved body\r\n  ",
      })),
    };
    const updater = createUpdater({ blockReader });

    const result = await updater.preflight({
      remoteDocumentToken: "docx_1",
      managedBodyBlockId: "blk_body",
    });

    expect(result).toEqual({
      revision: 12,
      blockType: "text",
      canonicalBodyHash: "1ba80129bba0f252eb425297a8bef2139fabe9ced391c6eca3270159f2dfbc86",
    });
    expect(JSON.stringify(result)).not.toContain("Approved body");
  });

  it.each([
    {
      name: "proposed",
      body: "New approved body",
      revision: 13,
      hash: "d5afffb60260a0333d9a9a9754a728df62fd2273d29b3676d9d064ced39f1fcd",
    },
    {
      name: "old",
      body: "Old approved body",
      revision: 12,
      hash: "c25c7d6f99fd951acd445ffd59de89d27e93da0f6a62445cabd8513437e56fb2",
    },
    {
      name: "unrelated human edit",
      body: "Human edit",
      revision: 14,
      hash: "755b60cd4ffa7cedb8a464c6cdb0de35798becc0674909f11a30aacd6f7d102b",
    },
  ])("readBack exposes the $name hash without the body", async ({ body, revision, hash }) => {
    const blockReader: ManagedBlockReader = {
      readManagedBlock: vi.fn(async () => ({ revision, blockType: "text" as const, body })),
    };
    const updater = createUpdater({ blockReader });

    const result = await updater.readBack({
      remoteDocumentToken: "docx_1",
      managedBodyBlockId: "blk_body",
    });

    expect(result).toEqual({ revision, blockType: "text", canonicalBodyHash: hash });
    expect(JSON.stringify(result)).not.toContain(body);
  });

  it("does not serialize body, access token, or upstream response text in outcomes", async () => {
    const updater = createUpdater({
      fetch: vi.fn(async () => jsonResponse({
        code: 1770001,
        msg: "tenant-secret New approved body complete upstream response",
      }, { status: 400 })),
    });

    const outcome = await updater.update(validUpdateInput);
    expect(JSON.stringify(outcome)).not.toMatch(
      /tenant-secret|New approved body|complete upstream response/iu,
    );
  });

  it("redacts token-provider failures before dispatch", async () => {
    const fetch = vi.fn();
    const updater = createUpdater({
      fetch,
      tokenProvider: {
        getTenantAccessToken: vi.fn(async () => {
          throw new Error("tenant-secret New approved body upstream response");
        }),
      },
    });

    const rejection = updater.update(validUpdateInput);
    await expect(rejection).rejects.toThrow("authorization failed");
    await rejection.catch((error) => {
      expect(String(error)).not.toMatch(/tenant-secret|New approved body|upstream response/iu);
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

function createUpdater(overrides: {
  blockReader?: ManagedBlockReader;
  fetch?: ReturnType<typeof vi.fn>;
  timeoutMs?: number;
  tokenProvider?: { getTenantAccessToken(): Promise<string> };
} = {}) {
  return createFeishuManagedKnowledgeUpdater({
    baseUrl: "https://open.feishu.cn/",
    blockReader: overrides.blockReader ?? {
      readManagedBlock: vi.fn(async () => ({
        revision: 12,
        blockType: "text" as const,
        body: "Old approved body",
      })),
    },
    tokenProvider: overrides.tokenProvider ?? {
      getTenantAccessToken: vi.fn(async () => "tenant-secret"),
    },
    fetch: (overrides.fetch ?? vi.fn()) as unknown as typeof globalThis.fetch,
    timeoutMs: overrides.timeoutMs ?? 1_000,
  });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}
