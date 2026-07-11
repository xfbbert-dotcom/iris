import type { RawFeishuEvent } from "../feishu/feishu-types.js";

export interface EventQueue {
  enqueueRawFeishuEvent(event: RawFeishuEvent): Promise<void>;
}
