export type MemoryExtractionJob = {
  schemaVersion: 1;
  idempotencyKey: string;
  requestId: string;
  groupId: string;
  enqueuedAt: Date;
  notBefore: Date;
  attempts: number;
};

export type MemoryExtractionJobDeadLetter = {
  id: string;
  job: MemoryExtractionJob;
  errorMessage: string;
  failedAt: Date;
  replayable: true;
};

export type MemoryExtractionInvalidPayloadDeadLetter = {
  id: string;
  payloadDigest: string;
  payloadBytes: number;
  errorMessage: string;
  failedAt: Date;
  replayable: false;
};

export type MemoryExtractionDeadLetter =
  | MemoryExtractionJobDeadLetter
  | MemoryExtractionInvalidPayloadDeadLetter;

export type ReplayMemoryExtractionDeadLettersResult = {
  replayedCount: number;
  notFoundIds: string[];
  unsupportedLegacyIds: string[];
};

export type MemoryExtractionTerminalErrorCode =
  | "provider_unauthorized"
  | "invalid_model_response"
  | "corrupt_routing";

export type RecoverMemoryExtractionProcessingResult = {
  recoveredCount: number;
  remainingCount: number;
};

export const MAX_MEMORY_EXTRACTION_IDENTIFIER_CHARS = 512;
export const MAX_MEMORY_EXTRACTION_QUEUE_LIMIT = 100;
export const MEMORY_EXTRACTION_SCHEMA_VERSION = 1 as const;
const MEMORY_EXTRACTION_IDEMPOTENCY_KEY_PREFIX = "memory-extraction:";
export const MAX_MEMORY_EXTRACTION_IDEMPOTENCY_KEY_CHARS =
  MAX_MEMORY_EXTRACTION_IDENTIFIER_CHARS;
export const MAX_MEMORY_EXTRACTION_REQUEST_ID_CHARS =
  MAX_MEMORY_EXTRACTION_IDEMPOTENCY_KEY_CHARS - MEMORY_EXTRACTION_IDEMPOTENCY_KEY_PREFIX.length;

export interface MemoryExtractionQueue {
  enqueue(job: MemoryExtractionJob): Promise<void>;
  recoverProcessing(input: {
    limit: number;
  }): Promise<RecoverMemoryExtractionProcessingResult>;
  dequeueBatch(limit: number, now?: Date): Promise<MemoryExtractionJob[]>;
  deferJob(job: MemoryExtractionJob): Promise<void>;
  handleProcessedJob(job: MemoryExtractionJob): Promise<void>;
  handleTerminalJob(input: {
    job: MemoryExtractionJob;
    errorCode: MemoryExtractionTerminalErrorCode;
  }): Promise<{ action: "dead_lettered"; attempts: number }>;
  handleFailedJob(input: {
    job: MemoryExtractionJob;
    errorMessage: string;
    retryAt?: Date;
  }): Promise<{ action: "requeued" | "dead_lettered"; attempts: number }>;
  getPendingCount(): Promise<number>;
  getProcessingCount(): Promise<number>;
  getDelayedCount(): Promise<number>;
  getDeadLetterCount(): Promise<number>;
  getProviderCooldown(): Promise<Date | undefined>;
  setProviderCooldown(until: Date): Promise<void>;
  listDeadLetters(input: { limit: number }): Promise<MemoryExtractionDeadLetter[]>;
  replayDeadLetter(id: string): Promise<"replayed" | "not_found" | "unsupported_legacy_item">;
  deleteDeadLetter(id: string): Promise<"deleted" | "not_found" | "unsupported_legacy_item">;
  replayDeadLetters(input: {
    ids: string[];
  }): Promise<ReplayMemoryExtractionDeadLettersResult>;
}

export function createMemoryExtractionJob(input: {
  requestId: string;
  groupId: string;
  now: Date;
}): MemoryExtractionJob {
  const requestId = normalizeMemoryExtractionRequestId(input.requestId);
  const groupId = normalizeMemoryExtractionIdentifier(input.groupId, "groupId");
  const now = requireValidMemoryExtractionDate(input.now, "now");

  return {
    schemaVersion: MEMORY_EXTRACTION_SCHEMA_VERSION,
    idempotencyKey: createMemoryExtractionIdempotencyKey(requestId),
    requestId,
    groupId,
    enqueuedAt: now,
    notBefore: new Date(now.getTime()),
    attempts: 0,
  };
}

export function createMemoryExtractionIdempotencyKey(requestId: string): string {
  return `${MEMORY_EXTRACTION_IDEMPOTENCY_KEY_PREFIX}${normalizeMemoryExtractionRequestId(
    requestId,
  )}`;
}

function normalizeMemoryExtractionRequestId(value: string): string {
  const normalized = normalizeMemoryExtractionIdentifier(value, "requestId");
  if (normalized.length > MAX_MEMORY_EXTRACTION_REQUEST_ID_CHARS) {
    throw new Error(
      `requestId must be at most ${MAX_MEMORY_EXTRACTION_REQUEST_ID_CHARS} characters`,
    );
  }
  return normalized;
}

export function normalizeMemoryExtractionIdentifier(value: string, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${fieldName} must be nonblank`);
  }
  if (normalized.length > MAX_MEMORY_EXTRACTION_IDENTIFIER_CHARS) {
    throw new Error(
      `${fieldName} must be at most ${MAX_MEMORY_EXTRACTION_IDENTIFIER_CHARS} characters`,
    );
  }
  return normalized;
}

export function requireValidMemoryExtractionDate(value: Date, fieldName: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }
  return new Date(value.getTime());
}
