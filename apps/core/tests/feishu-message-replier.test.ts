import { describe, expect, it, vi } from "vitest";

import { createFeishuMessageReplier } from "../src/feishu/feishu-message-replier.js";

describe("FeishuMessageReplier", () => {
  it("sends text replies to a Feishu message", async () => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const fetch = vi.fn(async () =>
      jsonResponse({
        code: 0,
        data: { message_id: "reply-message-1" },
      }),
    );
    const replier = createFeishuMessageReplier({
      baseUrl: "https://open.feishu.cn",
      tokenProvider,
      fetch,
    });

    await expect(
      replier.replyText({
        messageId: "om_1",
        text: "Hello",
      }),
    ).resolves.toEqual({ replyMessageId: "reply-message-1" });

    expect(tokenProvider.getTenantAccessToken).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_1/reply",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer tenant-token",
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          msg_type: "text",
          content: JSON.stringify({ text: "Hello" }),
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("normalizes trailing slashes in Feishu OpenAPI base URLs", async () => {
    const fetch = vi.fn(async () => jsonResponse({ code: 0 }));
    const replier = createFeishuMessageReplier({
      baseUrl: "https://open.feishu.cn/",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
    });

    await replier.replyText({ messageId: "om_1", text: "Hello" });

    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_1/reply",
      expect.any(Object),
    );
  });

  it("sends optional thread replies and Feishu dedupe UUIDs", async () => {
    const fetch = vi.fn(async () => jsonResponse({ code: 0 }));
    const replier = createFeishuMessageReplier({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
    });

    await replier.replyText({
      messageId: "om_1",
      text: "Hello",
      replyInThread: true,
      uuid: "reply-uuid-1",
    });

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      msg_type: "text",
      content: JSON.stringify({ text: "Hello" }),
      reply_in_thread: true,
      uuid: "reply-uuid-1",
    });
  });

  it.each([
    {
      input: { messageId: " ", text: "Hello" },
      message: "messageId must not be blank",
    },
    {
      input: { messageId: "m".repeat(513), text: "Hello" },
      message: "messageId must be at most 512 characters",
    },
    {
      input: { messageId: "om_1", text: " " },
      message: "text must not be blank",
    },
    {
      input: { messageId: "om_1", text: "T".repeat(8001) },
      message: "text must be at most 8000 characters",
    },
    {
      input: { messageId: "om_1", text: "Hello", uuid: " " },
      message: "uuid must not be blank",
    },
    {
      input: { messageId: "om_1", text: "Hello", uuid: "u".repeat(51) },
      message: "uuid must be at most 50 characters",
    },
  ] as const)("rejects invalid $message before requesting tenant tokens", async ({ input, message }) => {
    const tokenProvider = {
      getTenantAccessToken: vi.fn(async () => {
        throw new Error("tenant token should not be requested");
      }),
    };
    const replier = createFeishuMessageReplier({
      baseUrl: "https://open.feishu.cn",
      tokenProvider,
      fetch: vi.fn(),
    });

    await expect(replier.replyText(input)).rejects.toThrow(message);
    expect(tokenProvider.getTenantAccessToken).not.toHaveBeenCalled();
  });

  it("throws on non-OK Feishu reply HTTP responses", async () => {
    const replier = createFeishuMessageReplier({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => jsonResponse({ msg: "forbidden" }, { ok: false, status: 403 })),
    });

    await expect(replier.replyText({ messageId: "om_1", text: "Hello" })).rejects.toThrow(
      "Feishu message reply request failed with status 403: forbidden",
    );
  });

  it("throws on non-zero Feishu reply codes", async () => {
    const replier = createFeishuMessageReplier({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => jsonResponse({ code: 999, msg: "bad message" })),
    });

    await expect(replier.replyText({ messageId: "om_1", text: "Hello" })).rejects.toThrow(
      "Feishu message reply request failed: bad message",
    );
  });

  it("throws when successful Feishu reply responses omit the code", async () => {
    const replier = createFeishuMessageReplier({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => jsonResponse({ data: { message_id: "reply-1" } })),
    });

    await expect(replier.replyText({ messageId: "om_1", text: "Hello" })).rejects.toThrow(
      "Feishu message reply response did not include code",
    );
  });

  it("throws on invalid Feishu reply response JSON", async () => {
    const replier = createFeishuMessageReplier({
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

    await expect(replier.replyText({ messageId: "om_1", text: "Hello" })).rejects.toThrow(
      "Feishu message reply response was not valid JSON",
    );
  });

  it("times out Feishu reply requests", async () => {
    const fetch = vi.fn(async (_url, init) => {
      if (init?.signal === undefined) {
        throw new Error("missing abort signal");
      }
      init.signal.dispatchEvent(new Event("abort"));
      throw abortError();
    }) as typeof globalThis.fetch;
    const replier = createFeishuMessageReplier({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
      timeoutMs: 1,
    });

    await expect(replier.replyText({ messageId: "om_1", text: "Hello" })).rejects.toThrow(
      "Feishu message reply request timed out",
    );
  });

  it("treats aborted Feishu reply response body reads as request timeouts", async () => {
    const replier = createFeishuMessageReplier({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => abortingJsonResponse()),
      timeoutMs: 1,
    });

    await expect(replier.replyText({ messageId: "om_1", text: "Hello" })).rejects.toThrow(
      "Feishu message reply request timed out",
    );
  });

  it("rejects invalid timeout configuration before reply requests can start", () => {
    for (const timeoutMs of [
      0,
      1.5,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      9007199254740992,
    ]) {
      expect(() =>
        createFeishuMessageReplier({
          baseUrl: "https://open.feishu.cn",
          tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
          fetch: vi.fn(),
          timeoutMs,
        }),
      ).toThrow("Feishu message reply timeoutMs must be a positive safe integer");
    }
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
