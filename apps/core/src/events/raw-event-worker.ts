import type { RawEvent, RawEventQueue } from "./raw-event-queue.js";

export type RawEventWorkerResult =
  | {
      status: "processed";
      idempotencyKey: string;
      eventType: string;
    }
  | {
      status: "failed";
      idempotencyKey: string;
      eventType: string;
      errorMessage: string;
      retryAction: "requeued" | "dead_lettered";
      attempts: number;
    };

export type RawEventWorkerDependencies = {
  queue: Pick<RawEventQueue, "dequeueBatch" | "handleFailedEvent">;
  processor: {
    process(event: RawEvent): Promise<void>;
  };
};

export function createRawEventWorker(dependencies: RawEventWorkerDependencies) {
  return {
    async processBatch({ limit }: { limit: number }): Promise<RawEventWorkerResult[]> {
      const events = await dependencies.queue.dequeueBatch(Math.max(0, Math.floor(limit)));
      const results: RawEventWorkerResult[] = [];

      for (const event of events) {
        try {
          await dependencies.processor.process(event);
          results.push({
            status: "processed",
            idempotencyKey: event.idempotencyKey,
            eventType: event.eventType,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const retryResult = await dependencies.queue.handleFailedEvent({ event, errorMessage });
          results.push({
            status: "failed",
            idempotencyKey: event.idempotencyKey,
            eventType: event.eventType,
            errorMessage,
            retryAction: retryResult.action,
            attempts: retryResult.attempts,
          });
        }
      }

      return results;
    },
  };
}
