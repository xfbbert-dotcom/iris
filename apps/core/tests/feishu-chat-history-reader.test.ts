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

  it("requests the explicit date range in seconds and enforces inclusive start and exclusive end locally", async () => {
    const fetch = vi.fn(async () => page([
      message({ message_id: "om-before", create_time: "1788710400122" }),
      message({ message_id: "om-at-start", create_time: "1788710400123" }),
      message({ message_id: "om-before-end", create_time: "1788796800455" }),
      message({ message_id: "om-at-end", create_time: "1788796800456" }),
    ]));
    const reader = readerFor(fetch);

    const result = await reader.listRecentMessages({
      chatId: "oc-group", limit: 100,
      timeRange: { start: new Date("2026-09-06T16:00:00.123Z"), end: new Date("2026-09-07T16:00:00.456Z") },
    });

    expect(result.map((item) => item.messageId)).toEqual(["om-before-end", "om-at-start"]);
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=oc-group&page_size=50&sort_type=ByCreateTimeDesc&start_time=1788710400&end_time=1788796801",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("keeps the same date bounds while following the second bounded page", async () => {
    const fetch = vi.fn(async () => fetch.mock.calls.length === 1
      ? page([message({ message_id: "om-after", create_time: "1788796800000" })], true)
      : page([message({ message_id: "om-original" })]));
    const reader = readerFor(fetch);

    const result = await reader.listRecentMessages({
      chatId: "oc-group", limit: 1,
      timeRange: { start: new Date("2026-09-06T16:00:00Z"), end: new Date("2026-09-07T16:00:00Z") },
    });

    expect(result.map((item) => item.messageId)).toEqual(["om-original"]);
    expect(fetch).toHaveBeenNthCalledWith(2,
      "https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=oc-group&page_size=50&sort_type=ByCreateTimeDesc&start_time=1788710400&end_time=1788796800&page_token=next-page",
      expect.any(Object),
    );
  });

  it.each([
    ["invalid start", new Date(Number.NaN), new Date("2026-09-08T00:00:00Z")],
    ["invalid end", new Date("2026-09-07T00:00:00Z"), new Date(Number.NaN)],
    ["reversed bounds", new Date("2026-09-08T00:00:00Z"), new Date("2026-09-07T00:00:00Z")],
    ["empty interval", new Date("2026-09-07T00:00:00Z"), new Date("2026-09-07T00:00:00Z")],
    ["negative timestamp", new Date(-1000), new Date(1000)],
    ["more than thirty-one days", new Date("2026-08-07T00:00:00Z"), new Date("2026-09-07T00:00:00.001Z")],
  ] as const)("rejects %s before any authorization or history request", async (_name, start, end) => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const fetch = vi.fn();
    const reader = createFeishuChatHistoryReader({ baseUrl: "https://open.feishu.cn", tokenProvider, fetch });

    await expect(reader.listRecentMessages({ chatId: "oc-group", limit: 100, timeRange: { start, end } })).rejects.toSatisfy(isHistoryUnavailable);
    expect(tokenProvider.getTenantAccessToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts exactly thirty-one days without widening the requested range", async () => {
    const reader = readerFor(async () => page([message()]));

    const result = await reader.listRecentMessages({
      chatId: "oc-group", limit: 100,
      timeRange: { start: new Date("2026-08-08T03:00:00Z"), end: new Date("2026-09-08T03:00:00Z") },
    });

    expect(result.map((item) => item.messageId)).toEqual(["om-message"]);
  });

  it("validates a candidate ID against the live single-message response and preserves reply metadata", async () => {
    const fetch = vi.fn(async () => json({ code: 0, data: { items: [message({
      message_id: "om/original?1", parent_id: "om-parent", root_id: "om-root", msg_type: "post",
      body: { content: JSON.stringify({ title: "调研", content: [[{ tag: "text", text: "原始问题正文" }]] }) },
    })] } }));
    const reader = readerFor(fetch);

    const result = await reader.readMessagesByIds?.({ chatId: "oc-group", messageIds: ["om/original?1"] });

    expect(result).toEqual([{
      messageId: "om/original?1", chatId: "oc-group", senderId: "ou-author",
      text: "调研 原始问题正文", sentAt: new Date("2026-09-07T03:00:00Z"),
      parentMessageId: "om-parent", rootMessageId: "om-root",
    }]);
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/messages/om%2Foriginal%3F1",
      expect.objectContaining({ method: "GET", headers: { authorization: "Bearer tenant-token" }, signal: expect.any(AbortSignal) }),
    );
  });

  it("deduplicates candidate IDs and bounds all single-message requests to eight", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => json({ code: 0, data: { items: [message({ message_id: decodeURIComponent(String(url).split("/").at(-1)!) })] } }));
    const reader = readerFor(fetch);

    const result = await reader.readMessagesByIds?.({
      chatId: "oc-group", messageIds: ["om-0", "om-0", ...Array.from({ length: 12 }, (_, index) => `om-${index + 1}`)],
    });

    expect(result?.[0].messageId).toBe("om-0");
    expect(new Set(result?.map((item) => item.messageId)).size).toBe(result?.length);
    expect(result?.length).toBeLessThanOrEqual(8);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(8);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/om-0"))).toHaveLength(1);
  });

  it("skips unreadable, deleted, bot, and foreign-chat candidate messages", async () => {
    const rows = [
      message({ message_id: "om-valid" }),
      message({ message_id: "om-foreign", chat_id: "oc-other" }),
      message({ message_id: "om-deleted", deleted: true }),
      message({ message_id: "om-bot", sender: { id: "cli-bot", sender_type: "app" } }),
      message({ message_id: "om-unreadable", body: { content: "not-json" } }),
    ];
    const fetch = vi.fn(async (url: string | URL | Request) => json({ code: 0, data: { items: [rows.find((row) => String(url).endsWith(`/${row.message_id}`))] } }));
    const reader = readerFor(fetch);

    const result = await reader.readMessagesByIds?.({ chatId: "oc-group", messageIds: rows.map((row) => row.message_id as string) });

    expect(result?.map((item) => item.messageId)).toEqual(["om-valid"]);
  });

  it.each([401, 403, 404])("omits a denied or missing candidate with HTTP %s", async (status) => {
    const reader = readerFor(async () => json({ code: 999, msg: "private-content tenant-token" }, status));

    await expect(reader.readMessagesByIds?.({ chatId: "oc-group", messageIds: ["om-missing"] })).resolves.toEqual([]);
  });

  it("omits a missing candidate when the live API returns an empty items array", async () => {
    const reader = readerFor(async () => json({ code: 0, data: { items: [] } }));

    await expect(reader.readMessagesByIds?.({ chatId: "oc-group", messageIds: ["om-missing"] })).resolves.toEqual([]);
  });

  it("makes no requests for empty or invalid bounded candidate IDs", async () => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const fetch = vi.fn();
    const reader = createFeishuChatHistoryReader({ baseUrl: "https://open.feishu.cn", tokenProvider, fetch });

    await expect(reader.readMessagesByIds?.({ chatId: "oc-group", messageIds: ["", " om-other ", "m".repeat(513)] })).resolves.toEqual([]);
    await expect(reader.readMessagesByIds?.({ chatId: "oc-group", messageIds: [] })).resolves.toEqual([]);
    expect(tokenProvider.getTenantAccessToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["HTTP 429", () => json({}, 429)],
    ["HTTP 500", () => json({}, 500)],
    ["unknown API error", () => json({ code: 230000, msg: "private-content tenant-token" })],
    ["invalid JSON", () => new Response("private-content tenant-token")],
    ["missing data", () => json({ code: 0 })],
    ["missing items", () => json({ code: 0, data: {} })],
    ["wrong message ID", () => json({ code: 0, data: { items: [message({ message_id: "om-different" })] } })],
    ["multiple rows", () => json({ code: 0, data: { items: [message(), message()] } })],
    ["malformed row", () => json({ code: 0, data: { items: [null] } })],
    ["oversized body", () => json({ code: 0, data: { items: [message()] }, padding: "s".repeat(2 * 1024 * 1024) })],
  ] as const)("fails closed for single-message %s", async (_name, response) => {
    const reader = readerFor(async () => response());

    await expect(reader.readMessagesByIds?.({ chatId: "oc-group", messageIds: ["om-message"] })).rejects.toSatisfy(isHistoryUnavailable);
  });

  it("bounds single-message concurrency and shares the timeout across the whole batch", async () => {
    vi.useFakeTimers();
    try {
      let active = 0;
      let peak = 0;
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        active += 1;
        peak = Math.max(peak, active);
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => {
            active -= 1;
            resolve(json({ code: 0, data: { items: [message({ message_id: String(url).split("/").at(-1) })] } }));
          }, 60);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            active -= 1;
            reject(new Error("private-content tenant-token"));
          }, { once: true });
        });
      });
      const reader = readerFor(fetch, 100);
      const outcome = reader.readMessagesByIds?.({ chatId: "oc-group", messageIds: Array.from({ length: 8 }, (_, index) => `om-${index}`) })
        .then((messages) => ({ messages, error: undefined }), (error: unknown) => ({ messages: undefined, error }));

      await vi.advanceTimersByTimeAsync(100);

      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(2);
      expect(fetch.mock.calls.length).toBeLessThanOrEqual(4);
      expect(isHistoryUnavailable((await outcome)?.error)).toBe(true);
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
