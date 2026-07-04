import type { DocumentSource } from "../documents/document-source-registry.js";
import {
  parseFeishuDocxDocumentId,
  parseFeishuWikiNodeToken,
} from "../documents/feishu-document-body-fetcher.js";
import type { FeishuTenantAccessTokenProvider } from "../feishu/feishu-tenant-access-token-provider.js";
import { readPositiveSafeInteger } from "../config/numeric-guards.js";

export type FeishuDocumentPermissionChecker = {
  canReadSource(source: DocumentSource): Promise<boolean>;
};

export type FeishuDocumentPermissionCheckerDependencies = {
  baseUrl: string;
  tokenProvider: FeishuTenantAccessTokenProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_FEISHU_DOCUMENT_PERMISSION_TIMEOUT_MS = 5_000;

export function createFeishuDocumentPermissionChecker({
  baseUrl,
  tokenProvider,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_FEISHU_DOCUMENT_PERMISSION_TIMEOUT_MS,
}: FeishuDocumentPermissionCheckerDependencies): FeishuDocumentPermissionChecker {
  const safeTimeoutMs = readPositiveSafeInteger(
    timeoutMs,
    "Feishu document permission timeoutMs",
  );

  return {
    async canReadSource(source) {
      const locator = parseDocumentLocator(source.sourceUri);
      if (locator === undefined) {
        return false;
      }

      const tenantAccessToken = await tokenProvider.getTenantAccessToken();
      const documentId = await resolveDocumentId({
        locator,
        baseUrl,
        tenantAccessToken,
        fetch,
        timeoutMs: safeTimeoutMs,
      });
      if (documentId === undefined) {
        return false;
      }

      return canReadDocumentMetadata({
        documentId,
        baseUrl,
        tenantAccessToken,
        fetch,
        timeoutMs: safeTimeoutMs,
      });
    },
  };
}

type DocumentLocator =
  | { type: "direct"; documentId: string }
  | { type: "wiki"; wikiNodeToken: string };

function parseDocumentLocator(sourceUri: string): DocumentLocator | undefined {
  const directDocumentId = parseFeishuDocxDocumentId(sourceUri);
  if (directDocumentId !== undefined) {
    return { type: "direct", documentId: directDocumentId };
  }

  const wikiNodeToken = parseFeishuWikiNodeToken(sourceUri);
  return wikiNodeToken === undefined ? undefined : { type: "wiki", wikiNodeToken };
}

async function resolveDocumentId({
  locator,
  baseUrl,
  tenantAccessToken,
  fetch,
  timeoutMs,
}: {
  locator: DocumentLocator;
  baseUrl: string;
  tenantAccessToken: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
}): Promise<string | undefined> {
  if (locator.type === "direct") {
    return locator.documentId;
  }

  const { response, responseBody } = await fetchJsonWithTimeout({
    fetch,
    url: `${trimTrailingSlash(baseUrl)}/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(
      locator.wikiNodeToken,
    )}`,
    init: {
      method: "GET",
      headers: { authorization: `Bearer ${tenantAccessToken}` },
    },
    timeoutMs,
  });

  if (!isSuccessfulFeishuResponse(response, responseBody)) {
    return undefined;
  }

  return readWikiDocumentId(responseBody);
}

async function canReadDocumentMetadata({
  documentId,
  baseUrl,
  tenantAccessToken,
  fetch,
  timeoutMs,
}: {
  documentId: string;
  baseUrl: string;
  tenantAccessToken: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
}): Promise<boolean> {
  const { response, responseBody } = await fetchJsonWithTimeout({
    fetch,
    url: `${trimTrailingSlash(baseUrl)}/open-apis/docx/v1/documents/${encodeURIComponent(
      documentId,
    )}`,
    init: {
      method: "GET",
      headers: { authorization: `Bearer ${tenantAccessToken}` },
    },
    timeoutMs,
  });

  return isSuccessfulFeishuResponse(response, responseBody);
}

async function fetchJsonWithTimeout({
  fetch,
  url,
  init,
  timeoutMs,
}: {
  fetch: typeof globalThis.fetch;
  url: string;
  init: RequestInit;
  timeoutMs: number;
}): Promise<{ response: Response; responseBody: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const responseBody = await readJsonResponse(response);

    return { response, responseBody };
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error("Feishu document permission request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new Error("Feishu document permission response was not valid JSON");
  }
}

function isSuccessfulFeishuResponse(response: Response, responseBody: unknown): boolean {
  if (!response.ok) {
    return false;
  }
  if (!isRecord(responseBody)) {
    return false;
  }

  const code = responseBody.code;
  return typeof code !== "number" || code === 0;
}

function readWikiDocumentId(responseBody: unknown): string | undefined {
  if (!isRecord(responseBody) || !isRecord(responseBody.data) || !isRecord(responseBody.data.node)) {
    return undefined;
  }

  const objectType = responseBody.data.node.obj_type;
  if (objectType !== "docx" && objectType !== "doc") {
    return undefined;
  }

  const objectToken = responseBody.data.node.obj_token;
  return typeof objectToken === "string" && objectToken.trim().length > 0
    ? objectToken.trim()
    : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
