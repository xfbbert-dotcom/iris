import { describe, expect, it, vi } from "vitest";

import { RuntimeController } from "../src/admin/runtime-controller.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import { createProactiveSignalRuntime } from "../src/runtime/proactive-signal-runtime.js";

describe("createProactiveSignalRuntime", () => {
  it("returns undefined without the explicit feature flag", () => {
    expect(createProactiveSignalRuntime({ env: {} })).toBeUndefined();
  });

  it("composes the scanner, loop, repository, status, manual scan, and clean shutdown", async () => {
    const pool = { query: vi.fn(), connect: vi.fn(), end: vi.fn(async () => undefined) };
    const repository = repositoryFixture();
    const scanner = { scan: vi.fn(async () => scanResult()) };
    const loop = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      isRunning: vi.fn(() => true),
      getSnapshot: vi.fn(() => ({
        running: true,
        intervalMs: 1000,
        latestScan: {
          status: "succeeded" as const,
          startedAt: new Date("2026-07-18T12:00:00.000Z"),
          finishedAt: new Date("2026-07-18T12:00:01.000Z"),
          result: scanResult(),
        },
      })),
    };
    const runtimeController = new RuntimeController(createDefaultRuntimeConfig());
    const runtime = createProactiveSignalRuntime({
      env: enabledEnv(),
      runtimeController,
      dependencies: {
        createPostgresPool: vi.fn(() => pool),
        createRepository: vi.fn(() => repository),
        createScanner: vi.fn(() => scanner),
        createWorkerLoop: vi.fn(() => loop),
      },
    });

    expect(runtime).toBeDefined();
    runtime?.start();
    runtime?.start();
    expect(loop.start).toHaveBeenCalledOnce();
    await expect(runtime?.scanNow()).resolves.toEqual(scanResult());
    await expect(runtime?.getStatus()).resolves.toEqual({
      enabled: true,
      running: true,
      policyVersion: "phase4a-v1",
      intervalMs: 1000,
      batchLimit: 25,
      allowlistedGroupCount: 2,
      idleReason: undefined,
      counts: {
        candidates: { pending: 2, dismissed: 1, expired: 3 },
        scans: { processing: 0, completed: 4, failed: 1 },
      },
      latestScan: loop.getSnapshot().latestScan,
    });
    await runtime?.close();
    expect(loop.stop).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("reports an explicit idle reason for an enabled empty allowlist", async () => {
    const runtime = createProactiveSignalRuntime({
      env: {
        IRIS_PROACTIVE_CANDIDATE_SCANNING_ENABLED: "true",
        DATABASE_URL: "postgresql://example/iris",
      },
      runtimeController: new RuntimeController(createDefaultRuntimeConfig()),
      dependencies: runtimeDependencies(),
    });

    await expect(runtime?.getStatus()).resolves.toMatchObject({
      enabled: true,
      allowlistedGroupCount: 0,
      idleReason: "empty_allowlist",
    });
    await runtime?.close();
  });

  it("requires a runtime controller and database only when enabled", () => {
    expect(() => createProactiveSignalRuntime({ env: enabledEnv() }))
      .toThrow("runtimeController");
    expect(() => createProactiveSignalRuntime({
      env: { IRIS_PROACTIVE_CANDIDATE_SCANNING_ENABLED: "true" },
      runtimeController: new RuntimeController(createDefaultRuntimeConfig()),
    })).toThrow("DATABASE_URL");
  });
});

function enabledEnv() {
  return {
    IRIS_PROACTIVE_CANDIDATE_SCANNING_ENABLED: "true",
    IRIS_PROACTIVE_CANDIDATE_GROUP_IDS: "group-b,group-a",
    IRIS_PROACTIVE_CANDIDATE_INTERVAL_MS: "1000",
    IRIS_PROACTIVE_CANDIDATE_BATCH_LIMIT: "25",
    DATABASE_URL: "postgresql://example/iris",
  };
}

function scanResult() {
  return {
    status: "completed" as const,
    runId: "scan-1",
    scannedSourceCount: 1,
    createdCandidateCount: 1,
    duplicateCandidateCount: 0,
    expiredCandidateCount: 0,
    skippedCandidateCount: 0,
  };
}

function repositoryFixture() {
  return {
    loadEligibleSources: vi.fn(async () => []),
    observeCandidate: vi.fn(),
    listCandidates: vi.fn(async () => []),
    getCandidate: vi.fn(async () => undefined),
    dismissCandidate: vi.fn(async () => "conflict" as const),
    startScanRun: vi.fn(),
    completeScanRun: vi.fn(),
    failScanRun: vi.fn(),
    getStatusCounts: vi.fn(async () => ({
      candidates: { pending: 2, dismissed: 1, expired: 3 },
      scans: { processing: 0, completed: 4, failed: 1 },
    })),
  };
}

function runtimeDependencies() {
  const pool = { query: vi.fn(), connect: vi.fn(), end: vi.fn(async () => undefined) };
  const repository = repositoryFixture();
  const scanner = { scan: vi.fn(async () => scanResult()) };
  const loop = {
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    isRunning: vi.fn(() => false),
    getSnapshot: vi.fn(() => ({ running: false, intervalMs: 300_000 })),
  };
  return {
    createPostgresPool: vi.fn(() => pool),
    createRepository: vi.fn(() => repository),
    createScanner: vi.fn(() => scanner),
    createWorkerLoop: vi.fn(() => loop),
  };
}
