import { describe, expect, it, vi } from "vitest";

import {
  createFeishuInteractiveCardClient,
  FeishuInteractiveCardClientError,
} from "../src/feishu/feishu-interactive-card-client.js";

describe("FeishuInteractiveCardClient", () => {
  it("sends interactive cards using the exact Feishu message contract", async () => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const fetch = vi.fn(async () => jsonResponse({ code: 0, data: { message_id: "om-card-1" } }));
    const client = createFeishuInteractiveCardClient({
      baseUrl: "https://open.feishu.cn/",
      tokenProvider,
      fetch,
    });

    await expect(
      client.sendCard({ chatId: "oc_group", cardJson: '{"schema":"2.0"}', uuid: "card-send-1" }),
    ).resolves.toEqual({ messageId: "om-card-1" });

    expect(tokenProvider.getTenantAccessToken).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer tenant-token",
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          receive_id: "oc_group",
          msg_type: "interactive",
          content: '{"schema":"2.0"}',
          uuid: "card-send-1",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("sends approval cards to an exact Feishu user Open ID", async () => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const fetch = vi.fn(async () => jsonResponse({ code: 0, data: { message_id: "om-user-card-1" } }));
    const client = createFeishuInteractiveCardClient({
      baseUrl: "https://open.feishu.cn/",
      tokenProvider,
      fetch,
    });

    await expect(client.sendCardToUser({
      recipientOpenId: "ou_owner",
      cardJson: '{"schema":"2.0"}',
      uuid: "approval-send-1",
    })).resolves.toEqual({ messageId: "om-user-card-1" });
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          receive_id: "ou_owner",
          msg_type: "interactive",
          content: '{"schema":"2.0"}',
          uuid: "approval-send-1",
        }),
      }),
    );
  });

  it("updates an existing interactive card using the exact Feishu message contract", async () => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const fetch = vi.fn(async () => jsonResponse({ code: 0 }));
    const client = createFeishuInteractiveCardClient({
      baseUrl: "https://open.feishu.cn",
      tokenProvider,
      fetch,
    });

    await expect(
      client.updateCard({ messageId: "om/card 1", cardJson: '{"schema":"2.0","stale":true}' }),
    ).resolves.toBeUndefined();

    expect(tokenProvider.getTenantAccessToken).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/messages/om%2Fcard%201",
      expect.objectContaining({
        method: "PATCH",
        headers: {
          authorization: "Bearer tenant-token",
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ content: '{"schema":"2.0","stale":true}' }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("gets a tenant token once per card operation and reuses it for its request", async () => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { message_id: "om-card-1" } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0 }));
    const client = createFeishuInteractiveCardClient({
      baseUrl: "https://open.feishu.cn",
      tokenProvider,
      fetch,
    });

    await client.sendCard({ chatId: "oc_group", cardJson: "{}", uuid: "send-1" });
    await client.updateCard({ messageId: "om-card-1", cardJson: "{}" });

    expect(tokenProvider.getTenantAccessToken).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([, init]) => (init as RequestInit).headers)).toEqual([
      {
        authorization: "Bearer tenant-token",
        "content-type": "application/json; charset=utf-8",
      },
      {
        authorization: "Bearer tenant-token",
        "content-type": "application/json; charset=utf-8",
      },
    ]);
  });

  it.each([
    ["sendCard", { chatId: " ", cardJson: "{}", uuid: "send-1" }],
    ["sendCard", { chatId: "c".repeat(513), cardJson: "{}", uuid: "send-1" }],
    ["sendCard", { chatId: "oc_group", cardJson: " ", uuid: "send-1" }],
    ["sendCard", { chatId: "oc_group", cardJson: "{}", uuid: " " }],
    ["sendCard", { chatId: "oc_group", cardJson: "{}", uuid: "u".repeat(51) }],
    ["sendCardToUser", { recipientOpenId: " ", cardJson: "{}", uuid: "send-1" }],
    ["sendCardToUser", { recipientOpenId: "o".repeat(513), cardJson: "{}", uuid: "send-1" }],
    ["updateCard", { messageId: " ", cardJson: "{}" }],
    ["updateCard", { messageId: "m".repeat(513), cardJson: "{}" }],
    ["updateCard", { messageId: "om-card-1", cardJson: " " }],
  ] as const)("rejects invalid %s input before requesting a tenant token", async (method, input) => {
    const tokenProvider = {
      getTenantAccessToken: vi.fn(async () => {
        throw new Error("tenant token should not be requested");
      }),
    };
    const client = createFeishuInteractiveCardClient({
      baseUrl: "https://open.feishu.cn",
      tokenProvider,
      fetch: vi.fn(),
    });

    await expect(client[method](input as never)).rejects.toMatchObject({
      classification: "request_not_sent",
      code: "invalid_input",
    });
    expect(tokenProvider.getTenantAccessToken).not.toHaveBeenCalled();
  });

  it.each([
    [401, "remote_rejected", "http_401"],
    [403, "remote_rejected", "http_403"],
    [429, "retryable_remote_failure", "http_429"],
    [500, "retryable_remote_failure", "http_500"],
  ] as const)("classifies HTTP %i without exposing the response body", async (status, classification, code) => {
    const client = createFeishuInteractiveCardClient({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () =>
        jsonResponse({ code: 999, msg: "Bearer tenant-token secret=hidden" }, { status }),
      ),
    });

    await expect(client.sendCard({ chatId: "oc_group", cardJson: "{}", uuid: "send-1" })).rejects.toSatisfy(
      (error) => isCardError(error, classification, code),
    );
  });

  it("classifies nonzero Feishu response codes without exposing the remote message", async () => {
    const client = createFeishuInteractiveCardClient({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => jsonResponse({ code: 230001, msg: "sensitive remote explanation" })),
    });

    await expect(client.updateCard({ messageId: "om-card-1", cardJson: "{}" })).rejects.toSatisfy(
      (error) => isCardError(error, "remote_rejected", "feishu_230001"),
    );
  });

  it("classifies timeouts as outcome unknown", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error("missing abort signal");
      }
      signal.dispatchEvent(new Event("abort"));
      throw abortError();
    }) as typeof globalThis.fetch;
    const client = createFeishuInteractiveCardClient({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
      timeoutMs: 1,
    });

    await expect(client.sendCard({ chatId: "oc_group", cardJson: "{}", uuid: "send-1" })).rejects.toSatisfy(
      (error) => isCardError(error, "outcome_unknown", "timeout"),
    );
  });

  it.each([
    ["sendCard", { chatId: "oc_group", cardJson: "{}", uuid: "send-1" }],
    ["updateCard", { messageId: "om-card-1", cardJson: "{}" }],
  ] as const)("classifies a generic %s fetch rejection after dispatch as outcome unknown", async (method, input) => {
    const fetch = vi.fn(async () => {
      throw new TypeError("connection reset after request dispatch");
    });
    const client = createFeishuInteractiveCardClient({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
    });

    await expect(client[method](input as never)).rejects.toSatisfy(
      (error) => isCardError(error, "outcome_unknown", "network_failure"),
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("classifies a response-stream reset as outcome unknown", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"code":0,'));
        controller.error(new Error("response connection reset"));
      },
    });
    const client = createFeishuInteractiveCardClient({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => new Response(body, { status: 200 })),
    });

    await expect(client.updateCard({ messageId: "om-card-1", cardJson: "{}" })).rejects.toSatisfy(
      (error) => isCardError(error, "outcome_unknown", "invalid_response"),
    );
  });

  it.each([
    [
      "sendCard",
      { chatId: "oc_group", cardJson: "{}", uuid: "send-1" },
      "unreadable 401 response",
      invalidJsonResponse(401),
      "remote_rejected",
      "http_401",
    ],
    [
      "updateCard",
      { messageId: "om-card-1", cardJson: "{}" },
      "oversized 429 response",
      oversizedJsonResponse(429),
      "retryable_remote_failure",
      "http_429",
    ],
    [
      "sendCard",
      { chatId: "oc_group", cardJson: "{}", uuid: "send-1" },
      "unreadable 2xx response",
      invalidJsonResponse(),
      "outcome_unknown",
      "invalid_response",
    ],
    [
      "updateCard",
      { messageId: "om-card-1", cardJson: "{}" },
      "oversized 2xx response",
      oversizedJsonResponse(),
      "outcome_unknown",
      "invalid_response",
    ],
  ] as const)("classifies %s %s without exposing the response body", async (method, input, _description, response, classification, code) => {
    const client = createFeishuInteractiveCardClient({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => response),
    });

    await expect(client[method](input as never)).rejects.toSatisfy(
      (error) => isCardError(error, classification, code),
    );
  });

  it.each([" ", "m".repeat(513)])("rejects invalid successful response message IDs", async (messageId) => {
    const client = createFeishuInteractiveCardClient({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => jsonResponse({ code: 0, data: { message_id: messageId } })),
    });

    await expect(client.sendCard({ chatId: "oc_group", cardJson: "{}", uuid: "send-1" })).rejects.toSatisfy(
      (error) => isCardError(error, "outcome_unknown", "invalid_response"),
    );
  });
});

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function invalidJsonResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error("invalid json");
    },
  } as unknown as Response;
}

function oversizedJsonResponse(status = 200): Response {
  return new Response(
    JSON.stringify({ code: 0, data: { message_id: "om-card-1" }, padding: "x".repeat(70_000) }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function isCardError(
  error: unknown,
  classification: string,
  code: string,
): error is FeishuInteractiveCardClientError {
  return (
    error instanceof FeishuInteractiveCardClientError &&
    error.classification === classification &&
    error.code === code &&
    !error.message.includes("tenant-token") &&
    !error.message.includes("sensitive remote explanation")
  );
}
