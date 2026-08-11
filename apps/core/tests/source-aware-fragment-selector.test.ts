import { describe, expect, it } from "vitest";

import type { RetrievedDocumentFragment } from "../src/documents/document-fragment-repository.js";
import { selectSourceAwareFragments } from "../src/memory/source-aware-fragment-selector.js";

describe("selectSourceAwareFragments", () => {
  it("keeps overview and evolution evidence from the named Quello source", async () => {
    const selected = await selectSourceAwareFragments({
      queryText: "Quello 的电子宠物是如何自己产生目标的？",
      fragmentLimit: 8,
      rankedFragments: [
        fragment("watch-1", "watch", 0, "Apple Watch"),
        fragment("diary-1", "diary", 0, "Diary"),
        fragment("watch-2", "watch", 1, "Apple Watch"),
        fragment("diary-2", "diary", 1, "Diary"),
        fragment("quello-overview", "quello", 0, "Quello Life Engine（生命粒子引擎）副本"),
        fragment("notes-1", "notes", 0, "Notes"),
        fragment("watch-3", "watch", 2, "Apple Watch"),
        fragment("diary-3", "diary", 2, "Diary"),
        fragment("notes-2", "notes", 1, "Notes"),
        fragment("quello-evolution", "quello", 3, "Quello Life Engine（生命粒子引擎）副本"),
      ],
    });

    expect(selected[0]?.id).toBe("quello-overview");
    expect(selected.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "quello-overview",
      "quello-evolution",
    ]));
    expect(selected.filter(({ documentSourceId }) => documentSourceId === "watch").length)
      .toBeLessThanOrEqual(3);
    expect(selected).toHaveLength(8);
  });

  it("reserves room for coherent evidence when many one-fragment sources compete", async () => {
    const selected = await selectSourceAwareFragments({
      queryText: "Quello 的电子宠物是如何自己产生目标的？",
      fragmentLimit: 8,
      rankedFragments: [
        fragment("noise-1", "noise-1", 0, "Noise 1"),
        fragment("noise-2", "noise-2", 0, "Noise 2"),
        fragment("noise-3", "noise-3", 0, "Noise 3"),
        fragment("noise-4", "noise-4", 0, "Noise 4"),
        fragment("quello-overview", "quello", 0, "Quello Life Engine（生命粒子引擎）副本"),
        fragment("noise-5", "noise-5", 0, "Noise 5"),
        fragment("noise-6", "noise-6", 0, "Noise 6"),
        fragment("noise-7", "noise-7", 0, "Noise 7"),
        fragment("noise-8", "noise-8", 0, "Noise 8"),
        fragment("quello-evolution", "quello", 3, "Quello Life Engine（生命粒子引擎）副本"),
      ],
    });

    expect(selected.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "quello-overview",
      "quello-evolution",
    ]));
    expect(selected).toHaveLength(8);
  });

  it("returns no fragments when the caller budget is zero", async () => {
    const selected = await selectSourceAwareFragments({
      queryText: "Quello",
      fragmentLimit: 0,
      rankedFragments: [fragment("quello", "quello", 0, "Quello")],
    });

    expect(selected).toEqual([]);
  });

  it("completes immediate chunk boundaries only within the selected snapshot and source", async () => {
    const seed = fragment(
      "quello-middle",
      "quello",
      1,
      "Quello Life Engine（生命粒子引擎）副本",
    );
    const selected = await selectSourceAwareFragments({
      queryText: "Quello 的机制是什么？",
      fragmentLimit: 3,
      rankedFragments: [seed],
      listFragmentsForSnapshot: async () => [
        {
          ...fragment("legacy-before", "quello", 0, seed.sourceTitle!),
          embeddingProfileId: "legacy-profile",
        },
        fragment("quello-before", "quello", 0, seed.sourceTitle!),
        seed,
        {
          ...fragment("legacy-after", "quello", 2, seed.sourceTitle!),
          embeddingProfileId: "legacy-profile",
        },
        fragment("quello-after", "quello", 2, seed.sourceTitle!),
        fragment("other-source", "other", 2, "Other"),
      ],
    });

    expect(selected.map(({ id }) => id)).toEqual([
      "quello-middle",
      "quello-before",
      "quello-after",
    ]);
  });

  it("does not add a blank neighboring fragment to the evidence window", async () => {
    const seed = fragment("seed", "quello", 1, "Quello");
    const blank = { ...fragment("blank", "quello", 0, "Quello"), text: " \n\t " };
    const useful = fragment("useful", "quello", 2, "Quello");

    const selected = await selectSourceAwareFragments({
      queryText: "Quello",
      fragmentLimit: 3,
      rankedFragments: [seed],
      listFragmentsForSnapshot: async () => [blank, seed, useful],
    });

    expect(selected.map(({ id }) => id)).toEqual(["seed", "useful"]);
  });
});

function fragment(
  id: string,
  documentSourceId: string,
  chunkIndex: number,
  sourceTitle: string,
): RetrievedDocumentFragment {
  return {
    id,
    documentSourceId,
    documentSnapshotId: `snapshot-${documentSourceId}`,
    sourceUri: `https://example.com/${documentSourceId}`,
    chunkIndex,
    text: id,
    contentHash: `hash-${id}`,
    embedding: [],
    embeddingProfileId: "static-dev-6d",
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    sourceType: "feishu_wiki",
    sourceTitle,
  };
}
