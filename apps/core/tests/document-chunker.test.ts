import { describe, expect, it } from "vitest";

import { createDocumentChunker } from "../src/documents/document-chunker.js";

describe("DocumentChunker", () => {
  it("splits paragraphs deterministically and preserves order", () => {
    const chunker = createDocumentChunker({ maxChunkChars: 80, minChunkChars: 20 });

    expect(
      chunker.chunkText(" Alpha paragraph. \r\n\r\nBeta paragraph.\n\nGamma paragraph. "),
    ).toEqual([
      { chunkIndex: 0, text: "Alpha paragraph.\n\nBeta paragraph." },
      { chunkIndex: 1, text: "Gamma paragraph." },
    ]);
  });

  it("hard-splits a single long block", () => {
    const chunker = createDocumentChunker({ maxChunkChars: 10, minChunkChars: 4 });

    expect(chunker.chunkText("abcdefghijklmnopqrstuvwxyz")).toEqual([
      { chunkIndex: 0, text: "abcdefghij" },
      { chunkIndex: 1, text: "klmnopqrst" },
      { chunkIndex: 2, text: "uvwxyz" },
    ]);
  });

  it("returns no chunks for blank text", () => {
    const chunker = createDocumentChunker();

    expect(chunker.chunkText(" \n\n\t ")).toEqual([]);
  });
});
