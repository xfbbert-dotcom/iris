import type {
  RawEvent,
  RawEventFailureInput,
  RawEventFailureResult,
  RawEventQueue,
} from "./raw-event-queue.js";

const DEFAULT_MAX_ATTEMPTS = 3;

type DeadLetteredRawEvent = {
  event: RawEvent;
  errorMessage: string;
  failedAt: Date;
};

export type InMemoryRawEventQueueOptions = {
  maxAttempts?: number;
  now?: () => Date;
};

export class InMemoryRawEventQueue implements RawEventQueue {
  private readonly events: RawEvent[] = [];
  private readonly deadLetters: DeadLetteredRawEvent[] = [];
  private readonly seenKeys = new Set<string>();
  private readonly maxAttempts: number;
  private readonly now: () => Date;

  constructor(options: InMemoryRawEventQueueOptions = {}) {
    this.maxAttempts = sanitizeMaxAttempts(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.now = options.now ?? (() => new Date());
  }

  async enqueue(event: RawEvent): Promise<void> {
    if (this.seenKeys.has(event.idempotencyKey)) {
      return;
    }

    this.seenKeys.add(event.idempotencyKey);
    this.events.push(cloneEvent(event));
  }

  async dequeueBatch(limit: number): Promise<RawEvent[]> {
    const safeLimit = sanitizeLimit(limit);
    return this.events.splice(0, safeLimit).map(cloneEvent);
  }

  async handleFailedEvent(input: RawEventFailureInput): Promise<RawEventFailureResult> {
    const attempts = input.event.attempts + 1;
    const failedEvent = cloneEvent({ ...input.event, attempts });

    if (attempts >= this.maxAttempts) {
      this.deadLetters.push({
        event: cloneEvent(failedEvent),
        errorMessage: input.errorMessage,
        failedAt: this.now(),
      });
      return { action: "dead_lettered", attempts };
    }

    this.events.push(cloneEvent(failedEvent));
    return { action: "requeued", attempts };
  }

  async getPendingCount(): Promise<number> {
    return this.events.length;
  }

  async getDeadLetterCount(): Promise<number> {
    return this.deadLetters.length;
  }
}

function sanitizeMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxAttempts must be a positive integer");
  }

  return value;
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function cloneEvent(event: RawEvent): RawEvent {
  return {
    ...event,
    rawBody: structuredClone(event.rawBody),
    receivedAt: new Date(event.receivedAt),
  };
}
