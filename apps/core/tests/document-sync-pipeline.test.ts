import { describe, expect, it } from "vitest";

import { createDocumentSyncPlanner } from "../src/documents/document-sync-pipeline.js";
import type { DocumentSource } from "../src/documents/document-source-registry.js";

function source(overrides: Partial<DocumentSource> = {}): DocumentSource {
  const createdAt = new Date("2026-07-02T04:00:00.000Z");

  return {
    id: "doc-source-1",
    sourceType: "group_visible_document",
    sourceUri: "https://example.com/docs/doc-1",
    title: "Launch Notes",
    originGroupId: "group-1",
    originMessageId: "message-1",
    submittedByUserId: undefined,
    authorizedSpaceId: undefined,
    permissionState: "unknown",
    syncState: "pending",
    canUseForAnswering: true,
    canUseForKnowledgeDrafts: true,
    createdAt,
    updatedAt: createdAt,
    evidence: [
      {
        kind: "group_message",
        sourceUri: "https://example.com/docs/doc-1",
        groupId: "group-1",
        messageId: "message-1",
        userId: undefined,
        spaceId: undefined,
        observedAt: new Date("2026-07-02T04:01:00.000Z"),
      },
    ],
    ...overrides,
  };
}

describe("createDocumentSyncPlanner", () => {
  it("selects pending eligible sources", async () => {
    const pendingEligible = source({ id: "pending-eligible" });
    const alreadySyncing = source({ id: "syncing", syncState: "syncing" });
    const alreadySynced = source({ id: "synced", syncState: "synced" });
    const failed = source({ id: "failed", syncState: "failed" });
    const planner = createDocumentSyncPlanner({
      registry: {
        listSources: async () => [
          pendingEligible,
          alreadySyncing,
          alreadySynced,
          failed,
        ],
      },
    });

    await expect(planner.listSyncCandidates()).resolves.toEqual([pendingEligible]);
  });

  it("excludes sources with denied permission", async () => {
    const denied = source({ id: "denied", permissionState: "denied" });
    const readable = source({ id: "readable", permissionState: "readable" });
    const planner = createDocumentSyncPlanner({
      registry: {
        listSources: async () => [denied, readable],
      },
    });

    await expect(planner.listSyncCandidates()).resolves.toEqual([readable]);
  });

  it("excludes sources disabled for answering and knowledge drafts", async () => {
    const disabled = source({
      id: "disabled",
      canUseForAnswering: false,
      canUseForKnowledgeDrafts: false,
    });
    const draftsOnly = source({
      id: "drafts-only",
      canUseForAnswering: false,
      canUseForKnowledgeDrafts: true,
    });
    const answeringOnly = source({
      id: "answering-only",
      canUseForAnswering: true,
      canUseForKnowledgeDrafts: false,
    });
    const planner = createDocumentSyncPlanner({
      registry: {
        listSources: async () => [disabled, draftsOnly, answeringOnly],
      },
    });

    await expect(planner.listSyncCandidates()).resolves.toEqual([
      draftsOnly,
      answeringOnly,
    ]);
  });
});
