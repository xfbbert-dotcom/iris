import type pg from "pg";

import {
  InMemoryAuditLog,
  type AuditEvent,
  type InMemoryAuditLogOptions,
  type RecordedAuditEvent,
} from "./audit-log.js";

type AuditEventRow = {
  payload: unknown;
  recorded_at: Date;
};

type AuditMetadataRow = {
  dropped_event_count: string | number;
};

export type AuditEventStore = {
  load(maxEvents: number): Promise<{
    events: RecordedAuditEvent[];
    droppedEventCount: number;
  }>;
  record(event: RecordedAuditEvent, maxEvents: number): Promise<void>;
};

export class PostgresAuditLog extends InMemoryAuditLog {
  override readonly storage = "postgres" as const;
  private writeTail: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly store: AuditEventStore,
    options: InMemoryAuditLogOptions,
  ) {
    super(options);
  }

  static async create(
    store: AuditEventStore,
    options: InMemoryAuditLogOptions = {},
  ): Promise<PostgresAuditLog> {
    const auditLog = new PostgresAuditLog(store, options);
    const restored = await store.load(auditLog.maxEventCount);
    auditLog.restoreRecordedEvents(restored.events, restored.droppedEventCount);
    return auditLog;
  }

  override record(event: AuditEvent): Promise<void> {
    const recordedEvent = this.createRecordedEvent(event);
    const result = this.writeTail.catch(() => undefined).then(async () => {
      await this.store.record(recordedEvent, this.maxEventCount);
      this.appendRecordedEvent(recordedEvent);
    });
    this.writeTail = result;
    return result;
  }
}

export function createPostgresAuditEventStore(
  pool: Pick<pg.Pool, "query" | "connect">,
): AuditEventStore {
  return {
    async load(maxEvents) {
      const [eventsResult, metadataResult] = await Promise.all([
        pool.query<AuditEventRow>(
          `select payload, recorded_at
from audit_events
order by recorded_at desc, id desc
limit $1`,
          [maxEvents],
        ),
        pool.query<AuditMetadataRow>(
          `select dropped_event_count
from audit_log_metadata
where singleton = true`,
        ),
      ]);
      const metadata = metadataResult.rows[0];
      const droppedEventCount =
        metadata === undefined ? 0 : parseDroppedEventCount(metadata.dropped_event_count);

      return {
        events: eventsResult.rows.map(toRecordedAuditEvent).reverse(),
        droppedEventCount,
      };
    },

    async record(event, maxEvents) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          "select pg_advisory_xact_lock(hashtext('iris_audit_log'))",
        );
        await client.query(
          `insert into audit_events (payload, recorded_at)
values ($1::jsonb, $2)`,
          [JSON.stringify(toStoredPayload(event)), event.recordedAt],
        );
        const overflow = await client.query<{ id: string }>(
          `select id
from audit_events
order by recorded_at desc, id desc
offset $1`,
          [maxEvents],
        );
        const overflowIds = overflow.rows.map((row) => row.id);
        if (overflowIds.length > 0) {
          await client.query("delete from audit_events where id = any($1::bigint[])", [
            overflowIds,
          ]);
          await client.query(
            `insert into audit_log_metadata (singleton, dropped_event_count)
values (true, $1)
on conflict (singleton) do update
set dropped_event_count =
  audit_log_metadata.dropped_event_count + excluded.dropped_event_count`,
            [overflowIds.length],
          );
        }
        await client.query("commit");
      } catch (error) {
        try {
          await client.query("rollback");
        } catch {
          // Preserve the original persistence failure.
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function toStoredPayload(event: RecordedAuditEvent): AuditEvent {
  const { recordedAt: _recordedAt, ...payload } = event;
  return {
    ...payload,
    fragmentIds: [...payload.fragmentIds],
  };
}

function toRecordedAuditEvent(row: AuditEventRow): RecordedAuditEvent {
  if (!(row.recorded_at instanceof Date) || !Number.isFinite(row.recorded_at.getTime())) {
    throw new Error("stored audit event has an invalid recorded_at");
  }
  const payload = parseStoredAuditEvent(row.payload);
  return {
    ...payload,
    fragmentIds: [...payload.fragmentIds],
    recordedAt: new Date(row.recorded_at),
  };
}

function parseStoredAuditEvent(value: unknown): AuditEvent {
  if (!isRecord(value)) {
    throw new Error("stored audit event payload must be an object");
  }
  const type = value.type;
  const documentId = value.documentId;
  const fragmentIds = value.fragmentIds;
  if (
    (type !== "permission_guard_denied" &&
      type !== "permission_guard_error" &&
      type !== "runtime_control_updated") ||
    typeof documentId !== "string" ||
    !Array.isArray(fragmentIds) ||
    !fragmentIds.every((fragmentId) => typeof fragmentId === "string")
  ) {
    throw new Error("stored audit event payload is invalid");
  }
  const optional = parseOptionalAuditFields(value);

  if (type === "runtime_control_updated") {
    const scope = value.runtimeControlScope;
    if (
      documentId !== "runtime-control" ||
      (scope !== "global" && scope !== "group" && scope !== "capability") ||
      typeof value.enabled !== "boolean" ||
      typeof value.previousEnabled !== "boolean"
    ) {
      throw new Error("stored runtime control audit event payload is invalid");
    }
    return {
      type,
      documentId,
      fragmentIds,
      runtimeControlScope: scope,
      enabled: value.enabled,
      previousEnabled: value.previousEnabled,
      ...optional,
      ...(typeof value.targetId === "string" ? { targetId: value.targetId } : {}),
    };
  }

  return {
    type,
    documentId,
    fragmentIds,
    ...optional,
  };
}

function parseOptionalAuditFields(value: Record<string, unknown>): {
  operatorHint?: string;
  message?: string;
} {
  return {
    ...(typeof value.operatorHint === "string"
      ? { operatorHint: value.operatorHint }
      : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
  };
}

function parseDroppedEventCount(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("stored audit dropped event count is invalid");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
