import { describe, expect, it } from "vitest";

import { createAnswerSourcePermissionVerifier } from
  "../src/answer-replies/answer-source-permission-verifier.js";

describe("AnswerSourcePermissionVerifier managed freshness barrier", () => {
  it("blocks a prepared reply source that entered the managed freshness barrier", async () => {
    const verifier = createAnswerSourcePermissionVerifier({
      canReadDocument: async () => true,
      managedSourceQueryable: {
        async query<T = unknown>(sql: string, values?: unknown[]) {
          expect(sql.replace(/\s+/gu, " ").trim().toLowerCase()).toContain(
            "select linked_document_source_id, state, current_reconciled_snapshot_id from managed_knowledge_pages",
          );
          expect(values).toEqual([["source-managed"]]);
          return {
            rows: [{
              linked_document_source_id: "source-managed",
              state: "updating",
              current_reconciled_snapshot_id: null,
            }] as T[],
          };
        },
      },
    });

    await expect(verifier.verify({
      chatId: "chat-a",
      documentSourceIds: ["source-managed"],
    })).resolves.toEqual([{
      documentSourceId: "source-managed",
      outcome: "denied",
      reason: "managed_source_unavailable",
    }]);
  });

  it("preserves live permission results for active managed and unmanaged sources", async () => {
    const verifier = createAnswerSourcePermissionVerifier({
      canReadDocument: async (documentSourceId) => documentSourceId !== "source-denied",
      managedSourceQueryable: {
        async query<T = unknown>() {
          return {
            rows: [{
              linked_document_source_id: "source-active",
              state: "active",
              current_reconciled_snapshot_id: "snapshot-active",
            }] as T[],
          };
        },
      },
    });

    await expect(verifier.verify({
      chatId: "chat-a",
      documentSourceIds: ["source-active", "source-unmanaged", "source-denied"],
    })).resolves.toEqual([
      { documentSourceId: "source-active", outcome: "allowed" },
      { documentSourceId: "source-unmanaged", outcome: "allowed" },
      { documentSourceId: "source-denied", outcome: "denied" },
    ]);
  });

  it("denies a prepared managed citation after reactivation changes the reconciled snapshot", async () => {
    const verifier = createAnswerSourcePermissionVerifier({
      canReadDocument: async () => true,
      managedSourceQueryable: {
        async query<T = unknown>() {
          return { rows: [{
            linked_document_source_id: "source-managed",
            state: "active",
            current_reconciled_snapshot_id: "snapshot-new",
          }] as T[] };
        },
      },
    });

    await expect(verifier.verify({
      chatId: "chat-a",
      documentSourceIds: ["source-managed"],
      sourceSnapshotBindings: [{
        documentSourceId: "source-managed",
        documentSnapshotId: "snapshot-old",
      }],
    })).resolves.toEqual([{
      documentSourceId: "source-managed",
      outcome: "denied",
      reason: "managed_source_unavailable",
    }]);
  });

  it("bars a legacy active managed page until it has a reconciled snapshot identity", async () => {
    const verifier = createAnswerSourcePermissionVerifier({
      canReadDocument: async () => true,
      managedSourceQueryable: {
        async query<T = unknown>() {
          return { rows: [{
            linked_document_source_id: "source-managed",
            state: "active",
            current_reconciled_snapshot_id: null,
          }] as T[] };
        },
      },
    });

    await expect(verifier.verify({
      chatId: "chat-a",
      documentSourceIds: ["source-managed"],
    })).resolves.toEqual([{
      documentSourceId: "source-managed",
      outcome: "denied",
      reason: "managed_source_unavailable",
    }]);
  });

  it("fails closed when managed freshness cannot be verified", async () => {
    const verifier = createAnswerSourcePermissionVerifier({
      canReadDocument: async () => true,
      managedSourceQueryable: {
        async query() {
          throw new Error("database unavailable");
        },
      },
    });

    await expect(verifier.verify({
      chatId: "chat-a",
      documentSourceIds: ["source-managed"],
    })).resolves.toEqual([{
      documentSourceId: "source-managed",
      outcome: "error",
    }]);
  });
});
