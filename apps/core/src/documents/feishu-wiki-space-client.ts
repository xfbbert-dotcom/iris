import type { FeishuTenantAccessTokenProvider } from "../feishu/feishu-tenant-access-token-provider.js";
import { readPositiveSafeInteger } from "../config/numeric-guards.js";
import { readBoundedJsonResponse } from "../integrations/bounded-json-response.js";

export type FeishuWikiNode = {
  nodeToken: string;
  objectToken: string;
  objectType: string;
  spaceId: string;
  title?: string;
  hasChild: boolean;
};

export type FeishuWikiSpaceClient = {
  getNode(nodeToken: string): Promise<FeishuWikiNode>;
  listChildren(input: {
    spaceId: string;
    parentNodeToken: string;
    pageToken?: string;
    pageSize: number;
  }): Promise<{ nodes: FeishuWikiNode[]; nextPageToken?: string }>;
};

export type WikiSpaceSyncErrorClassification =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "upstream_unavailable"
  | "timeout"
  | "invalid_response"
  | "request_failed"
  | "cross_space_node"
  | "depth_limit_exceeded"
  | "node_limit_exceeded";

export class WikiSpaceSyncError extends Error {
  constructor(
    public readonly classification: WikiSpaceSyncErrorClassification,
    public readonly retriable: boolean,
  ) {
    super(`Feishu wiki space request failed: ${classification}`);
    this.name = "WikiSpaceSyncError";
  }
}

export type FeishuWikiSpaceClientDependencies = {
  baseUrl: string;
  tokenProvider: FeishuTenantAccessTokenProvider;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 65_536;
const MAX_PAGE_SIZE = 50;

export function createFeishuWikiSpaceClient({
  baseUrl,
  tokenProvider,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}: FeishuWikiSpaceClientDependencies): FeishuWikiSpaceClient {
  const safeTimeoutMs = readPositiveSafeInteger(timeoutMs, "Feishu wiki space timeoutMs");
  const safeMaxResponseBytes = readPositiveSafeInteger(
    maxResponseBytes,
    "Feishu wiki space maxResponseBytes",
  );
  const normalizedBaseUrl = trimTrailingSlash(baseUrl);

  return {
    async getNode(nodeToken) {
      const safeNodeToken = requireToken(nodeToken, "nodeToken");
      const responseBody = await requestJson({
        url: `${normalizedBaseUrl}/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(safeNodeToken)}`,
        tokenProvider,
        fetch,
        timeoutMs: safeTimeoutMs,
        maxResponseBytes: safeMaxResponseBytes,
      });
      if (!isRecord(responseBody) || !isRecord(responseBody.data) || !isRecord(responseBody.data.node)) {
        throw invalidResponse();
      }
      return readNode(responseBody.data.node);
    },

    async listChildren({ spaceId, parentNodeToken, pageToken, pageSize }) {
      const safeSpaceId = requireToken(spaceId, "spaceId");
      const safeParentNodeToken = requireToken(parentNodeToken, "parentNodeToken");
      const safePageSize = requirePageSize(pageSize);
      const query = new URLSearchParams({
        parent_node_token: safeParentNodeToken,
        page_size: String(safePageSize),
      });
      if (pageToken !== undefined) {
        query.set("page_token", requireToken(pageToken, "pageToken"));
      }
      const responseBody = await requestJson({
        url: `${normalizedBaseUrl}/open-apis/wiki/v2/spaces/${encodeURIComponent(safeSpaceId)}/nodes?${query.toString()}`,
        tokenProvider,
        fetch,
        timeoutMs: safeTimeoutMs,
        maxResponseBytes: safeMaxResponseBytes,
      });
      return readChildrenPage(responseBody);
    },
  };
}

async function requestJson({
  url,
  tokenProvider,
  fetch,
  timeoutMs,
  maxResponseBytes,
}: {
  url: string;
  tokenProvider: FeishuTenantAccessTokenProvider;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  maxResponseBytes: number;
}): Promise<unknown> {
  let tenantAccessToken: string;
  try {
    tenantAccessToken = await tokenProvider.getTenantAccessToken();
  } catch {
    throw new WikiSpaceSyncError("request_failed", true);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${tenantAccessToken}` },
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new WikiSpaceSyncError("timeout", true);
      }
      throw new WikiSpaceSyncError("request_failed", true);
    }
    if (!response.ok) {
      throw httpError(response.status);
    }
    let responseBody: unknown;
    try {
      responseBody = await readBoundedJsonResponse({
        response,
        invalidJsonErrorMessage: "Feishu wiki space response was not valid JSON",
        maxResponseBytes,
        responseSizeErrorMessage: "Feishu wiki space response exceeded the configured size limit",
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new WikiSpaceSyncError("timeout", true);
      }
      throw invalidResponse();
    }
    if (!isRecord(responseBody) || responseBody.code !== 0) {
      throw invalidResponse();
    }
    return responseBody;
  } finally {
    clearTimeout(timeout);
  }
}

function readChildrenPage(responseBody: unknown): { nodes: FeishuWikiNode[]; nextPageToken?: string } {
  if (!isRecord(responseBody) || !isRecord(responseBody.data)) {
    throw invalidResponse();
  }
  const { items, has_more: hasMore, page_token: pageToken } = responseBody.data;
  if (!Array.isArray(items) || typeof hasMore !== "boolean") {
    throw invalidResponse();
  }
  const nodes = items.map(readNode);
  if (!hasMore) {
    return { nodes };
  }
  if (typeof pageToken !== "string" || pageToken.trim().length === 0) {
    throw invalidResponse();
  }
  return { nodes, nextPageToken: pageToken.trim() };
}

function readNode(value: unknown): FeishuWikiNode {
  if (!isRecord(value)) {
    throw invalidResponse();
  }
  const title = optionalString(value.title);
  return {
    nodeToken: requireToken(value.node_token, "node_token"),
    objectToken: requireToken(value.obj_token, "obj_token"),
    objectType: requireToken(value.obj_type, "obj_type"),
    spaceId: requireToken(value.space_id, "space_id"),
    ...(title === undefined ? {} : { title }),
    hasChild: requireBoolean(value.has_child, "has_child"),
  };
}

function httpError(status: number): WikiSpaceSyncError {
  if (status === 401) return new WikiSpaceSyncError("unauthorized", false);
  if (status === 403) return new WikiSpaceSyncError("forbidden", false);
  if (status === 404) return new WikiSpaceSyncError("not_found", false);
  if (status === 429) return new WikiSpaceSyncError("rate_limited", true);
  if (status >= 500 && status <= 599) return new WikiSpaceSyncError("upstream_unavailable", true);
  return new WikiSpaceSyncError("request_failed", false);
}

function invalidResponse(): WikiSpaceSyncError {
  return new WikiSpaceSyncError("invalid_response", false);
}

function requireToken(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 512) {
    throw new WikiSpaceSyncError("invalid_response", false);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireToken(value, "title");
}

function requireBoolean(value: unknown, _name: string): boolean {
  if (typeof value !== "boolean") throw invalidResponse();
  return value;
}

function requirePageSize(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_PAGE_SIZE
  ) {
    throw new WikiSpaceSyncError("invalid_response", false);
  }
  return value;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
