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

  it("merges a short trailing block into the previous chunk when it fits", () => {
    const chunker = createDocumentChunker({ maxChunkChars: 80, minChunkChars: 20 });

    expect(chunker.chunkText("A decision paragraph with enough context.\n\nDone.")).toEqual([
      { chunkIndex: 0, text: "A decision paragraph with enough context.\n\nDone." },
    ]);
  });

  it("returns no chunks for blank text", () => {
    const chunker = createDocumentChunker();

    expect(chunker.chunkText(" \n\n\t ")).toEqual([]);
  });

  it("rejects non-integer or unsafe chunk size limits", () => {
    expect(() => createDocumentChunker({ maxChunkChars: Number.NaN })).toThrow(
      "maxChunkChars must be a positive safe integer",
    );
    expect(() => createDocumentChunker({ maxChunkChars: Number.POSITIVE_INFINITY })).toThrow(
      "maxChunkChars must be a positive safe integer",
    );
    expect(() => createDocumentChunker({ maxChunkChars: 10.5 })).toThrow(
      "maxChunkChars must be a positive safe integer",
    );
    expect(() => createDocumentChunker({ maxChunkChars: 9007199254740992 })).toThrow(
      "maxChunkChars must be a positive safe integer",
    );
    expect(() => createDocumentChunker({ minChunkChars: Number.NaN })).toThrow(
      "minChunkChars must be a positive safe integer",
    );
  });
});
