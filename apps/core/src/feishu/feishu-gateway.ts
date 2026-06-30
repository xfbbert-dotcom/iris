import { randomUUID } from "node:crypto";
import type { EventQueue } from "../queues/event-queue.js";

export type FeishuCallbackRequest = {
  headers: Record<string, string | undefined>;
  body: unknown;
};

export type FeishuCallbackResponse = {
  statusCode: 200;
  body: { ok: true };
};

type SignalFilter = (event: unknown) => Promise<void>;

export type FeishuGatewayDependencies = {
  queue: EventQueue;
  signalFilter?: SignalFilter;
  now?: () => Date;
};

export function createFeishuGateway(dependencies: FeishuGatewayDependencies) {
  const now = dependencies.now ?? (() => new Date());

  return {
    async handleCallback(request: FeishuCallbackRequest): Promise<FeishuCallbackResponse> {
      const idempotencyKey = resolveIdempotencyKey(request);

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

function resolveIdempotencyKey(request: FeishuCallbackRequest): string {
  const headerKey = request.headers["x-iris-event-id"];
  if (headerKey) {
    return headerKey;
  }

  if (isRecord(request.body) && typeof request.body.event_id === "string") {
    return request.body.event_id;
  }

  return randomUUID();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
