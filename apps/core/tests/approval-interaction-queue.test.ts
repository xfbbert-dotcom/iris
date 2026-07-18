import { describe, expect, it } from "vitest";

import type {
  ApprovalInteractionDeadLetter,
  ApprovalInteractionQueue,
} from "../src/knowledge-cards/approval-interaction-queue.js";
import type { ApprovalInteractionJob } from "../src/knowledge-cards/knowledge-card.js";

describe("ApprovalInteractionQueue contract", () => {
  it("publishes the exact worker and operator surface", async () => {
    const queue = {
      enqueue: async () => "enqueued" as const,
      claimBatch: async () => [] as ApprovalInteractionJob[],
      acknowledge: async () => undefined,
      handleFailure: async () => ({ action: "delayed" as const }),
      getCounts: async () => ({ pending: 0, processing: 0, delayed: 0, deadLetter: 0 }),
      listDeadLetters: async () => [] as ApprovalInteractionDeadLetter[],
      replayDeadLetter: async () => "not_found" as const,
      deleteDeadLetter: async () => "not_found" as const,
    } satisfies ApprovalInteractionQueue;

    await expect(queue.getCounts()).resolves.toEqual({
      pending: 0,
      processing: 0,
      delayed: 0,
      deadLetter: 0,
    });
  });
});
