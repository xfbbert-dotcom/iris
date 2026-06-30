import { describe, expect, it } from "vitest";
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
});
