import { describe, expect, it, vi } from "vitest";

import {
  createFeishuGroupMembershipChecker,
  FeishuGroupMembershipError,
} from "../src/feishu/feishu-group-membership-checker.js";

describe("FeishuGroupMembershipChecker", () => {
  it("checks the first bounded member page with the exact Feishu contract", async () => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const fetch = vi.fn(async () => membersResponse({ memberList: [{ open_id: "ou-member" }] }));
    const checker = createFeishuGroupMembershipChecker({
      baseUrl: "https://open.feishu.cn/",
      tokenProvider,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(checker.isCurrentMember({ chatId: "oc/group 1", openId: "ou-member" })).resolves.toBe(true);

    expect(tokenProvider.getTenantAccessToken).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/im/v1/chats/oc%2Fgroup%201/members?member_id_type=open_id&page_size=100",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer tenant-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("reuses one tenant token while traversing bounded member pages", async () => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(membersResponse({ memberList: [], hasMore: true, pageToken: "page-2" }))
      .mockResolvedValueOnce(membersResponse({ memberList: [{ open_id: "ou-member" }] }));
    const checker = createFeishuGroupMembershipChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(checker.isCurrentMember({ chatId: "oc_group", openId: "ou-member" })).resolves.toBe(true);

    expect(tokenProvider.getTenantAccessToken).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://open.feishu.cn/open-apis/im/v1/chats/oc_group/members?member_id_type=open_id&page_size=100",
      expect.any(Object),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://open.feishu.cn/open-apis/im/v1/chats/oc_group/members?member_id_type=open_id&page_size=100&page_token=page-2",
      expect.any(Object),
    );
  });

  it("returns early when a normalized exact Open ID appears on the first page", async () => {
    const fetch = vi.fn(async () =>
      membersResponse({
        memberList: [{ open_id: " ou-member " }],
        hasMore: true,
        pageToken: "page-2",
      }),
    );
    const checker = createFeishuGroupMembershipChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(checker.isCurrentMember({ chatId: " oc_group ", openId: " ou-member " })).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("returns false after the final page when the Open ID is absent", async () => {
    const checker = createFeishuGroupMembershipChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => membersResponse({ memberList: [{ open_id: "ou-other" }] })),
    });

    await expect(checker.isCurrentMember({ chatId: "oc_group", openId: "ou-member" })).resolves.toBe(false);
  });

  it.each([
    [" ", "ou-member"],
    ["c".repeat(513), "ou-member"],
    ["oc_group", " "],
    ["oc_group", "o".repeat(513)],
  ])("rejects blank or oversized identifiers before requesting tenant tokens", async (chatId, openId) => {
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const checker = createFeishuGroupMembershipChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider,
      fetch: vi.fn(),
    });

    await expect(checker.isCurrentMember({ chatId, openId })).rejects.toSatisfy(isMembershipUnavailable);
    expect(tokenProvider.getTenantAccessToken).not.toHaveBeenCalled();
  });

  it.each([
    ["nonzero Feishu code", membersResponse({ code: 999 })],
    ["HTTP 401", membersResponse({ status: 401 })],
    ["HTTP 403", membersResponse({ status: 403 })],
    ["HTTP 429", membersResponse({ status: 429 })],
    ["HTTP 500", membersResponse({ status: 500 })],
    ["syntactically invalid JSON", invalidJsonResponse()],
    ["malformed response", jsonResponse({ code: 0, data: {} })],
    ["oversized response", oversizedMembersResponse()],
  ])("fails closed on %s", async (_description, response) => {
    const checker = createFeishuGroupMembershipChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => response),
    });

    await expect(checker.isCurrentMember({ chatId: "oc_group", openId: "ou-member" })).rejects.toSatisfy(
      isMembershipUnavailable,
    );
  });

  it("fails closed when the member response contains an invalid bounded Open ID", async () => {
    const checker = createFeishuGroupMembershipChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => membersResponse({ memberList: [{ open_id: "o".repeat(513) }] })),
    });

    await expect(checker.isCurrentMember({ chatId: "oc_group", openId: "ou-member" })).rejects.toSatisfy(
      isMembershipUnavailable,
    );
  });

  it("fails closed when Feishu repeats a page token", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(membersResponse({ memberList: [], hasMore: true, pageToken: "same-page" }))
      .mockResolvedValueOnce(membersResponse({ memberList: [], hasMore: true, pageToken: "same-page" }));
    const checker = createFeishuGroupMembershipChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
    });

    await expect(checker.isCurrentMember({ chatId: "oc_group", openId: "ou-member" })).rejects.toSatisfy(
      isMembershipUnavailable,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a paginated response has a malformed page token", async () => {
    const checker = createFeishuGroupMembershipChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: vi.fn(async () => membersResponse({ memberList: [], hasMore: true, pageToken: 42 })),
    });

    await expect(checker.isCurrentMember({ chatId: "oc_group", openId: "ou-member" })).rejects.toSatisfy(
      isMembershipUnavailable,
    );
  });

  it("fails closed after exactly 20 pages instead of treating the limit as absence", async () => {
    const fetch = vi.fn(async (_url: string) => {
      const page = fetch.mock.calls.length;
      return membersResponse({ memberList: [], hasMore: true, pageToken: `page-${page}` });
    });
    const checker = createFeishuGroupMembershipChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(checker.isCurrentMember({ chatId: "oc_group", openId: "ou-member" })).rejects.toSatisfy(
      isMembershipUnavailable,
    );
    expect(fetch).toHaveBeenCalledTimes(20);
  });

  it("fails closed when a membership request times out", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error("missing abort signal");
      }
      signal.dispatchEvent(new Event("abort"));
      throw abortError();
    }) as typeof globalThis.fetch;
    const checker = createFeishuGroupMembershipChecker({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: { getTenantAccessToken: vi.fn(async () => "tenant-token") },
      fetch,
      timeoutMs: 1,
    });

    await expect(checker.isCurrentMember({ chatId: "oc_group", openId: "ou-member" })).rejects.toSatisfy(
      isMembershipUnavailable,
    );
  });
});

function membersResponse({
  code = 0,
  memberList = [],
  hasMore = false,
  pageToken,
  status = 200,
}: {
  code?: number;
  memberList?: unknown[];
  hasMore?: boolean;
  pageToken?: unknown;
  status?: number;
}): Response {
  return jsonResponse(
    {
      code,
      data: {
        member_list: memberList,
        has_more: hasMore,
        ...(pageToken === undefined ? {} : { page_token: pageToken }),
      },
    },
    { status },
  );
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function oversizedMembersResponse(): Response {
  return new Response(
    JSON.stringify({
      code: 0,
      data: { member_list: [], has_more: false },
      padding: "x".repeat(70_000),
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function invalidJsonResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("invalid json");
    },
  } as unknown as Response;
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function isMembershipUnavailable(error: unknown): error is FeishuGroupMembershipError {
  return (
    error instanceof FeishuGroupMembershipError &&
    error.code === "membership_unavailable" &&
    !error.message.includes("tenant-token")
  );
}
