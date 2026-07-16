import {
  AiWorkerMemoryExtractionError,
  MEMORY_CANDIDATE_CATEGORIES,
  type AiWorkerMemoryExtractionClient,
  type AiWorkerExtractionResponse,
  type ProposedActionOperation,
  type ProposedActionOwner,
  type ProposedMemoryCandidate,
  type ProposedThreadOperation,
} from "./ai-worker-memory-extraction-client.js";
import type {
  ClaimedMemoryExtractionRun,
  ExtractionExistingAction,
  ExtractionExistingMemory,
  ExtractionExistingThread,
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
const MAX_CONVERSATION_STATE_SNAPSHOTS = 12;
const MAX_OPERATIONS_PER_FAMILY = 8;
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

  async extract(run: ClaimedMemoryExtractionRun): Promise<AiWorkerExtractionResponse> {
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
    schema_version: 2,
    run_id: run.id,
    group_id: run.groupId,
    input_fingerprint: run.inputFingerprint,
    messages: messages.map(mapMessage),
    evidence_message_ids: run.evidenceMessages.map((message) => message.id),
    existing_memories: run.existingMemories.map(mapExistingMemory),
    existing_threads: run.existingThreads.map(mapExistingThread),
    existing_actions: run.existingActions.map(mapExistingAction),
    enabled_operation_families: [...run.enabledOperationFamilies].sort(),
  };
}

function requireExactRun(run: ClaimedMemoryExtractionRun): void {
  if (!isIdentifier(run.id) || !isIdentifier(run.groupId) || !/^[a-f0-9]{64}$/u.test(run.inputFingerprint)) {
    throw invalidResponse();
  }
  if (!Array.isArray(run.evidenceMessages) ||
    !Array.isArray(run.contextMessages) ||
    !Array.isArray(run.existingMemories) ||
    !Array.isArray(run.mentions) ||
    !Array.isArray(run.existingThreads) ||
    !Array.isArray(run.existingActions) ||
    !Array.isArray(run.enabledOperationFamilies) ||
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
  if (run.existingThreads.length > MAX_CONVERSATION_STATE_SNAPSHOTS ||
    run.existingActions.length > MAX_CONVERSATION_STATE_SNAPSHOTS ||
    new Set(run.enabledOperationFamilies).size !== run.enabledOperationFamilies.length ||
    run.enabledOperationFamilies.some((family) => family !== "memory" && family !== "thread" && family !== "action")) {
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
    mentions: (message.mentions ?? []).map((mention) => ({
      key: mention.key,
      open_id: mention.openId,
    })),
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

function mapExistingThread(thread: ExtractionExistingThread): Record<string, unknown> {
  return {
    id: thread.id, title: thread.title, summary: thread.summary, status: thread.status,
    version: thread.version, updated_at: thread.updatedAt.toISOString(),
  };
}

function mapExistingAction(action: ExtractionExistingAction): Record<string, unknown> {
  return {
    id: action.id, ...(action.threadId === undefined ? {} : { thread_id: action.threadId }),
    description: action.description, owner_ref_type: action.ownerRefType, owner_ref: action.ownerRef,
    status: action.status, version: action.version, updated_at: action.updatedAt.toISOString(),
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
): AiWorkerExtractionResponse {
  const response = requireExactRecord(value, [
    "schema_version",
    "run_id",
    "candidates",
    "thread_operations",
    "action_operations",
  ], ["thread_operations", "action_operations"]);
  if ((response.schema_version !== 1 && response.schema_version !== 2) || !isIdentifier(response.run_id)) {
    throw invalidResponse();
  }
  if (response.run_id !== expectedRunId || !isExactArray(response.candidates)) {
    throw invalidResponse();
  }
  if (response.candidates.length > MAX_CANDIDATES) {
    throw invalidResponse();
  }
  if (response.schema_version === 1) {
    if (Object.hasOwn(response, "thread_operations") || Object.hasOwn(response, "action_operations")) {
      throw invalidResponse();
    }
    return {
      runId: response.run_id,
      candidates: response.candidates.map(parseCandidate),
    };
  }
  if (!Object.hasOwn(response, "thread_operations") || !Object.hasOwn(response, "action_operations") ||
    !isExactArray(response.thread_operations) || !isExactArray(response.action_operations) ||
    response.thread_operations.length > MAX_OPERATIONS_PER_FAMILY ||
    response.action_operations.length > MAX_OPERATIONS_PER_FAMILY) {
    throw invalidResponse();
  }
  return {
    runId: response.run_id,
    candidates: response.candidates.map(parseCandidate),
    threadOperations: response.thread_operations.map(parseThreadOperation),
    actionOperations: response.action_operations.map(parseActionOperation),
  };
}

function parseThreadOperation(value: unknown): ProposedThreadOperation {
  const base = parseEvidenceBoundOperation(value, [
    "operation", "thread_id", "source_thread_id", "target_thread_id", "expected_version",
    "title", "summary", "initial_status", "corrected_fields",
  ], ["thread_id", "source_thread_id", "target_thread_id", "expected_version", "title", "summary", "initial_status", "corrected_fields"]);
  switch (base.operation) {
    case "create":
      requireExactOperationFields(base, ["operation", "operation_key", "confidence", "evidence_message_ids", "evidence_span", "title", "summary", "initial_status"]);
      if (!isContent(base.title) || !isContent(base.summary) || (base.initial_status !== "candidate" && base.initial_status !== "open")) throw invalidResponse();
      return { ...base.common, operation: "create", title: base.title, summary: base.summary, initialStatus: base.initial_status };
    case "attach_evidence":
      requireExistingThreadFields(base, "thread_id");
      return { ...base.common, operation: "attach_evidence", threadId: base.thread_id, expectedVersion: base.expected_version };
    case "promote":
      requireExistingThreadFields(base, "thread_id", "summary");
      if (!isContent(base.summary)) throw invalidResponse();
      return { ...base.common, operation: "promote", threadId: base.thread_id, expectedVersion: base.expected_version, summary: base.summary };
    case "merge":
      requireExistingThreadFields(base, "source_thread_id", "target_thread_id");
      if (base.source_thread_id === base.target_thread_id) throw invalidResponse();
      return { ...base.common, operation: "merge", sourceThreadId: base.source_thread_id, targetThreadId: base.target_thread_id, expectedVersion: base.expected_version };
    case "resolve":
    case "reopen":
      requireExistingThreadFields(base, "thread_id");
      return { ...base.common, operation: base.operation, threadId: base.thread_id, expectedVersion: base.expected_version };
    case "update_summary":
      requireExistingThreadFields(base, "thread_id", "summary");
      if (!isContent(base.summary)) throw invalidResponse();
      return { ...base.common, operation: "update_summary", threadId: base.thread_id, expectedVersion: base.expected_version, summary: base.summary };
    case "correct": {
      requireExactOperationFields(base, [
        "operation", "operation_key", "confidence", "evidence_message_ids", "evidence_span",
        "thread_id", "expected_version", "corrected_fields", "title", "summary",
      ], ["title", "summary"]);
      if (!isIdentifier(base.thread_id) || !isPositiveSafeInteger(base.expected_version)) throw invalidResponse();
      const correctedFields = parseCorrectedFields(base.corrected_fields, ["title", "summary"]);
      const supplied = [base.title === undefined ? undefined : "title", base.summary === undefined ? undefined : "summary"].filter((field): field is "title" | "summary" => field !== undefined);
      if (!sameSortedValues(correctedFields, supplied) || (base.title !== undefined && !isContent(base.title)) || (base.summary !== undefined && !isContent(base.summary))) throw invalidResponse();
      return { ...base.common, operation: "correct", threadId: base.thread_id, expectedVersion: base.expected_version, correctedFields, ...(base.title === undefined ? {} : { title: base.title }), ...(base.summary === undefined ? {} : { summary: base.summary }) };
    }
    default:
      throw invalidResponse();
  }
}

function parseActionOperation(value: unknown): ProposedActionOperation {
  const base = parseEvidenceBoundOperation(value, [
    "operation", "action_id", "expected_version", "thread_id", "description", "owner", "due_at", "due_evidence_span", "corrected_fields",
  ], ["action_id", "expected_version", "thread_id", "description", "owner", "due_at", "due_evidence_span", "corrected_fields"]);
  switch (base.operation) {
    case "create": {
      requireExactOperationFields(base, ["operation", "operation_key", "confidence", "evidence_message_ids", "evidence_span", "thread_id", "description", "owner", "due_at", "due_evidence_span"], ["thread_id", "due_at", "due_evidence_span"]);
      if ((base.thread_id !== undefined && base.thread_id !== null && !isIdentifier(base.thread_id)) || !isContent(base.description) || !Object.hasOwn(base.record, "owner")) throw invalidResponse();
      const owner = parseActionOwner(base.owner);
      if ((base.due_at === undefined) !== (base.due_evidence_span === undefined) || (base.due_at !== undefined && (!isTimestamp(base.due_at) || !isContent(base.due_evidence_span)))) throw invalidResponse();
      return { ...base.common, operation: "create", ...(base.thread_id === undefined ? {} : { threadId: base.thread_id }), description: base.description, owner, ...(base.due_at === undefined ? {} : { dueAt: base.due_at, dueEvidenceSpan: base.due_evidence_span! }) };
    }
    case "complete":
    case "cancel":
    case "reopen":
      requireExistingActionFields(base);
      return { ...base.common, operation: base.operation, actionId: base.action_id, expectedVersion: base.expected_version };
    case "resolve_owner":
      requireExistingActionFields(base, "owner");
      return { ...base.common, operation: "resolve_owner", actionId: base.action_id, expectedVersion: base.expected_version, owner: parseActionOwner(base.owner) };
    case "correct": {
      requireExactOperationFields(base, [
        "operation", "operation_key", "confidence", "evidence_message_ids", "evidence_span",
        "action_id", "expected_version", "corrected_fields", "description", "thread_id", "owner",
      ], ["description", "thread_id", "owner"]);
      if (!isIdentifier(base.action_id) || !isPositiveSafeInteger(base.expected_version)) throw invalidResponse();
      const correctedFields = parseCorrectedFields(base.corrected_fields, ["description", "thread_id", "owner"]);
      const supplied = [base.description === undefined ? undefined : "description", Object.hasOwn(base.record, "thread_id") ? "thread_id" : undefined, base.owner === undefined ? undefined : "owner"].filter((field): field is "description" | "thread_id" | "owner" => field !== undefined);
      if (!sameSortedValues(correctedFields, supplied) || (base.description !== undefined && !isContent(base.description)) || (Object.hasOwn(base.record, "thread_id") && base.thread_id !== null && !isIdentifier(base.thread_id))) throw invalidResponse();
      return { ...base.common, operation: "correct", actionId: base.action_id, expectedVersion: base.expected_version, correctedFields, ...(base.description === undefined ? {} : { description: base.description }), ...(Object.hasOwn(base.record, "thread_id") ? { threadId: base.thread_id as string | null } : {}), ...(base.owner === undefined ? {} : { owner: parseActionOwner(base.owner) }) };
    }
    default:
      throw invalidResponse();
  }
}

type ParsedEvidenceBoundOperation = Record<string, any> & {
  record: Record<string, any>;
  operation: string;
  common: { operationKey: string; confidence: number; evidenceMessageIds: string[]; evidenceSpan: string };
};

function parseEvidenceBoundOperation(value: unknown, allowedSpecific: readonly string[], optionalSpecific: readonly string[]): ParsedEvidenceBoundOperation {
  const allowed = ["operation_key", "confidence", "evidence_message_ids", "evidence_span", ...allowedSpecific];
  const optional = optionalSpecific;
  const record = requireExactRecord(value, allowed, optional);
  if (!isIdentifier(record.operation_key) || typeof record.operation !== "string" || !isConfidence(record.confidence) || !isContent(record.evidence_span) || !isExactArray(record.evidence_message_ids) || record.evidence_message_ids.length === 0 || record.evidence_message_ids.length > MAX_EVIDENCE_IDS || !record.evidence_message_ids.every(isIdentifier) || new Set(record.evidence_message_ids).size !== record.evidence_message_ids.length) throw invalidResponse();
  return { record, operation: record.operation, common: { operationKey: record.operation_key, confidence: record.confidence, evidenceMessageIds: [...record.evidence_message_ids] as string[], evidenceSpan: record.evidence_span }, ...record };
}

function requireExactOperationFields(base: ParsedEvidenceBoundOperation, keys: readonly string[], optional: readonly string[] = []): void {
  requireExactRecord(base.record, keys, optional);
}

function requireExistingThreadFields(base: ParsedEvidenceBoundOperation, ...extras: string[]): void {
  requireExactOperationFields(base, ["operation", "operation_key", "confidence", "evidence_message_ids", "evidence_span", "expected_version", ...extras]);
  if (!isPositiveSafeInteger(base.expected_version) || extras.some((field) => field.endsWith("thread_id") && !isIdentifier(base[field]))) throw invalidResponse();
}

function requireExistingActionFields(base: ParsedEvidenceBoundOperation, extra?: "owner" | "corrected_fields"): void {
  requireExactOperationFields(base, ["operation", "operation_key", "confidence", "evidence_message_ids", "evidence_span", "action_id", "expected_version", ...(extra === undefined ? [] : [extra])]);
  if (!isIdentifier(base.action_id) || !isPositiveSafeInteger(base.expected_version)) throw invalidResponse();
}

function parseCorrectedFields<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (!isExactArray(value) || value.length === 0 || value.length > allowed.length || !value.every((field) => typeof field === "string" && allowed.includes(field as T)) || new Set(value).size !== value.length) throw invalidResponse();
  return [...value].sort() as T[];
}

function sameSortedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === [...right].sort()[index]);
}

function parseActionOwner(value: unknown): ProposedActionOwner {
  const owner = requireExactRecord(value, ["owner_type", "message_id", "mention_key", "label"], ["mention_key", "label"]);
  if (!isIdentifier(owner.message_id)) throw invalidResponse();
  if (owner.owner_type === "sender") {
    requireExactRecord(owner, ["owner_type", "message_id"]);
    return { ownerType: "sender", messageId: owner.message_id };
  }
  if (owner.owner_type === "mention") {
    requireExactRecord(owner, ["owner_type", "message_id", "mention_key"]);
    if (!isIdentifier(owner.mention_key)) throw invalidResponse();
    return { ownerType: "mention", messageId: owner.message_id, mentionKey: owner.mention_key };
  }
  if (owner.owner_type === "text_label") {
    requireExactRecord(owner, ["owner_type", "message_id", "label"]);
    if (!isContent(owner.label)) throw invalidResponse();
    return { ownerType: "text_label", messageId: owner.message_id, label: owner.label };
  }
  throw invalidResponse();
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
  if (!isExactArray(candidate.evidence_message_ids) || candidate.evidence_message_ids.length === 0 || candidate.evidence_message_ids.length > MAX_EVIDENCE_IDS) {
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
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw invalidResponse();
  }
  const record = value as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(record);
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key)) ||
    Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) {
    throw invalidResponse();
  }
  if (allowedKeys.some((key) => !optionalKeys.includes(key) && !Object.hasOwn(record, key))) {
    throw invalidResponse();
  }
  return record;
}

function isExactArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)))) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return false;
  }
  return true;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    codePointLength(value) <= MAX_IDENTIFIER_CHARS &&
    value === value.trim() &&
    !hasUnsafeText(value) &&
    !/\p{Cc}/u.test(value);
}

function isContent(value: unknown): value is string {
  if (typeof value !== "string" || hasUnsafeText(value)) {
    return false;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_MEMORY_CONTENT_CHARS;
}

function isMessageText(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    codePointLength(value) <= MAX_MESSAGE_TEXT_CHARS &&
    !hasUnsafeText(value);
}

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isTimestamp(value: unknown): value is string {
  if (!isContent(value) || value.length > 64) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && /(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(value);
}

function hasUnsafeText(value: string): boolean {
  return value.includes("\u0000") || hasLoneSurrogate(value) || /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value);
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
