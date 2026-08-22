import { describe, expect, it, vi } from "vitest";

import { createDocumentReindexCompletionRepository } from
  "../src/reindex/document-reindex-completion-repository.js";

describe("DocumentReindexCompletionRepository", () => {
  it("treats an existing exact snapshot-profile success as an idempotent replay", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ completion_kind: "indexed", fragment_count: 0 }] });
    const repository = createDocumentReindexCompletionRepository({ queryable: { query } });

    await expect(repository.recordSuccessfulCompletion({
      documentSnapshotId: "snapshot-1",
      embeddingProfileId: "profile-1",
      completionKind: "already_indexed",
      fragmentCount: 1,
      completedAt: new Date("2026-08-21T04:00:00.000Z"),
    })).resolves.toBeUndefined();

    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining(
      "WHERE document_snapshot_id = $1 AND embedding_profile_id = $2",
    ), ["snapshot-1", "profile-1"]);
  });

  it("fails closed when an insert conflict does not resolve to the exact pair", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const repository = createDocumentReindexCompletionRepository({ queryable: { query } });

    await expect(repository.recordSuccessfulCompletion({
      documentSnapshotId: "snapshot-1",
      embeddingProfileId: "profile-1",
      completionKind: "indexed",
      fragmentCount: 0,
      completedAt: new Date("2026-08-21T04:00:00.000Z"),
    })).rejects.toThrow("document reindex completion operation conflict");
  });
});
