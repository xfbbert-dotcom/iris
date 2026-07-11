import type {
  RawEvent,
  RawEventDeadLetter,
  RawEventFailureInput,
  RawEventFailureResult,
  RawEventQueue,
  ReplayRawEventDeadLettersResult,
} from "./raw-event-queue.js";
import {
  MAX_RAW_EVENT_ID_LENGTH,
  MAX_RAW_EVENT_IDEMPOTENCY_KEY_LENGTH,
  MAX_RAW_EVENT_QUEUE_LIMIT,
} from "./raw-event-queue.js";
import { normalizeDeadLetterErrorMessage } from "../queues/dead-letter-error-message.js";

const DEFAULT_MAX_ATTEMPTS = 3;

type DeadLetteredRawEvent = {
  id: string;
  event: RawEvent;
  errorMessage: string;
  failedAt: Date;
};

export type InMemoryRawEventQueueOptions = {
  maxAttempts?: number;
  idGenerator?: () => string;
  now?: () => Date;
};

export class InMemoryRawEventQueue implements RawEventQueue {
  private readonly events: RawEvent[] = [];
  private readonly inFlightEvents = new Map<string, RawEvent>();
  private readonly deadLetters: DeadLetteredRawEvent[] = [];
  private readonly seenKeys = new Set<string>();
  private readonly maxAttempts: number;
  private readonly idGenerator: () => string;
  private readonly now: () => Date;

  constructor(options: InMemoryRawEventQueueOptions = {}) {
    this.maxAttempts = sanitizeMaxAttempts(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
    this.now = options.now ?? (() => new Date());
    this.replayDeadLetter = this.replayDeadLetter.bind(this);
    this.deleteDeadLetter = this.deleteDeadLetter.bind(this);
    this.replayDeadLetters = this.replayDeadLetters.bind(this);
  }

  async enqueue(event: RawEvent): Promise<void> {
    const clonedEvent = cloneEvent(event);
    if (this.seenKeys.has(clonedEvent.idempotencyKey)) {
      return;
    }

    this.seenKeys.add(clonedEvent.idempotencyKey);
    this.events.push(clonedEvent);
  }

  async dequeueBatch(limit: number): Promise<RawEvent[]> {
    const safeLimit = sanitizeLimit(limit);
    const events = this.events.splice(0, safeLimit);
    for (const event of events) {
      this.inFlightEvents.set(event.idempotencyKey, cloneEvent(event));
    }

    return events.map(cloneEvent);
  }

  async handleProcessedEvent(event: RawEvent): Promise<void> {
    const processedEvent = cloneEvent(event);
    this.inFlightEvents.delete(processedEvent.idempotencyKey);
    this.seenKeys.delete(processedEvent.idempotencyKey);
  }

  async handleFailedEvent(input: RawEventFailureInput): Promise<RawEventFailureResult> {
    const attempts = input.event.attempts + 1;
    const failedEvent = cloneEvent({ ...input.event, attempts });
    this.inFlightEvents.delete(failedEvent.idempotencyKey);

    if (attempts >= this.maxAttempts) {
      this.deadLetters.push({
        id: this.idGenerator(),
        event: cloneEvent(failedEvent),
        errorMessage: normalizeDeadLetterErrorMessage(input.errorMessage),
        failedAt: this.now(),
      });
      this.seenKeys.delete(failedEvent.idempotencyKey);
      return { action: "dead_lettered", attempts };
    }

    const existingIndex = this.events.findIndex(
      (event) => event.idempotencyKey === failedEvent.idempotencyKey,
    );
    if (existingIndex === -1) {
      this.seenKeys.add(failedEvent.idempotencyKey);
      this.events.push(cloneEvent(failedEvent));
    } else {
      this.events[existingIndex] = cloneEvent(failedEvent);
    }

    return { action: "requeued", attempts };
  }

  async getPendingCount(): Promise<number> {
    return this.events.length;
  }

  async getDeadLetterCount(): Promise<number> {
    return this.deadLetters.length;
  }

  async listDeadLetters(input: { limit: number }): Promise<RawEventDeadLetter[]> {
    const safeLimit = sanitizeLimit(input.limit);
    return this.deadLetters.slice(0, safeLimit).map(cloneDeadLetter);
  }

  async replayDeadLetter(
    id: string,
  ): Promise<"replayed" | "not_found" | "unsupported_legacy_item"> {
    const index = this.deadLetters.findIndex((deadLetter) => deadLetter.id === id);
    if (index === -1) {
      return id.startsWith("legacy:") ? "unsupported_legacy_item" : "not_found";
    }

    const [deadLetter] = this.deadLetters.splice(index, 1);
    const replayedEvent = cloneEvent({ ...deadLetter.event, attempts: 0 });
    const existingIndex = this.events.findIndex(
      (event) => event.idempotencyKey === replayedEvent.idempotencyKey,
    );
    this.seenKeys.add(replayedEvent.idempotencyKey);
    if (existingIndex === -1) {
      this.events.push(replayedEvent);
    } else {
      this.events[existingIndex] = replayedEvent;
    }
    return "replayed";
  }

  async deleteDeadLetter(
    id: string,
  ): Promise<"deleted" | "not_found" | "unsupported_legacy_item"> {
    const index = this.deadLetters.findIndex((deadLetter) => deadLetter.id === id);
    if (index === -1) {
      return id.startsWith("legacy:") ? "unsupported_legacy_item" : "not_found";
    }

    this.deadLetters.splice(index, 1);
    return "deleted";
  }

  async replayDeadLetters(
    input: { ids: string[] },
  ): Promise<ReplayRawEventDeadLettersResult> {
    const result: ReplayRawEventDeadLettersResult = {
      replayedCount: 0,
      notFoundIds: [],
      unsupportedLegacyIds: [],
    };

    for (const id of new Set(input.ids)) {
      const replayResult = await this.replayDeadLetter(id);
      if (replayResult === "replayed") {
        result.replayedCount += 1;
      } else if (replayResult === "not_found") {
        result.notFoundIds.push(id);
      } else {
        result.unsupportedLegacyIds.push(id);
      }
    }

    return result;
  }
}

function sanitizeMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxAttempts must be a positive integer");
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error("maxAttempts must be a positive safe integer");
  }

  return value;
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error("raw event queue limit must be a finite safe-magnitude number");
  }

  return Math.min(MAX_RAW_EVENT_QUEUE_LIMIT, Math.max(0, Math.floor(value)));
}

function cloneEvent(event: RawEvent): RawEvent {
  const idempotencyKey = event.idempotencyKey.trim();
  const eventType = event.eventType.trim();
  assertValidEvent({ ...event, idempotencyKey, eventType });
  return {
    ...event,
    idempotencyKey,
    eventType,
    rawBody: structuredClone(event.rawBody),
    receivedAt: new Date(event.receivedAt),
  };
}

function assertValidEvent(event: RawEvent): void {
  if (
    event.idempotencyKey.trim().length === 0 ||
    event.idempotencyKey.trim().length > MAX_RAW_EVENT_IDEMPOTENCY_KEY_LENGTH ||
    event.provider !== "feishu" ||
    event.eventType.trim().length === 0 ||
    event.eventType.trim().length > MAX_RAW_EVENT_ID_LENGTH ||
    typeof event.rawBody !== "object" ||
    event.rawBody === null ||
    Number.isNaN(event.receivedAt.getTime()) ||
    !Number.isInteger(event.attempts) ||
    !Number.isSafeInteger(event.attempts) ||
    event.attempts < 0
  ) {
    throw new Error("Invalid raw event payload");
  }
}

function cloneDeadLetter(deadLetter: DeadLetteredRawEvent): RawEventDeadLetter {
  return {
    id: deadLetter.id,
    event: cloneEvent(deadLetter.event),
    errorMessage: deadLetter.errorMessage,
    failedAt: new Date(deadLetter.failedAt),
    replayable: true,
  };
}

function defaultIdGenerator(): string {
  return `dlq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
