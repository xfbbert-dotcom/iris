import { describe, expect, it, vi } from "vitest";

import { createDiscoveredDocumentSyncPlanner } from "../src/documents/discovered-document-sync-planner.js";
import {
  createDocumentSyncIdempotencyKey,
  type DocumentSyncJob,
} from "../src/documents/document-sync-queue.js";
import type { DocumentSource } from "../src/documents/document-source-registry.js";

describe("DiscoveredDocumentSyncPlanner", () => {
  it("enqueues pending eligible document sources", async () => {
    const queue = { enqueue: vi.fn(async () => undefined) };
    const planner = createDiscoveredDocumentSyncPlanner({
      queue,
      now: () => new Date("2026-07-03T01:00:00.000Z"),
    });
    const eligible = source({ id: "source-1" });

    await expect(planner.planRegisteredSources([eligible])).resolves.toEqual({
      enqueuedCount: 1,
      skippedCount: 0,
    });
    expect(queue.enqueue).toHaveBeenCalledWith({
      idempotencyKey: createDocumentSyncIdempotencyKey({ documentSourceId: "source-1" }),
      documentSourceId: "source-1",
      reason: "discovered_group_document",
      enqueuedAt: new Date("2026-07-03T01:00:00.000Z"),
      attempts: 0,
    } satisfies DocumentSyncJob);
  });

  it("skips ineligible document sources", async () => {
    const queue = { enqueue: vi.fn(async () => undefined) };
    const planner = createDiscoveredDocumentSyncPlanner({ queue });

    await expect(
      planner.planRegisteredSources([
        source({ id: "syncing", syncState: "syncing" }),
        source({ id: "synced", syncState: "synced" }),
        source({ id: "denied", permissionState: "denied" }),
        source({
          id: "disabled",
          canUseForAnswering: false,
          canUseForKnowledgeDrafts: false,
        }),
      ]),
    ).resolves.toEqual({ enqueuedCount: 0, skippedCount: 4 });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});

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
