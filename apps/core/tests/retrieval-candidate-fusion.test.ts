import { describe, expect, it } from "vitest";

import type { RetrievedDocumentFragment } from "../src/documents/document-fragment-repository.js";
import { fuseRetrievedDocumentFragments } from "../src/memory/retrieval-candidate-fusion.js";

describe("fuseRetrievedDocumentFragments", () => {
  it("lets a strong primary result resist contextual noise", () => {
    expect(fuseRetrievedDocumentFragments({
      primary: [fragment("quello"), fragment("watch")],
      supplemental: [fragment("diary"), fragment("watch"), fragment("quello")],
    }).map(({ id }) => id)).toEqual(["quello", "watch", "diary"]);
  });

  it("deduplicates the same fragment across query channels", () => {
    const fused = fuseRetrievedDocumentFragments({
      primary: [fragment("shared")],
      supplemental: [fragment("shared")],
    });

    expect(fused).toEqual([expect.objectContaining({ id: "shared" })]);
  });
});

function fragment(id: string): RetrievedDocumentFragment {
  return {
    id,
    documentSourceId: `source-${id}`,
    documentSnapshotId: `snapshot-${id}`,
    sourceUri: `https://example.com/${id}`,
    chunkIndex: 0,
    text: id,
    contentHash: `hash-${id}`,
    embedding: [],
    embeddingProfileId: "static-dev-6d",
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    sourceType: "feishu_wiki",
  };
}
