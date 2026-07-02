import { randomUUID } from "node:crypto";
import {
  createRawEventIdempotencyKey,
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

export type FeishuGatewayDependencies = {
  queue: EventQueue;
  rawEventQueue?: Pick<RawEventQueue, "enqueue">;
  signalFilter?: SignalFilter;
  verifyRequest?: RequestVerifier;
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

      const idempotencyKey = resolveIdempotencyKey(request);

      await dependencies.rawEventQueue?.enqueue({
        idempotencyKey: createRawEventIdempotencyKey({
          provider: "feishu",
          eventId: resolveRawEventId(request),
        }),
        provider: "feishu",
        eventType: resolveEventType(request.body),
        rawBody: request.body,
        receivedAt: now(),
        attempts: 0,
      });

      await dependencies.queue.enqueueRawFeishuEvent({
        idempotencyKey,
        receivedAt: now(),
        body: request.body
      });

      return {
        statusCode: 200,
        body: { ok: true }
      };
    }
  };
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

function isFeishuUrlVerificationPayload(
  body: unknown
): body is { type: "url_verification"; challenge: string } {
  return isRecord(body) && body.type === "url_verification" && typeof body.challenge === "string";
}

function resolveIdempotencyKey(request: FeishuCallbackRequest): string {
  const headerKey = normalizeIdempotencyKey(request.headers["x-iris-event-id"]);
  if (headerKey) {
    return headerKey;
  }

  if (isRecord(request.body)) {
    const bodyKey = normalizeIdempotencyKey(request.body.event_id);
    if (bodyKey) {
      return bodyKey;
    }
  }

  return randomUUID();
}

function normalizeIdempotencyKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stableJsonHash(value: unknown): string {
  const serialized = JSON.stringify(value) ?? String(value);
  let hash = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    hash = (hash * 31 + serialized.charCodeAt(index)) >>> 0;
  }

  return `body-${hash.toString(16)}`;
}
