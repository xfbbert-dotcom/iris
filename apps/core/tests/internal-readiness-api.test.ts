import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { InMemoryAuditLog } from "../src/audit/audit-log.js";
import type { EnvLike } from "../src/config/env.js";
import type { MemoryExtractionRuntime } from "../src/runtime/memory-extraction-runtime.js";
import { isolateEnvVar } from "./test-env.js";

let restoreInternalApiToken: () => void = () => undefined;

beforeEach(() => {
  restoreInternalApiToken = isolateEnvVar("IRIS_INTERNAL_API_TOKEN");
});

afterEach(() => {
  restoreInternalApiToken();
});

describe("GET /internal/readiness", () => {
  it("returns the internal rollout readiness report for the configured environment", async () => {
    const app = buildApp({
      readinessEnv: readyRolloutEnv(),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/readiness",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      status: "ready",
      schemaVersion: 1,
      summary: {
        failCount: 0,
        warnCount: 0,
      },
    });
  });

  it("remains ready when the optional extraction AI worker is unhealthy", async () => {
    const app = buildApp({
      readinessEnv: readyRolloutEnv(),
      createAnswerDraftRuntime: () => undefined,
      createMemoryExtractionRuntime: () =>
        fakeMemoryExtractionRuntime({
          getStatus: vi.fn(async () => memoryExtractionStatus({ workerHealthy: false })),
        }),
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({ method: "GET", url: "/internal/readiness" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, status: "ready" });
    await app.close();
  });
});

describe("memory extraction internal API", () => {
  it("returns exact disabled status without a runtime", async () => {
    const app = buildTestApp({ createMemoryExtractionRuntime: () => undefined });

    const response = await app.inject({
      method: "GET",
      url: "/internal/memory-extraction/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, enabled: false, running: false });

    const consolidated = await app.inject({ method: "GET", url: "/internal/status" });
    expect(consolidated.statusCode).toBe(200);
    expect(consolidated.json().componentOrder).toEqual([
      "audit",
      "runtimeControl",
      "answerDraft",
      "feishuGateway",
      "memoryExtraction",
      "eventWorker",
      "documentSync",
      "reindex",
    ]);
    expect(consolidated.json().summary).toMatchObject({
      componentCount: 8,
      healthyComponentCount: 3,
      enabledComponentCount: 3,
      disabledComponentCount: 5,
      disabledComponents: [
        "answerDraft",
        "memoryExtraction",
        "eventWorker",
        "documentSync",
        "reindex",
      ],
      componentStatusCounts: {
        healthy: 3,
        disabled: 5,
        degraded: 0,
        stopped: 0,
      },
    });
    expect(consolidated.json().components.memoryExtraction).toEqual({
      status: "disabled",
      ok: true,
      enabled: false,
      running: false,
    });
    await app.close();
  });

  it("requires the exact configured bearer token for every recovery surface", async () => {
    const runtime = fakeMemoryExtractionRuntime();
    const app = buildTestApp({
      internalApiToken: "internal-token",
      createMemoryExtractionRuntime: () => runtime,
    });
    const routes = [
      { method: "GET" as const, url: "/internal/memory-extraction/status" },
      { method: "GET" as const, url: "/internal/memory-extraction/dead-letters" },
      { method: "POST" as const, url: "/internal/memory-extraction/dead-letters/dlq-1/replay" },
      { method: "POST" as const, url: "/internal/memory-extraction/dead-letters/replay", payload: { ids: ["dlq-1"] } },
      { method: "DELETE" as const, url: "/internal/memory-extraction/dead-letters/dlq-1" },
    ];

    for (const route of routes) {
      const missing = await app.inject(route);
      const wrong = await app.inject({
        ...route,
        headers: { authorization: "Bearer wrong-token" },
      });
      const authorized = await app.inject({
        ...route,
        headers: { authorization: "Bearer internal-token" },
      });

      expect(missing.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(authorized.statusCode).not.toBe(401);
    }

    await app.close();
  });

  it("reports content-free queue state and degrades only consolidated internal status", async () => {
    const runtime = fakeMemoryExtractionRuntime({
      getStatus: vi.fn(async () =>
        memoryExtractionStatus({
          workerHealthy: false,
          providerCooldownUntil: new Date("2026-07-15T06:00:00.000Z"),
          latestBatch: {
            status: "succeeded",
            startedAt: new Date("2026-07-15T05:59:00.000Z"),
            finishedAt: new Date("2026-07-15T05:59:01.000Z"),
            completedCount: 1,
            skippedCount: 1,
            deferredCount: 0,
            failedCount: 0,
            failed: false,
            providerError: "raw provider error with secret-token",
            providerPayload: "secret upstream body",
          },
        }),
      ),
    });
    const app = buildTestApp({ createMemoryExtractionRuntime: () => runtime });

    const direct = await app.inject({
      method: "GET",
      url: "/internal/memory-extraction/status",
    });
    const consolidated = await app.inject({ method: "GET", url: "/internal/status" });
    const health = await app.inject({ method: "GET", url: "/health" });
    const callback = await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: { challenge: "challenge-token" },
    });

    expect(direct.statusCode).toBe(200);
    expect(direct.json()).toEqual({
      ok: true,
      enabled: true,
      running: true,
      workerHealthy: false,
      intervalMs: 1000,
      batchLimit: 20,
      minConfidence: 0.85,
      pendingJobCount: 3,
      processingJobCount: 2,
      delayedJobCount: 1,
      deadLetterJobCount: 0,
      acceptedCandidateCount: 9,
      rejectedCandidateCount: 7,
      duplicateCandidateCount: 3,
      conflictCandidateCount: 2,
      skippedRequestCount: 6,
      failedRunCount: 5,
      providerCooldownUntil: "2026-07-15T06:00:00.000Z",
      latestBatch: {
        status: "succeeded",
        startedAt: "2026-07-15T05:59:00.000Z",
        finishedAt: "2026-07-15T05:59:01.000Z",
        completedCount: 1,
        skippedCount: 1,
        deferredCount: 0,
        failedCount: 0,
        failed: false,
      },
    });
    expect(consolidated.statusCode).toBe(200);
    expect(consolidated.json()).toMatchObject({
      ok: false,
      status: "degraded",
      components: {
        memoryExtraction: {
          status: "degraded",
          ok: false,
          enabled: true,
          running: true,
          workerHealthy: false,
          pendingJobCount: 3,
          processingJobCount: 2,
          delayedJobCount: 1,
          deadLetterJobCount: 0,
          acceptedCandidateCount: 9,
          rejectedCandidateCount: 7,
          duplicateCandidateCount: 3,
          conflictCandidateCount: 2,
          skippedRequestCount: 6,
          failedRunCount: 5,
          degradedReason: "ai_worker_unavailable",
        },
      },
    });
    expect(consolidated.json().componentOrder).toContain("memoryExtraction");
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true, service: "iris-core" });
    expect(callback.statusCode).toBe(200);
    expect(callback.json()).toEqual({ ok: true });
    expect(JSON.stringify(direct.json())).not.toContain("worker-token");
    expect(JSON.stringify(direct.json())).not.toContain("ai-worker:8000");
    expect(JSON.stringify(direct.json())).not.toContain("raw provider error");
    expect(JSON.stringify(direct.json())).not.toContain("secret upstream body");

    await app.close();
  });

  it("degrades status with a fixed content-free error when diagnostics aggregation fails", async () => {
    const runtime = fakeMemoryExtractionRuntime({
      getStatus: vi.fn(async () => {
        throw new Error("database returned raw candidate and secret-token");
      }),
    });
    const app = buildTestApp({ createMemoryExtractionRuntime: () => runtime });

    const direct = await app.inject({
      method: "GET",
      url: "/internal/memory-extraction/status",
    });
    const consolidated = await app.inject({ method: "GET", url: "/internal/status" });
    const health = await app.inject({ method: "GET", url: "/health" });

    expect(direct.statusCode).toBe(500);
    expect(direct.json()).toEqual({ ok: false, error: "memory_extraction_status_failed" });
    expect(consolidated.statusCode).toBe(200);
    expect(consolidated.json().components.memoryExtraction).toEqual({
      status: "degraded",
      ok: false,
      enabled: true,
      running: false,
      error: "memory_extraction_status_failed",
    });
    expect(health.statusCode).toBe(200);
    expect(JSON.stringify(direct.json())).not.toContain("secret-token");
    expect(JSON.stringify(consolidated.json())).not.toContain("raw candidate");
    await app.close();
  });

  it.each([
    [memoryExtractionStatus({ running: false }), "stopped", undefined],
    [memoryExtractionStatus({ deadLetterJobCount: 2 }), "degraded", "dead_letters_present"],
  ])("degrades consolidated status for stopped runtime or DLQ backlog", async (status, componentStatus, degradedReason) => {
    const app = buildTestApp({
      createMemoryExtractionRuntime: () =>
        fakeMemoryExtractionRuntime({ getStatus: vi.fn(async () => status) }),
    });

    const response = await app.inject({ method: "GET", url: "/internal/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json().components.memoryExtraction).toMatchObject({
      status: componentStatus,
      enabled: true,
      running: status.running,
      deadLetterJobCount: status.deadLetterJobCount,
      ...(degradedReason === undefined ? {} : { ok: false, degradedReason }),
    });
    expect(response.json().ok).toBe(false);
    await app.close();
  });

  it("lists bounded sanitized diagnostics and rejects invalid query shapes", async () => {
    const runtime = fakeMemoryExtractionRuntime({
      deadLetters: {
        list: vi.fn(async () => [
          {
            id: "dlq-1",
            job: {
              schemaVersion: 1 as const,
              idempotencyKey: "memory-extraction:request-1",
              requestId: "request-1",
              groupId: "group-1",
              enqueuedAt: new Date("2026-07-15T01:00:00.000Z"),
              notBefore: new Date("2026-07-15T01:05:00.000Z"),
              attempts: 5,
            },
            errorMessage: "raw provider body with secret-token",
            failedAt: new Date("2026-07-15T01:10:00.000Z"),
            replayable: true as const,
          },
        ]),
        replay: vi.fn(async () => "not_found" as const),
        replayBatch: vi.fn(async () => ({
          replayedCount: 0,
          notFoundIds: [],
          unsupportedLegacyIds: [],
        })),
        delete: vi.fn(async () => "not_found" as const),
      },
    });
    const app = buildTestApp({ createMemoryExtractionRuntime: () => runtime });

    const response = await app.inject({
      method: "GET",
      url: "/internal/memory-extraction/dead-letters?limit=101",
    });

    expect(response.statusCode).toBe(200);
    expect(runtime.deadLetters.list).toHaveBeenCalledWith({ limit: 100 });
    expect(response.json()).toEqual({
      ok: true,
      deadLetters: [
        {
          id: "dlq-1",
          job: {
            schemaVersion: 1,
            idempotencyKey: "memory-extraction:request-1",
            requestId: "request-1",
            groupId: "group-1",
            enqueuedAt: "2026-07-15T01:00:00.000Z",
            notBefore: "2026-07-15T01:05:00.000Z",
            attempts: 5,
          },
          errorMessage: "internal_error",
          failedAt: "2026-07-15T01:10:00.000Z",
          replayable: true,
        },
      ],
    });
    expect(JSON.stringify(response.json())).not.toContain("raw provider body");
    expect(JSON.stringify(response.json())).not.toContain("secret-token");

    for (const url of [
      "/internal/memory-extraction/dead-letters?limit=-1",
      "/internal/memory-extraction/dead-letters?limit=1e2",
      "/internal/memory-extraction/dead-letters?limit=9007199254740992",
      "/internal/memory-extraction/dead-letters?limit=20&extra=true",
    ]) {
      const invalid = await app.inject({ method: "GET", url });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({ ok: false, error: "invalid_request" });
    }

    await app.close();
  });

  it("audits only actual replay/delete mutations and deduplicates bounded batches", async () => {
    const auditLog = new InMemoryAuditLog();
    const runtime = fakeMemoryExtractionRuntime({
      deadLetters: {
        list: vi.fn(async () => []),
        replay: vi
          .fn()
          .mockResolvedValueOnce("replayed" as const)
          .mockResolvedValueOnce("not_found" as const)
          .mockResolvedValueOnce("replayed" as const)
          .mockResolvedValueOnce("not_found" as const),
        replayBatch: vi.fn(async () => ({
          replayedCount: 1,
          notFoundIds: ["missing"],
          unsupportedLegacyIds: [],
        })),
        delete: vi
          .fn()
          .mockResolvedValueOnce("deleted" as const)
          .mockResolvedValueOnce("not_found" as const),
      },
    });
    const app = buildTestApp({
      auditLog,
      createMemoryExtractionRuntime: () => runtime,
    });

    const replayed = await app.inject({
      method: "POST",
      url: "/internal/memory-extraction/dead-letters/dlq-replay/replay",
    });
    const replayMissing = await app.inject({
      method: "POST",
      url: "/internal/memory-extraction/dead-letters/missing/replay",
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: "/internal/memory-extraction/dead-letters/dlq-delete",
    });
    const deleteMissing = await app.inject({
      method: "DELETE",
      url: "/internal/memory-extraction/dead-letters/missing",
    });
    const batch = await app.inject({
      method: "POST",
      url: "/internal/memory-extraction/dead-letters/replay",
      payload: { ids: ["dlq-batch", "missing", "dlq-batch", "missing"] },
    });

    expect(replayed.json()).toEqual({ ok: true, status: "replayed" });
    expect(replayMissing.json()).toEqual({ ok: true, status: "not_found" });
    expect(deleted.json()).toEqual({ ok: true, status: "deleted" });
    expect(deleteMissing.json()).toEqual({ ok: true, status: "not_found" });
    expect(batch.json()).toEqual({
      ok: true,
      replayedCount: 1,
      notFoundIds: ["missing"],
      unsupportedLegacyIds: [],
    });
    expect(runtime.deadLetters.replay).toHaveBeenNthCalledWith(3, "dlq-batch");
    expect(runtime.deadLetters.replay).toHaveBeenNthCalledWith(4, "missing");
    expect(runtime.deadLetters.replayBatch).not.toHaveBeenCalled();
    expect(auditLog.events).toEqual([
      expect.objectContaining({
        type: "memory_extraction_dlq_replayed",
        documentId: "dlq-replay",
        fragmentIds: [],
      }),
      expect.objectContaining({
        type: "memory_extraction_dlq_deleted",
        documentId: "dlq-delete",
        fragmentIds: [],
      }),
      expect.objectContaining({
        type: "memory_extraction_dlq_replayed",
        documentId: "dlq-batch",
        fragmentIds: [],
      }),
    ]);
    expect(JSON.stringify(auditLog.events)).not.toContain("missing");

    for (const payload of [
      { ids: [] },
      { ids: Array.from({ length: 101 }, (_, index) => `dlq-${index}`) },
      { ids: ["dlq-1"], extra: true },
    ]) {
      const invalid = await app.inject({
        method: "POST",
        url: "/internal/memory-extraction/dead-letters/replay",
        payload,
      });
      expect(invalid.statusCode).toBe(400);
    }

    await app.close();
  });

  it("audits each successful batch replay before a later replay fails", async () => {
    const auditLog = new InMemoryAuditLog();
    const runtime = fakeMemoryExtractionRuntime({
      deadLetters: {
        list: vi.fn(async () => []),
        replay: vi
          .fn()
          .mockResolvedValueOnce("replayed" as const)
          .mockResolvedValueOnce("not_found" as const)
          .mockResolvedValueOnce("replayed" as const)
          .mockRejectedValueOnce(new Error("redis secret failure")),
        replayBatch: vi.fn(),
        delete: vi.fn(async () => "not_found" as const),
      },
    });
    const app = buildTestApp({
      auditLog,
      createMemoryExtractionRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/memory-extraction/dead-letters/replay",
      payload: { ids: ["replayed-1", "missing", "replayed-2", "failed", "replayed-1"] },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: "memory_extraction_dead_letter_operation_failed",
    });
    expect(runtime.deadLetters.replay).toHaveBeenCalledTimes(4);
    expect(runtime.deadLetters.replayBatch).not.toHaveBeenCalled();
    expect(auditLog.events).toEqual([
      expect.objectContaining({
        type: "memory_extraction_dlq_replayed",
        documentId: "replayed-1",
        fragmentIds: [],
      }),
      expect.objectContaining({
        type: "memory_extraction_dlq_replayed",
        documentId: "replayed-2",
        fragmentIds: [],
      }),
    ]);
    expect(JSON.stringify(response.json())).not.toContain("redis secret failure");
    expect(JSON.stringify(auditLog.events)).not.toContain("missing");
    expect(JSON.stringify(auditLog.events)).not.toContain("failed");
    await app.close();
  });

  it("isolates audit failures and never records success for failed mutations", async () => {
    const auditLog = new InMemoryAuditLog();
    const record = vi.spyOn(auditLog, "record").mockRejectedValueOnce(new Error("sink failed"));
    const runtime = fakeMemoryExtractionRuntime({
      deadLetters: {
        list: vi.fn(async () => []),
        replay: vi
          .fn()
          .mockResolvedValueOnce("replayed" as const)
          .mockRejectedValueOnce(new Error("redis failed")),
        replayBatch: vi.fn(async () => ({
          replayedCount: 0,
          notFoundIds: [],
          unsupportedLegacyIds: [],
        })),
        delete: vi.fn(async () => "not_found" as const),
      },
    });
    const app = buildTestApp({
      auditLog,
      createMemoryExtractionRuntime: () => runtime,
    });

    const replayed = await app.inject({
      method: "POST",
      url: "/internal/memory-extraction/dead-letters/dlq-1/replay",
    });
    const failed = await app.inject({
      method: "POST",
      url: "/internal/memory-extraction/dead-letters/dlq-2/replay",
    });

    expect(replayed.statusCode).toBe(200);
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({
      ok: false,
      error: "memory_extraction_dead_letter_operation_failed",
    });
    expect(record).toHaveBeenCalledOnce();
    expect(auditLog.events).toEqual([]);
    await app.close();
  });
});

function buildTestApp(overrides: Parameters<typeof buildApp>[0] = {}) {
  return buildApp({
    createAnswerDraftRuntime: () => undefined,
    createEventWorkerRuntime: () => undefined,
    createDocumentSyncRuntime: () => undefined,
    createReindexWorkerRuntime: () => undefined,
    ...overrides,
  });
}

function fakeMemoryExtractionRuntime(
  overrides: Partial<MemoryExtractionRuntime> = {},
): MemoryExtractionRuntime {
  return {
    planner: { registerMessage: vi.fn(async () => undefined) },
    deadLetters: {
      list: vi.fn(async () => []),
      replay: vi.fn(async () => "not_found" as const),
      replayBatch: vi.fn(async () => ({
        replayedCount: 0,
        notFoundIds: [],
        unsupportedLegacyIds: [],
      })),
      delete: vi.fn(async () => "not_found" as const),
    },
    getStatus: vi.fn(async () => memoryExtractionStatus()),
    start: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function memoryExtractionStatus(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true as const,
    running: true,
    workerHealthy: true,
    intervalMs: 1000,
    batchLimit: 20,
    minConfidence: 0.85,
    pendingJobCount: 3,
    processingJobCount: 2,
    delayedJobCount: 1,
    deadLetterJobCount: 0,
    acceptedCandidateCount: 9,
    rejectedCandidateCount: 7,
    duplicateCandidateCount: 3,
    conflictCandidateCount: 2,
    skippedRequestCount: 6,
    failedRunCount: 5,
    ...overrides,
  };
}

function readyRolloutEnv(): EnvLike {
  return {
    DATABASE_URL: "postgres://iris:iris@localhost:5432/iris",
    REDIS_URL: "redis://localhost:6379",
    IRIS_INTERNAL_API_TOKEN: "operator_shared_secret-1",
    FEISHU_VERIFICATION_TOKEN: "verification-token",
    FEISHU_APP_ID: "app-id",
    FEISHU_APP_SECRET: "app-secret",
    FEISHU_OPEN_BASE_URL: "https://open.feishu.cn",
    IRIS_FEISHU_BOT_OPEN_ID: "ou_iris",
    IRIS_EVENT_WORKER_ENABLED: "true",
    IRIS_DOCUMENT_SYNC_WORKER_ENABLED: "true",
    IRIS_REINDEX_WORKER_ENABLED: "true",
    IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "true",
    IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "source-policy",
    IRIS_MODEL_PROVIDER: "openai-compatible",
    IRIS_MODEL_BASE_URL: "https://model.example.com/v1",
    IRIS_MODEL_API_KEY: "model-key",
    IRIS_MODEL_NAME: "model-name",
    IRIS_EMBEDDING_PROVIDER: "openai-compatible",
    IRIS_EMBEDDING_BASE_URL: "https://embedding.example.com/v1",
    IRIS_EMBEDDING_API_KEY: "embedding-key",
    IRIS_EMBEDDING_MODEL: "embedding-model",
    IRIS_EMBEDDING_DIMENSIONS: "1536",
  };
}
