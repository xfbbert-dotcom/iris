export type AuditEvent = {
  type: "permission_guard_denied" | "permission_guard_error";
  documentId: string;
  fragmentIds: string[];
  message?: string;
};

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
};

export interface AuditLog {
  record(event: AuditEvent): Promise<void>;
}

export type InMemoryAuditLogOptions = {
  maxEvents?: number;
  now?: () => Date;
};

export class InMemoryAuditLog implements AuditLog {
  readonly events: RecordedAuditEvent[] = [];
  private readonly maxEvents: number;
  private readonly now: () => Date;

  constructor(options: InMemoryAuditLogOptions = {}) {
    this.maxEvents = options.maxEvents ?? 1000;
    this.now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.maxEvents) || this.maxEvents <= 0) {
      throw new Error("maxEvents must be a positive integer");
    }
  }

  async record(event: AuditEvent): Promise<void> {
    this.events.push({
      ...event,
      fragmentIds: [...event.fragmentIds],
      recordedAt: new Date(this.now()),
    });
    const overflow = this.events.length - this.maxEvents;
    if (overflow > 0) {
      this.events.splice(0, overflow);
    }
  }

  summarizeRecent(options: AuditEventSummaryQuery): AuditEventSummary[] {
    if (options.limit <= 0) {
      return [];
    }

    const summaries = new Map<
      string,
      AuditEventSummary & { affectedFragmentIds: Set<string> }
    >();

    for (const event of this.events.slice(-options.limit)) {
      if (options.documentId !== undefined && event.documentId !== options.documentId) {
        continue;
      }
      if (options.type !== undefined && event.type !== options.type) {
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
