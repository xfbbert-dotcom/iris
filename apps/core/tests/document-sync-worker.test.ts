import { describe, expect, it, vi } from "vitest";

import {
  createDocumentSyncWorker,
  type DocumentSyncWorkerResult,
} from "../src/documents/document-sync-worker.js";
import {
  createDocumentSyncIdempotencyKey,
  type DocumentSyncJob,
} from "../src/documents/document-sync-queue.js";
import type { DocumentSnapshot } from "../src/documents/document-snapshot-repository.js";
import type { DocumentSource } from "../src/documents/document-source-registry.js";

describe("DocumentSyncWorker", () => {
  it("processes document sync jobs through the runner", async () => {
    const job = jobFixture({ documentSourceId: "source-1" });
    const queue = {
      dequeueBatch: vi.fn(async () => [job]),
      handleFailedJob: vi.fn(),
    };
    const runner = {
      syncSourceById: vi.fn(async () => ({
        status: "synced" as const,
        source: sourceFixture({ id: "source-1" }),
        snapshot: snapshotFixture({ documentSourceId: "source-1" }),
      })),
    };
    const worker = createDocumentSyncWorker({ queue, runner });

    await expect(worker.processBatch({ limit: 10.9 })).resolves.toEqual([
      {
        status: "processed",
        idempotencyKey: job.idempotencyKey,
        documentSourceId: "source-1",
        syncStatus: "synced",
      },
    ] satisfies DocumentSyncWorkerResult[]);
    expect(queue.dequeueBatch).toHaveBeenCalledWith(10);
    expect(runner.syncSourceById).toHaveBeenCalledWith("source-1");
  });

  it("treats runner-handled failed syncs as processed jobs", async () => {
    const job = jobFixture({ documentSourceId: "source-failed" });
    const worker = createDocumentSyncWorker({
      queue: {
        dequeueBatch: vi.fn(async () => [job]),
        handleFailedJob: vi.fn(),
      },
      runner: {
        syncSourceById: vi.fn(async () => ({
          status: "failed" as const,
          source: sourceFixture({ id: "source-failed" }),
          snapshot: snapshotFixture({ documentSourceId: "source-failed" }),
          errorMessage: "fetch failed",
        })),
      },
    });

    await expect(worker.processBatch({ limit: 1 })).resolves.toEqual([
      {
        status: "processed",
        idempotencyKey: job.idempotencyKey,
        documentSourceId: "source-failed",
        syncStatus: "failed",
      },
    ]);
  });

  it("records thrown runner errors and continues processing", async () => {
    const first = jobFixture({ documentSourceId: "source-1" });
    const second = jobFixture({ documentSourceId: "source-2" });
    const queue = {
      dequeueBatch: vi.fn(async () => [first, second]),
      handleFailedJob: vi.fn(async () => ({ action: "requeued" as const, attempts: 1 })),
    };
    const worker = createDocumentSyncWorker({
      queue,
      runner: {
        syncSourceById: vi
          .fn()
          .mockRejectedValueOnce(new Error("runner crashed"))
          .mockResolvedValueOnce({
            status: "skipped",
            source: sourceFixture({ id: "source-2" }),
            reason: "already_synced",
          }),
      },
    });

    await expect(worker.processBatch({ limit: 5 })).resolves.toEqual([
      {
        status: "failed",
        idempotencyKey: first.idempotencyKey,
        documentSourceId: "source-1",
        errorMessage: "runner crashed",
        retryAction: "requeued",
        attempts: 1,
      },
      {
        status: "processed",
        idempotencyKey: second.idempotencyKey,
        documentSourceId: "source-2",
        syncStatus: "skipped",
      },
    ]);
    expect(queue.handleFailedJob).toHaveBeenCalledWith({
      job: first,
      errorMessage: "runner crashed",
    });
  });

  it("records dead-lettered runner errors", async () => {
    const syncJob = jobFixture({ documentSourceId: "source-dead-letter" });
    const worker = createDocumentSyncWorker({
      queue: {
        dequeueBatch: vi.fn(async () => [syncJob]),
        handleFailedJob: vi.fn(async () => ({ action: "dead_lettered" as const, attempts: 3 })),
      },
      runner: {
        syncSourceById: vi.fn(async () => {
          throw new Error("runner crashed");
        }),
      },
    });

    await expect(worker.processBatch({ limit: 1 })).resolves.toEqual([
      {
        status: "failed",
        idempotencyKey: syncJob.idempotencyKey,
        documentSourceId: "source-dead-letter",
        errorMessage: "runner crashed",
        retryAction: "dead_lettered",
        attempts: 3,
      },
    ]);
  });

  it("bounds thrown runner errors before returning and requeueing", async () => {
    const syncJob = jobFixture({ documentSourceId: "source-oversized-error" });
    const oversizedMessage = `${"E".repeat(1200)} trailing diagnostic detail`;
    const queue = {
      dequeueBatch: vi.fn(async () => [syncJob]),
      handleFailedJob: vi.fn(async () => ({ action: "requeued" as const, attempts: 1 })),
    };
    const worker = createDocumentSyncWorker({
      queue,
      runner: {
        syncSourceById: vi.fn(async () => {
          throw new Error(oversizedMessage);
        }),
      },
    });

    const [result] = await worker.processBatch({ limit: 1 });

    expect(result?.status).toBe("failed");
    if (result?.status !== "failed") {
      throw new Error("expected failed worker result");
    }
    expect(result.errorMessage.length).toBeLessThanOrEqual(1000);
    expect(result.errorMessage).toContain("[truncated]");
    expect(result.errorMessage).not.toContain("trailing diagnostic detail");
    expect(queue.handleFailedJob).toHaveBeenCalledWith({
      job: syncJob,
      errorMessage: result.errorMessage,
    });
  });

  it("rejects unsafe batch limits before dequeuing jobs", async () => {
    const queue = {
      dequeueBatch: vi.fn(async () => []),
      handleFailedJob: vi.fn(),
    };
    const worker = createDocumentSyncWorker({
      queue,
      runner: { syncSourceById: vi.fn() },
    });

    await expect(worker.processBatch({ limit: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow(
      "document sync worker batch limit must be a finite safe-magnitude number",
    );
    expect(queue.dequeueBatch).not.toHaveBeenCalled();
  });
});

function jobFixture(overrides: Partial<DocumentSyncJob> = {}): DocumentSyncJob {
  const documentSourceId = overrides.documentSourceId ?? "source-1";

  return {
    idempotencyKey:
      overrides.idempotencyKey ?? createDocumentSyncIdempotencyKey({ documentSourceId }),
    documentSourceId,
    reason: "discovered_group_document",
    enqueuedAt: new Date("2026-07-03T02:00:00.000Z"),
    attempts: 0,
    ...overrides,
  };
}

function sourceFixture(overrides: Partial<DocumentSource> = {}): DocumentSource {
  const createdAt = new Date("2026-07-03T02:00:00.000Z");

  return {
    id: "source-1",
    sourceType: "group_visible_document",
    sourceUri: "https://docs.feishu.cn/docx/a",
    originGroupId: "chat-1",
    originMessageId: "message-1",
    submittedByUserId: undefined,
    authorizedSpaceId: undefined,
    permissionState: "unknown",
    syncState: "pending",
    canUseForAnswering: true,
    canUseForKnowledgeDrafts: true,
    createdAt,
    updatedAt: createdAt,
    evidence: [],
    ...overrides,
  };
}

function snapshotFixture(overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  const fetchedAt = new Date("2026-07-03T02:01:00.000Z");

  return {
    id: "snapshot-1",
    documentSourceId: "source-1",
    sourceUri: "https://docs.feishu.cn/docx/a",
    fetchStatus: "succeeded",
    bodyText: "Document body",
    contentHash: "hash-1",
    sourceVersion: "version-1",
    fetchedAt,
    createdAt: fetchedAt,
    ...overrides,
  };
}
