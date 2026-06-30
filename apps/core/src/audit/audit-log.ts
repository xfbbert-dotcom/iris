export type AuditEvent = {
  type: "permission_guard_denied" | "permission_guard_error";
  documentId: string;
  fragmentIds: string[];
  message?: string;
};

export interface AuditLog {
  record(event: AuditEvent): Promise<void>;
}

export class InMemoryAuditLog implements AuditLog {
  readonly events: AuditEvent[] = [];

  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}
