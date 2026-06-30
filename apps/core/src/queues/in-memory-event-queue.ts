import type { RawFeishuEvent } from "../feishu/feishu-types.js";
import type { EventQueue } from "./event-queue.js";

export class InMemoryEventQueue implements EventQueue {
  readonly events: RawFeishuEvent[] = [];
  private readonly seenKeys = new Set<string>();

  async enqueueRawFeishuEvent(event: RawFeishuEvent): Promise<void> {
    if (this.seenKeys.has(event.idempotencyKey)) {
      return;
    }

    this.seenKeys.add(event.idempotencyKey);
    this.events.push(event);
  }
}
