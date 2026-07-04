export type RawEventProvider = "feishu";

export type RawEvent = {
  idempotencyKey: string;
  provider: RawEventProvider;
  eventType: string;
  rawBody: unknown;
  receivedAt: Date;
  attempts: number;
};

export type RawEventFailureInput = {
  event: RawEvent;
  errorMessage: string;
};

export type RawEventFailureResult = {
  action: "requeued" | "dead_lettered";
  attempts: number;
};

export type RawEventDeadLetter =
  | {
      id: string;
      event: RawEvent;
      errorMessage: string;
      failedAt: Date;
      replayable: boolean;
    }
  | {
      id: string;
      rawPayload: string;
      errorMessage: string;
      failedAt: Date;
      replayable: false;
    };

export type ReplayRawEventDeadLettersResult = {
  replayedCount: number;
  notFoundIds: string[];
  unsupportedLegacyIds: string[];
};

export type CreateRawEventIdempotencyKeyInput = {
  provider: RawEventProvider;
  eventId: string;
};

export interface RawEventQueue {
  enqueue(event: RawEvent): Promise<void>;
  dequeueBatch(limit: number): Promise<RawEvent[]>;
  handleFailedEvent(input: RawEventFailureInput): Promise<RawEventFailureResult>;
  getPendingCount(): Promise<number>;
  getDeadLetterCount(): Promise<number>;
  listDeadLetters(input: { limit: number }): Promise<RawEventDeadLetter[]>;
  replayDeadLetter(id: string): Promise<"replayed" | "not_found" | "unsupported_legacy_item">;
  deleteDeadLetter(id: string): Promise<"deleted" | "not_found" | "unsupported_legacy_item">;
  replayDeadLetters(input: { ids: string[] }): Promise<ReplayRawEventDeadLettersResult>;
}

export function createRawEventIdempotencyKey(
  input: CreateRawEventIdempotencyKeyInput,
): string {
  return `raw-event:${input.provider}:${normalizeNonBlankId(input.eventId, "eventId")}`;
}

function normalizeNonBlankId(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${fieldName} must be nonblank`);
  }

  return normalized;
}
