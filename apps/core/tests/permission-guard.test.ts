import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditLog, type AuditEvent } from "../src/audit/audit-log.js";
import { filterFragmentsByLivePermission } from "../src/permissions/permission-guard.js";

describe("filterFragmentsByLivePermission", () => {
  it("keeps only fragments whose document IDs pass live permission checks", async () => {
    const fragments = [
      { id: "frag-1", documentId: "doc-allowed", text: "Allowed content" },
      { id: "frag-2", documentId: "doc-denied", text: "Denied content" }
    ];

    const result = await filterFragmentsByLivePermission({
      fragments,
      canReadDocument: async (documentId) => documentId === "doc-allowed"
    });

    expect(result.allowedFragments).toEqual([fragments[0]]);
    expect(result.deniedDocumentIds).toEqual(["doc-denied"]);
  });

  it("excludes fragments when live permission checks throw", async () => {
    const fragments = [{ id: "frag-1", documentId: "doc-timeout", text: "Uncertain content" }];

    const result = await filterFragmentsByLivePermission({
      fragments,
      canReadDocument: async () => {
        throw new Error("Feishu permission timeout");
      }
    });

    expect(result.allowedFragments).toEqual([]);
    expect(result.deniedDocumentIds).toEqual(["doc-timeout"]);
  });

  it("checks duplicate allowed document IDs once and keeps all allowed fragments", async () => {
    const fragments = [
      { id: "frag-1", documentId: "doc-allowed", text: "Allowed content A" },
      { id: "frag-2", documentId: "doc-allowed", text: "Allowed content B" }
    ];
    const canReadDocument = vi.fn(async () => true);

    const result = await filterFragmentsByLivePermission({
      fragments,
      canReadDocument
    });

    expect(canReadDocument).toHaveBeenCalledTimes(1);
    expect(canReadDocument).toHaveBeenCalledWith("doc-allowed");
    expect(result.allowedFragments).toEqual(fragments);
    expect(result.deniedDocumentIds).toEqual([]);
  });

  it("checks distinct document permissions concurrently while preserving output order", async () => {
    const fragments = [
      { id: "frag-1", documentId: "doc-slow-allowed", text: "Allowed content" },
      { id: "frag-2", documentId: "doc-slow-denied", text: "Denied content" },
      { id: "frag-3", documentId: "doc-fast-allowed", text: "More allowed content" },
    ];
    const resolvers = new Map<string, (allowed: boolean) => void>();
    const canReadDocument = vi.fn(
      async (documentId: string) =>
        new Promise<boolean>((resolve) => {
          resolvers.set(documentId, resolve);
        }),
    );

    const pending = filterFragmentsByLivePermission({
      fragments,
      canReadDocument,
    });
    await Promise.resolve();

    expect(canReadDocument).toHaveBeenCalledTimes(3);
    resolvers.get("doc-slow-denied")?.(false);
    resolvers.get("doc-fast-allowed")?.(true);
    resolvers.get("doc-slow-allowed")?.(true);

    await expect(pending).resolves.toEqual({
      allowedFragments: [fragments[0], fragments[2]],
      deniedDocumentIds: ["doc-slow-denied"],
    });
  });

  it("checks duplicate denied document IDs once, excludes all denied fragments, and reports the document once", async () => {
    const fragments = [
      { id: "frag-1", documentId: "doc-denied", text: "Denied content A" },
      { id: "frag-2", documentId: "doc-denied", text: "Denied content B" }
    ];
    const canReadDocument = vi.fn(async () => false);

    const result = await filterFragmentsByLivePermission({
      fragments,
      canReadDocument
    });

    expect(canReadDocument).toHaveBeenCalledTimes(1);
    expect(canReadDocument).toHaveBeenCalledWith("doc-denied");
    expect(result.allowedFragments).toEqual([]);
    expect(result.deniedDocumentIds).toEqual(["doc-denied"]);
  });

  it("records one audit event per denied document with all fragment IDs from the call", async () => {
    const fragments = [
      { id: "frag-1", documentId: "doc-denied", text: "Denied content A" },
      { id: "frag-2", documentId: "doc-denied", text: "Denied content B" }
    ];
    const auditLog = new InMemoryAuditLog();

    const result = await filterFragmentsByLivePermission({
      fragments,
      canReadDocument: async () => false,
      auditLog
    });

    expect(result.allowedFragments).toEqual([]);
    expect(result.deniedDocumentIds).toEqual(["doc-denied"]);
    expect(auditLog.events).toEqual([
      {
        type: "permission_guard_denied",
        documentId: "doc-denied",
        fragmentIds: ["frag-1", "frag-2"],
        recordedAt: expect.any(Date),
      }
    ]);
  });

  it("records one audit event per errored document with all fragment IDs and the error message", async () => {
    const fragments = [
      { id: "frag-1", documentId: "doc-timeout", text: "Uncertain content A" },
      { id: "frag-2", documentId: "doc-timeout", text: "Uncertain content B" }
    ];
    const auditLog = new InMemoryAuditLog();

    const result = await filterFragmentsByLivePermission({
      fragments,
      canReadDocument: async () => {
        throw new Error("Feishu permission timeout");
      },
      auditLog
    });

    expect(result.allowedFragments).toEqual([]);
    expect(result.deniedDocumentIds).toEqual(["doc-timeout"]);
    expect(auditLog.events).toEqual([
      {
        type: "permission_guard_error",
        documentId: "doc-timeout",
        fragmentIds: ["frag-1", "frag-2"],
        message: "Feishu permission timeout",
        recordedAt: expect.any(Date),
      }
    ]);
  });

  it("bounds permission guard audit error messages before recording them", async () => {
    const fragments = [{ id: "frag-1", documentId: "doc-timeout", text: "Uncertain content" }];
    const oversizedMessage = `${"E".repeat(1200)} trailing diagnostic detail`;
    const record = vi.fn(async (_event: AuditEvent) => undefined);
    const auditLog = {
      record,
    };

    await filterFragmentsByLivePermission({
      fragments,
      canReadDocument: async () => {
        throw new Error(oversizedMessage);
      },
      auditLog,
    });

    expect(auditLog.record).toHaveBeenCalledWith({
      type: "permission_guard_error",
      documentId: "doc-timeout",
      fragmentIds: ["frag-1"],
      message: expect.stringContaining("[truncated]"),
    });
    const event = record.mock.calls[0]?.[0];
    if (event === undefined) {
      throw new Error("expected audit event");
    }
    expect(event.message?.length).toBeLessThanOrEqual(1000);
    expect(event.message).not.toContain("trailing diagnostic detail");
  });

  it("does not fail permission filtering when audit recording fails", async () => {
    const fragments = [
      { id: "frag-1", documentId: "doc-denied", text: "Denied content A" },
      { id: "frag-2", documentId: "doc-allowed", text: "Allowed content B" }
    ];
    const auditLog = {
      record: vi.fn(async () => {
        throw new Error("audit store unavailable");
      })
    };

    const result = await filterFragmentsByLivePermission({
      fragments,
      canReadDocument: async (documentId) => documentId === "doc-allowed",
      auditLog
    });

    expect(result.allowedFragments).toEqual([fragments[1]]);
    expect(result.deniedDocumentIds).toEqual(["doc-denied"]);
    expect(auditLog.record).toHaveBeenCalledWith({
      type: "permission_guard_denied",
      documentId: "doc-denied",
      fragmentIds: ["frag-1"]
    });
  });
});
