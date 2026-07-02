import { describe, expect, it, vi } from "vitest";

import {
  createDocumentSyncPlanner,
  createDocumentSyncRunner,
} from "../src/documents/document-sync-pipeline.js";
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

describe("createDocumentSyncRunner", () => {
  const fetchedAt = new Date("2026-07-02T05:00:00.000Z");
  const failedAt = new Date("2026-07-02T05:01:00.000Z");

  it("syncs a pending source and records a succeeded snapshot", async () => {
    const candidate = source({ id: "source-to-sync" });
    const calls: string[] = [];
    const fetchResult = {
      bodyText: "Document body",
      sourceVersion: "version-1",
      fetchedAt,
    };
    const registry = {
      findSourceById: vi.fn(async (id: string) => {
        calls.push(`find:${id}`);
        return candidate;
      }),
      markSyncState: vi.fn(async (id: string, syncState: string) => {
        calls.push(`mark:${id}:${syncState}`);
        return source({ id, syncState: syncState as DocumentSource["syncState"] });
      }),
    };
    const fetcher = {
      fetch: vi.fn(async (documentSource: DocumentSource) => {
        calls.push(`fetch:${documentSource.id}`);
        return fetchResult;
      }),
    };
    const snapshots = {
      insertSucceededSnapshot: vi.fn(async (input: unknown) => {
        calls.push("snapshot:succeeded");
        return input;
      }),
      insertFailedSnapshot: vi.fn(),
    };
    const runner = createDocumentSyncRunner({
      registry,
      snapshots,
      fetcher,
      now: () => failedAt,
    });

    const result = await runner.syncSource("source-to-sync");

    expect(calls).toEqual([
      "find:source-to-sync",
      "mark:source-to-sync:syncing",
      "fetch:source-to-sync",
      "snapshot:succeeded",
      "mark:source-to-sync:synced",
    ]);
    expect(fetcher.fetch).toHaveBeenCalledWith(candidate);
    expect(snapshots.insertSucceededSnapshot).toHaveBeenCalledWith({
      documentSourceId: "source-to-sync",
      sourceUri: candidate.sourceUri,
      bodyText: "Document body",
      sourceVersion: "version-1",
      fetchedAt,
    });
    expect(snapshots.insertFailedSnapshot).not.toHaveBeenCalled();
    expect(result.status).toBe("synced");
  });

  it("records a failed snapshot and marks failed when fetching throws", async () => {
    const candidate = source({ id: "source-to-fail" });
    const calls: string[] = [];
    const registry = {
      findSourceById: vi.fn(async () => candidate),
      markSyncState: vi.fn(async (id: string, syncState: string) => {
        calls.push(`mark:${id}:${syncState}`);
        return source({ id, syncState: syncState as DocumentSource["syncState"] });
      }),
    };
    const fetcher = {
      fetch: vi.fn(async () => {
        calls.push("fetch");
        throw new Error("network unavailable");
      }),
    };
    const snapshots = {
      insertSucceededSnapshot: vi.fn(),
      insertFailedSnapshot: vi.fn(async (input: unknown) => {
        calls.push("snapshot:failed");
        return input;
      }),
    };
    const runner = createDocumentSyncRunner({
      registry,
      snapshots,
      fetcher,
      now: () => failedAt,
    });

    const result = await runner.syncSource("source-to-fail");

    expect(calls).toEqual([
      "mark:source-to-fail:syncing",
      "fetch",
      "snapshot:failed",
      "mark:source-to-fail:failed",
    ]);
    expect(snapshots.insertSucceededSnapshot).not.toHaveBeenCalled();
    expect(snapshots.insertFailedSnapshot).toHaveBeenCalledWith({
      documentSourceId: "source-to-fail",
      sourceUri: candidate.sourceUri,
      errorMessage: "network unavailable",
      fetchedAt: failedAt,
    });
    expect(result.status).toBe("failed");
  });

  it("stringifies non-Error fetch failures before recording them", async () => {
    const candidate = source({ id: "source-to-string-fail" });
    const registry = {
      findSourceById: vi.fn(async () => candidate),
      markSyncState: vi.fn(async (id: string, syncState: string) =>
        source({ id, syncState: syncState as DocumentSource["syncState"] }),
      ),
    };
    const fetcher = {
      fetch: vi.fn(async () => {
        throw "temporary outage";
      }),
    };
    const snapshots = {
      insertSucceededSnapshot: vi.fn(),
      insertFailedSnapshot: vi.fn(),
    };
    const runner = createDocumentSyncRunner({
      registry,
      snapshots,
      fetcher,
      now: () => failedAt,
    });

    await expect(runner.syncSource("source-to-string-fail")).resolves.toEqual({
      status: "failed",
      sourceId: "source-to-string-fail",
      errorMessage: "temporary outage",
    });
    expect(snapshots.insertFailedSnapshot).toHaveBeenCalledWith({
      documentSourceId: "source-to-string-fail",
      sourceUri: candidate.sourceUri,
      errorMessage: "temporary outage",
      fetchedAt: failedAt,
    });
  });

  it("rejects denied sources without fetching or marking sync state", async () => {
    const registry = registryReturning(source({ permissionState: "denied" }));
    const { runner, fetcher } = runnerWith({ registry });

    await expect(runner.syncSource("doc-source-1")).resolves.toEqual({
      status: "rejected",
      reason: "permission_denied",
    });
    expect(fetcher.fetch).not.toHaveBeenCalled();
    expect(registry.markSyncState).not.toHaveBeenCalled();
  });

  it("skips sources that are already syncing without fetching", async () => {
    const registry = registryReturning(source({ syncState: "syncing" }));
    const { runner, fetcher } = runnerWith({ registry });

    await expect(runner.syncSource("doc-source-1")).resolves.toEqual({
      status: "skipped",
      reason: "already_syncing",
    });
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it("skips sources that are already synced without fetching", async () => {
    const registry = registryReturning(source({ syncState: "synced" }));
    const { runner, fetcher } = runnerWith({ registry });

    await expect(runner.syncSource("doc-source-1")).resolves.toEqual({
      status: "skipped",
      reason: "already_synced",
    });
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it("rejects sources with both usage capabilities disabled", async () => {
    const registry = registryReturning(
      source({
        canUseForAnswering: false,
        canUseForKnowledgeDrafts: false,
      }),
    );
    const { runner, fetcher } = runnerWith({ registry });

    await expect(runner.syncSource("doc-source-1")).resolves.toEqual({
      status: "rejected",
      reason: "capability_disabled",
    });
    expect(fetcher.fetch).not.toHaveBeenCalled();
    expect(registry.markSyncState).not.toHaveBeenCalled();
  });

  it("returns not_found when the source does not exist", async () => {
    const registry = registryReturning(undefined);
    const { runner, fetcher } = runnerWith({ registry });

    await expect(runner.syncSource("missing-source")).resolves.toEqual({
      status: "not_found",
      sourceId: "missing-source",
    });
    expect(fetcher.fetch).not.toHaveBeenCalled();
    expect(registry.markSyncState).not.toHaveBeenCalled();
  });
});

function registryReturning(documentSource: DocumentSource | undefined) {
  return {
    findSourceById: vi.fn(async () => documentSource),
    markSyncState: vi.fn(),
  };
}

function runnerWith({
  registry,
}: {
  registry: ReturnType<typeof registryReturning>;
}) {
  const fetcher = {
    fetch: vi.fn(async () => ({
      bodyText: "Document body",
      fetchedAt: new Date("2026-07-02T05:00:00.000Z"),
    })),
  };
  const snapshots = {
    insertSucceededSnapshot: vi.fn(),
    insertFailedSnapshot: vi.fn(),
  };

  return {
    runner: createDocumentSyncRunner({
      registry,
      snapshots,
      fetcher,
      now: () => new Date("2026-07-02T05:01:00.000Z"),
    }),
    fetcher,
    snapshots,
  };
}
