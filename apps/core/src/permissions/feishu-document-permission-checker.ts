import type { DocumentSource } from "../documents/document-source-registry.js";
import {
  MAX_FEISHU_DOCUMENT_TOKEN_CHARS,
  parseFeishuDocxDocumentId,
  parseFeishuWikiNodeToken,
} from "../documents/feishu-document-body-fetcher.js";
import type { FeishuTenantAccessTokenProvider } from "../feishu/feishu-tenant-access-token-provider.js";
import { readPositiveSafeInteger } from "../config/numeric-guards.js";
import { readBoundedJsonResponse } from "../integrations/bounded-json-response.js";
import { readExternalErrorMessage } from "../integrations/external-error-message.js";

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
const MAX_FEISHU_PERMISSION_RESPONSE_BYTES = 65_536;
const FEISHU_PERMISSION_DENIED_CODES = new Set([99991663]);
const invalidFeishuDocumentTokenPattern = /,|%/u;

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

  throwIfTransientPermissionFailure(response, responseBody);
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

  throwIfTransientPermissionFailure(response, responseBody);
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
    const responseBody = await readBoundedJsonResponse({
      response,
      invalidJsonErrorMessage: "Feishu document permission response was not valid JSON",
      maxResponseBytes: MAX_FEISHU_PERMISSION_RESPONSE_BYTES,
      responseSizeErrorMessage: `Feishu document permission response exceeds ${MAX_FEISHU_PERMISSION_RESPONSE_BYTES} bytes`,
    });

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

function isSuccessfulFeishuResponse(response: Response, responseBody: unknown): boolean {
  if (!response.ok) {
    return false;
  }
  if (!isRecord(responseBody) || typeof responseBody.code !== "number") {
    throw new Error("Feishu document permission response did not include code");
  }

  if (responseBody.code === 0) {
    return true;
  }
  if (FEISHU_PERMISSION_DENIED_CODES.has(responseBody.code)) {
    return false;
  }

  throw new Error(
    `Feishu document permission request failed: ${readExternalErrorMessage(responseBody)}`,
  );
}

function throwIfTransientPermissionFailure(response: Response, responseBody: unknown): void {
  if (response.ok || response.status === 403 || response.status === 404) {
    return;
  }

  throw new Error(
    `Feishu document permission request failed with status ${response.status}: ${readExternalErrorMessage(
      responseBody,
    )}`,
  );
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
  if (typeof objectToken !== "string") {
    return undefined;
  }

  const documentToken = objectToken.trim();
  return documentToken.length > 0 &&
    documentToken.length <= MAX_FEISHU_DOCUMENT_TOKEN_CHARS &&
    !invalidFeishuDocumentTokenPattern.test(documentToken)
    ? documentToken
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
