import { readPositiveSafeInteger } from "../config/numeric-guards.js";
import type { FeishuTenantAccessTokenProvider } from "../feishu/feishu-tenant-access-token-provider.js";
import { readBoundedJsonResponse } from "../integrations/bounded-json-response.js";

import type { ManagedBlockReader } from "./feishu-managed-knowledge-block-reader.js";
import {
  canonicalManagedBody,
  canonicalManagedBodyHash,
} from "./managed-knowledge-page.js";

export type ManagedUpdateOutcome =
  | { kind: "applied"; resultingRevision: number }
  | { kind: "not_applied_retryable"; code: "rate_limited" | "server_error" }
  | { kind: "rejected"; code: "stale_revision" | "forbidden" | "missing" | "invalid" }
  | { kind: "unknown"; code: "timeout" | "connection_lost" | "malformed_success" };

export type ManagedKnowledgeBlockObservation = {
  revision: number;
  blockType: "text";
  canonicalBodyHash: string;
};

export type ManagedKnowledgeBlockInput = {
  remoteDocumentToken: string;
  managedBodyBlockId: string;
};

export type ManagedKnowledgeUpdateInput = ManagedKnowledgeBlockInput & {
  expectedRevision: number;
  proposedBody: string;
  clientToken: string;
};

export interface ManagedKnowledgeUpdater {
  preflight(input: ManagedKnowledgeBlockInput): Promise<ManagedKnowledgeBlockObservation>;
  update(input: ManagedKnowledgeUpdateInput): Promise<ManagedUpdateOutcome>;
  readBack(input: ManagedKnowledgeBlockInput): Promise<ManagedKnowledgeBlockObservation>;
}

export type FeishuManagedKnowledgeUpdaterDependencies = {
  baseUrl: string;
  tokenProvider: FeishuTenantAccessTokenProvider;
  blockReader: ManagedBlockReader;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_IDENTIFIER_CHARS = 512;
const MAX_CLIENT_TOKEN_CHARS = 64;
const MAX_FEISHU_TEXT_UTF16_UNITS = 100_000;

const FEISHU_RATE_LIMIT_CODE = 99_991_400;
const FEISHU_STALE_REVISION_CODE = 1_770_021;
const FEISHU_MISSING_CODES = new Set([1_770_002, 1_770_003, 1_770_038]);

export function createFeishuManagedKnowledgeUpdater({
  baseUrl,
  tokenProvider,
  blockReader,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: FeishuManagedKnowledgeUpdaterDependencies): ManagedKnowledgeUpdater {
  const safeBaseUrl = trimTrailingSlash(requireHttpsUrl("baseUrl", baseUrl));
  const safeTimeoutMs = readPositiveSafeInteger(
    timeoutMs,
    "Feishu managed block update timeoutMs",
  );

  return {
    preflight(input) {
      return observeManagedBlock(blockReader, input, "preflight");
    },

    async update(input) {
      const remoteDocumentToken = requireIdentifier(
        "remoteDocumentToken",
        input.remoteDocumentToken,
      );
      const managedBodyBlockId = requireIdentifier(
        "managedBodyBlockId",
        input.managedBodyBlockId,
      );
      const expectedRevision = requirePositiveSafeInteger(
        "expectedRevision",
        input.expectedRevision,
      );
      const clientToken = requireClientToken(input.clientToken);
      const proposedBody = requireFeishuManagedBody(input.proposedBody);

      let tenantAccessToken: string;
      try {
        tenantAccessToken = requireAccessToken(
          await tokenProvider.getTenantAccessToken(),
        );
      } catch {
        throw new Error("Feishu managed block update authorization failed");
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), safeTimeoutMs);
      let responseReceived = false;
      try {
        const response = await fetch(
          `${safeBaseUrl}/open-apis/docx/v1/documents/${encodeURIComponent(
            remoteDocumentToken,
          )}/blocks/batch_update?document_revision_id=${expectedRevision}&client_token=${encodeURIComponent(
            clientToken,
          )}`,
          {
            method: "PATCH",
            headers: {
              authorization: `Bearer ${tenantAccessToken}`,
              "content-type": "application/json; charset=utf-8",
            },
            body: JSON.stringify({
              requests: [{
                block_id: managedBodyBlockId,
                update_text_elements: {
                  elements: [{
                    text_run: {
                      content: proposedBody,
                      text_element_style: {},
                    },
                  }],
                },
              }],
            }),
            signal: controller.signal,
          },
        );
        responseReceived = true;
        const responseBody = await readBoundedJsonResponse({
          response,
          invalidJsonErrorMessage: "Feishu managed block update response was not valid JSON",
          maxResponseBytes: MAX_RESPONSE_BYTES,
          responseSizeErrorMessage: `Feishu managed block update response exceeds ${MAX_RESPONSE_BYTES} bytes`,
        });
        return classifyResponse(response.status, responseBody);
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          return { kind: "unknown", code: "timeout" };
        }
        return responseReceived
          ? { kind: "unknown", code: "malformed_success" }
          : { kind: "unknown", code: "connection_lost" };
      } finally {
        clearTimeout(timeout);
      }
    },

    readBack(input) {
      return observeManagedBlock(blockReader, input, "readback");
    },
  };
}

async function observeManagedBlock(
  blockReader: ManagedBlockReader,
  input: ManagedKnowledgeBlockInput,
  operation: "preflight" | "readback",
): Promise<ManagedKnowledgeBlockObservation> {
  const remoteDocumentToken = requireIdentifier(
    "remoteDocumentToken",
    input.remoteDocumentToken,
  );
  const managedBodyBlockId = requireIdentifier(
    "managedBodyBlockId",
    input.managedBodyBlockId,
  );
  try {
    const block = await blockReader.readManagedBlock({
      remoteDocumentToken,
      managedBodyBlockId,
    });
    return {
      revision: requirePositiveSafeInteger("revision", block.revision),
      blockType: requireTextBlockType(block.blockType),
      canonicalBodyHash: canonicalManagedBodyHash(block.body),
    };
  } catch {
    throw new Error(`Feishu managed block ${operation} failed`);
  }
}

function classifyResponse(status: number, responseBody: unknown): ManagedUpdateOutcome {
  if (!isRecord(responseBody) || !Number.isSafeInteger(responseBody.code)) {
    return { kind: "unknown", code: "malformed_success" };
  }
  const code = Number(responseBody.code);

  if (status === 200) {
    if (code !== 0) {
      return { kind: "unknown", code: "malformed_success" };
    }
    const resultingRevision = readResultingRevision(responseBody);
    return resultingRevision === undefined
      ? { kind: "unknown", code: "malformed_success" }
      : { kind: "applied", resultingRevision };
  }

  if (code === 0) {
    return { kind: "unknown", code: "malformed_success" };
  }
  if (status === 429 || (status === 400 && code === FEISHU_RATE_LIMIT_CODE)) {
    return { kind: "not_applied_retryable", code: "rate_limited" };
  }
  if (status >= 500 && status <= 599) {
    return { kind: "not_applied_retryable", code: "server_error" };
  }
  if (status === 401 || status === 403) {
    return { kind: "rejected", code: "forbidden" };
  }
  if (status === 404) {
    return { kind: "rejected", code: "missing" };
  }
  if (status >= 400 && status <= 499) {
    if (code === FEISHU_STALE_REVISION_CODE) {
      return { kind: "rejected", code: "stale_revision" };
    }
    if (FEISHU_MISSING_CODES.has(code)) {
      return { kind: "rejected", code: "missing" };
    }
    return { kind: "rejected", code: "invalid" };
  }
  return { kind: "unknown", code: "malformed_success" };
}

function readResultingRevision(responseBody: Record<string, unknown>): number | undefined {
  if (!isRecord(responseBody.data)) {
    return undefined;
  }
  const value = responseBody.data.document_revision_id;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function requireHttpsUrl(name: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${name} must be HTTPS`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(`${name} is invalid`);
  }
  return url.href;
}

function requireIdentifier(name: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  const normalized = value.trim();
  const length = [...normalized].length;
  if (length < 1 || length > MAX_IDENTIFIER_CHARS) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function requireClientToken(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("clientToken must be a string");
  }
  if (
    value !== value.trim() ||
    value.length < 1 ||
    value.length > MAX_CLIENT_TOKEN_CHARS ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error("clientToken is invalid");
  }
  return value;
}

function requireFeishuManagedBody(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("proposedBody must be a string");
  }
  const normalized = canonicalManagedBody(value);
  if (normalized.length > MAX_FEISHU_TEXT_UTF16_UNITS) {
    throw new Error("proposedBody exceeds Feishu text limit");
  }
  return normalized;
}

function requirePositiveSafeInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireAccessToken(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1) {
    throw new Error("access token is invalid");
  }
  return value.trim();
}

function requireTextBlockType(value: unknown): "text" {
  if (value !== "text") {
    throw new Error("managed block type is invalid");
  }
  return value;
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
