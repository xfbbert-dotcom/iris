import { readPositiveSafeInteger } from "../config/numeric-guards.js";
import type { FeishuTenantAccessTokenProvider } from "../feishu/feishu-tenant-access-token-provider.js";
import { readBoundedJsonResponse } from "../integrations/bounded-json-response.js";
import { readExternalErrorMessage } from "../integrations/external-error-message.js";

export interface ManagedBlockReader {
  readManagedBlock(input: {
    remoteDocumentToken: string;
    managedBodyBlockId: string;
  }): Promise<{ revision: number; blockType: "text"; body: string }>;
}

export type FeishuManagedKnowledgeBlockReaderDependencies = {
  baseUrl: string;
  tokenProvider: FeishuTenantAccessTokenProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const TEXT_BLOCK_TYPE = 2;

export function createFeishuManagedKnowledgeBlockReader({
  baseUrl,
  tokenProvider,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: FeishuManagedKnowledgeBlockReaderDependencies): ManagedBlockReader {
  const safeBaseUrl = trimTrailingSlash(requireHttpsUrl("baseUrl", baseUrl));
  const safeTimeoutMs = readPositiveSafeInteger(
    timeoutMs,
    "Feishu managed block read timeoutMs",
  );

  return {
    async readManagedBlock(input) {
      const remoteDocumentToken = requireIdentifier(
        "remoteDocumentToken",
        input.remoteDocumentToken,
      );
      const managedBodyBlockId = requireIdentifier(
        "managedBodyBlockId",
        input.managedBodyBlockId,
      );
      const tenantAccessToken = await tokenProvider.getTenantAccessToken();
      const documentBody = await requestJson({
        fetch,
        url: `${safeBaseUrl}/open-apis/docx/v1/documents/${encodeURIComponent(
          remoteDocumentToken,
        )}`,
        tenantAccessToken,
        timeoutMs: safeTimeoutMs,
        requestName: "Feishu managed document read",
      });
      const revision = readDocumentRevision(documentBody);
      const blockBody = await requestJson({
        fetch,
        url: `${safeBaseUrl}/open-apis/docx/v1/documents/${encodeURIComponent(
          remoteDocumentToken,
        )}/blocks/${encodeURIComponent(
          managedBodyBlockId,
        )}?document_revision_id=${revision}`,
        tenantAccessToken,
        timeoutMs: safeTimeoutMs,
        requestName: "Feishu managed block read",
      });

      return readPlainTextBlock(blockBody, managedBodyBlockId, revision);
    },
  };
}

async function requestJson(input: {
  fetch: typeof globalThis.fetch;
  url: string;
  tenantAccessToken: string;
  timeoutMs: number;
  requestName: string;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetch(input.url, {
      method: "GET",
      headers: { authorization: `Bearer ${input.tenantAccessToken}` },
      signal: controller.signal,
    });
    const responseBody = await readBoundedJsonResponse({
      response,
      invalidJsonErrorMessage: `${input.requestName} response was not valid JSON`,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      responseSizeErrorMessage: `${input.requestName} response exceeds ${MAX_RESPONSE_BYTES} bytes`,
    });
    if (!response.ok) {
      throw new Error(
        `${input.requestName} failed with status ${response.status}: ${readExternalErrorMessage(
          responseBody,
        )}`,
      );
    }
    if (!isRecord(responseBody) || responseBody.code !== 0) {
      throw new Error(`${input.requestName} failed: ${readExternalErrorMessage(responseBody)}`);
    }
    return responseBody;
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`${input.requestName} request timed out`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function readDocumentRevision(responseBody: unknown): number {
  if (
    !isRecord(responseBody) ||
    !isRecord(responseBody.data) ||
    !isRecord(responseBody.data.document)
  ) {
    throw new Error("Feishu managed document response returned invalid revision");
  }
  const value = responseBody.data.document.revision_id;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Feishu managed document response returned invalid revision");
  }
  return value;
}

function readPlainTextBlock(
  responseBody: unknown,
  expectedBlockId: string,
  revision: number,
): { revision: number; blockType: "text"; body: string } {
  if (!isRecord(responseBody) || !isRecord(responseBody.data) || !isRecord(responseBody.data.block)) {
    throw new Error("Feishu managed block response did not include the requested block");
  }
  const block = responseBody.data.block;
  if (block.block_id !== expectedBlockId) {
    throw new Error("Feishu managed block response did not include the requested block");
  }
  if (block.block_type !== TEXT_BLOCK_TYPE || !isRecord(block.text)) {
    throw new Error("Feishu managed block response returned unsupported block type");
  }
  if (!Array.isArray(block.text.elements)) {
    throw new Error("Feishu managed block response did not include plain text");
  }
  const content: string[] = [];
  for (const element of block.text.elements) {
    if (
      !isRecord(element) ||
      !isRecord(element.text_run) ||
      typeof element.text_run.content !== "string"
    ) {
      throw new Error("Feishu managed block response did not include plain text");
    }
    content.push(element.text_run.content);
  }
  return { revision, blockType: "text", body: content.join("") };
}

function requireHttpsUrl(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  if (url.protocol !== "https:") throw new Error(`${name} must be HTTPS`);
  if (url.username.length > 0 || url.password.length > 0) throw new Error(`${name} is invalid`);
  return url.href;
}

function requireIdentifier(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if ([...normalized].length < 1 || [...normalized].length > 512) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
