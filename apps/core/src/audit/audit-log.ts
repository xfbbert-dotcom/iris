export type PermissionGuardAuditEvent = {
  type: "permission_guard_denied" | "permission_guard_error";
  documentId: string;
  fragmentIds: string[];
  operatorHint?: string;
  message?: string;
};

export type RuntimeControlAuditEvent = {
  type: "runtime_control_updated";
  documentId: "runtime-control";
  fragmentIds: string[];
  runtimeControlScope: "global" | "group" | "capability";
  enabled: boolean;
  previousEnabled: boolean;
  targetId?: string;
  operatorHint?: string;
  message?: string;
};

export type AuditEvent = PermissionGuardAuditEvent | RuntimeControlAuditEvent;

export type RecordedAuditEvent = AuditEvent & {
  recordedAt: Date;
};

export type AuditEventSummary = {
  documentId: string;
  type: AuditEvent["type"];
  eventCount: number;
  affectedFragmentCount: number;
  firstRecordedAt: Date;
  latestRecordedAt: Date;
};

export type AuditEventSummaryQuery = {
  limit: number;
  documentId?: string;
  type?: AuditEvent["type"];
  operatorHint?: string;
};

export interface AuditLog {
  record(event: AuditEvent): Promise<void>;
}

export type InMemoryAuditLogOptions = {
  maxEvents?: number;
  now?: () => Date;
};

export class InMemoryAuditLog implements AuditLog {
  private readonly storedEvents: RecordedAuditEvent[] = [];
  private readonly maxEvents: number;
  private readonly now: () => Date;
  private droppedEvents = 0;

  constructor(options: InMemoryAuditLogOptions = {}) {
    this.maxEvents = options.maxEvents ?? 1000;
    this.now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.maxEvents) || this.maxEvents <= 0) {
      throw new Error("maxEvents must be a positive integer");
    }
  }

  get events(): RecordedAuditEvent[] {
    return this.storedEvents.map(cloneRecordedEvent);
  }

  async record(event: AuditEvent): Promise<void> {
    this.storedEvents.push({
      ...event,
      fragmentIds: [...event.fragmentIds],
      recordedAt: new Date(this.now()),
    });
    const overflow = this.storedEvents.length - this.maxEvents;
    if (overflow > 0) {
      this.storedEvents.splice(0, overflow);
      this.droppedEvents += overflow;
    }
  }

  get retention() {
    return {
      maxEventCount: this.maxEvents,
      retainedEventCount: this.storedEvents.length,
      droppedEventCount: this.droppedEvents,
    };
  }

  summarizeRecent(options: AuditEventSummaryQuery): AuditEventSummary[] {
    const limit = sanitizeLimit(options.limit);
    if (limit <= 0) {
      return [];
    }

    const summaries = new Map<
      string,
      AuditEventSummary & { affectedFragmentIds: Set<string> }
    >();

    for (const event of this.storedEvents.slice(-limit)) {
      if (options.documentId !== undefined && event.documentId !== options.documentId) {
        continue;
      }
      if (options.type !== undefined && event.type !== options.type) {
        continue;
      }
      if (options.operatorHint !== undefined && event.operatorHint !== options.operatorHint) {
        continue;
      }

      const key = `${event.documentId}:${event.type}`;
      const existing = summaries.get(key);
      if (existing === undefined) {
        summaries.set(key, {
          documentId: event.documentId,
          type: event.type,
          eventCount: 1,
          affectedFragmentCount: event.fragmentIds.length,
          firstRecordedAt: new Date(event.recordedAt),
          latestRecordedAt: new Date(event.recordedAt),
          affectedFragmentIds: new Set(event.fragmentIds),
        });
        continue;
      }

      existing.eventCount += 1;
      for (const fragmentId of event.fragmentIds) {
        existing.affectedFragmentIds.add(fragmentId);
      }
      existing.affectedFragmentCount = existing.affectedFragmentIds.size;
      if (event.recordedAt < existing.firstRecordedAt) {
        existing.firstRecordedAt = new Date(event.recordedAt);
      }
      if (event.recordedAt > existing.latestRecordedAt) {
        existing.latestRecordedAt = new Date(event.recordedAt);
      }
    }

    return [...summaries.values()]
      .sort((left, right) => {
        if (right.eventCount !== left.eventCount) {
          return right.eventCount - left.eventCount;
        }
        const latestDifference =
          right.latestRecordedAt.getTime() - left.latestRecordedAt.getTime();
        if (latestDifference !== 0) {
          return latestDifference;
        }
        return `${left.documentId}:${left.type}`.localeCompare(`${right.documentId}:${right.type}`);
      })
      .map(({ affectedFragmentIds: _affectedFragmentIds, ...summary }) => ({
        ...summary,
        firstRecordedAt: new Date(summary.firstRecordedAt),
        latestRecordedAt: new Date(summary.latestRecordedAt),
      }));
  }
}

function cloneRecordedEvent(event: RecordedAuditEvent): RecordedAuditEvent {
  return {
    ...event,
    fragmentIds: [...event.fragmentIds],
    recordedAt: new Date(event.recordedAt),
  };
}

function sanitizeLimit(value: number): number {
  if (Number.isFinite(value) && Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error("audit summary limit must be a finite safe-magnitude number");
  }

  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}
