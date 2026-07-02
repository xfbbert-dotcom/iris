import type { DocumentBodyFetcher, DocumentBodyFetchResult } from "./document-sync-pipeline.js";
import type { DocumentSource, DocumentSourceType } from "./document-source-registry.js";
import type { FeishuTenantAccessTokenProvider } from "../feishu/feishu-tenant-access-token-provider.js";

export type FeishuDocumentBodyFetcherDependencies = {
  baseUrl: string;
  tokenProvider: FeishuTenantAccessTokenProvider;
  fetch?: typeof fetch;
  now?: () => Date;
};

const supportedSourceTypes = new Set<DocumentSourceType>([
  "group_visible_document",
  "authorized_wiki_document",
]);

export function parseFeishuDocxDocumentId(sourceUri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(sourceUri);
  } catch {
    return undefined;
  }

  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const markerIndex = segments.findIndex((segment) => segment === "docx" || segment === "docs");
  if (markerIndex < 0) {
    return undefined;
  }

  const documentId = segments[markerIndex + 1];
  return documentId === undefined || documentId.trim().length === 0 ? undefined : documentId;
}

export function createFeishuDocumentBodyFetcher({
  baseUrl,
  tokenProvider,
  fetch = globalThis.fetch,
  now = () => new Date(),
}: FeishuDocumentBodyFetcherDependencies): DocumentBodyFetcher {
  return {
    async fetch(source: DocumentSource): Promise<DocumentBodyFetchResult> {
      assertSupportedSourceType(source.sourceType);
      const documentId = parseFeishuDocxDocumentId(source.sourceUri);
      if (documentId === undefined) {
        throw new Error(`unsupported Feishu docx URL: ${source.sourceUri}`);
      }

      const tenantAccessToken = await tokenProvider.getTenantAccessToken();
      const response = await fetch(
        `${trimTrailingSlash(baseUrl)}/open-apis/docx/v1/documents/${encodeURIComponent(
          documentId,
        )}/raw_content`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${tenantAccessToken}` },
        },
      );
      const responseBody = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(
          `Feishu document raw content request failed with status ${response.status}: ${readErrorMessage(
            responseBody,
          )}`,
        );
      }

      const bodyText = readRawContent(responseBody);
      return {
        bodyText,
        fetchedAt: now(),
      };
    },
  };
}

function assertSupportedSourceType(sourceType: DocumentSourceType): void {
  if (!supportedSourceTypes.has(sourceType)) {
    throw new Error(`unsupported Feishu document source type: ${sourceType}`);
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("Feishu document raw content response was not valid JSON");
  }
}

function readRawContent(responseBody: unknown): string {
  if (!isRecord(responseBody)) {
    throw new Error("Feishu document raw content response did not include content");
  }

  const code = responseBody.code;
  if (typeof code === "number" && code !== 0) {
    throw new Error(`Feishu document raw content request failed: ${readErrorMessage(responseBody)}`);
  }

  if (!isRecord(responseBody.data)) {
    throw new Error("Feishu document raw content response did not include content");
  }

  const content = responseBody.data.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("Feishu document raw content response did not include content");
  }

  return content.trim();
}

function readErrorMessage(responseBody: unknown): string {
  if (isRecord(responseBody)) {
    const message = responseBody.msg ?? responseBody.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }

  return "unknown error";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
