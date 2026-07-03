import { describe, expect, it } from "vitest";

import { InMemoryAuditLog } from "../src/audit/audit-log.js";

describe("InMemoryAuditLog", () => {
  it("records audit events with default retention", async () => {
    const auditLog = new InMemoryAuditLog();

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
      },
      {
        type: "permission_guard_error",
        documentId: "source-3",
        fragmentIds: ["fragment-3"],
        message: "permission lookup failed",
      },
    ]);
  });
});
