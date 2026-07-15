import { describe, expect, it } from "vitest";

import { buildInternalStatusSnapshot } from "../src/admin/internal-status-snapshot.js";

describe("buildInternalStatusSnapshot", () => {
  it("derives aggregate and component statuses from a component map", () => {
    const snapshot = buildInternalStatusSnapshot({
      generatedAt: new Date("2026-07-03T08:00:00.000Z"),
      components: {
        audit: {
          ok: true,
          enabled: true,
          storage: "in_memory",
        },
        answerDraft: {
          ok: true,
          enabled: false,
        },
        eventWorker: {
          ok: false,
          enabled: true,
          running: false,
          error: "event_worker_status_failed",
        },
        documentSync: {
          ok: true,
          enabled: true,
          running: true,
        },
        reindex: {
          ok: true,
          enabled: true,
          running: false,
        },
      },
    });

    expect(snapshot).toEqual({
      ok: false,
      status: "degraded",
      schemaVersion: 1,
      generatedAt: "2026-07-03T08:00:00.000Z",
      componentOrder: ["audit", "answerDraft", "eventWorker", "documentSync", "reindex"],
      summary: {
        componentCount: 5,
        healthyComponentCount: 2,
        degradedComponentCount: 2,
        degradedComponents: ["eventWorker", "reindex"],
        enabledComponentCount: 4,
        disabledComponentCount: 1,
        disabledComponents: ["answerDraft"],
        enabledRuntimeComponentCount: 3,
        runningEnabledRuntimeComponentCount: 1,
        stoppedEnabledRuntimeComponentCount: 2,
        stoppedEnabledRuntimeComponents: ["eventWorker", "reindex"],
        componentStatusCounts: {
          healthy: 2,
          disabled: 1,
          degraded: 1,
          stopped: 1,
        },
        attentionComponents: [
          { name: "eventWorker", status: "degraded" },
          { name: "reindex", status: "stopped" },
          { name: "answerDraft", status: "disabled" },
        ],
        attentionComponentCount: 3,
        requiresOperatorAttention: true,
        primaryAttentionComponent: { name: "eventWorker", status: "degraded" },
        attentionSeverity: "critical",
      },
      components: {
        audit: {
          status: "healthy",
          ok: true,
          enabled: true,
          storage: "in_memory",
        },
        answerDraft: {
          status: "disabled",
          ok: true,
          enabled: false,
        },
        eventWorker: {
          status: "degraded",
          ok: false,
          enabled: true,
          running: false,
          error: "event_worker_status_failed",
        },
        documentSync: {
          status: "healthy",
          ok: true,
          enabled: true,
          running: true,
        },
        reindex: {
          status: "stopped",
          ok: true,
          enabled: true,
          running: false,
        },
      },
    });
  });

  it("returns no primary attention component when every component is healthy", () => {
    const snapshot = buildInternalStatusSnapshot({
      generatedAt: new Date("2026-07-03T08:05:00.000Z"),
      components: {
        audit: {
          ok: true,
          enabled: true,
        },
        eventWorker: {
          ok: true,
          enabled: true,
          running: true,
        },
      },
    });

    expect(snapshot.summary.attentionComponents).toEqual([]);
    expect(snapshot.summary.attentionComponentCount).toBe(0);
    expect(snapshot.summary.requiresOperatorAttention).toBe(false);
    expect(snapshot.summary.primaryAttentionComponent).toBeNull();
    expect(snapshot.summary.attentionSeverity).toBe("none");
  });

  it("marks enabled stopped runtime components as not ok", () => {
    const snapshot = buildInternalStatusSnapshot({
      generatedAt: new Date("2026-07-03T08:07:00.000Z"),
      components: {
        reindex: {
          ok: true,
          enabled: true,
          running: false,
        },
      },
    });

    expect(snapshot.ok).toBe(false);
    expect(snapshot.status).toBe("degraded");
    expect(snapshot.summary.stoppedEnabledRuntimeComponents).toEqual(["reindex"]);
    expect(snapshot.summary.primaryAttentionComponent).toEqual({
      name: "reindex",
      status: "stopped",
    });
    expect(snapshot.summary.attentionSeverity).toBe("warning");
  });

  it("marks a disabled unhealthy component degraded before considering disabled state", () => {
    const snapshot = buildInternalStatusSnapshot({
      generatedAt: new Date("2026-07-03T08:07:30.000Z"),
      components: {
        runtimeControl: {
          ok: false,
          enabled: false,
          globalEnabled: false,
          degradedReason: "runtime_control_persistence_failed",
        },
      },
    });

    expect(snapshot).toMatchObject({
      ok: false,
      status: "degraded",
      summary: {
        degradedComponents: ["runtimeControl"],
        disabledComponents: ["runtimeControl"],
        primaryAttentionComponent: {
          name: "runtimeControl",
          status: "degraded",
        },
        attentionSeverity: "critical",
      },
      components: {
        runtimeControl: {
          status: "degraded",
          ok: false,
          enabled: false,
          globalEnabled: false,
          degradedReason: "runtime_control_persistence_failed",
        },
      },
    });
  });

  it("summarizes component health from derived component statuses", () => {
    const snapshot = buildInternalStatusSnapshot({
      generatedAt: new Date("2026-07-03T08:08:00.000Z"),
      components: {
        reindex: {
          ok: true,
          enabled: true,
          running: false,
        },
      },
    });

    expect(snapshot.summary.healthyComponentCount).toBe(0);
    expect(snapshot.summary.degradedComponentCount).toBe(1);
    expect(snapshot.summary.degradedComponents).toEqual(["reindex"]);
  });

  it("degrades for an enabled memory extraction runtime with an unavailable AI worker", () => {
    const snapshot = buildInternalStatusSnapshot({
      generatedAt: new Date("2026-07-15T03:00:00.000Z"),
      components: {
        memoryExtraction: {
          ok: false,
          enabled: true,
          running: true,
          workerHealthy: false,
          pendingJobCount: 3,
          processingJobCount: 2,
          delayedJobCount: 1,
          deadLetterJobCount: 0,
          providerCooldownUntil: new Date("2026-07-15T04:00:00.000Z"),
          degradedReason: "ai_worker_unavailable",
        },
      },
    });

    expect(snapshot).toMatchObject({
      ok: false,
      status: "degraded",
      componentOrder: ["memoryExtraction"],
      summary: {
        degradedComponents: ["memoryExtraction"],
        stoppedEnabledRuntimeComponents: [],
        primaryAttentionComponent: {
          name: "memoryExtraction",
          status: "degraded",
        },
      },
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
          providerCooldownUntil: new Date("2026-07-15T04:00:00.000Z"),
          degradedReason: "ai_worker_unavailable",
        },
      },
    });
  });

  it("does not share nested component values with the returned snapshot", () => {
    const latestBatch = {
      status: "succeeded" as const,
      startedAt: new Date("2026-07-03T08:10:00.000Z"),
      finishedAt: new Date("2026-07-03T08:10:01.000Z"),
      processedCount: 1,
      failedCount: 0,
      failed: false as const,
    };
    const retention = {
      maxEventCount: 100,
      retainedEventCount: 2,
      droppedEventCount: 0,
    };
    const snapshot = buildInternalStatusSnapshot({
      generatedAt: new Date("2026-07-03T08:10:02.000Z"),
      components: {
        audit: {
          ok: true,
          enabled: true,
          retention,
        },
        eventWorker: {
          ok: true,
          enabled: true,
          running: true,
          latestBatch,
        },
      },
    });

    snapshot.components.audit.retention.retainedEventCount = 999;
    snapshot.components.eventWorker.latestBatch.startedAt.setUTCFullYear(2030);
    snapshot.components.eventWorker.latestBatch.processedCount = 999;

    expect(retention).toEqual({
      maxEventCount: 100,
      retainedEventCount: 2,
      droppedEventCount: 0,
    });
    expect(latestBatch).toEqual({
      status: "succeeded",
      startedAt: new Date("2026-07-03T08:10:00.000Z"),
      finishedAt: new Date("2026-07-03T08:10:01.000Z"),
      processedCount: 1,
      failedCount: 0,
      failed: false,
    });
  });
});
