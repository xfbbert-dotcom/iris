import { describe, expect, it, vi } from "vitest";

import { createFeishuReviewOAuthClient } from "../src/action-reviews/feishu-review-oauth-client.js";

describe("FeishuReviewOAuthClient", () => {
  it("builds the exact authorization URL with PKCE S256", () => {
    const client = createClient();

    const url = client.buildAuthorizationUrl({ state: "state-value", codeChallenge: "challenge-value" });

    expect(url.toString()).toBe(
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=cli_review&redirect_uri=https%3A%2F%2Firis.quello.cn%2Freview%2Foauth%2Fcallback&response_type=code&state=state-value&code_challenge=challenge-value&code_challenge_method=S256",
    );
  });

  it.each([
    ["hostile Open API origin", { baseUrl: "https://attacker.example" }],
    ["explicit default Open API port", { baseUrl: "https://open.feishu.cn:443" }],
    ["non-root Open API base path", { baseUrl: "https://open.feishu.cn/open-apis" }],
    ["query-bearing Open API base URL", { baseUrl: "https://open.feishu.cn/?target=attacker" }],
    ["hostile authorization origin", { authorizeUrl: "https://accounts.attacker.example/open-apis/authen/v1/authorize" }],
    ["explicit default authorization port", { authorizeUrl: "https://accounts.feishu.cn:443/open-apis/authen/v1/authorize" }],
    ["wrong authorization path", { authorizeUrl: "https://accounts.feishu.cn/open-apis/authen/v1/authorize/extra" }],
    ["query-bearing authorization URL", { authorizeUrl: "https://accounts.feishu.cn/open-apis/authen/v1/authorize?target=attacker" }],
    ["non-root public origin", { publicOrigin: "https://iris.quello.cn/review" }],
    ["explicit default public-origin port", { publicOrigin: "https://iris.quello.cn:443" }],
    ["query-bearing public origin", { publicOrigin: "https://iris.quello.cn?target=attacker" }],
  ])("rejects a %s before any OAuth request can be made", (_name, overrides) => {
    const fetch = vi.fn();

    expect(() => createClient({ ...overrides, fetch })).toThrow(/Feishu review OAuth/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("exchanges the code and reads the Feishu actor Open ID using separate bounded requests", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { access_token: "user-token", token_type: "Bearer" } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { open_id: "ou_owner" } }));
    const client = createClient({ fetch });

    await expect(
      client.exchangeCode({ code: "authorization-code", codeVerifier: "verifier-value" }),
    ).resolves.toEqual({ actorOpenId: "ou_owner" });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: "authorization-code",
          client_id: "cli_review",
          client_secret: "app-secret",
          redirect_uri: "https://iris.quello.cn/review/oauth/callback",
          code_verifier: "verifier-value",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://open.feishu.cn/open-apis/authen/v1/user_info",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer user-token" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect((fetch.mock.calls[0]?.[1] as RequestInit).signal).not.toBe(
      (fetch.mock.calls[1]?.[1] as RequestInit).signal,
    );
  });

  it.each([
    ["token code", [{ code: 1001, msg: "upstream token body" }]],
    ["user info code", [{ code: 0, data: { access_token: "user-token", token_type: "Bearer" } }, { code: 1002, msg: "upstream user body" }]],
  ] as const)("rejects non-zero %s without leaking credentials or upstream bodies", async (_name, bodies) => {
    const responseBodies = [...bodies];
    const client = createClient({ fetch: vi.fn(async () => jsonResponse(responseBodies.shift())) });

    await expect(client.exchangeCode({ code: "authorization-code", codeVerifier: "verifier-value" })).rejects.toSatisfy(
      (error) => secretFreeError(error),
    );
  });

  it.each([
    [[{ code: 0, data: { access_token: "user-token", token_type: "mac" } }]],
    [[{ code: 0, data: { token_type: "Bearer" } }]],
    [[{ code: 0, data: { access_token: "user-token", token_type: "Bearer" } }, { code: 0, data: {} }]],
  ])("rejects invalid token or user payloads without leaking credentials", async (bodies) => {
    const responseBodies = [...bodies];
    const client = createClient({ fetch: vi.fn(async () => jsonResponse(responseBodies.shift())) });

    await expect(client.exchangeCode({ code: "authorization-code", codeVerifier: "verifier-value" })).rejects.toSatisfy(
      (error) => secretFreeError(error),
    );
  });

  it.each([
    ["token", [new Response("x".repeat(16 * 1024 + 1))]],
    ["user info", [jsonResponse({ code: 0, data: { access_token: "user-token", token_type: "Bearer" } }), new Response("x".repeat(16 * 1024 + 1))]],
  ] as const)("rejects responses over the 16 KiB %s budget without leaking credentials", async (_name, responses) => {
    const queuedResponses = [...responses];
    const client = createClient({ fetch: vi.fn(async () => queuedResponses.shift() as Response) });

    await expect(client.exchangeCode({ code: "authorization-code", codeVerifier: "verifier-value" })).rejects.toSatisfy(
      (error) => secretFreeError(error),
    );
  });

  it.each([
    ["token", [invalidJsonResponse()]],
    ["user info", [jsonResponse({ code: 0, data: { access_token: "user-token", token_type: "Bearer" } }), invalidJsonResponse()]],
  ] as const)("rejects invalid %s JSON without leaking credentials", async (_name, responses) => {
    const queuedResponses = [...responses];
    const client = createClient({ fetch: vi.fn(async () => queuedResponses.shift() as Response) });

    await expect(client.exchangeCode({ code: "authorization-code", codeVerifier: "verifier-value" })).rejects.toSatisfy(
      (error) => secretFreeError(error),
    );
  });

  it("aborts a timed out OAuth request after five seconds without leaking credentials", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(abortError()));
    })) as typeof globalThis.fetch;
    const client = createClient({ fetch });
    const request = client.exchangeCode({ code: "authorization-code", codeVerifier: "verifier-value" });
    const result = expect(request).rejects.toSatisfy((error) => secretFreeError(error));

    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    vi.useRealTimers();
  });
});

function createClient(overrides: Partial<Parameters<typeof createFeishuReviewOAuthClient>[0]> = {}) {
  return createFeishuReviewOAuthClient({
    baseUrl: "https://open.feishu.cn/",
    authorizeUrl: "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
    publicOrigin: "https://iris.quello.cn",
    appId: "cli_review",
    appSecret: "app-secret",
    ...overrides,
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function invalidJsonResponse(): Response {
  return new Response("{not-json");
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function secretFreeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return !message.includes("app-secret") && !message.includes("user-token") && !message.includes("upstream");
}
