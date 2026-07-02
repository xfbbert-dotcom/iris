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
}

export function createRawEventIdempotencyKey(
  input: CreateRawEventIdempotencyKeyInput,
): string {
  return `raw-event:${input.provider}:${input.eventId}`;
}
