import { describe, expect, it, vi } from "vitest";

import {
  createFeishuChatHistoryReader,
  FeishuChatHistoryError,
} from "../src/feishu/feishu-chat-history-reader.js";

describe("FeishuChatHistoryReader", () => {
  it("recovers a missing questionnaire post from the original Feishu history contract", async () => {
    const fetch = vi.fn(async () => page([
      message({
        message_id: "om-questionnaire",
        chat_id: "oc/group 1",
        msg_type: "post",
        body: {
          content: JSON.stringify({
            zh_cn: {
              title: "试点问卷",
              content: [
                [{ tag: "text", text: "请反馈日常使用场景。" }],
                [{ tag: "a", text: "填写问卷", href: "https://example.com/questionnaire" }],
                [{ tag: "img", image_key: "private-image-key" }],
              ],
            },
          }),
        },
      }),
    ], true));
    const reader = createFeishuChatHistoryReader({
      baseUrl: "https://open.feishu.cn/",
      tokenProvider: { getTenantAccessToken: async () => "tenant-token" },
      fetch,
    });

    await expect(reader.listRecentMessages({ chatId: "oc/group 1", limit: 1 })).resolves.toEqual([
      {
        messageId: "om-questionnaire",
        chatId: "oc/group 1",
        senderId: "ou-author",
        text: "试点问卷 请反馈日常使用场景。 填写问卷 https://example.com/questionnaire",
        sentAt: new Date("2026-09-07T03:00:00.000Z"),
      },
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=oc%2Fgroup%201&page_size=50&sort_type=ByCreateTimeDesc",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer tenant-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("only returns readable human messages from the exact requested chat", async () => {
    const items = [
      message({ message_id: "om-allowed" }),
      message({ message_id: "om-foreign", chat_id: "oc-other" }),
      message({ message_id: "om-space-scope", chat_id: "oc-group " }),
      message({ message_id: "om-deleted", deleted: true }),
      message({ message_id: "om-unknown-deletion", deleted: undefined }),
      message({ message_id: "om-bot", sender: { id: "cli-bot", sender_type: "app", id_type: "app_id" } }),
      message({ message_id: "om-unknown-sender", sender: { id: "ou-author", id_type: "open_id" } }),
      message({ message_id: "om-system", msg_type: "system" }),
      message({ message_id: "om-image", msg_type: "image" }),
      message({ message_id: "om-bad-content", body: { content: "{invalid" } }),
      message({ message_id: "om-empty", body: { content: '{"text":"  "}' } }),
      message({ message_id: "om-no-content", body: {} }),
      message({ message_id: "om-no-author", sender: { id: "", sender_type: "user", id_type: "open_id" } }),
      message({ message_id: "" }),
      message({ message_id: "m".repeat(513) }),
      message({ message_id: "om-bad-date", create_time: "not-a-time" }),
      message({ message_id: "om-negative-date", create_time: "-1000" }),
      message({ message_id: "om-overflow-date", create_time: "9007199254740990" }),
      message({ message_id: "om-number-date", create_time: 1788750000000 }),
      null,
    ];
    const reader = readerFor(async () => page(items));

    const result = await reader.listRecentMessages({ chatId: "oc-group", limit: 20 });

    expect(result.map((item) => item.messageId)).toEqual(["om-allowed"]);
  });

  it("sorts by actual timestamps and deduplicates before applying the requested limit", async () => {
    const reader = readerFor(async () => page([
      message({ message_id: "om-older", create_time: "1788750000000" }),
      message({ message_id: "om-newest", create_time: "1788750002000" }),
      message({ message_id: "om-newest", create_time: "1788750002000" }),
      message({ message_id: "om-middle", create_time: "1788750001000" }),
    ]));

    const result = await reader.listRecentMessages({ chatId: "oc-group", limit: 2.9 });

    expect(result.map((item) => item.messageId)).toEqual(["om-newest", "om-middle"]);
  });

  it("stops at the first page once the requested twenty readable messages are available", async () => {
    const fetch = vi.fn(async () => page(Array.from({ length: 50 }, (_, index) => message({
      message_id: `om-${index}`,
      create_time: String(1788750000000 + index),
    })), true));
    const reader = readerFor(fetch);

    const result = await reader.listRecentMessages({ chatId: "oc-group", limit: 20 });

    expect(result).toHaveLength(20);
    expect(result[0].messageId).toBe("om-49");
    expect(result[19].messageId).toBe("om-30");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("recovers the original questionnaire on page two after fifty recent short messages", async () => {
    const recent = Array.from({ length: 50 }, (_, index) => message({
      message_id: `om-followup-${index}`,
      create_time: String(1788750010000 + index),
      body: { content: JSON.stringify({ text: "收到，谢谢" }) },
    }));
    const fetch = vi.fn(async (_url: string | URL | Request) => fetch.mock.calls.length === 1
      ? page(recent, true, "older/page?=2")
      : page([message({
        message_id: "om-original-questionnaire",
        msg_type: "post",
        body: { content: JSON.stringify({
          title: "场景调研问卷",
          content: [[{ tag: "text", text: "请写出用户角色、使用时机和当前困难。" }]],
        }) },
      })]));
    const reader = readerFor(fetch);

    const result = await reader.listRecentMessages({ chatId: "oc-group", limit: 100 });

    expect(result).toHaveLength(51);
    expect(result[50]).toEqual({
      messageId: "om-original-questionnaire",
      chatId: "oc-group",
      senderId: "ou-author",
      text: "场景调研问卷 请写出用户角色、使用时机和当前困难。",
      sentAt: new Date("2026-09-07T03:00:00.000Z"),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(2,
      "https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=oc-group&page_size=50&sort_type=ByCreateTimeDesc&page_token=older%2Fpage%3F%3D2",
      expect.objectContaining({ method: "GET", headers: { authorization: "Bearer tenant-token" } }),
    );
  });

  it("caps a large requested limit at one hundred messages across two pages", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request) => {
      const currentPage = fetch.mock.calls.length;
      return page(Array.from({ length: 50 }, (_, index) => {
        const messageIndex = (2 - currentPage) * 50 + index;
        return message({ message_id: `om-${messageIndex}`, create_time: String(1788750000000 + messageIndex) });
      }), true, `next-${currentPage}`);
    });
    const reader = readerFor(fetch);

    const result = await reader.listRecentMessages({ chatId: "oc-group", limit: 1000 });

    expect(result).toHaveLength(100);
    expect(result[0].messageId).toBe("om-99");
    expect(result[99].messageId).toBe("om-0");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never requests a third page even when filtering leaves fewer than the requested messages", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request) => {
      const currentPage = fetch.mock.calls.length;
      return page(Array.from({ length: 50 }, (_, index) => message({
        message_id: `om-${currentPage}-${index}`,
        ...(index === 0 ? {} : { sender: { id: "cli-bot", sender_type: "app", id_type: "app_id" } }),
      })), true, `next-${currentPage}`);
    });
    const reader = readerFor(fetch);

    const result = await reader.listRecentMessages({ chatId: "oc-group", limit: 100 });

    expect(result.map((item) => item.messageId)).toEqual(["om-1-0", "om-2-0"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps exact chat scope and deduplicates IDs across both pages", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request) => fetch.mock.calls.length === 1
      ? page([message({ message_id: "om-recent", create_time: "1788750001000" })], true)
      : page([
        message({ message_id: "om-recent", create_time: "1788750001000" }),
        message({ message_id: "om-foreign", chat_id: "oc-other" }),
        message({ message_id: "om-deleted", deleted: true }),
        message({ message_id: "om-original" }),
      ]));
    const reader = readerFor(fetch);

    const result = await reader.listRecentMessages({ chatId: "oc-group", limit: 3 });

    expect(result.map((item) => item.messageId)).toEqual(["om-recent", "om-original"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves validated reply bindings without inventing missing or malformed message IDs", async () => {
    const reader = readerFor(async () => page([
      message({
        message_id: "om-questionnaire-label",
        parent_id: "om-original",
        root_id: "om-thread-root",
        body: { content: JSON.stringify({ text: "这是问卷" }) },
      }),
      message({ message_id: "om-invalid-binding", parent_id: " om-other ", root_id: "m".repeat(513) }),
      message({ message_id: "om-no-binding" }),
    ]));

    const result = await reader.listRecentMessages({ chatId: "oc-group", limit: 100 });

    expect(result[0]).toMatchObject({
      messageId: "om-questionnaire-label",
      text: "这是问卷",
      parentMessageId: "om-original",
      rootMessageId: "om-thread-root",
    });
    for (const item of result.slice(1)) {
      expect(item).not.toHaveProperty("parentMessageId");
      expect(item).not.toHaveProperty("rootMessageId");
    }
  });

  it.each([undefined, null, "", " ", 42, "p".repeat(513)])(
    "fails closed before following a missing or malformed cursor: %s",
    async (pageToken) => {
      const fetch = vi.fn(async () => json({ code: 0, data: { items: [message()], has_more: true, page_token: pageToken } }));
      const reader = readerFor(fetch);

      await expect(reader.listRecentMessages({ chatId: "oc-group", limit: 100 })).rejects.toSatisfy(isHistoryUnavailable);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("fails closed when Feishu repeats a pagination cursor", async () => {
    const fetch = vi.fn(async () => page([message()], true, "repeated-cursor"));
    const reader = readerFor(fetch);

    await expect(reader.listRecentMessages({ chatId: "oc-group", limit: 100 })).rejects.toSatisfy(isHistoryUnavailable);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["authorization denial", () => json({ code: 99991672, msg: "private-content tenant-token" }, 403)],
    ["malformed page", () => json({ code: 0, data: {} })],
    ["oversized body", () => json({ code: 0, data: { items: [], has_more: false }, padding: "s".repeat(2 * 1024 * 1024) })],
  ] as const)("discards the first page if page two fails with %s", async (_name, response) => {
    const fetch = vi.fn(async () => fetch.mock.calls.length === 1 ? page([message()], true) : response());
    const reader = readerFor(fetch);

    await expect(reader.listRecentMessages({ chatId: "oc-group", limit: 100 })).rejects.toSatisfy(isHistoryUnavailable);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shares one overall timeout across both page requests", async () => {
    vi.useFakeTimers();
    try {
      let secondSignal: AbortSignal | null | undefined;
      const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (fetch.mock.calls.length === 1) {
          return new Promise<Response>((resolve) => setTimeout(() => resolve(page([message()], true)), 60));
        }
        secondSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          secondSignal?.addEventListener("abort", () => reject(new Error("private-content tenant-token")), { once: true });
        });
      });
      const reader = readerFor(fetch, 100);
      const outcome = reader.listRecentMessages({ chatId: "oc-group", limit: 100 }).then(
        (messages) => ({ messages, error: undefined }),
        (error: unknown) => ({ messages: undefined, error }),
      );

      await vi.advanceTimersByTimeAsync(100);

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(secondSignal?.aborted).toBe(true);
      expect(isHistoryUnavailable((await outcome).error)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "makes no auth or history request for a limit sanitized to zero: %s",
    async (limit) => {
      const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
      const fetch = vi.fn();
      const reader = createFeishuChatHistoryReader({ baseUrl: "https://open.feishu.cn", tokenProvider, fetch });

      await expect(reader.listRecentMessages({ chatId: "oc-group", limit })).resolves.toEqual([]);
      expect(tokenProvider.getTenantAccessToken).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["", " ", "oc-group ", "c".repeat(513)])(
    "rejects invalid chat identifiers before requesting authorization: %s",
    async (chatId) => {
      const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
      const fetch = vi.fn();
      const reader = createFeishuChatHistoryReader({ baseUrl: "https://open.feishu.cn", tokenProvider, fetch });

      await expect(reader.listRecentMessages({ chatId, limit: 1 })).rejects.toSatisfy(isHistoryUnavailable);
      expect(tokenProvider.getTenantAccessToken).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("bounds text and post output while retaining the existing truncation marker", async () => {
    const reader = readerFor(async () => page([
      message({ message_id: "om-long-text", body: { content: JSON.stringify({ text: "x".repeat(32_000) }) } }),
      message({ message_id: "om-long-post", msg_type: "post", body: { content: JSON.stringify({ title: "问卷", content: [[{ tag: "text", text: "y".repeat(32_000) }]] }) } }),
      message({ message_id: "om-oversized-content", body: { content: JSON.stringify({ text: "z".repeat(64_000) }) } }),
    ]));

    const result = await reader.listRecentMessages({ chatId: "oc-group", limit: 20 });

    expect(result.map((item) => item.messageId)).toEqual(["om-long-text", "om-long-post"]);
    expect(result[0].text).toHaveLength(8000);
    expect(result[0].text).toMatch(/^x+ \.\.\. \[truncated\]$/u);
    expect(result[1].text).toHaveLength(8000);
    expect(result[1].text).toMatch(/^问卷 y+ \.\.\. \[truncated\]$/u);
  });

  it("preserves rich-post part and traversal budgets", async () => {
    let nested: unknown = { text: "hidden-after-depth-budget" };
    for (let depth = 0; depth < 25; depth += 1) nested = { content: nested };
    const reader = readerFor(async () => page([
      message({ message_id: "om-parts", msg_type: "post", body: { content: JSON.stringify({ content: Array.from({ length: 201 }, (_, index) => ({ text: `part-${index}` })) }) } }),
      message({ message_id: "om-depth", msg_type: "post", body: { content: JSON.stringify(nested) } }),
    ]));

    const result = await reader.listRecentMessages({ chatId: "oc-group", limit: 20 });

    expect(result).toHaveLength(1);
    expect(result[0].text.split(" ")).toHaveLength(200);
    expect(result[0].text).toContain("part-199");
    expect(result[0].text).not.toContain("part-200");
  });

  it.each([
    ["HTTP 401", () => json({ code: 0, data: { items: [], has_more: false } }, 401)],
    ["HTTP 403", () => json({ code: 0, data: { items: [], has_more: false } }, 403)],
    ["API permission error", () => json({ code: 99991672, msg: "private-content tenant-token" })],
    ["invalid JSON", () => new Response("private-content tenant-token")],
    ["missing code", () => json({ data: { items: [], has_more: false } })],
    ["missing data", () => json({ code: 0 })],
    ["missing items", () => json({ code: 0, data: { has_more: false } })],
    ["invalid pagination shape", () => json({ code: 0, data: { items: [], has_more: "false" } })],
    ["too many rows", () => page(Array.from({ length: 51 }, () => message()))],
    ["oversized streamed body", () => json({ code: 0, data: { items: [], has_more: false }, padding: "s".repeat(2 * 1024 * 1024) })],
    ["oversized declared body", () => new Response("{}", { headers: { "content-length": "2097153" } })],
  ] as const)("fails closed without content in errors on %s", async (_name, response) => {
    const reader = readerFor(async () => response());

    await expect(reader.listRecentMessages({ chatId: "oc-group", limit: 20 })).rejects.toSatisfy(isHistoryUnavailable);
  });

  it("does not reuse old history after a subsequent authorization failure", async () => {
    let authorized = true;
    const reader = readerFor(async () => authorized ? page([message()]) : json({ code: 99991672, msg: "private-content tenant-token" }, 403));
    await expect(reader.listRecentMessages({ chatId: "oc-group", limit: 20 })).resolves.toHaveLength(1);

    authorized = false;

    await expect(reader.listRecentMessages({ chatId: "oc-group", limit: 20 })).rejects.toSatisfy(isHistoryUnavailable);
  });

  it("sanitizes tenant authorization failures before returning them", async () => {
    const fetch = vi.fn();
    const reader = createFeishuChatHistoryReader({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: async () => { throw new Error("private-content tenant-token"); } },
      fetch,
    });

    await expect(reader.listRecentMessages({ chatId: "oc-group", limit: 20 })).rejects.toSatisfy(isHistoryUnavailable);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts a stalled history request at the configured deadline", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | null | undefined;
      const reader = readerFor(async (_url, init) => {
        requestSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(new Error("private-content tenant-token")), { once: true });
        });
      }, 100);
      const result = expect(reader.listRecentMessages({ chatId: "oc-group", limit: 20 })).rejects.toSatisfy(isHistoryUnavailable);

      await Promise.all([result, vi.advanceTimersByTimeAsync(100)]);
      expect(requestSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

function readerFor(fetch: typeof globalThis.fetch, timeoutMs?: number) {
  return createFeishuChatHistoryReader({
    baseUrl: "https://open.feishu.cn",
    tokenProvider: { getTenantAccessToken: async () => "tenant-token" },
    fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    message_id: "om-message",
    chat_id: "oc-group",
    msg_type: "text",
    create_time: "1788750000000",
    deleted: false,
    sender: { id: "ou-author", sender_type: "user", id_type: "open_id" },
    body: { content: JSON.stringify({ text: "A recent human message" }) },
    ...overrides,
  };
}

function page(items: unknown[], hasMore = false, pageToken = "next-page"): Response {
  return json({ code: 0, data: { items, has_more: hasMore, ...(hasMore ? { page_token: pageToken } : {}) } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function isHistoryUnavailable(error: unknown): boolean {
  return error instanceof FeishuChatHistoryError &&
    error.code === "history_unavailable" &&
    !error.message.includes("tenant-token") &&
    !error.message.includes("private-content") &&
    error.cause === undefined;
}
