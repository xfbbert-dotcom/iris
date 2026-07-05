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
    const queue = queueFixture([job()]);
    const worker = createDocumentReindexWorker({
      queue,
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
    expect(queue.handleProcessedJob).toHaveBeenCalledWith(job());
  });

  it("rejects non-finite batch limits before dequeuing jobs", async () => {
    const queue = queueFixture([]);
    const worker = createDocumentReindexWorker({
      queue,
      snapshots: { findSnapshotById: vi.fn() },
      fragments: { hasFragmentsForSnapshotProfile: vi.fn() },
      indexer: { indexSnapshot: vi.fn() },
    });

    await expect(worker.processBatch({ limit: Number.POSITIVE_INFINITY })).rejects.toThrow(
      "document reindex worker batch limit must be a finite safe-magnitude number",
    );
    await expect(worker.processBatch({ limit: Number.NaN })).rejects.toThrow(
      "document reindex worker batch limit must be a finite safe-magnitude number",
    );

    expect(queue.dequeueBatch).not.toHaveBeenCalled();
  });

  it("rejects unsafe batch limits before dequeuing jobs", async () => {
    const queue = queueFixture([]);
    const worker = createDocumentReindexWorker({
      queue,
      snapshots: { findSnapshotById: vi.fn() },
      fragments: { hasFragmentsForSnapshotProfile: vi.fn() },
      indexer: { indexSnapshot: vi.fn() },
    });

    await expect(worker.processBatch({ limit: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow(
      "document reindex worker batch limit must be a finite safe-magnitude number",
    );
    expect(queue.dequeueBatch).not.toHaveBeenCalled();
  });

  it("caps oversized batch limits before dequeuing jobs", async () => {
    const queue = queueFixture([]);
    const worker = createDocumentReindexWorker({
      queue,
      snapshots: { findSnapshotById: vi.fn() },
      fragments: { hasFragmentsForSnapshotProfile: vi.fn() },
      indexer: { indexSnapshot: vi.fn() },
    });

    await expect(worker.processBatch({ limit: 101 })).resolves.toEqual([]);

    expect(queue.dequeueBatch).toHaveBeenCalledWith(100);
  });

  it("skips missing snapshots", async () => {
    const queue = queueFixture([job()]);
    const worker = createDocumentReindexWorker({
      queue,
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
    expect(queue.handleProcessedJob).toHaveBeenCalledWith(job());
  });

  it("skips failed snapshots", async () => {
    const worker = createDocumentReindexWorker({
      queue: queueFixture([job()]),
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
      queue: queueFixture([job()]),
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

  it("requeues failed processing jobs below the retry limit", async () => {
    const queuedJob = job();
    const queue = queueFixture([queuedJob], { action: "requeued", attempts: 1 });
    const worker = createDocumentReindexWorker({
      queue,
      snapshots: { findSnapshotById: vi.fn(async () => snapshot()) },
      fragments: { hasFragmentsForSnapshotProfile: vi.fn(async () => false) },
      indexer: { indexSnapshot: vi.fn(async () => Promise.reject(new Error("embedding failed"))) },
    });

    await expect(worker.processBatch({ limit: 10 })).resolves.toEqual([
      {
        status: "failed",
        documentSnapshotId: "snapshot-1",
        embeddingProfileId: "profile-1536",
        reason: "processing_error",
        errorMessage: "embedding failed",
        retryAction: "requeued",
        attempts: 1,
      },
    ]);
    expect(queue.handleFailedJob).toHaveBeenCalledWith({
      job: queuedJob,
      errorMessage: "embedding failed",
    });
  });

  it("dead-letters failed processing jobs at the retry limit", async () => {
    const queuedJob = job({ attempts: 2 });
    const queue = queueFixture([queuedJob], { action: "dead_lettered", attempts: 3 });
    const worker = createDocumentReindexWorker({
      queue,
      snapshots: { findSnapshotById: vi.fn(async () => snapshot()) },
      fragments: { hasFragmentsForSnapshotProfile: vi.fn(async () => false) },
      indexer: { indexSnapshot: vi.fn(async () => Promise.reject(new Error("embedding failed"))) },
    });

    await expect(worker.processBatch({ limit: 10 })).resolves.toEqual([
      {
        status: "failed",
        documentSnapshotId: "snapshot-1",
        embeddingProfileId: "profile-1536",
        reason: "processing_error",
        errorMessage: "embedding failed",
        retryAction: "dead_lettered",
        attempts: 3,
      },
    ]);
  });

  it("continues processing later jobs when one job fails", async () => {
    const firstJob = job({ documentSnapshotId: "snapshot-1" });
    const secondJob = job({
      idempotencyKey: "reindex:profile-1536:snapshot-2",
      documentSnapshotId: "snapshot-2",
    });
    const indexer = {
      indexSnapshot: vi
        .fn()
        .mockRejectedValueOnce(new Error("embedding failed"))
        .mockResolvedValueOnce({
          status: "indexed" as const,
          snapshotId: "snapshot-2",
          fragmentCount: 1,
        }),
    };
    const worker = createDocumentReindexWorker({
      queue: queueFixture([firstJob, secondJob], { action: "requeued", attempts: 1 }),
      snapshots: {
        findSnapshotById: vi.fn(async (id: string) => snapshot({ id })),
      },
      fragments: { hasFragmentsForSnapshotProfile: vi.fn(async () => false) },
      indexer,
    });

    await expect(worker.processBatch({ limit: 10 })).resolves.toEqual([
      {
        status: "failed",
        documentSnapshotId: "snapshot-1",
        embeddingProfileId: "profile-1536",
        reason: "processing_error",
        errorMessage: "embedding failed",
        retryAction: "requeued",
        attempts: 1,
      },
      {
        status: "indexed",
        documentSnapshotId: "snapshot-2",
        embeddingProfileId: "profile-1536",
        fragmentCount: 1,
      },
    ]);
    expect(indexer.indexSnapshot).toHaveBeenCalledTimes(2);
  });

  it("retries transient failure handling errors before continuing the batch", async () => {
    const firstJob = job({ documentSnapshotId: "snapshot-1" });
    const secondJob = job({
      idempotencyKey: "reindex:profile-1536:snapshot-2",
      documentSnapshotId: "snapshot-2",
    });
    const queue = queueFixture([firstJob, secondJob], { action: "requeued", attempts: 1 });
    queue.handleFailedJob
      .mockRejectedValueOnce(new Error("redis unavailable"))
      .mockResolvedValueOnce({ action: "requeued" as const, attempts: 1 });
    const indexer = {
      indexSnapshot: vi
        .fn()
        .mockRejectedValueOnce(new Error("embedding failed"))
        .mockResolvedValueOnce({
          status: "indexed" as const,
          snapshotId: "snapshot-2",
          fragmentCount: 1,
        }),
    };
    const worker = createDocumentReindexWorker({
      queue,
      snapshots: {
        findSnapshotById: vi.fn(async (id: string) => snapshot({ id })),
      },
      fragments: { hasFragmentsForSnapshotProfile: vi.fn(async () => false) },
      indexer,
    });

    await expect(worker.processBatch({ limit: 10 })).resolves.toEqual([
      {
        status: "failed",
        documentSnapshotId: "snapshot-1",
        embeddingProfileId: "profile-1536",
        reason: "processing_error",
        errorMessage: "embedding failed",
        retryAction: "requeued",
        attempts: 1,
      },
      {
        status: "indexed",
        documentSnapshotId: "snapshot-2",
        embeddingProfileId: "profile-1536",
        fragmentCount: 1,
      },
    ]);
    expect(queue.handleFailedJob).toHaveBeenCalledTimes(2);
  });

  it("bounds failed processing error messages before returning and requeueing", async () => {
    const queuedJob = job({ documentSnapshotId: "snapshot-oversized-error" });
    const oversizedMessage = `${"E".repeat(1200)} trailing diagnostic detail`;
    const queue = queueFixture([queuedJob], { action: "requeued", attempts: 1 });
    const worker = createDocumentReindexWorker({
      queue,
      snapshots: { findSnapshotById: vi.fn(async () => snapshot()) },
      fragments: { hasFragmentsForSnapshotProfile: vi.fn(async () => false) },
      indexer: {
        indexSnapshot: vi.fn(async () => {
          throw new Error(oversizedMessage);
        }),
      },
    });

    const [result] = await worker.processBatch({ limit: 10 });

    expect(result?.status).toBe("failed");
    if (result?.status !== "failed") {
      throw new Error("expected failed worker result");
    }
    expect(result.errorMessage.length).toBeLessThanOrEqual(1000);
    expect(result.errorMessage).toContain("[truncated]");
    expect(result.errorMessage).not.toContain("trailing diagnostic detail");
    expect(queue.handleFailedJob).toHaveBeenCalledWith({
      job: queuedJob,
      errorMessage: result.errorMessage,
    });
  });
});

function queueFixture(
  jobs: DocumentReindexJob[],
  failedResult: { action: "requeued" | "dead_lettered"; attempts: number } = {
    action: "requeued",
    attempts: 1,
  },
) {
  return {
    dequeueBatch: vi.fn(async () => jobs),
    handleProcessedJob: vi.fn(async () => undefined),
    handleFailedJob: vi.fn(async () => failedResult),
  };
}

function job(overrides: Partial<DocumentReindexJob> = {}): DocumentReindexJob {
  return {
    idempotencyKey: "reindex:profile-1536:snapshot-1",
    embeddingProfileId: "profile-1536",
    documentSnapshotId: "snapshot-1",
    reason: "manual_profile_reindex",
    enqueuedAt: new Date("2026-07-02T01:00:00.000Z"),
    attempts: 0,
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
