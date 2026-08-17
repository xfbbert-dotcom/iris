import { describe, expect, it, vi } from "vitest";

import {
  createFeishuBotChatAccessChecker,
  FeishuBotChatAccessError,
} from "../src/feishu/feishu-bot-chat-access-checker.js";

describe("FeishuBotChatAccessChecker", () => {
  it("proves bot membership through the bot-authorized chat detail endpoint", async () => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const fetch = vi.fn(async () => chatResponse());
    const checker = createFeishuBotChatAccessChecker({
      baseUrl: "https://open.feishu.cn/",
      tokenProvider,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(checker.canAccessChat({ chatId: " oc/group 1 " })).resolves.toBe(true);
    expect(tokenProvider.getTenantAccessToken).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/chats/oc%2Fgroup%201",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer tenant-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([400, 403, 404])(
    "treats an authoritative HTTP %s chat denial as not accessible",
    async (status) => {
      const checker = createFeishuBotChatAccessChecker({
        baseUrl: "https://open.feishu.cn",
        tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
        fetch: vi.fn(async () => chatResponse({ status, code: 99992356 })),
      });

      await expect(checker.canAccessChat({ chatId: "oc_group" })).resolves.toBe(false);
    },
  );

  it("treats a successful HTTP response with a Feishu business denial as not accessible", async () => {
    const checker = createFeishuBotChatAccessChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => chatResponse({ code: 230001 })),
    });

    await expect(checker.canAccessChat({ chatId: "oc_group" })).resolves.toBe(false);
  });

  it.each([
    ["HTTP 401", chatResponse({ status: 401 })],
    ["HTTP 429", chatResponse({ status: 429 })],
    ["HTTP 500", chatResponse({ status: 500 })],
    ["malformed success", jsonResponse({ code: 0, data: null })],
    ["invalid JSON", invalidJsonResponse()],
  ])("fails closed when chat access is unavailable through %s", async (_case, response) => {
    const checker = createFeishuBotChatAccessChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => response),
    });

    await expect(checker.canAccessChat({ chatId: "oc_group" })).rejects.toSatisfy(
      (error: unknown) => error instanceof FeishuBotChatAccessError,
    );
  });

  it("rejects invalid chat identifiers before loading a token", async () => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const checker = createFeishuBotChatAccessChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider,
      fetch: vi.fn(),
    });

    await expect(checker.canAccessChat({ chatId: " " })).rejects.toBeInstanceOf(
      FeishuBotChatAccessError,
    );
    expect(tokenProvider.getTenantAccessToken).not.toHaveBeenCalled();
  });
});

function chatResponse({
  status = 200,
  code = 0,
}: {
  status?: number;
  code?: number;
} = {}): Response {
  return jsonResponse({ code, data: code === 0 ? { chat_id: "oc_group" } : {} }, { status });
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function invalidJsonResponse(): Response {
  return new Response("not-json", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
