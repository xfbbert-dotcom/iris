import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PostgresAuditLog,
  createPostgresAuditEventStore,
  type AuditEventStore,
} from "../src/audit/postgres-audit-log.js";
import type { RecordedAuditEvent } from "../src/audit/audit-log.js";
import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";

describe("PostgresAuditLog", () => {
  it("restores retained events and dropped counts", async () => {
    const restoredEvent = permissionEvent("source-restored", "2026-07-29T06:00:00.000Z");
    const store = fakeAuditEventStore({
      load: vi.fn(async () => ({
        events: [restoredEvent],
        droppedEventCount: 4,
      })),
    });

    const auditLog = await PostgresAuditLog.create(store, { maxEvents: 10 });

    expect(auditLog.storage).toBe("postgres");
    expect(auditLog.events).toEqual([restoredEvent]);
    expect(auditLog.retention).toEqual({
      maxEventCount: 10,
      retainedEventCount: 1,
      droppedEventCount: 4,
    });
  });

  it("does not expose an event in memory until its durable write succeeds", async () => {
    let shouldFail = true;
    const store = fakeAuditEventStore({
      record: vi.fn(async () => {
        if (shouldFail) {
          throw new Error("audit database unavailable");
        }
      }),
    });
    const auditLog = await PostgresAuditLog.create(store);
    const event = {
      type: "permission_guard_denied" as const,
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    };

    await expect(auditLog.record(event)).rejects.toThrow("audit database unavailable");
    expect(auditLog.events).toEqual([]);

    shouldFail = false;
    await auditLog.record(event);
    expect(auditLog.events).toHaveLength(1);
  });

  it("serializes durable writes in record order", async () => {
    const recordedDocumentIds: string[] = [];
    let releaseFirst: () => void = () => undefined;
    let markFirstStarted: () => void = () => undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const store = fakeAuditEventStore({
      record: vi.fn(async (event) => {
        recordedDocumentIds.push(event.documentId);
        if (event.documentId === "source-1") {
          markFirstStarted();
          await firstWrite;
        }
      }),
    });
    const auditLog = await PostgresAuditLog.create(store);

    const first = auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: [],
    });
    const second = auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-2",
      fragmentIds: [],
    });
    await firstStarted;

    expect(recordedDocumentIds).toEqual(["source-1"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(recordedDocumentIds).toEqual(["source-1", "source-2"]);
    expect(auditLog.events.map((event) => event.documentId)).toEqual([
      "source-1",
      "source-2",
    ]);
  });
});

function fakeAuditEventStore(
  overrides: Partial<AuditEventStore> = {},
): AuditEventStore {
  return {
    load: async () => ({ events: [], droppedEventCount: 0 }),
    record: async () => undefined,
    ...overrides,
  };
}

function permissionEvent(documentId: string, recordedAt: string): RecordedAuditEvent {
  return {
    type: "permission_guard_denied",
    documentId,
    fragmentIds: [`fragment-${documentId}`],
    recordedAt: new Date(recordedAt),
  };
}

const databaseUrl = process.env.DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;

runIfDatabase("Postgres audit retention and restart recovery", () => {
  const schemaName = `audit_test_${randomUUID().replaceAll("-", "")}`;
  let adminPool: pg.Pool;
  let isolatedPool: pg.Pool;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: databaseUrl });
    await adminPool.query(`create schema "${schemaName}"`);
    isolatedPool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
    });
    const client = await isolatedPool.connect();
    try {
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await isolatedPool.end();
    await adminPool.query(`drop schema "${schemaName}" cascade`);
    await adminPool.end();
  });

  it("retains a bounded durable history and restores it in a new instance", async () => {
    const times = [
      new Date("2026-07-29T06:00:00.000Z"),
      new Date("2026-07-29T06:01:00.000Z"),
      new Date("2026-07-29T06:02:00.000Z"),
    ];
    let nowIndex = 0;
    const store = createPostgresAuditEventStore(isolatedPool);
    const first = await PostgresAuditLog.create(store, {
      maxEvents: 2,
      now: () => times[nowIndex++] ?? times.at(-1)!,
    });

    await first.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    });
    await first.record({
      type: "permission_guard_error",
      documentId: "source-2",
      fragmentIds: ["fragment-2"],
      message: "permission lookup failed",
    });
    await first.record({
      type: "runtime_control_updated",
      documentId: "runtime-control",
      fragmentIds: [],
      runtimeControlScope: "global",
      enabled: false,
      previousEnabled: true,
    });

    const restarted = await PostgresAuditLog.create(store, { maxEvents: 2 });
    expect(restarted.events.map((event) => event.documentId)).toEqual([
      "source-2",
      "runtime-control",
    ]);
    expect(restarted.retention).toEqual({
      maxEventCount: 2,
      retainedEventCount: 2,
      droppedEventCount: 1,
    });
    await expect(
      isolatedPool.query<{ count: string }>("select count(*) from audit_events"),
    ).resolves.toMatchObject({ rows: [{ count: "2" }] });
  });
});
