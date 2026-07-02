import { describe, expect, it, vi } from "vitest";

import type { DocumentSnapshot } from "../src/documents/document-snapshot-repository.js";
import type { DocumentReindexJob } from "../src/reindex/document-reindex-queue.js";
import { createDocumentReindexWorker } from "../src/reindex/document-reindex-worker.js";

describe("DocumentReindexWorker", () => {
  it("indexes missing successful snapshot profile jobs", async () => {
    const indexer = {
      indexSnapshot: vi.fn(async () => ({
        status: "indexed" as const,
        snapshotId: "snapshot-1",
        fragmentCount: 3,
      })),
    };
    const worker = createDocumentReindexWorker({
      queue: { dequeueBatch: vi.fn(async () => [job()]) },
      snapshots: { findSnapshotById: vi.fn(async () => snapshot({ id: "snapshot-1" })) },
      fragments: { hasFragmentsForSnapshotProfile: vi.fn(async () => false) },
      indexer,
    });

    await expect(worker.processBatch({ limit: 10 })).resolves.toEqual([
      {
        status: "indexed",
        documentSnapshotId: "snapshot-1",
        embeddingProfileId: "profile-1536",
        fragmentCount: 3,
      },
    ]);
    expect(indexer.indexSnapshot).toHaveBeenCalledWith(snapshot({ id: "snapshot-1" }));
  });

  it("skips missing snapshots", async () => {
    const worker = createDocumentReindexWorker({
      queue: { dequeueBatch: vi.fn(async () => [job()]) },
      snapshots: { findSnapshotById: vi.fn(async () => undefined) },
      fragments: { hasFragmentsForSnapshotProfile: vi.fn() },
      indexer: { indexSnapshot: vi.fn() },
    });

    await expect(worker.processBatch({ limit: 10 })).resolves.toEqual([
      {
        status: "skipped",
        documentSnapshotId: "snapshot-1",
        embeddingProfileId: "profile-1536",
        reason: "snapshot_not_found",
      },
    ]);
  });

  it("skips failed snapshots", async () => {
    const worker = createDocumentReindexWorker({
      queue: { dequeueBatch: vi.fn(async () => [job()]) },
      snapshots: {
        findSnapshotById: vi.fn(async () => snapshot({ fetchStatus: "failed", bodyText: undefined })),
      },
      fragments: { hasFragmentsForSnapshotProfile: vi.fn() },
      indexer: { indexSnapshot: vi.fn() },
    });

    await expect(worker.processBatch({ limit: 10 })).resolves.toEqual([
      {
        status: "skipped",
        documentSnapshotId: "snapshot-1",
        embeddingProfileId: "profile-1536",
        reason: "snapshot_not_successful",
      },
    ]);
  });

  it("skips already indexed snapshot profile jobs", async () => {
    const worker = createDocumentReindexWorker({
      queue: { dequeueBatch: vi.fn(async () => [job()]) },
      snapshots: { findSnapshotById: vi.fn(async () => snapshot()) },
      fragments: { hasFragmentsForSnapshotProfile: vi.fn(async () => true) },
      indexer: { indexSnapshot: vi.fn() },
    });

    await expect(worker.processBatch({ limit: 10 })).resolves.toEqual([
      {
        status: "skipped",
        documentSnapshotId: "snapshot-1",
        embeddingProfileId: "profile-1536",
        reason: "already_indexed",
      },
    ]);
  });
});

function job(overrides: Partial<DocumentReindexJob> = {}): DocumentReindexJob {
  return {
    idempotencyKey: "reindex:profile-1536:snapshot-1",
    embeddingProfileId: "profile-1536",
    documentSnapshotId: "snapshot-1",
    reason: "manual_profile_reindex",
    enqueuedAt: new Date("2026-07-02T01:00:00.000Z"),
    ...overrides,
  };
}

function snapshot(overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  return {
    id: "snapshot-1",
    documentSourceId: "source-1",
    sourceUri: "https://example.com/doc",
    fetchStatus: "succeeded",
    bodyText: "Alpha body",
    fetchedAt: new Date("2026-07-02T00:00:00.000Z"),
    createdAt: new Date("2026-07-02T00:00:00.000Z"),
    ...overrides,
  };
}
