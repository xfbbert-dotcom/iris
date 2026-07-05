import { createHash } from "node:crypto";

import {
  createRawEventIdempotencyKey,
  MAX_RAW_EVENT_ID_LENGTH,
  type RawEventQueue,
} from "../events/raw-event-queue.js";
import type { EventQueue } from "../queues/event-queue.js";

export type FeishuCallbackRequest = {
  headers: Record<string, string | undefined>;
  body: unknown;
  rawBody?: string;
};

export type FeishuCallbackResponse =
  | {
      statusCode: 200;
      body: { ok: true };
    }
  | {
      statusCode: 200;
      body: { challenge: string };
    }
  | {
      statusCode: 401;
      body: { ok: false };
    };

type SignalFilter = (event: unknown) => Promise<void>;
type RequestVerifier = (request: FeishuCallbackRequest) => Promise<boolean> | boolean;
type EnqueueErrorHandler = (error: unknown) => void;
type RuntimeGate = {
  canProcessIncomingEvent(input: { groupId?: string }): boolean;
};

export type FeishuGatewayDependencies = {
  queue: EventQueue;
  rawEventQueue?: Pick<RawEventQueue, "enqueue">;
  signalFilter?: SignalFilter;
  verifyRequest?: RequestVerifier;
  onEnqueueError?: EnqueueErrorHandler;
  runtimeController?: RuntimeGate;
  now?: () => Date;
};

export function createFeishuGateway(dependencies: FeishuGatewayDependencies) {
  const now = dependencies.now ?? (() => new Date());

  return {
    async handleCallback(request: FeishuCallbackRequest): Promise<FeishuCallbackResponse> {
      if (dependencies.verifyRequest) {
        try {
          const isVerified = await dependencies.verifyRequest(request);
          if (!isVerified) {
            return {
              statusCode: 401,
              body: { ok: false }
            };
          }
        } catch {
          return {
            statusCode: 401,
            body: { ok: false }
          };
        }
      }

      if (isFeishuUrlVerificationPayload(request.body)) {
        return {
          statusCode: 200,
          body: { challenge: request.body.challenge }
        };
      }

      const receivedAt = now();
      const groupId = resolveGroupId(request.body);
      if (
        dependencies.runtimeController !== undefined &&
        !dependencies.runtimeController.canProcessIncomingEvent({
          ...(groupId === undefined ? {} : { groupId }),
        })
      ) {
        return {
          statusCode: 200,
          body: { ok: true },
        };
      }

      const rawEventQueue = dependencies.rawEventQueue;
      if (rawEventQueue !== undefined) {
        enqueueWithoutWaiting(
          () =>
            rawEventQueue.enqueue({
              idempotencyKey: createRawEventIdempotencyKey({
                provider: "feishu",
                eventId: resolveRawEventId(request),
              }),
              provider: "feishu",
              eventType: resolveEventType(request.body),
              rawBody: request.body,
              receivedAt,
              attempts: 0,
            }),
          dependencies.onEnqueueError,
        );
      } else {
        enqueueWithoutWaiting(
          () =>
            dependencies.queue.enqueueRawFeishuEvent({
              idempotencyKey: resolveIdempotencyKey(request),
              receivedAt,
              body: request.body
            }),
          dependencies.onEnqueueError,
        );
      }

      return {
        statusCode: 200,
        body: { ok: true }
      };
    }
  };
}

function enqueueWithoutWaiting(
  enqueue: () => Promise<void>,
  onError: EnqueueErrorHandler | undefined,
): void {
  try {
    void enqueue().catch((error: unknown) => {
      reportEnqueueError(onError, error);
    });
  } catch (error) {
    reportEnqueueError(onError, error);
  }
}

function reportEnqueueError(
  onError: EnqueueErrorHandler | undefined,
  error: unknown,
): void {
  try {
    onError?.(error);
  } catch {
    // Observability hooks must not break Feishu callback acknowledgement.
  }
}

function resolveRawEventId(request: FeishuCallbackRequest): string {
  const headerKey = normalizeIdempotencyKey(request.headers["x-iris-event-id"]);
  if (headerKey) {
    return headerKey;
  }

  if (isRecord(request.body)) {
    const header = request.body.header;
    if (isRecord(header)) {
      const headerEventId = normalizeIdempotencyKey(header.event_id);
      if (headerEventId) {
        return headerEventId;
      }
    }

    const bodyEventId = normalizeIdempotencyKey(request.body.event_id);
    if (bodyEventId) {
      return bodyEventId;
    }
  }

  return stableJsonHash(request.body);
}

function resolveEventType(body: unknown): string {
  if (!isRecord(body)) {
    return "unknown";
  }

  const header = body.header;
  if (isRecord(header)) {
    const eventType = normalizeIdempotencyKey(header.event_type);
    if (eventType) {
      return eventType;
    }
  }

  const eventType = normalizeIdempotencyKey(body.event_type);
  return eventType ?? "unknown";
}

function resolveGroupId(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  const event = body.event;
  if (isRecord(event)) {
    const message = event.message;
    if (isRecord(message)) {
      const chatId = normalizeIdempotencyKey(message.chat_id);
      if (chatId !== undefined) {
        return chatId;
      }
    }

    const eventChatId = normalizeIdempotencyKey(event.chat_id);
    if (eventChatId !== undefined) {
      return eventChatId;
    }
  }

  const message = body.message;
  if (isRecord(message)) {
    const chatId = normalizeIdempotencyKey(message.chat_id);
    if (chatId !== undefined) {
      return chatId;
    }
  }

  return normalizeIdempotencyKey(body.chat_id);
}

function isFeishuUrlVerificationPayload(
  body: unknown
): body is { type: "url_verification"; challenge: string } {
  return isRecord(body) && body.type === "url_verification" && typeof body.challenge === "string";
}

function resolveIdempotencyKey(request: FeishuCallbackRequest): string {
  return resolveRawEventId(request);
}

function normalizeIdempotencyKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_RAW_EVENT_ID_LENGTH ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stableJsonHash(value: unknown): string {
  const serialized = serializeForStableHash(value);
  return `body-${createHash("sha256").update(serialized).digest("hex")}`;
}

function serializeForStableHash(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
