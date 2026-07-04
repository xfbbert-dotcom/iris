import { describe, expect, it, vi } from "vitest";

import {
  createManualDocumentSyncPlanner,
  type ManualDocumentSyncPlannerRegistry,
} from "../src/documents/manual-document-sync-planner.js";
import type { DocumentSyncJob } from "../src/documents/document-sync-queue.js";
import type { DocumentSource } from "../src/documents/document-source-registry.js";

describe("ManualDocumentSyncPlanner", () => {
  it("enqueues pending sources with manual idempotency keys", async () => {
    const queue = { enqueue: vi.fn(async () => undefined) };
    const registry = registryWith(source({ id: "source-1" }));
    const planner = createManualDocumentSyncPlanner({
      registry,
      queue,
      now: () => new Date("2026-07-03T03:00:00.000Z"),
      requestId: () => "request-1",
    });

    await expect(planner.enqueueSource({ documentSourceId: "source-1" })).resolves.toEqual({
      status: "enqueued",
      documentSourceId: "source-1",
    });
    expect(queue.enqueue).toHaveBeenCalledWith({
      idempotencyKey: "manual-source-sync:source-1:request-1",
      documentSourceId: "source-1",
      reason: "manual_source_sync",
      enqueuedAt: new Date("2026-07-03T03:00:00.000Z"),
      attempts: 0,
    } satisfies DocumentSyncJob);
    expect(registry.markSyncState).not.toHaveBeenCalled();
  });

  it("resets synced sources to pending before enqueueing", async () => {
    const queue = { enqueue: vi.fn(async () => undefined) };
    const registry = registryWith(source({ id: "source-1", syncState: "synced" }));
    const planner = createManualDocumentSyncPlanner({
      registry,
      queue,
      now: () => new Date("2026-07-03T03:00:00.000Z"),
      requestId: () => "request-1",
    });

    await expect(planner.enqueueSource({ documentSourceId: "source-1" })).resolves.toEqual({
      status: "enqueued",
      documentSourceId: "source-1",
    });
    expect(registry.markSyncState).toHaveBeenCalledWith("source-1", "pending");
    expect(queue.enqueue).toHaveBeenCalledOnce();
  });

  it("resets failed sources to pending before enqueueing", async () => {
    const queue = { enqueue: vi.fn(async () => undefined) };
    const registry = registryWith(source({ id: "source-1", syncState: "failed" }));
    const planner = createManualDocumentSyncPlanner({
      registry,
      queue,
      now: () => new Date("2026-07-03T03:00:00.000Z"),
      requestId: () => "request-1",
    });

    await expect(planner.enqueueSource({ documentSourceId: "source-1" })).resolves.toEqual({
      status: "enqueued",
      documentSourceId: "source-1",
    });
    expect(registry.markSyncState).toHaveBeenCalledWith("source-1", "pending");
    expect(queue.enqueue).toHaveBeenCalledOnce();
  });

  it("normalizes source ids before lookup and enqueueing", async () => {
    const queue = { enqueue: vi.fn(async () => undefined) };
    const registry = registryWith(source({ id: "source-1" }));
    const planner = createManualDocumentSyncPlanner({
      registry,
      queue,
      now: () => new Date("2026-07-03T03:00:00.000Z"),
      requestId: () => "request-1",
    });

    await expect(planner.enqueueSource({ documentSourceId: " source-1 " })).resolves.toEqual({
      status: "enqueued",
      documentSourceId: "source-1",
    });
    expect(registry.findSourceById).toHaveBeenCalledWith("source-1");
    expect(queue.enqueue).toHaveBeenCalledWith({
      idempotencyKey: "manual-source-sync:source-1:request-1",
      documentSourceId: "source-1",
      reason: "manual_source_sync",
      enqueuedAt: new Date("2026-07-03T03:00:00.000Z"),
      attempts: 0,
    } satisfies DocumentSyncJob);
  });

  it("rejects blank and oversized source ids before registry lookup", async () => {
    const queue = { enqueue: vi.fn(async () => undefined) };
    const registry = registryWith(source({ id: "source-1" }));
    const planner = createManualDocumentSyncPlanner({ registry, queue });

    await expect(planner.enqueueSource({ documentSourceId: "   " })).rejects.toThrow(
      "documentSourceId must be nonblank",
    );
    await expect(
      planner.enqueueSource({ documentSourceId: "s".repeat(513) }),
    ).rejects.toThrow("documentSourceId must be at most 512 characters");
    expect(registry.findSourceById).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("returns not_found for unknown sources", async () => {
    const queue = { enqueue: vi.fn(async () => undefined) };
    const registry = registryWith(undefined);
    const planner = createManualDocumentSyncPlanner({ registry, queue });

    await expect(planner.enqueueSource({ documentSourceId: "missing" })).resolves.toEqual({
      status: "not_found",
      documentSourceId: "missing",
    });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("rejects denied or disabled sources", async () => {
    const queue = { enqueue: vi.fn(async () => undefined) };
    const deniedRegistry = registryWith(source({ id: "denied", permissionState: "denied" }));
    const disabledRegistry = registryWith(
      source({
        id: "disabled",
        canUseForAnswering: false,
        canUseForKnowledgeDrafts: false,
      }),
    );

    await expect(
      createManualDocumentSyncPlanner({ registry: deniedRegistry, queue }).enqueueSource({
        documentSourceId: "denied",
      }),
    ).resolves.toEqual({
      status: "rejected",
      documentSourceId: "denied",
      reason: "permission_denied",
    });
    await expect(
      createManualDocumentSyncPlanner({ registry: disabledRegistry, queue }).enqueueSource({
        documentSourceId: "disabled",
      }),
    ).resolves.toEqual({
      status: "rejected",
      documentSourceId: "disabled",
      reason: "capability_disabled",
    });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("skips sources that are already syncing", async () => {
    const queue = { enqueue: vi.fn(async () => undefined) };
    const registry = registryWith(source({ id: "source-1", syncState: "syncing" }));
    const planner = createManualDocumentSyncPlanner({ registry, queue });

    await expect(planner.enqueueSource({ documentSourceId: "source-1" })).resolves.toEqual({
      status: "skipped",
      documentSourceId: "source-1",
      reason: "already_syncing",
    });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});

function registryWith(source: DocumentSource | undefined): ManualDocumentSyncPlannerRegistry {
  return {
    findSourceById: vi.fn(async () => source),
    markSyncState: vi.fn(async () => {
      if (source === undefined) {
        throw new Error("missing source");
      }
      return { ...source, syncState: "pending" as const };
    }),
  };
}

function source(overrides: Partial<DocumentSource> = {}): DocumentSource {
  const createdAt = new Date("2026-07-03T01:00:00.000Z");

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
