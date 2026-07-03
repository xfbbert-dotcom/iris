import { describe, expect, it, vi } from "vitest";

import { createFeishuTenantAccessTokenProvider } from "../src/feishu/feishu-tenant-access-token-provider.js";

describe("FeishuTenantAccessTokenProvider", () => {
  it("fetches and caches tenant access tokens", async () => {
    let now = new Date("2026-07-03T02:00:00.000Z");
    const fetch = vi.fn(async () => jsonResponse({
      code: 0,
      tenant_access_token: "tenant-token-1",
      expire: 7200,
    }));
    const provider = createFeishuTenantAccessTokenProvider({
      baseUrl: "https://open.feishu.cn",
      appId: "app-id",
      appSecret: "app-secret",
      fetch,
      now: () => now,
    });

    await expect(provider.getTenantAccessToken()).resolves.toBe("tenant-token-1");
    await expect(provider.getTenantAccessToken()).resolves.toBe("tenant-token-1");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_id: "app-id", app_secret: "app-secret" }),
        signal: expect.any(AbortSignal),
      }),
    );

    now = new Date("2026-07-03T04:00:01.000Z");
    fetch.mockResolvedValueOnce(jsonResponse({
      code: 0,
      tenant_access_token: "tenant-token-2",
      expire: 7200,
    }));

    await expect(provider.getTenantAccessToken()).resolves.toBe("tenant-token-2");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent tenant access token refreshes", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as typeof globalThis.fetch;
    const provider = createFeishuTenantAccessTokenProvider({
      baseUrl: "https://open.feishu.cn",
      appId: "app-id",
      appSecret: "app-secret",
      fetch,
      now: () => new Date("2026-07-03T02:00:00.000Z"),
    });

    const first = provider.getTenantAccessToken();
    const second = provider.getTenantAccessToken();

    expect(fetch).toHaveBeenCalledTimes(1);
    resolveFetch?.(
      jsonResponse({
        code: 0,
        tenant_access_token: "tenant-token-1",
        expire: 7200,
      }),
    );
    await expect(Promise.all([first, second])).resolves.toEqual([
      "tenant-token-1",
      "tenant-token-1",
    ]);
    await expect(provider.getTenantAccessToken()).resolves.toBe("tenant-token-1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("clears coalesced tenant token refreshes after failures", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          tenant_access_token: "tenant-token-2",
          expire: 7200,
        }),
      ) as typeof globalThis.fetch;
    const provider = createFeishuTenantAccessTokenProvider({
      baseUrl: "https://open.feishu.cn",
      appId: "app-id",
      appSecret: "app-secret",
      fetch,
      now: () => new Date("2026-07-03T02:00:00.000Z"),
    });

    await expect(
      Promise.all([provider.getTenantAccessToken(), provider.getTenantAccessToken()]),
    ).rejects.toThrow("network unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);

    await expect(provider.getTenantAccessToken()).resolves.toBe("tenant-token-2");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("times out tenant access token requests", async () => {
    const fetch = vi.fn(async (_url, init) => {
      if (init?.signal === undefined) {
        throw new Error("missing abort signal");
      }
      init.signal.dispatchEvent(new Event("abort"));
      throw abortError();
    }) as typeof globalThis.fetch;
    const provider = createFeishuTenantAccessTokenProvider({
      baseUrl: "https://open.feishu.cn",
      appId: "app-id",
      appSecret: "app-secret",
      fetch,
      timeoutMs: 1,
    });

    await expect(provider.getTenantAccessToken()).rejects.toThrow(
      "Feishu tenant access token request timed out",
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("treats aborted token response body reads as request timeouts", async () => {
    const provider = createFeishuTenantAccessTokenProvider({
      baseUrl: "https://open.feishu.cn",
      appId: "app-id",
      appSecret: "app-secret",
      fetch: vi.fn(async () => abortingJsonResponse()),
      timeoutMs: 1,
    });

    await expect(provider.getTenantAccessToken()).rejects.toThrow(
      "Feishu tenant access token request timed out",
    );
  });

  it("throws on failed token responses", async () => {
    const provider = createFeishuTenantAccessTokenProvider({
      baseUrl: "https://open.feishu.cn",
      appId: "app-id",
      appSecret: "app-secret",
      fetch: vi.fn(async () => jsonResponse({ code: 999, msg: "bad app secret" })),
    });

    await expect(provider.getTenantAccessToken()).rejects.toThrow(
      "Feishu tenant access token request failed: bad app secret",
    );
  });

  it("throws on invalid token response JSON", async () => {
    const provider = createFeishuTenantAccessTokenProvider({
      baseUrl: "https://open.feishu.cn",
      appId: "app-id",
      appSecret: "app-secret",
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("invalid json");
        },
      } as unknown as Response)),
    });

    await expect(provider.getTenantAccessToken()).rejects.toThrow(
      "Feishu tenant access token response was not valid JSON",
    );
  });

  it("throws when token response omits the token", async () => {
    const provider = createFeishuTenantAccessTokenProvider({
      baseUrl: "https://open.feishu.cn",
      appId: "app-id",
      appSecret: "app-secret",
      fetch: vi.fn(async () => jsonResponse({ code: 0, expire: 7200 })),
    });

    await expect(provider.getTenantAccessToken()).rejects.toThrow(
      "Feishu tenant access token response did not include tenant_access_token",
    );
  });
});

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
