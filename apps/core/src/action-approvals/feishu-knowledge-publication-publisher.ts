import { createHash } from "node:crypto";

import { readPositiveSafeInteger } from "../config/numeric-guards.js";
import type { FeishuTenantAccessTokenProvider } from "../feishu/feishu-tenant-access-token-provider.js";
import { readBoundedJsonResponse } from "../integrations/bounded-json-response.js";

import type {
  KnowledgePublicationPublisher,
  KnowledgePublicationPublisherResult,
} from "./knowledge-publication-executor.js";

export type FeishuKnowledgePublicationPublisherDependencies = {
  baseUrl: string;
  tokenProvider: FeishuTenantAccessTokenProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_FEISHU_PUBLISH_RESPONSE_BYTES = 65_536;
const MAX_TITLE_CHARS = 256;
const MAX_CONTENT_CHARS = 200_000;

export function createFeishuKnowledgePublicationPublisher({
  baseUrl,
  tokenProvider,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: FeishuKnowledgePublicationPublisherDependencies): KnowledgePublicationPublisher {
  const safeBaseUrl = trimTrailingSlash(requireHttpsUrl("baseUrl", baseUrl));
  const safeTimeoutMs = readPositiveSafeInteger(timeoutMs, "Feishu publication timeoutMs");
  return {
    async publish(input): Promise<KnowledgePublicationPublisherResult> {
      const title = requireBoundedText("draft.title", input.draft.title, MAX_TITLE_CHARS);
      const content = requireBoundedText("draft.content", input.draft.content, MAX_CONTENT_CHARS);
      const spaceId = requireIdentifier("policy.spaceId", input.policy.spaceId);
      const parentNodeToken = input.policy.parentNodeToken === undefined
        ? undefined
        : requireIdentifier("policy.parentNodeToken", input.policy.parentNodeToken);
      const tenantAccessToken = await tokenProvider.getTenantAccessToken();
      const node = await createWikiNode({
        baseUrl: safeBaseUrl,
        fetch,
        timeoutMs: safeTimeoutMs,
        tenantAccessToken,
        spaceId,
        title,
        ...(parentNodeToken === undefined ? {} : { parentNodeToken }),
      });
      const revision = await appendDocxContent({
        baseUrl: safeBaseUrl,
        fetch,
        timeoutMs: safeTimeoutMs,
        tenantAccessToken,
        documentToken: node.remoteDocumentToken,
        content,
      });
      return {
        remoteNodeToken: node.remoteNodeToken,
        remoteDocumentToken: node.remoteDocumentToken,
        remoteDocumentType: "docx",
        ...(revision === undefined ? {} : { remoteDocumentVersion: revision }),
        contentHash: createHash("sha256").update(content).digest("hex"),
        permissionCheckSummary: "feishu_write_access_verified",
      };
    },
  };
}

async function createWikiNode(input: {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  tenantAccessToken: string;
  spaceId: string;
  title: string;
  parentNodeToken?: string;
}): Promise<{ remoteNodeToken: string; remoteDocumentToken: string }> {
  const body = {
    obj_type: "docx",
    node_type: "origin",
    title: input.title,
    ...(input.parentNodeToken === undefined ? {} : { parent_node_token: input.parentNodeToken }),
  };
  const { response, responseBody } = await requestJson({
    fetch: input.fetch,
    url: `${input.baseUrl}/open-apis/wiki/v2/spaces/${encodeURIComponent(input.spaceId)}/nodes`,
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.tenantAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
    timeoutMs: input.timeoutMs,
    invalidJsonErrorMessage: "Feishu wiki node creation response was not valid JSON",
    timeoutMessage: "Feishu wiki node creation request timed out",
  });
  if (!response.ok || !isFeishuCodeOk(responseBody)) {
    throw new Error(`Feishu wiki node creation failed with status ${response.status}`);
  }
  return readCreatedWikiNode(responseBody);
}

async function appendDocxContent(input: {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  tenantAccessToken: string;
  documentToken: string;
  content: string;
}): Promise<number | undefined> {
  const { response, responseBody } = await requestJson({
    fetch: input.fetch,
    url: `${input.baseUrl}/open-apis/docx/v1/documents/${encodeURIComponent(
      input.documentToken,
    )}/blocks/${encodeURIComponent(input.documentToken)}/children`,
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.tenantAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        children: [{
          block_type: 2,
          text: {
            elements: [{
              text_run: {
                content: input.content,
                text_element_style: {},
              },
            }],
            style: {},
          },
        }],
      }),
    },
    timeoutMs: input.timeoutMs,
    invalidJsonErrorMessage: "Feishu docx content append response was not valid JSON",
    timeoutMessage: "Feishu docx content append request timed out",
  });
  if (!response.ok || !isFeishuCodeOk(responseBody)) {
    throw new Error(`Feishu docx content append failed with status ${response.status}`);
  }
  return readRevisionId(responseBody);
}

async function requestJson(input: {
  fetch: typeof globalThis.fetch;
  url: string;
  init: RequestInit;
  timeoutMs: number;
  invalidJsonErrorMessage: string;
  timeoutMessage: string;
}): Promise<{ response: Response; responseBody: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetch(input.url, { ...input.init, signal: controller.signal });
    const responseBody = await readBoundedJsonResponse({
      response,
      invalidJsonErrorMessage: input.invalidJsonErrorMessage,
      maxResponseBytes: MAX_FEISHU_PUBLISH_RESPONSE_BYTES,
      responseSizeErrorMessage: `Feishu publication response exceeds ${MAX_FEISHU_PUBLISH_RESPONSE_BYTES} bytes`,
    });
    return { response, responseBody };
  } catch (error) {
    if (isAbortError(error)) throw new Error(input.timeoutMessage);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function readCreatedWikiNode(responseBody: unknown): {
  remoteNodeToken: string;
  remoteDocumentToken: string;
} {
  if (!isRecord(responseBody) || !isRecord(responseBody.data) || !isRecord(responseBody.data.node)) {
    throw new Error("Feishu wiki node creation response did not include node");
  }
  const nodeToken = requireIdentifier("node.node_token", responseBody.data.node.node_token);
  const objectToken = requireIdentifier("node.obj_token", responseBody.data.node.obj_token);
  if (responseBody.data.node.obj_type !== "docx") {
    throw new Error("Feishu wiki node creation response returned unsupported object type");
  }
  return { remoteNodeToken: nodeToken, remoteDocumentToken: objectToken };
}

function readRevisionId(responseBody: unknown): number | undefined {
  if (!isRecord(responseBody) || !isRecord(responseBody.data)) return undefined;
  const value = responseBody.data.revision_id;
  if (value === undefined || value === null) return undefined;
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Feishu docx content append response returned invalid revision");
  }
  return revision;
}

function isFeishuCodeOk(responseBody: unknown): boolean {
  return isRecord(responseBody) && responseBody.code === 0;
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
  return url.href;
}

function requireBoundedText(name: string, value: unknown, maxChars: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if ([...normalized].length < 1 || [...normalized].length > maxChars) {
    throw new Error(`${name} length is invalid`);
  }
  return normalized;
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
  return error instanceof DOMException && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
