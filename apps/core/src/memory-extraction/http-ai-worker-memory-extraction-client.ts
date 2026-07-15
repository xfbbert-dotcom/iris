import {
  AiWorkerMemoryExtractionError,
  MEMORY_CANDIDATE_CATEGORIES,
  type AiWorkerMemoryExtractionClient,
  type ProposedMemoryCandidate,
} from "./ai-worker-memory-extraction-client.js";
import type {
  ClaimedMemoryExtractionRun,
  ExtractionExistingMemory,
  ExtractionMessage,
} from "./memory-extraction-repository.js";

const MAX_URL_CHARS = 2048;
const MAX_TOKEN_CHARS = 4096;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_IDENTIFIER_CHARS = 512;
const MAX_MESSAGE_TEXT_CHARS = 8000;
const MAX_MEMORY_CONTENT_CHARS = 4000;
const MAX_MESSAGES = 50;
const MAX_CONTEXT_MESSAGES = 10;
const MAX_CANDIDATES = 8;
const MAX_EVIDENCE_IDS = 40;
const MAX_EXISTING_MEMORIES = 8;
const MAX_RETRY_AFTER_SECONDS = 86_400;
const CANDIDATE_RELATIONS = ["new", "duplicate", "conflict"] as const;
const EXISTING_MEMORY_CATEGORIES = [
  ...MEMORY_CANDIDATE_CATEGORIES,
  "action",
  "summary",
] as const;

export type HttpAiWorkerMemoryExtractionClientConfig = {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
};

export class HttpAiWorkerMemoryExtractionClient implements AiWorkerMemoryExtractionClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpAiWorkerMemoryExtractionClientConfig) {
    this.baseUrl = requireBaseUrl(config.baseUrl);
    this.token = requireToken(config.token);
    this.timeoutMs = requireBoundedInteger(
      "timeout",
      config.timeoutMs ?? 30_000,
      MAX_TIMEOUT_MS,
    );
    this.maxRequestBytes = requireBoundedInteger(
      "request byte limit",
      config.maxRequestBytes ?? MAX_REQUEST_BYTES,
      MAX_REQUEST_BYTES,
    );
    this.maxResponseBytes = requireBoundedInteger(
      "response byte limit",
      config.maxResponseBytes ?? 64 * 1024,
      MAX_RESPONSE_BYTES,
    );
    if (config.fetch !== undefined && typeof config.fetch !== "function") {
      throw new Error("ai worker fetch is invalid");
    }
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  async checkHealth(): Promise<boolean> {
    try {
      return await runWithWallTimeout(this.timeoutMs, async (signal) => {
        const response = await this.fetchImpl(`${this.baseUrl}/health`, {
          method: "GET",
          headers: {
            accept: "application/json",
            "accept-encoding": "identity",
          },
          signal,
        });
        if (response.status !== 200) {
          return false;
        }
        const value = await readSuccessJson(response, this.maxResponseBytes);
        return isExactHealth(value);
      });
    } catch {
      return false;
    }
  }

  async extract(run: ClaimedMemoryExtractionRun): Promise<{
    runId: string;
    candidates: ProposedMemoryCandidate[];
  }> {
    let body: string;
    try {
      body = JSON.stringify(buildRequest(run));
    } catch {
      throw invalidResponse();
    }
    if (new TextEncoder().encode(body).byteLength > this.maxRequestBytes) {
      throw invalidResponse();
    }

    try {
      return await runWithWallTimeout(this.timeoutMs, async (signal) => {
        let response: Response;
        try {
          response = await this.fetchImpl(`${this.baseUrl}/v1/memory/extract`, {
            method: "POST",
            headers: {
              accept: "application/json",
              "accept-encoding": "identity",
              authorization: `Bearer ${this.token}`,
              "content-type": "application/json",
            },
            body,
            signal,
          });
        } catch (error) {
          if (signal.aborted || isAbortError(error)) {
            throw new WallTimeoutError();
          }
          throw new AiWorkerMemoryExtractionError("unavailable", true);
        }

        const statusError = await classifyStatus(response, this.maxResponseBytes);
        if (statusError !== undefined) {
          throw statusError;
        }

        const value = await readSuccessJson(response, this.maxResponseBytes);
        return parseExtractionResponse(value, run.id);
      });
    } catch (error) {
      if (error instanceof AiWorkerMemoryExtractionError) {
        throw error;
      }
      if (error instanceof WallTimeoutError || isAbortError(error)) {
        throw new AiWorkerMemoryExtractionError("timeout", true);
      }
      throw invalidResponse();
    }
  }
}

function buildRequest(run: ClaimedMemoryExtractionRun): Record<string, unknown> {
  requireExactRun(run);
  const messages = [...run.contextMessages, ...run.evidenceMessages]
    .slice()
    .sort(compareMessages);
  return {
    schema_version: 1,
    run_id: run.id,
    group_id: run.groupId,
    input_fingerprint: run.inputFingerprint,
    messages: messages.map(mapMessage),
    evidence_message_ids: run.evidenceMessages.map((message) => message.id),
    existing_memories: run.existingMemories.map(mapExistingMemory),
  };
}

function requireExactRun(run: ClaimedMemoryExtractionRun): void {
  if (!isIdentifier(run.id) || !isIdentifier(run.groupId) || !/^[a-f0-9]{64}$/u.test(run.inputFingerprint)) {
    throw invalidResponse();
  }
  if (!Array.isArray(run.evidenceMessages) ||
    !Array.isArray(run.contextMessages) ||
    !Array.isArray(run.existingMemories) ||
    run.evidenceMessages.length === 0 ||
    run.evidenceMessages.length > MAX_EVIDENCE_IDS ||
    run.contextMessages.length > MAX_CONTEXT_MESSAGES ||
    run.evidenceMessages.length + run.contextMessages.length > MAX_MESSAGES) {
    throw invalidResponse();
  }
  const messages = [...run.contextMessages, ...run.evidenceMessages];
  const messageIds = new Set<string>();
  for (const message of messages) {
    if (!isIdentifier(message.id) || message.groupId !== run.groupId || !isValidDate(message.sentAt) || !isValidDate(message.createdAt) || !isMessageText(message.text)) {
      throw invalidResponse();
    }
    if (message.senderId !== undefined && !isIdentifier(message.senderId)) {
      throw invalidResponse();
    }
    if (messageIds.has(message.id)) {
      throw invalidResponse();
    }
    messageIds.add(message.id);
  }
  if (run.evidenceMessages.some((message) => message.evidenceEligible !== true)) {
    throw invalidResponse();
  }
  if (run.existingMemories.length > MAX_EXISTING_MEMORIES) {
    throw invalidResponse();
  }
  const memoryIds = new Set<string>();
  for (const memory of run.existingMemories) {
    if (!isIdentifier(memory.id) ||
      !EXISTING_MEMORY_CATEGORIES.includes(memory.category as never) ||
      !isContent(memory.content) ||
      !isValidDate(memory.updatedAt) ||
      memoryIds.has(memory.id)) {
      throw invalidResponse();
    }
    memoryIds.add(memory.id);
  }
}

function compareMessages(left: ExtractionMessage, right: ExtractionMessage): number {
  return left.sentAt.getTime() - right.sentAt.getTime() ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function mapMessage(message: ExtractionMessage): Record<string, unknown> {
  return {
    id: message.id,
    ...(message.senderId === undefined ? {} : { sender_id: message.senderId }),
    sent_at: message.sentAt.toISOString(),
    text: message.text,
  };
}

function mapExistingMemory(memory: ExtractionExistingMemory): Record<string, unknown> {
  return {
    id: memory.id,
    category: memory.category,
    content: memory.content,
    updated_at: memory.updatedAt.toISOString(),
  };
}

async function classifyStatus(
  response: Response,
  maxResponseBytes: number,
): Promise<AiWorkerMemoryExtractionError | undefined> {
  if (response.status === 200) {
    return undefined;
  }
  if (response.status === 401 || response.status === 403) {
    return new AiWorkerMemoryExtractionError("unauthorized", false);
  }
  if (response.status === 429) {
    return new AiWorkerMemoryExtractionError(
      "rate_limited",
      true,
      parseRetryAfterMs(safeHeader(response, "retry-after")),
    );
  }
  if (response.status === 502) {
    try {
      const value = await readSuccessJson(response, maxResponseBytes);
      const body = requireExactRecord(value, ["error"]);
      if (body.error === "invalid_model_response") {
        return new AiWorkerMemoryExtractionError("invalid_response", true);
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
    }
    return new AiWorkerMemoryExtractionError("unavailable", true);
  }
  if (response.status >= 500 && response.status <= 599) {
    return new AiWorkerMemoryExtractionError("unavailable", true);
  }
  return invalidResponse();
}

async function readSuccessJson(response: Response, maxBytes: number): Promise<unknown> {
  const encoding = safeHeader(response, "content-encoding");
  if (encoding !== null && encoding.toLowerCase() !== "identity") {
    throw invalidResponse();
  }
  const contentLength = safeHeader(response, "content-length");
  if (contentLength !== null && !isValidBoundedDecimal(contentLength, maxBytes)) {
    throw invalidResponse();
  }

  let text: string;
  try {
    text = await readBoundedText(response, maxBytes);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw invalidResponse();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw invalidResponse();
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (body === null || body === undefined) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw invalidResponse();
    }
    return text;
  }

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
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw invalidResponse();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseExtractionResponse(
  value: unknown,
  expectedRunId: string,
): { runId: string; candidates: ProposedMemoryCandidate[] } {
  const response = requireExactRecord(value, ["schema_version", "run_id", "candidates"]);
  if (response.schema_version !== 1 || !isIdentifier(response.run_id)) {
    throw invalidResponse();
  }
  if (response.run_id !== expectedRunId || !Array.isArray(response.candidates)) {
    throw invalidResponse();
  }
  if (response.candidates.length > MAX_CANDIDATES) {
    throw invalidResponse();
  }
  return {
    runId: response.run_id,
    candidates: response.candidates.map(parseCandidate),
  };
}

function parseCandidate(value: unknown): ProposedMemoryCandidate {
  const candidate = requireExactRecord(value, [
    "category",
    "content",
    "importance",
    "confidence",
    "evidence_message_ids",
    "relation",
    "existing_memory_id",
  ], ["existing_memory_id"]);
  if (!MEMORY_CANDIDATE_CATEGORIES.includes(candidate.category as never)) {
    throw invalidResponse();
  }
  if (!isContent(candidate.content)) {
    throw invalidResponse();
  }
  if (!Number.isSafeInteger(candidate.importance) || candidate.importance < 1 || candidate.importance > 5) {
    throw invalidResponse();
  }
  if (typeof candidate.confidence !== "number" || !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) {
    throw invalidResponse();
  }
  if (!Array.isArray(candidate.evidence_message_ids) || candidate.evidence_message_ids.length === 0 || candidate.evidence_message_ids.length > MAX_EVIDENCE_IDS) {
    throw invalidResponse();
  }
  if (!candidate.evidence_message_ids.every(isIdentifier) || new Set(candidate.evidence_message_ids).size !== candidate.evidence_message_ids.length) {
    throw invalidResponse();
  }
  if (!CANDIDATE_RELATIONS.includes(candidate.relation as never)) {
    throw invalidResponse();
  }
  const existingMemoryId = candidate.existing_memory_id;
  if (existingMemoryId !== undefined && !isIdentifier(existingMemoryId)) {
    throw invalidResponse();
  }
  if ((candidate.relation === "new") === (existingMemoryId !== undefined)) {
    throw invalidResponse();
  }
  return {
    category: candidate.category as ProposedMemoryCandidate["category"],
    content: candidate.content,
    importance: candidate.importance,
    confidence: candidate.confidence,
    evidenceMessageIds: [...candidate.evidence_message_ids],
    relation: candidate.relation as ProposedMemoryCandidate["relation"],
    ...(existingMemoryId === undefined ? {} : { existingMemoryId }),
  };
}

function isExactHealth(value: unknown): boolean {
  try {
    const health = requireExactRecord(value, ["ok", "service", "schemaVersion"]);
    return health.ok === true && health.service === "iris-ai-worker" && health.schemaVersion === 1;
  } catch {
    return false;
  }
}

function requireExactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !allowedKeys.includes(key))) {
    throw invalidResponse();
  }
  if (allowedKeys.some((key) => !optionalKeys.includes(key) && !Object.hasOwn(record, key))) {
    throw invalidResponse();
  }
  return record;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    codePointLength(value) <= MAX_IDENTIFIER_CHARS &&
    value === value.trim() &&
    !hasLoneSurrogate(value) &&
    !/[\p{Cc}\p{Cf}]/u.test(value);
}

function isContent(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\u0000") || hasLoneSurrogate(value)) {
    return false;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_MEMORY_CONTENT_CHARS;
}

function isMessageText(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    codePointLength(value) <= MAX_MESSAGE_TEXT_CHARS &&
    !hasLoneSurrogate(value);
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null || value.length > 16 || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) {
    return undefined;
  }
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(60, seconds)) * 1000;
}

function safeHeader(response: Response, name: string): string | null {
  try {
    return response.headers.get(name);
  } catch {
    throw invalidResponse();
  }
}

function isValidBoundedDecimal(value: string, maximum: number): boolean {
  if (!/^(0|[1-9][0-9]{0,19})$/u.test(value)) {
    return false;
  }
  const maximumText = String(maximum);
  return value.length < maximumText.length ||
    (value.length === maximumText.length && value <= maximumText);
}

async function runWithWallTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new WallTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function requireBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_CHARS || /[\s\p{Cc}]/u.test(value)) {
    throw new Error("ai worker base URL is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("ai worker base URL is invalid");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname || parsed.username || parsed.password || hasAuthorityMarker(value) || parsed.search || parsed.hash) {
    throw new Error("ai worker base URL is invalid");
  }
  return value.replace(/\/+$/u, "");
}

function hasAuthorityMarker(value: string): boolean {
  const authorityStart = value.indexOf("://") + 3;
  const pathStart = value.indexOf("/", authorityStart);
  const authority = value.slice(authorityStart, pathStart === -1 ? value.length : pathStart);
  return authority.includes("@");
}

function requireToken(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TOKEN_CHARS || /[^\x21-\x7e]/u.test(value) || value.includes(",")) {
    throw new Error("ai worker token is invalid");
  }
  return value;
}

function requireBoundedInteger(name: string, value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`ai worker ${name} is invalid`);
  }
  return value as number;
}

function invalidResponse(): AiWorkerMemoryExtractionError {
  return new AiWorkerMemoryExtractionError("invalid_response", false);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

class WallTimeoutError extends Error {}
