import { describe, expect, it, vi } from "vitest";

import {
  createDocumentSyncPlanner,
  createDocumentSyncRunner,
} from "../src/documents/document-sync-pipeline.js";
import type { DocumentSnapshot } from "../src/documents/document-snapshot-repository.js";
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

function snapshot(overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  const fetchedAt = new Date("2026-07-02T05:00:00.000Z");
  const createdAt = new Date("2026-07-02T05:02:00.000Z");

  return {
    id: "snapshot-1",
    documentSourceId: "doc-source-1",
    sourceUri: "https://example.com/docs/doc-1",
    fetchStatus: "succeeded",
    bodyText: "Document body",
    contentHash: "content-hash-1",
    sourceVersion: "version-1",
    fetchedAt,
    createdAt,
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
    const succeededSnapshot = snapshot({
      id: "snapshot-success",
      documentSourceId: candidate.id,
      sourceUri: candidate.sourceUri,
      fetchedAt,
    });
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
        return succeededSnapshot;
      }),
      insertFailedSnapshot: vi.fn(),
    };
    const runner = createDocumentSyncRunner({
      registry,
      snapshots,
      fetcher,
      now: () => failedAt,
    });

    const result = await runner.syncSourceById("source-to-sync");

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
    expect(result).toEqual({
      status: "synced",
      source: candidate,
      snapshot: succeededSnapshot,
    });
  });

  it("enqueues reindex after a successful sync snapshot is marked synced", async () => {
    const candidate = source({ id: "source-to-reindex" });
    const calls: string[] = [];
    const succeededSnapshot = snapshot({
      id: "snapshot-to-reindex",
      documentSourceId: candidate.id,
      sourceUri: candidate.sourceUri,
      fetchedAt,
    });
    const registry = {
      findSourceById: vi.fn(async () => candidate),
      markSyncState: vi.fn(async (id: string, syncState: string) => {
        calls.push(`mark:${syncState}`);
        return source({ id, syncState: syncState as DocumentSource["syncState"] });
      }),
    };
    const syncedSnapshotReindexer = {
      enqueueSyncedSnapshotReindex: vi.fn(async (input: unknown) => {
        calls.push("reindex");
      }),
    };
    const runner = createDocumentSyncRunner({
      registry,
      snapshots: {
        insertSucceededSnapshot: vi.fn(async () => {
          calls.push("snapshot:succeeded");
          return succeededSnapshot;
        }),
        insertFailedSnapshot: vi.fn(),
      },
      fetcher: {
        fetch: vi.fn(async () => ({
          bodyText: "Document body",
          fetchedAt,
        })),
      },
      syncedSnapshotReindexer,
    });

    await expect(runner.syncSourceById("source-to-reindex")).resolves.toMatchObject({
      status: "synced",
      snapshot: succeededSnapshot,
    });
    expect(calls).toEqual(["mark:syncing", "snapshot:succeeded", "mark:synced", "reindex"]);
    expect(syncedSnapshotReindexer.enqueueSyncedSnapshotReindex).toHaveBeenCalledWith({
      documentSnapshotId: "snapshot-to-reindex",
    });
  });

  it("marks a successfully fetched source pending again when reindex enqueue fails", async () => {
    const candidate = source({ id: "source-with-reindex-failure" });
    const calls: string[] = [];
    const succeededSnapshot = snapshot({
      id: "snapshot-with-reindex-failure",
      documentSourceId: candidate.id,
      sourceUri: candidate.sourceUri,
      fetchedAt,
    });
    const registry = {
      findSourceById: vi.fn(async () => candidate),
      markSyncState: vi.fn(async (id: string, syncState: string) => {
        calls.push(`mark:${syncState}`);
        return source({ id, syncState: syncState as DocumentSource["syncState"] });
      }),
    };
    const syncedSnapshotReindexer = {
      enqueueSyncedSnapshotReindex: vi.fn(async () => {
        calls.push("reindex");
        throw new Error("reindex queue unavailable");
      }),
    };
    const runner = createDocumentSyncRunner({
      registry,
      snapshots: {
        insertSucceededSnapshot: vi.fn(async () => {
          calls.push("snapshot:succeeded");
          return succeededSnapshot;
        }),
        insertFailedSnapshot: vi.fn(),
      },
      fetcher: {
        fetch: vi.fn(async () => ({
          bodyText: "Document body",
          fetchedAt,
        })),
      },
      syncedSnapshotReindexer,
    });

    await expect(
      runner.syncSourceById("source-with-reindex-failure"),
    ).rejects.toThrow("reindex queue unavailable");
    expect(calls).toEqual([
      "mark:syncing",
      "snapshot:succeeded",
      "mark:synced",
      "reindex",
      "mark:pending",
    ]);
  });

  it("does not enqueue reindex after a failed sync snapshot", async () => {
    const candidate = source({ id: "source-with-fetch-failure" });
    const syncedSnapshotReindexer = {
      enqueueSyncedSnapshotReindex: vi.fn(),
    };
    const runner = createDocumentSyncRunner({
      registry: {
        findSourceById: vi.fn(async () => candidate),
        markSyncState: vi.fn(async (id: string, syncState: string) =>
          source({ id, syncState: syncState as DocumentSource["syncState"] }),
        ),
      },
      snapshots: {
        insertSucceededSnapshot: vi.fn(),
        insertFailedSnapshot: vi.fn(async () =>
          snapshot({
            id: "snapshot-failed-no-reindex",
            documentSourceId: candidate.id,
            sourceUri: candidate.sourceUri,
            fetchStatus: "failed",
            bodyText: undefined,
            fetchedAt: failedAt,
          }),
        ),
      },
      fetcher: {
        fetch: vi.fn(async () => {
          throw new Error("network unavailable");
        }),
      },
      now: () => failedAt,
      syncedSnapshotReindexer,
    });

    await expect(runner.syncSourceById("source-with-fetch-failure")).resolves.toMatchObject({
      status: "failed",
    });
    expect(syncedSnapshotReindexer.enqueueSyncedSnapshotReindex).not.toHaveBeenCalled();
  });

  it("records a failed snapshot and marks failed when fetching throws", async () => {
    const candidate = source({ id: "source-to-fail" });
    const calls: string[] = [];
    const failedSnapshot = snapshot({
      id: "snapshot-failed",
      documentSourceId: candidate.id,
      sourceUri: candidate.sourceUri,
      fetchStatus: "failed",
      bodyText: undefined,
      contentHash: undefined,
      sourceVersion: undefined,
      fetchedAt: failedAt,
      errorMessage: "network unavailable",
    });
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
        return failedSnapshot;
      }),
    };
    const runner = createDocumentSyncRunner({
      registry,
      snapshots,
      fetcher,
      now: () => failedAt,
    });

    const result = await runner.syncSourceById("source-to-fail");

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
    expect(result).toEqual({
      status: "failed",
      source: candidate,
      snapshot: failedSnapshot,
      errorMessage: "network unavailable",
    });
  });

  it("stringifies non-Error fetch failures before recording them", async () => {
    const candidate = source({ id: "source-to-string-fail" });
    const failedSnapshot = snapshot({
      id: "snapshot-string-failed",
      documentSourceId: candidate.id,
      sourceUri: candidate.sourceUri,
      fetchStatus: "failed",
      bodyText: undefined,
      contentHash: undefined,
      sourceVersion: undefined,
      fetchedAt: failedAt,
      errorMessage: "temporary outage",
    });
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
      insertFailedSnapshot: vi.fn(async () => failedSnapshot),
    };
    const runner = createDocumentSyncRunner({
      registry,
      snapshots,
      fetcher,
      now: () => failedAt,
    });

    await expect(runner.syncSourceById("source-to-string-fail")).resolves.toEqual({
      status: "failed",
      source: candidate,
      snapshot: failedSnapshot,
      errorMessage: "temporary outage",
    });
    expect(snapshots.insertFailedSnapshot).toHaveBeenCalledWith({
      documentSourceId: "source-to-string-fail",
      sourceUri: candidate.sourceUri,
      errorMessage: "temporary outage",
      fetchedAt: failedAt,
    });
  });

  it("rejects when recording a succeeded snapshot fails without recording a failed snapshot", async () => {
    const candidate = source({ id: "source-with-snapshot-write-failure" });
    const registry = registryReturning(candidate);
    const snapshots = {
      insertSucceededSnapshot: vi.fn(async () => {
        throw new Error("snapshot write failed");
      }),
      insertFailedSnapshot: vi.fn(),
    };
    const runner = createDocumentSyncRunner({
      registry,
      snapshots,
      fetcher: {
        fetch: vi.fn(async () => ({
          bodyText: "Document body",
          fetchedAt,
        })),
      },
      now: () => failedAt,
    });

    await expect(
      runner.syncSourceById("source-with-snapshot-write-failure"),
    ).rejects.toThrow("snapshot write failed");
    expect(snapshots.insertFailedSnapshot).not.toHaveBeenCalled();
    expect(registry.markSyncState).toHaveBeenCalledTimes(1);
    expect(registry.markSyncState).toHaveBeenCalledWith(candidate.id, "syncing");
  });

  it("rejects when marking synced fails without recording a failed snapshot", async () => {
    const candidate = source({ id: "source-with-mark-synced-failure" });
    const succeededSnapshot = snapshot({
      id: "snapshot-before-mark-failure",
      documentSourceId: candidate.id,
      sourceUri: candidate.sourceUri,
      fetchedAt,
    });
    const registry = {
      findSourceById: vi.fn(async () => candidate),
      markSyncState: vi.fn(async (id: string, syncState: string) => {
        if (syncState === "synced") {
          throw new Error("mark synced failed");
        }

        return source({ id, syncState: syncState as DocumentSource["syncState"] });
      }),
    };
    const snapshots = {
      insertSucceededSnapshot: vi.fn(async () => succeededSnapshot),
      insertFailedSnapshot: vi.fn(),
    };
    const runner = createDocumentSyncRunner({
      registry,
      snapshots,
      fetcher: {
        fetch: vi.fn(async () => ({
          bodyText: "Document body",
          fetchedAt,
        })),
      },
      now: () => failedAt,
    });

    await expect(
      runner.syncSourceById("source-with-mark-synced-failure"),
    ).rejects.toThrow("mark synced failed");
    expect(snapshots.insertFailedSnapshot).not.toHaveBeenCalled();
    expect(registry.markSyncState).toHaveBeenCalledTimes(2);
    expect(registry.markSyncState).toHaveBeenLastCalledWith(candidate.id, "synced");
  });

  it("rejects denied sources without fetching or marking sync state", async () => {
    const deniedSource = source({ permissionState: "denied" });
    const registry = registryReturning(deniedSource);
    const { runner, fetcher } = runnerWith({ registry });

    await expect(runner.syncSourceById("doc-source-1")).resolves.toEqual({
      status: "rejected",
      source: deniedSource,
      reason: "permission_denied",
    });
    expect(fetcher.fetch).not.toHaveBeenCalled();
    expect(registry.markSyncState).not.toHaveBeenCalled();
  });

  it("skips sources that are already syncing without fetching", async () => {
    const syncingSource = source({ syncState: "syncing" });
    const registry = registryReturning(syncingSource);
    const { runner, fetcher } = runnerWith({ registry });

    await expect(runner.syncSourceById("doc-source-1")).resolves.toEqual({
      status: "skipped",
      source: syncingSource,
      reason: "already_syncing",
    });
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it("skips sources that are already synced without fetching", async () => {
    const syncedSource = source({ syncState: "synced" });
    const registry = registryReturning(syncedSource);
    const { runner, fetcher } = runnerWith({ registry });

    await expect(runner.syncSourceById("doc-source-1")).resolves.toEqual({
      status: "skipped",
      source: syncedSource,
      reason: "already_synced",
    });
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it("rejects sources with both usage capabilities disabled", async () => {
    const disabledSource = source({
      canUseForAnswering: false,
      canUseForKnowledgeDrafts: false,
    });
    const registry = registryReturning(disabledSource);
    const { runner, fetcher } = runnerWith({ registry });

    await expect(runner.syncSourceById("doc-source-1")).resolves.toEqual({
      status: "rejected",
      source: disabledSource,
      reason: "capability_disabled",
    });
    expect(fetcher.fetch).not.toHaveBeenCalled();
    expect(registry.markSyncState).not.toHaveBeenCalled();
  });

  it("returns not_found when the source does not exist", async () => {
    const registry = registryReturning(undefined);
    const { runner, fetcher } = runnerWith({ registry });

    await expect(runner.syncSourceById("missing-source")).resolves.toEqual({
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
