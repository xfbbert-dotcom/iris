import type { FeishuTenantAccessTokenProvider } from "./feishu-tenant-access-token-provider.js";
import { readPositiveSafeInteger } from "../config/numeric-guards.js";
import { readBoundedJsonResponse } from "../integrations/bounded-json-response.js";

export type FeishuGroupMembershipChecker = {
  isCurrentMember(input: { chatId: string; openId: string }): Promise<boolean>;
};

export type FeishuGroupMembershipCheckerDependencies = {
  baseUrl: string;
  tokenProvider: FeishuTenantAccessTokenProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class FeishuGroupMembershipError extends Error {
  readonly code = "membership_unavailable";

  constructor() {
    super("Feishu group membership unavailable");
    this.name = "FeishuGroupMembershipError";
  }
}

const DEFAULT_FEISHU_GROUP_MEMBERSHIP_TIMEOUT_MS = 10_000;
const MAX_FEISHU_IDENTIFIER_CHARS = 512;
const MAX_FEISHU_PAGE_TOKEN_CHARS = 512;
const MAX_FEISHU_MEMBERSHIP_RESPONSE_BYTES = 65_536;
const MAX_FEISHU_MEMBERSHIP_PAGES = 20;

export function createFeishuGroupMembershipChecker({
  baseUrl,
  tokenProvider,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_FEISHU_GROUP_MEMBERSHIP_TIMEOUT_MS,
}: FeishuGroupMembershipCheckerDependencies): FeishuGroupMembershipChecker {
  const safeTimeoutMs = readPositiveSafeInteger(
    timeoutMs,
    "Feishu group membership timeoutMs",
  );

  return {
    async isCurrentMember(input) {
      try {
        const chatId = readIdentifier(input.chatId);
        const openId = readIdentifier(input.openId);
        const tenantAccessToken = await tokenProvider.getTenantAccessToken();
        const seenPageTokens = new Set<string>();
        let pageToken: string | undefined;

        for (let page = 1; page <= MAX_FEISHU_MEMBERSHIP_PAGES; page += 1) {
          const responseBody = await requestMembers({
            baseUrl,
            chatId,
            pageToken,
            tenantAccessToken,
            fetch,
            timeoutMs: safeTimeoutMs,
          });
          const membersPage = readMembersPage(responseBody);

          if (membersPage.openIds.some((memberOpenId) => memberOpenId === openId)) {
            return true;
          }
          if (!membersPage.hasMore) {
            return false;
          }
          if (page === MAX_FEISHU_MEMBERSHIP_PAGES) {
            throw new FeishuGroupMembershipError();
          }

          const nextPageToken = readPageToken(membersPage.pageToken);
          if (seenPageTokens.has(nextPageToken)) {
            throw new FeishuGroupMembershipError();
          }
          seenPageTokens.add(nextPageToken);
          pageToken = nextPageToken;
        }

        throw new FeishuGroupMembershipError();
      } catch (error) {
        if (error instanceof FeishuGroupMembershipError) {
          throw error;
        }
        throw new FeishuGroupMembershipError();
      }
    },
  };
}

async function requestMembers({
  baseUrl,
  chatId,
  pageToken,
  tenantAccessToken,
  fetch,
  timeoutMs,
}: {
  baseUrl: string;
  chatId: string;
  pageToken: string | undefined;
  tenantAccessToken: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const query = `member_id_type=open_id&page_size=100${
      pageToken === undefined ? "" : `&page_token=${encodeURIComponent(pageToken)}`
    }`;
    const response = await fetch(
      `${trimTrailingSlash(baseUrl)}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?${query}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${tenantAccessToken}` },
        signal: controller.signal,
      },
    );
    const responseBody = await readBoundedJsonResponse({
      response,
      invalidJsonErrorMessage: "Feishu group membership response was not valid JSON",
      maxResponseBytes: MAX_FEISHU_MEMBERSHIP_RESPONSE_BYTES,
      responseSizeErrorMessage: `Feishu group membership response exceeds ${MAX_FEISHU_MEMBERSHIP_RESPONSE_BYTES} bytes`,
    });
    if (!response.ok) {
      throw new FeishuGroupMembershipError();
    }
    return responseBody;
  } finally {
    clearTimeout(timeout);
  }
}

function readMembersPage(responseBody: unknown): {
  openIds: string[];
  hasMore: boolean;
  pageToken: unknown;
} {
  if (!isRecord(responseBody) || responseBody.code !== 0 || !isRecord(responseBody.data)) {
    throw new FeishuGroupMembershipError();
  }
  const memberList = responseBody.data.member_list;
  const hasMore = responseBody.data.has_more;
  if (!Array.isArray(memberList) || typeof hasMore !== "boolean") {
    throw new FeishuGroupMembershipError();
  }

  const openIds = memberList.map((member) => {
    if (!isRecord(member)) {
      throw new FeishuGroupMembershipError();
    }
    return readIdentifier(member.open_id);
  });
  return { openIds, hasMore, pageToken: responseBody.data.page_token };
}

function readIdentifier(value: unknown): string {
  if (typeof value !== "string") {
    throw new FeishuGroupMembershipError();
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_FEISHU_IDENTIFIER_CHARS) {
    throw new FeishuGroupMembershipError();
  }
  return normalized;
}

function readPageToken(value: unknown): string {
  if (typeof value !== "string") {
    throw new FeishuGroupMembershipError();
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_FEISHU_PAGE_TOKEN_CHARS) {
    throw new FeishuGroupMembershipError();
  }
  return normalized;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
