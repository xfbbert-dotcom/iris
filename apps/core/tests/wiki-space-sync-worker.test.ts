import { describe, expect, it, vi } from "vitest";

import { WikiSpaceSyncError } from "../src/documents/feishu-wiki-space-client.js";
import { createWikiSpaceSyncWorker } from "../src/documents/wiki-space-sync-worker.js";
import type { WikiSpaceAuthorization } from "../src/documents/wiki-space-authorization-repository.js";

describe("WikiSpaceSyncWorker", () => {
  it("claims one authorization and registers canonical wiki documents in traversal order", async () => {
    const now = new Date("2026-07-29T02:00:00.000Z");
    const claimed = authorization({
      rootSourceUri: "https://tenant.feishu.cn/wiki/root?private=ignored",
      rootNodeToken: "root token",
    });
    const repository = {
      claimNext: vi.fn(async () => claimed),
      complete: vi.fn(async () => claimed),
      fail: vi.fn(),
    };
    const scanner = vi.fn(async () => ({
      spaceId: "space-1",
      rootTitle: "Root title",
      documents: [
        { nodeToken: "root token", title: "Root title" },
        { nodeToken: "child / one", title: "Child one" },
        { nodeToken: "child-two" },
      ],
      discoveredNodeCount: 4,
      skippedNodeCount: 1,
    }));
    const registrar = { register: vi.fn(async () => ({ sourceId: "source-1", enqueueStatus: "enqueued" as const })) };
    const worker = createWikiSpaceSyncWorker({
      repository,
      scanner,
      registrar,
      leaseMs: 60_000,
      refreshIntervalMs: 3_600_000,
      maxAttempts: 3,
      now: () => now,
    });

    await expect(worker.processNext()).resolves.toEqual({
      status: "synced",
      authorizationId: claimed.id,
      registeredDocumentCount: 3,
      skippedNodeCount: 1,
    });

    expect(repository.claimNext).toHaveBeenCalledTimes(1);
    expect(repository.claimNext).toHaveBeenCalledWith({
      at: now,
      leaseExpiresAt: new Date("2026-07-29T02:01:00.000Z"),
      maxAttempts: 3,
    });
    expect(scanner).toHaveBeenCalledWith({ rootNodeToken: "root token" });
    expect(registrar.register).toHaveBeenNthCalledWith(1, {
      sourceUri: "https://tenant.feishu.cn/wiki/root%20token",
      title: "Root title",
      authorizedSpaceId: "space-1",
      observedAt: now,
    });
    expect(registrar.register).toHaveBeenNthCalledWith(2, {
      sourceUri: "https://tenant.feishu.cn/wiki/child%20%2F%20one",
      title: "Child one",
      authorizedSpaceId: "space-1",
      observedAt: now,
    });
    expect(registrar.register).toHaveBeenNthCalledWith(3, {
      sourceUri: "https://tenant.feishu.cn/wiki/child-two",
      authorizedSpaceId: "space-1",
      observedAt: now,
    });
    expect(repository.complete).toHaveBeenCalledWith({
      id: claimed.id,
      revision: claimed.revision,
      at: now,
      nextScanAt: new Date("2026-07-29T03:00:00.000Z"),
      spaceId: "space-1",
      title: "Root title",
      discoveredNodeCount: 4,
      registeredDocumentCount: 3,
      skippedNodeCount: 1,
    });
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("returns idle without scanning when no authorization can be claimed", async () => {
    const repository = {
      claimNext: vi.fn(async () => undefined),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const scanner = vi.fn();
    const worker = createWikiSpaceSyncWorker({
      repository,
      scanner,
      registrar: { register: vi.fn() },
      leaseMs: 60_000,
      refreshIntervalMs: 3_600_000,
      maxAttempts: 3,
    });

    await expect(worker.processNext()).resolves.toEqual({ status: "idle" });
    expect(scanner).not.toHaveBeenCalled();
  });

  it("schedules a bounded retry for a retriable scan failure", async () => {
    const now = new Date("2026-07-29T02:00:00.000Z");
    const claimed = authorization({ attemptCount: 3 });
    const repository = {
      claimNext: vi.fn(async () => claimed),
      complete: vi.fn(),
      fail: vi.fn(async (_input: { retryAt?: Date }) => claimed),
    };
    const worker = createWikiSpaceSyncWorker({
      repository,
      scanner: vi.fn(async () => {
        throw new WikiSpaceSyncError("rate_limited", true);
      }),
      registrar: { register: vi.fn() },
      leaseMs: 60_000,
      refreshIntervalMs: 3_600_000,
      maxAttempts: 4,
      now: () => now,
    });

    await expect(worker.processNext()).resolves.toEqual({
      status: "retrying",
      authorizationId: claimed.id,
      classification: "rate_limited",
    });
    expect(repository.fail).toHaveBeenCalledWith({
      id: claimed.id,
      revision: claimed.revision,
      at: now,
      classification: "rate_limited",
      retryAt: new Date("2026-07-29T02:02:00.000Z"),
    });
  });

  it("dead-letters terminal scan failures with only their safe classification", async () => {
    const claimed = authorization();
    const repository = {
      claimNext: vi.fn(async () => claimed),
      complete: vi.fn(),
      fail: vi.fn(async (_input: { retryAt?: Date }) => claimed),
    };
    const worker = createWikiSpaceSyncWorker({
      repository,
      scanner: vi.fn(async () => {
        throw new WikiSpaceSyncError("forbidden", false);
      }),
      registrar: { register: vi.fn() },
      leaseMs: 60_000,
      refreshIntervalMs: 3_600_000,
      maxAttempts: 3,
    });

    await expect(worker.processNext()).resolves.toEqual({
      status: "dead_lettered",
      authorizationId: claimed.id,
      classification: "forbidden",
    });
    expect(repository.fail).toHaveBeenCalledWith(expect.objectContaining({
      id: claimed.id,
      revision: claimed.revision,
      classification: "forbidden",
    }));
    expect(repository.fail.mock.calls[0]?.[0]).not.toHaveProperty("retryAt");
  });

  it("dead-letters retriable failures once the claimed attempt exhausts the limit", async () => {
    const claimed = authorization({ attemptCount: 3 });
    const repository = {
      claimNext: vi.fn(async () => claimed),
      complete: vi.fn(),
      fail: vi.fn(async (_input: { retryAt?: Date }) => claimed),
    };
    const worker = createWikiSpaceSyncWorker({
      repository,
      scanner: vi.fn(async () => {
        throw new WikiSpaceSyncError("timeout", true);
      }),
      registrar: { register: vi.fn() },
      leaseMs: 60_000,
      refreshIntervalMs: 3_600_000,
      maxAttempts: 3,
    });

    await expect(worker.processNext()).resolves.toEqual({
      status: "dead_lettered",
      authorizationId: claimed.id,
      classification: "timeout",
    });
    expect(repository.fail.mock.calls[0]?.[0]).not.toHaveProperty("retryAt");
  });

  it("propagates stale completion rejection without converting it into another failure", async () => {
    const claimed = authorization();
    const repository = {
      claimNext: vi.fn(async () => claimed),
      complete: vi.fn(async () => {
        throw new Error("stale wiki space authorization");
      }),
      fail: vi.fn(),
    };
    const worker = createWikiSpaceSyncWorker({
      repository,
      scanner: vi.fn(async () => ({
        spaceId: "space-1",
        documents: [{ nodeToken: "root" }],
        discoveredNodeCount: 1,
        skippedNodeCount: 0,
      })),
      registrar: { register: vi.fn(async () => ({ sourceId: "source-1", enqueueStatus: "enqueued" as const })) },
      leaseMs: 60_000,
      refreshIntervalMs: 3_600_000,
      maxAttempts: 3,
    });

    await expect(worker.processNext()).rejects.toThrow("stale wiki space authorization");
    expect(repository.fail).not.toHaveBeenCalled();
  });
});

function authorization(overrides: Partial<WikiSpaceAuthorization> = {}): WikiSpaceAuthorization {
  const at = new Date("2026-07-29T02:00:00.000Z");
  return {
    id: "authorization-1",
    rootSourceUri: "https://tenant.feishu.cn/wiki/root",
    rootNodeToken: "root",
    spaceId: undefined,
    title: undefined,
    enabled: true,
    scanState: "scanning",
    attemptCount: 1,
    nextScanAt: at,
    leaseExpiresAt: new Date("2026-07-29T02:01:00.000Z"),
    lastScanStartedAt: at,
    lastScanCompletedAt: undefined,
    lastSuccessAt: undefined,
    lastErrorClassification: undefined,
    discoveredNodeCount: 0,
    registeredDocumentCount: 0,
    skippedNodeCount: 0,
    revision: 2,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}
