import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { ProactiveSignalRuntime } from "../src/runtime/proactive-signal-runtime.js";

const authorization = { authorization: "Bearer operator-secret" };

describe("proactive signal operator API", () => {
  it("requires the configured bearer token for every candidate surface", async () => {
    const runtime = runtimeFixture();
    const app = createApp(runtime);
    const routes = [
      { method: "GET" as const, url: "/internal/proactive/status" },
      { method: "GET" as const, url: "/internal/proactive/candidates?groupId=group-1" },
      { method: "GET" as const, url: "/internal/proactive/candidates/candidate-1?groupId=group-1" },
      { method: "POST" as const, url: "/internal/proactive/scans", payload: {} },
      {
        method: "POST" as const,
        url: "/internal/proactive/candidates/candidate-1/dismiss",
        payload: { groupId: "group-1", expectedVersion: 1, dismissedBy: "operator" },
      },
    ];

    for (const route of routes) {
      const missing = await app.inject(route);
      const wrong = await app.inject({
        ...route,
        headers: { authorization: "Bearer wrong" },
      });
      expect(missing.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
    }
    expect(runtime.getStatus).not.toHaveBeenCalled();
    expect(runtime.scanNow).not.toHaveBeenCalled();
    expect(runtime.repository.listCandidates).not.toHaveBeenCalled();
    await app.close();
  });

  it("fails closed when operator authentication is not configured", async () => {
    const runtime = runtimeFixture();
    const app = buildApp({
      ...disabledRuntimeFactories(),
      createProactiveSignalRuntime: () => runtime,
    });

    const response = await app.inject({ method: "GET", url: "/internal/proactive/status" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      error: "proactive_signal_api_auth_unavailable",
    });
    expect(runtime.getStatus).not.toHaveBeenCalled();
    await app.close();
  });

  it("lists bounded candidates in one exact group and status set", async () => {
    const runtime = runtimeFixture();
    vi.mocked(runtime.repository.listCandidates).mockResolvedValue([candidate()]);
    const app = createApp(runtime);

    const response = await app.inject({
      method: "GET",
      url: "/internal/proactive/candidates?groupId=group-1&status=pending&limit=7",
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(runtime.repository.listCandidates).toHaveBeenCalledWith({
      groupId: "group-1",
      statuses: ["pending"],
      limit: 7,
    });
    expect(response.json()).toEqual({ ok: true, groupId: "group-1", candidates: [
      expect.objectContaining({ id: "candidate-1", reason: "quiet_unresolved_thread" }),
    ] });
    await app.close();
  });

  it("loads candidate detail only through an exact group scope", async () => {
    const runtime = runtimeFixture();
    vi.mocked(runtime.repository.getCandidate).mockResolvedValue(candidate());
    const app = createApp(runtime);

    const response = await app.inject({
      method: "GET",
      url: "/internal/proactive/candidates/candidate-1?groupId=group-1",
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(runtime.repository.getCandidate).toHaveBeenCalledWith({
      id: "candidate-1",
      groupId: "group-1",
    });
    expect(response.json()).toEqual({ ok: true, candidate: expect.objectContaining({ id: "candidate-1" }) });
    await app.close();
  });

  it("dismisses through a versioned exact-group compare-and-swap", async () => {
    const runtime = runtimeFixture();
    vi.mocked(runtime.repository.dismissCandidate).mockResolvedValue(candidate({
      status: "dismissed",
      version: 2,
      dismissedAt: new Date("2026-07-18T13:00:00.000Z"),
      dismissedBy: "operator",
      dismissalReason: "already handled",
      updatedAt: new Date("2026-07-18T13:00:00.000Z"),
    }));
    const app = createApp(runtime);

    const response = await app.inject({
      method: "POST",
      url: "/internal/proactive/candidates/candidate-1/dismiss",
      headers: authorization,
      payload: {
        groupId: "group-1",
        expectedVersion: 1,
        dismissedBy: "operator",
        dismissalReason: "already handled",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runtime.repository.dismissCandidate).toHaveBeenCalledWith({
      id: "candidate-1",
      groupId: "group-1",
      expectedVersion: 1,
      dismissedBy: "operator",
      dismissalReason: "already handled",
      at: expect.any(Date),
    });
    expect(response.json()).toEqual({
      ok: true,
      candidate: expect.objectContaining({ status: "dismissed", version: 2 }),
    });
    await app.close();
  });

  it("runs one bounded manual scan and exposes content-free status", async () => {
    const runtime = runtimeFixture();
    const app = createApp(runtime);

    const scan = await app.inject({
      method: "POST",
      url: "/internal/proactive/scans",
      headers: authorization,
      payload: {},
    });
    const status = await app.inject({
      method: "GET",
      url: "/internal/proactive/status",
      headers: authorization,
    });

    expect(scan.json()).toEqual({ ok: true, result: scanResult() });
    expect(status.json()).toMatchObject({
      ok: true,
      enabled: true,
      counts: { candidates: { pending: 1 } },
    });
    expect(JSON.stringify(status.json())).not.toContain("thread title");
    await app.close();
  });

  it("rejects malformed values and exposes no Phase 4B approve or send route", async () => {
    const runtime = runtimeFixture();
    const app = createApp(runtime);
    for (const url of [
      "/internal/proactive/candidates?groupId=%20",
      "/internal/proactive/candidates?groupId=group-1&status=unknown",
      "/internal/proactive/candidates?groupId=group-1&limit=0",
      "/internal/proactive/candidates/candidate-1",
    ]) {
      const response = await app.inject({ method: "GET", url, headers: authorization });
      expect(response.statusCode, url).toBe(400);
    }
    const invalidDismiss = await app.inject({
      method: "POST",
      url: "/internal/proactive/candidates/candidate-1/dismiss",
      headers: authorization,
      payload: { groupId: "group-1", expectedVersion: 0, dismissedBy: "operator" },
    });
    expect(invalidDismiss.statusCode).toBe(400);
    expect((await app.inject({
      method: "POST", url: "/internal/proactive/candidates/candidate-1/approve", headers: authorization,
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "POST", url: "/internal/proactive/candidates/candidate-1/send", headers: authorization,
    })).statusCode).toBe(404);
    await app.close();
  });
});

function createApp(runtime: ProactiveSignalRuntime) {
  return buildApp({
    ...disabledRuntimeFactories(),
    internalApiToken: "operator-secret",
    createProactiveSignalRuntime: () => runtime,
  });
}

function disabledRuntimeFactories() {
  return {
    createAnswerDraftRuntime: () => undefined,
    createMemoryExtractionRuntime: () => undefined,
    createEventWorkerRuntime: () => undefined,
    createDocumentSyncRuntime: () => undefined,
    createReindexWorkerRuntime: () => undefined,
    createConversationStateInspectionRuntime: () => undefined,
  };
}

function runtimeFixture(): ProactiveSignalRuntime {
  return {
    repository: {
      loadEligibleSources: vi.fn(async () => []),
      observeCandidate: vi.fn(),
      listCandidates: vi.fn(async () => []),
      getCandidate: vi.fn(async () => undefined),
      dismissCandidate: vi.fn(async () => "conflict" as const),
      startScanRun: vi.fn(),
      completeScanRun: vi.fn(),
      failScanRun: vi.fn(),
      getStatusCounts: vi.fn(async () => ({
        candidates: { pending: 1, dismissed: 0, expired: 0 },
        scans: { processing: 0, completed: 1, failed: 0 },
      })),
    },
    start: vi.fn(),
    scanNow: vi.fn(async () => scanResult()),
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      running: true,
      policyVersion: "phase4a-v1",
      intervalMs: 300_000,
      batchLimit: 50,
      allowlistedGroupCount: 1,
      idleReason: undefined,
      counts: {
        candidates: { pending: 1, dismissed: 0, expired: 0 },
        scans: { processing: 0, completed: 1, failed: 0 },
      },
    })),
    close: vi.fn(async () => undefined),
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

function candidate(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-07-18T12:00:00.000Z");
  return {
    id: "candidate-1",
    groupId: "group-1",
    sourceType: "thread" as const,
    sourceId: "thread-1",
    sourceVersion: 1,
    reason: "quiet_unresolved_thread" as const,
    score: 0.7,
    scoreFactors: {
      base: 0.55,
      confidenceContribution: 0.1,
      ageContribution: 0.05,
      overdueContribution: 0,
      quietForMs: 86_400_000,
      overdueByMs: 0,
    },
    explanation: "Open thread has been quiet for 24 hours; semantic confidence is 0.90.",
    policyVersion: "phase4a-v1",
    status: "pending" as const,
    version: 1,
    sourceActivityAt: now,
    eligibleAt: now,
    observedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as never;
}
