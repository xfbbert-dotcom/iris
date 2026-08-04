import { describe, expect, it } from "vitest";

import { InMemoryAuditLog } from "../src/audit/audit-log.js";

describe("InMemoryAuditLog", () => {
  it("records content-free memory extraction lifecycle and recovery events", async () => {
    const auditLog = new InMemoryAuditLog({
      now: () => new Date("2026-07-15T01:00:00.000Z"),
    });

    await auditLog.record({
      type: "memory_extraction_completed",
      documentId: "run-1",
      fragmentIds: ["feishu:msg-1", "feishu:msg-2"],
      message: "completed",
    });
    await auditLog.record({
      type: "memory_extraction_skipped",
      documentId: "request-1",
      fragmentIds: [],
      message: "runtime_disabled_before_load",
    });
    await auditLog.record({
      type: "memory_extraction_failed",
      documentId: "run-2",
      fragmentIds: ["feishu:msg-3"],
      message: "provider_timeout",
    });
    await auditLog.record({
      type: "memory_extraction_dlq_replayed",
      documentId: "dlq-1",
      fragmentIds: ["request-2"],
      message: "replayed",
    });
    await auditLog.record({
      type: "memory_extraction_dlq_deleted",
      documentId: "dlq-2",
      fragmentIds: ["request-3"],
      message: "deleted",
    });

    expect(auditLog.events.map(({ recordedAt: _recordedAt, ...event }) => event)).toEqual([
      {
        type: "memory_extraction_completed",
        documentId: "run-1",
        fragmentIds: ["feishu:msg-1", "feishu:msg-2"],
        message: "completed",
      },
      {
        type: "memory_extraction_skipped",
        documentId: "request-1",
        fragmentIds: [],
        message: "runtime_disabled_before_load",
      },
      {
        type: "memory_extraction_failed",
        documentId: "run-2",
        fragmentIds: ["feishu:msg-3"],
        message: "provider_timeout",
      },
      {
        type: "memory_extraction_dlq_replayed",
        documentId: "dlq-1",
        fragmentIds: ["request-2"],
        message: "replayed",
      },
      {
        type: "memory_extraction_dlq_deleted",
        documentId: "dlq-2",
        fragmentIds: ["request-3"],
        message: "deleted",
      },
    ]);
  });

  it("records memory lifecycle events without requiring memory content", async () => {
    const auditLog = new InMemoryAuditLog({
      now: () => new Date("2026-07-14T01:00:00.000Z"),
    });

    await auditLog.record({
      type: "group_memory_corrected",
      documentId: "memory-2",
      fragmentIds: ["msg-1"],
      operatorHint: "alice",
      message: "supersedes:memory-1",
    });

    expect(auditLog.events).toEqual([
      {
        type: "group_memory_corrected",
        documentId: "memory-2",
        fragmentIds: ["msg-1"],
        operatorHint: "alice",
        message: "supersedes:memory-1",
        recordedAt: new Date("2026-07-14T01:00:00.000Z"),
      },
    ]);
  });

  it("records audit events with default retention", async () => {
    const recordedAt = new Date("2026-07-03T06:00:00.000Z");
    const auditLog = new InMemoryAuditLog({ now: () => recordedAt });

    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    });

    expect(auditLog.events).toEqual([
      {
        type: "permission_guard_denied",
        documentId: "source-1",
        fragmentIds: ["fragment-1"],
        recordedAt,
      },
    ]);
  });

  it("clones recorded events so caller mutation cannot change history", async () => {
    const recordedAt = new Date("2026-07-03T06:01:00.000Z");
    const auditLog = new InMemoryAuditLog({ now: () => recordedAt });
    const event = {
      type: "permission_guard_error" as const,
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
      message: "original",
    };

    await auditLog.record(event);
    event.documentId = "source-mutated";
    event.fragmentIds.push("fragment-mutated");
    event.message = "mutated";

    expect(auditLog.events).toEqual([
      {
        type: "permission_guard_error",
        documentId: "source-1",
        fragmentIds: ["fragment-1"],
        message: "original",
        recordedAt,
      },
    ]);
  });

  it("bounds recorded audit event messages", async () => {
    const recordedAt = new Date("2026-07-03T06:01:15.000Z");
    const auditLog = new InMemoryAuditLog({ now: () => recordedAt });
    const oversizedMessage = `${"E".repeat(1200)} trailing diagnostic detail`;

    await auditLog.record({
      type: "permission_guard_error",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
      message: oversizedMessage,
    });

    const [event] = auditLog.events;
    expect(event?.message?.length).toBeLessThanOrEqual(1000);
    expect(event?.message).toContain("[truncated]");
    expect(event?.message).not.toContain("trailing diagnostic detail");
  });

  it("clones returned events so readers cannot change history", async () => {
    const recordedAt = new Date("2026-07-03T06:01:30.000Z");
    const auditLog = new InMemoryAuditLog({ now: () => recordedAt });

    await auditLog.record({
      type: "permission_guard_error",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
      message: "original",
    });

    const [returned] = auditLog.events;
    returned.documentId = "source-mutated";
    returned.fragmentIds.push("fragment-mutated");
    returned.recordedAt.setUTCFullYear(2030);
    returned.message = "mutated";

    expect(auditLog.events).toEqual([
      {
        type: "permission_guard_error",
        documentId: "source-1",
        fragmentIds: ["fragment-1"],
        message: "original",
        recordedAt,
      },
    ]);
  });

  it("rejects invalid max event limits", () => {
    expect(() => new InMemoryAuditLog({ maxEvents: 0 })).toThrow(
      "maxEvents must be a positive integer",
    );
    expect(() => new InMemoryAuditLog({ maxEvents: 1.5 })).toThrow(
      "maxEvents must be a positive integer",
    );
  });

  it("retains only the newest audit events", async () => {
    const recordedAt = new Date("2026-07-03T06:02:00.000Z");
    const auditLog = new InMemoryAuditLog({ maxEvents: 2, now: () => recordedAt });

    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-2",
      fragmentIds: ["fragment-2"],
    });
    await auditLog.record({
      type: "permission_guard_error",
      documentId: "source-3",
      fragmentIds: ["fragment-3"],
      message: "permission lookup failed",
    });

    expect(auditLog.events).toEqual([
      {
        type: "permission_guard_denied",
        documentId: "source-2",
        fragmentIds: ["fragment-2"],
        recordedAt,
      },
      {
        type: "permission_guard_error",
        documentId: "source-3",
        fragmentIds: ["fragment-3"],
        message: "permission lookup failed",
        recordedAt,
      },
    ]);
  });

  it("reports in-memory retention capacity and dropped audit events", async () => {
    const auditLog = new InMemoryAuditLog({ maxEvents: 2 });

    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-2",
      fragmentIds: ["fragment-2"],
    });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-3",
      fragmentIds: ["fragment-3"],
    });

    expect(auditLog.retention).toEqual({
      maxEventCount: 2,
      retainedEventCount: 2,
      droppedEventCount: 1,
    });
  });

  it("summarizes recent audit events by document and type", async () => {
    const recordedTimes = [
      new Date("2026-07-03T06:00:00.000Z"),
      new Date("2026-07-03T06:01:00.000Z"),
      new Date("2026-07-03T06:02:00.000Z"),
      new Date("2026-07-03T06:03:00.000Z"),
    ];
    let nowIndex = 0;
    const auditLog = new InMemoryAuditLog({
      now: () => recordedTimes[nowIndex++] ?? recordedTimes.at(-1)!,
    });

    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-old",
      fragmentIds: ["fragment-old"],
    });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    });
    await auditLog.record({
      type: "permission_guard_error",
      documentId: "source-2",
      fragmentIds: ["fragment-2"],
      message: "permission lookup failed",
    });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1", "fragment-3"],
    });

    expect(auditLog.summarizeRecent({ limit: 3 })).toEqual([
      {
        documentId: "source-1",
        type: "permission_guard_denied",
        eventCount: 2,
        affectedFragmentCount: 2,
        firstRecordedAt: new Date("2026-07-03T06:01:00.000Z"),
        latestRecordedAt: new Date("2026-07-03T06:03:00.000Z"),
      },
      {
        documentId: "source-2",
        type: "permission_guard_error",
        eventCount: 1,
        affectedFragmentCount: 1,
        firstRecordedAt: new Date("2026-07-03T06:02:00.000Z"),
        latestRecordedAt: new Date("2026-07-03T06:02:00.000Z"),
      },
    ]);
  });

  it("returns no audit summary rows when the recent event limit is zero", async () => {
    const auditLog = new InMemoryAuditLog();

    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    });

    expect(auditLog.summarizeRecent({ limit: 0 })).toEqual([]);
  });

  it("rejects non-finite recent event limits", async () => {
    const auditLog = new InMemoryAuditLog();

    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    });

    expect(() => auditLog.summarizeRecent({ limit: Number.POSITIVE_INFINITY })).toThrow(
      "audit summary limit must be a finite safe-magnitude number",
    );
    expect(() => auditLog.summarizeRecent({ limit: Number.NaN })).toThrow(
      "audit summary limit must be a finite safe-magnitude number",
    );
  });

  it("caps oversized recent event limits before summarizing", async () => {
    const auditLog = new InMemoryAuditLog({ maxEvents: 200 });

    for (let index = 0; index < 101; index += 1) {
      await auditLog.record({
        type: "permission_guard_denied",
        documentId: "source-1",
        fragmentIds: [`fragment-${index}`],
      });
    }

    expect(auditLog.summarizeRecent({ limit: 101 })).toEqual([
      expect.objectContaining({
        documentId: "source-1",
        type: "permission_guard_denied",
        eventCount: 100,
        affectedFragmentCount: 100,
      }),
    ]);
  });

  it("rejects unsafe recent event limits", async () => {
    const auditLog = new InMemoryAuditLog();

    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    });

    expect(() => auditLog.summarizeRecent({ limit: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      "audit summary limit must be a finite safe-magnitude number",
    );
  });

  it("filters audit summaries by document and event type", async () => {
    const recordedAt = new Date("2026-07-03T06:04:00.000Z");
    const auditLog = new InMemoryAuditLog({ now: () => recordedAt });

    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    });
    await auditLog.record({
      type: "permission_guard_error",
      documentId: "source-1",
      fragmentIds: ["fragment-2"],
      message: "permission lookup failed",
    });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-2",
      fragmentIds: ["fragment-3"],
    });

    expect(
      auditLog.summarizeRecent({
        limit: 20,
        documentId: "source-1",
        type: "permission_guard_denied",
      }),
    ).toEqual([
      {
        documentId: "source-1",
        type: "permission_guard_denied",
        eventCount: 1,
        affectedFragmentCount: 1,
        firstRecordedAt: recordedAt,
        latestRecordedAt: recordedAt,
      },
    ]);
  });

  it("applies filtered audit summary limits after matching retained events", async () => {
    const recordedTimes = [
      new Date("2026-07-05T02:00:00.000Z"),
      new Date("2026-07-05T02:01:00.000Z"),
      new Date("2026-07-05T02:02:00.000Z"),
    ];
    let nowIndex = 0;
    const auditLog = new InMemoryAuditLog({
      now: () => recordedTimes[nowIndex++] ?? recordedTimes.at(-1)!,
    });

    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    });
    await auditLog.record({
      type: "permission_guard_error",
      documentId: "source-2",
      fragmentIds: ["fragment-2"],
      message: "newer unrelated event",
    });
    await auditLog.record({
      type: "runtime_control_updated",
      documentId: "runtime-control",
      fragmentIds: [],
      runtimeControlScope: "global",
      enabled: false,
      previousEnabled: true,
    });

    expect(
      auditLog.summarizeRecent({
        limit: 1,
        documentId: "source-1",
        type: "permission_guard_denied",
      }),
    ).toEqual([
      {
        documentId: "source-1",
        type: "permission_guard_denied",
        eventCount: 1,
        affectedFragmentCount: 1,
        firstRecordedAt: new Date("2026-07-05T02:00:00.000Z"),
        latestRecordedAt: new Date("2026-07-05T02:00:00.000Z"),
      },
    ]);
  });
});
