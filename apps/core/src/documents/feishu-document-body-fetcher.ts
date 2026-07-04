import type { DocumentBodyFetcher, DocumentBodyFetchResult } from "./document-sync-pipeline.js";
import type { DocumentSource, DocumentSourceType } from "./document-source-registry.js";
import type { FeishuTenantAccessTokenProvider } from "../feishu/feishu-tenant-access-token-provider.js";
import { readPositiveSafeInteger } from "../config/numeric-guards.js";
import { readExternalErrorMessage } from "../integrations/external-error-message.js";

export type FeishuDocumentBodyFetcherDependencies = {
  baseUrl: string;
  tokenProvider: FeishuTenantAccessTokenProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxContentChars?: number;
  now?: () => Date;
};

const DEFAULT_FEISHU_DOCUMENT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_FEISHU_DOCUMENT_MAX_CONTENT_CHARS = 2_000_000;
const RAW_CONTENT_RESPONSE_OVERHEAD_BYTES = 4096;
const WIKI_NODE_RESPONSE_MAX_BYTES = 65_536;
export const MAX_FEISHU_DOCUMENT_TOKEN_CHARS = 512;

const supportedSourceTypes = new Set<DocumentSourceType>([
  "group_visible_document",
  "authorized_wiki_document",
  "user_submitted_document",
]);

export function parseFeishuDocxDocumentId(sourceUri: string): string | undefined {
  return parseFeishuPathToken(sourceUri, ["docx", "docs"]);
}

export function parseFeishuWikiNodeToken(sourceUri: string): string | undefined {
  return parseFeishuPathToken(sourceUri, ["wiki"]);
}

function parseFeishuPathToken(sourceUri: string, markers: string[]): string | undefined {
  let url: URL;
  try {
    url = new URL(sourceUri);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") {
    return undefined;
  }
  if (!isSupportedFeishuHost(url.hostname)) {
    return undefined;
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return undefined;
  }

  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const marker = segments[0]?.toLowerCase();
  if (marker === undefined || !markers.includes(marker)) {
    return undefined;
  }

  return normalizeFeishuDocumentToken(segments[1]);
}

export function createFeishuDocumentBodyFetcher({
  baseUrl,
  tokenProvider,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_FEISHU_DOCUMENT_FETCH_TIMEOUT_MS,
  maxContentChars = DEFAULT_FEISHU_DOCUMENT_MAX_CONTENT_CHARS,
  now = () => new Date(),
}: FeishuDocumentBodyFetcherDependencies): DocumentBodyFetcher {
  const safeTimeoutMs = readPositiveSafeInteger(
    timeoutMs,
    "Feishu document fetch timeoutMs",
  );
  const safeMaxContentChars = readPositiveSafeInteger(
    maxContentChars,
    "Feishu document maxContentChars",
  );

  return {
    async fetch(source: DocumentSource): Promise<DocumentBodyFetchResult> {
      assertSupportedSourceType(source.sourceType);
      const directDocumentId = parseFeishuDocxDocumentId(source.sourceUri);
      const wikiNodeToken =
        directDocumentId === undefined ? parseFeishuWikiNodeToken(source.sourceUri) : undefined;
      if (directDocumentId === undefined && wikiNodeToken === undefined) {
        throw new Error(`unsupported Feishu docx URL: ${source.sourceUri}`);
      }

      const tenantAccessToken = await tokenProvider.getTenantAccessToken();
      let documentId = directDocumentId;
      if (documentId === undefined) {
        if (wikiNodeToken === undefined) {
          throw new Error(`unsupported Feishu docx URL: ${source.sourceUri}`);
        }
        documentId = await fetchWikiDocumentId({
          baseUrl,
          wikiNodeToken,
          tenantAccessToken,
          fetch,
          timeoutMs: safeTimeoutMs,
        });
      }

      const { response, responseBody } = await fetchJsonWithTimeout({
        fetch,
        url: `${trimTrailingSlash(baseUrl)}/open-apis/docx/v1/documents/${encodeURIComponent(
          documentId,
        )}/raw_content`,
        init: {
          method: "GET",
          headers: { authorization: `Bearer ${tenantAccessToken}` },
        },
        timeoutMs: safeTimeoutMs,
        timeoutMessage: "Feishu document raw content request timed out",
        jsonErrorMessage: "Feishu document raw content response was not valid JSON",
        maxResponseBytes: safeMaxContentChars + RAW_CONTENT_RESPONSE_OVERHEAD_BYTES,
        responseSizeErrorMessage: `Feishu document raw content response exceeds ${
          safeMaxContentChars + RAW_CONTENT_RESPONSE_OVERHEAD_BYTES
        } bytes`,
      });

      if (!response.ok) {
        throw new Error(
          `Feishu document raw content request failed with status ${response.status}: ${readExternalErrorMessage(
            responseBody,
          )}`,
        );
      }

      const bodyText = readRawContent(responseBody, safeMaxContentChars);
      return {
        bodyText,
        fetchedAt: now(),
      };
    },
  };
}

async function fetchWikiDocumentId({
  baseUrl,
  wikiNodeToken,
  tenantAccessToken,
  fetch,
  timeoutMs,
}: {
  baseUrl: string;
  wikiNodeToken: string;
  tenantAccessToken: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
}): Promise<string> {
  const { response, responseBody } = await fetchJsonWithTimeout({
    fetch,
    url: `${trimTrailingSlash(baseUrl)}/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(
      wikiNodeToken,
    )}`,
    init: {
      method: "GET",
      headers: { authorization: `Bearer ${tenantAccessToken}` },
    },
    timeoutMs,
    timeoutMessage: "Feishu wiki node request timed out",
    jsonErrorMessage: "Feishu wiki node response was not valid JSON",
    maxResponseBytes: WIKI_NODE_RESPONSE_MAX_BYTES,
    responseSizeErrorMessage: `Feishu wiki node response exceeds ${WIKI_NODE_RESPONSE_MAX_BYTES} bytes`,
  });

  if (!response.ok) {
    throw new Error(
      `Feishu wiki node request failed with status ${response.status}: ${readExternalErrorMessage(
        responseBody,
      )}`,
    );
  }

  return readWikiDocumentId(responseBody);
}

async function fetchJsonWithTimeout({
  fetch,
  url,
  init,
  timeoutMs,
  timeoutMessage,
  jsonErrorMessage,
  maxResponseBytes,
  responseSizeErrorMessage,
}: {
  fetch: typeof globalThis.fetch;
  url: string;
  init: RequestInit;
  timeoutMs: number;
  timeoutMessage: string;
  jsonErrorMessage: string;
  maxResponseBytes?: number;
  responseSizeErrorMessage?: string;
}): Promise<{ response: Response; responseBody: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    rejectOversizedKnownResponse(response, maxResponseBytes, responseSizeErrorMessage);
    const responseBody = await readJsonResponse({
      response,
      errorMessage: jsonErrorMessage,
      maxResponseBytes,
      responseSizeErrorMessage,
    });

    return { response, responseBody };
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function rejectOversizedKnownResponse(
  response: Response,
  maxResponseBytes: number | undefined,
  errorMessage: string | undefined,
): void {
  if (maxResponseBytes === undefined || errorMessage === undefined) {
    return;
  }

  const contentLength = (response.headers as Headers | undefined)?.get("content-length");
  if (contentLength === undefined || contentLength === null) {
    return;
  }

  const trimmed = contentLength.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return;
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed > maxResponseBytes) {
    throw new Error(errorMessage);
  }
}

function assertSupportedSourceType(sourceType: DocumentSourceType): void {
  if (!supportedSourceTypes.has(sourceType)) {
    throw new Error(`unsupported Feishu document source type: ${sourceType}`);
  }
}

async function readJsonResponse({
  response,
  errorMessage,
  maxResponseBytes,
  responseSizeErrorMessage,
}: {
  response: Response;
  errorMessage: string;
  maxResponseBytes?: number;
  responseSizeErrorMessage?: string;
}): Promise<unknown> {
  try {
    if (maxResponseBytes !== undefined && responseSizeErrorMessage !== undefined) {
      const boundedText = await readBoundedResponseText(
        response,
        maxResponseBytes,
        responseSizeErrorMessage,
      );
      if (boundedText !== undefined) {
        return JSON.parse(boundedText);
      }
    }

    return await response.json();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    if (error instanceof ResponseSizeError) {
      throw error;
    }
    throw new Error(errorMessage);
  }
}

async function readBoundedResponseText(
  response: Response,
  maxResponseBytes: number,
  errorMessage: string,
): Promise<string | undefined> {
  const body = response.body;
  if (body !== undefined && body !== null) {
    return readBoundedReadableStream(body, maxResponseBytes, errorMessage);
  }

  if (typeof response.text === "function") {
    const text = await response.text();
    const byteLength = new TextEncoder().encode(text).byteLength;
    if (byteLength > maxResponseBytes) {
      throw new ResponseSizeError(errorMessage);
    }
    return text;
  }

  return undefined;
}

async function readBoundedReadableStream(
  body: ReadableStream<Uint8Array>,
  maxResponseBytes: number,
  errorMessage: string,
): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }

      byteLength += value.byteLength;
      if (byteLength > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseSizeError(errorMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder().decode(concatChunks(chunks, byteLength));
}

function concatChunks(chunks: Uint8Array[], byteLength: number): Uint8Array {
  const buffer = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return buffer;
}

class ResponseSizeError extends Error {}

function readWikiDocumentId(responseBody: unknown): string {
  if (!isRecord(responseBody)) {
    throw new Error("Feishu wiki node response did not include document token");
  }

  const code = responseBody.code;
  if (typeof code !== "number") {
    throw new Error("Feishu wiki node response did not include code");
  }
  if (code !== 0) {
    throw new Error(`Feishu wiki node request failed: ${readExternalErrorMessage(responseBody)}`);
  }

  if (!isRecord(responseBody.data) || !isRecord(responseBody.data.node)) {
    throw new Error("Feishu wiki node response did not include document token");
  }

  const objectType = responseBody.data.node.obj_type;
  if (typeof objectType !== "string" || objectType.trim().length === 0) {
    throw new Error("Feishu wiki node response did not include document token");
  }
  if (objectType !== "docx" && objectType !== "doc") {
    throw new Error(`unsupported Feishu wiki object type: ${objectType}`);
  }

  const objectToken = responseBody.data.node.obj_token;
  const documentToken = normalizeFeishuDocumentToken(objectToken);
  if (documentToken === undefined) {
    throw new Error("Feishu wiki node response did not include document token");
  }

  return documentToken;
}

function normalizeFeishuDocumentToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const token = value.trim();
  if (token.length === 0 || token.length > MAX_FEISHU_DOCUMENT_TOKEN_CHARS) {
    return undefined;
  }

  return token;
}

function readRawContent(responseBody: unknown, maxContentChars: number): string {
  if (!isRecord(responseBody)) {
    throw new Error("Feishu document raw content response did not include content");
  }

  const code = responseBody.code;
  if (typeof code !== "number") {
    throw new Error("Feishu document raw content response did not include code");
  }
  if (code !== 0) {
    throw new Error(
      `Feishu document raw content request failed: ${readExternalErrorMessage(responseBody)}`,
    );
  }

  if (!isRecord(responseBody.data)) {
    throw new Error("Feishu document raw content response did not include content");
  }

  const content = responseBody.data.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("Feishu document raw content response did not include content");
  }

  const bodyText = content.trim();
  if (bodyText.length > maxContentChars) {
    throw new Error(`Feishu document raw content exceeds ${maxContentChars} characters`);
  }

  return bodyText;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function isSupportedFeishuHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "docs.feishu.cn" ||
    host.endsWith(".feishu.cn") ||
    host.endsWith(".larksuite.com")
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
