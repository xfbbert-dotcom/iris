export type AuditEvent = {
  type: "permission_guard_denied" | "permission_guard_error";
  documentId: string;
  fragmentIds: string[];
  message?: string;
};

export type RecordedAuditEvent = AuditEvent & {
  recordedAt: Date;
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
}
