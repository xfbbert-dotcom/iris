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
  if (!isSupportedFeishuHost(url.hostname)) {
    return undefined;
  }

  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (!markers.includes(segments[0] ?? "")) {
    return undefined;
  }

  const token = segments[1];
  return token === undefined || token.trim().length === 0 ? undefined : token;
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
        documentId = await fetchWikiDocumentId({ baseUrl, wikiNodeToken, tenantAccessToken, fetch });
      }

      const response = await fetch(
        `${trimTrailingSlash(baseUrl)}/open-apis/docx/v1/documents/${encodeURIComponent(
          documentId,
        )}/raw_content`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${tenantAccessToken}` },
        },
      );
      const responseBody = await readJsonResponse(
        response,
        "Feishu document raw content response was not valid JSON",
      );

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

async function fetchWikiDocumentId({
  baseUrl,
  wikiNodeToken,
  tenantAccessToken,
  fetch,
}: {
  baseUrl: string;
  wikiNodeToken: string;
  tenantAccessToken: string;
  fetch: typeof globalThis.fetch;
}): Promise<string> {
  const response = await fetch(
    `${trimTrailingSlash(baseUrl)}/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(
      wikiNodeToken,
    )}`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${tenantAccessToken}` },
    },
  );
  const responseBody = await readJsonResponse(
    response,
    "Feishu wiki node response was not valid JSON",
  );

  if (!response.ok) {
    throw new Error(
      `Feishu wiki node request failed with status ${response.status}: ${readErrorMessage(
        responseBody,
      )}`,
    );
  }

  return readWikiDocumentId(responseBody);
}

function assertSupportedSourceType(sourceType: DocumentSourceType): void {
  if (!supportedSourceTypes.has(sourceType)) {
    throw new Error(`unsupported Feishu document source type: ${sourceType}`);
  }
}

async function readJsonResponse(response: Response, errorMessage: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(errorMessage);
  }
}

function readWikiDocumentId(responseBody: unknown): string {
  if (!isRecord(responseBody)) {
    throw new Error("Feishu wiki node response did not include document token");
  }

  const code = responseBody.code;
  if (typeof code === "number" && code !== 0) {
    throw new Error(`Feishu wiki node request failed: ${readErrorMessage(responseBody)}`);
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
  if (typeof objectToken !== "string" || objectToken.trim().length === 0) {
    throw new Error("Feishu wiki node response did not include document token");
  }

  return objectToken.trim();
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

function isSupportedFeishuHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "docs.feishu.cn" ||
    host.endsWith(".feishu.cn") ||
    host.endsWith(".larksuite.com")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
