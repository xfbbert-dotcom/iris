import { describe, expect, it } from "vitest";

import {
  createMemoryExtractionJob,
  type MemoryExtractionJob,
} from "../src/memory-extraction/memory-extraction-queue.js";

describe("createMemoryExtractionJob", () => {
  it("creates the exact version 1 bounded identifier payload", () => {
    const now = new Date("2026-07-14T00:00:00.000Z");

    expect(
      createMemoryExtractionJob({
        requestId: "request-1",
        groupId: "chat-a",
        now,
      }),
    ).toEqual<MemoryExtractionJob>({
      schemaVersion: 1,
      idempotencyKey: "memory-extraction:request-1",
      requestId: "request-1",
      groupId: "chat-a",
      enqueuedAt: now,
      notBefore: now,
      attempts: 0,
    });
  });

  it("normalizes surrounding identifier whitespace", () => {
    expect(
      createMemoryExtractionJob({
        requestId: " request-1 ",
        groupId: " chat-a ",
        now: new Date("2026-07-14T00:00:00.000Z"),
      }),
    ).toMatchObject({
      idempotencyKey: "memory-extraction:request-1",
      requestId: "request-1",
      groupId: "chat-a",
    });
  });

  it("rejects blank and oversized identifiers", () => {
    const now = new Date("2026-07-14T00:00:00.000Z");

    expect(() => createMemoryExtractionJob({ requestId: " ", groupId: "chat-a", now })).toThrow(
      "requestId must be nonblank",
    );
    expect(() =>
      createMemoryExtractionJob({ requestId: "request-1", groupId: "g".repeat(513), now }),
    ).toThrow("groupId must be at most 512 characters");
  });

  it("caps request ids so the derived idempotency key is at most 512 characters", () => {
    const now = new Date("2026-07-14T00:00:00.000Z");
    const boundaryJob = createMemoryExtractionJob({
      requestId: "r".repeat(494),
      groupId: "chat-a",
      now,
    });

    expect(boundaryJob.idempotencyKey).toHaveLength(512);
    expect(() =>
      createMemoryExtractionJob({ requestId: "r".repeat(495), groupId: "chat-a", now }),
    ).toThrow("requestId must be at most 494 characters");
  });

  it("rejects invalid enqueue dates", () => {
    expect(() =>
      createMemoryExtractionJob({
        requestId: "request-1",
        groupId: "chat-a",
        now: new Date(Number.NaN),
      }),
    ).toThrow("now must be a valid date");
  });
});
