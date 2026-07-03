import type { RawFeishuEvent } from "../feishu/feishu-types.js";
import type { EventQueue } from "./event-queue.js";

export class InMemoryEventQueue implements EventQueue {
  private readonly storedEvents: RawFeishuEvent[] = [];
  private readonly seenKeys = new Set<string>();

  get events(): RawFeishuEvent[] {
    return this.storedEvents.map(cloneEvent);
  }

  async enqueueRawFeishuEvent(event: RawFeishuEvent): Promise<void> {
    if (this.seenKeys.has(event.idempotencyKey)) {
      return;
    }

    this.seenKeys.add(event.idempotencyKey);
    this.storedEvents.push(cloneEvent(event));
  }
}

function cloneEvent(event: RawFeishuEvent): RawFeishuEvent {
  return {
    ...event,
    receivedAt: new Date(event.receivedAt),
    body: structuredClone(event.body),
  };
}
