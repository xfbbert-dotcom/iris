import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditLog } from "../src/audit/audit-log.js";
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
