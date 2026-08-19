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

  it("rejects conflicting grant bindings for the same fragment", () => {
    expect(() => fuseRetrievedDocumentFragments({
      primary: [fragment("shared", {
        crossGroupGrantId: "grant-1",
        crossGroupGrantVersion: 1,
        crossGroupGrantorGroupId: "group-source",
        crossGroupGranteeGroupId: "group-reader",
      })],
      supplemental: [fragment("shared")],
    })).toThrow(/grant binding/iu);
  });

  it("deduplicates identical exact grant bindings", () => {
    const grant = {
      crossGroupGrantId: "grant-1",
      crossGroupGrantVersion: 2,
      crossGroupGrantorGroupId: "group-source",
      crossGroupGranteeGroupId: "group-reader",
    } as const;
    expect(fuseRetrievedDocumentFragments({
      primary: [fragment("shared", grant)],
      supplemental: [fragment("shared", grant)],
    })).toEqual([expect.objectContaining(grant)]);
  });
});

function fragment(
  id: string,
  overrides: Partial<RetrievedDocumentFragment> = {},
): RetrievedDocumentFragment {
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
    ...overrides,
  };
}
