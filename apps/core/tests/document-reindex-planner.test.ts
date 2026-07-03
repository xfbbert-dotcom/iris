import { describe, expect, it, vi } from "vitest";

import type { DocumentSnapshot } from "../src/documents/document-snapshot-repository.js";
import { createDocumentReindexPlanner } from "../src/reindex/document-reindex-planner.js";
import { createDocumentReindexIdempotencyKey } from "../src/reindex/document-reindex-queue.js";

describe("DocumentReindexPlanner", () => {
  it("enqueues missing successful snapshots for a manual profile reindex", async () => {
    const snapshots = [snapshot("snapshot-1"), snapshot("snapshot-2")];
    const queue = { enqueue: vi.fn(async () => undefined) };
    const planner = createDocumentReindexPlanner({
      snapshots: {
        listSuccessfulSnapshotsMissingProfile: vi.fn(async () => snapshots),
      },
      queue,
      now: () => new Date("2026-07-02T01:00:00.000Z"),
    });

    await expect(
      planner.planDocumentProfileReindex({
        embeddingProfileId: "profile-1536",
        limit: 100,
      }),
    ).resolves.toEqual({ enqueuedCount: 2, skippedCount: 0 });
    expect(queue.enqueue).toHaveBeenCalledWith({
      idempotencyKey: createDocumentReindexIdempotencyKey({
        embeddingProfileId: "profile-1536",
        documentSnapshotId: "snapshot-1",
      }),
      embeddingProfileId: "profile-1536",
      documentSnapshotId: "snapshot-1",
      reason: "manual_profile_reindex",
      enqueuedAt: new Date("2026-07-02T01:00:00.000Z"),
      attempts: 0,
    });
  });

  it("sanitizes invalid limits to zero", async () => {
    const snapshots = { listSuccessfulSnapshotsMissingProfile: vi.fn(async () => []) };
    const planner = createDocumentReindexPlanner({
      snapshots,
      queue: { enqueue: vi.fn() },
      now: () => new Date("2026-07-02T01:00:00.000Z"),
    });

    await planner.planDocumentProfileReindex({
      embeddingProfileId: "profile-1536",
      limit: Number.NaN,
    });

    expect(snapshots.listSuccessfulSnapshotsMissingProfile).toHaveBeenCalledWith({
      embeddingProfileId: "profile-1536",
      limit: 0,
    });
  });

  it("sanitizes unsafe integer limits to zero", async () => {
    const snapshots = { listSuccessfulSnapshotsMissingProfile: vi.fn(async () => []) };
    const planner = createDocumentReindexPlanner({
      snapshots,
      queue: { enqueue: vi.fn() },
      now: () => new Date("2026-07-02T01:00:00.000Z"),
    });

    await planner.planDocumentProfileReindex({
      embeddingProfileId: "profile-1536",
      limit: 9007199254740992,
    });

    expect(snapshots.listSuccessfulSnapshotsMissingProfile).toHaveBeenCalledWith({
      embeddingProfileId: "profile-1536",
      limit: 0,
    });
  });

  it("enqueues a document synced job for a specific snapshot", async () => {
    const queue = { enqueue: vi.fn(async () => undefined) };
    const planner = createDocumentReindexPlanner({
      snapshots: { listSuccessfulSnapshotsMissingProfile: vi.fn() },
      queue,
      now: () => new Date("2026-07-02T01:00:00.000Z"),
    });

    await planner.enqueueSyncedSnapshotReindex({
      embeddingProfileId: "profile-1536",
      documentSnapshotId: "snapshot-1",
    });

    expect(queue.enqueue).toHaveBeenCalledWith({
      idempotencyKey: "reindex:profile-1536:snapshot-1",
      embeddingProfileId: "profile-1536",
      documentSnapshotId: "snapshot-1",
      reason: "document_synced",
      enqueuedAt: new Date("2026-07-02T01:00:00.000Z"),
      attempts: 0,
    });
  });
});

function snapshot(id: string): DocumentSnapshot {
  return {
    id,
    documentSourceId: "source-1",
    sourceUri: "https://example.com/doc",
    fetchStatus: "succeeded",
    bodyText: "Alpha body",
    fetchedAt: new Date("2026-07-02T00:00:00.000Z"),
    createdAt: new Date("2026-07-02T00:00:00.000Z"),
  };
}
