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
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_id: "app-id", app_secret: "app-secret" }),
      },
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
  } as Response;
}
