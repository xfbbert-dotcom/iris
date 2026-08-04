import { describe, expect, it, vi } from "vitest";

import {
  createDocumentEmbeddingProvider,
  createQueryEmbeddingProvider,
} from "../src/model/embedding-input-format.js";

describe("embedding input format", () => {
  it("uses EmbeddingGemma's asymmetric retrieval prompts", async () => {
    const embedTexts = vi.fn(async (texts: string[]) => texts.map(() => [1]));
    const delegate = { embedTexts };

    await createDocumentEmbeddingProvider({
      model: "embeddinggemma:300m-qat-q4_0",
      delegate,
    }).embedTexts(["document body"]);
    await createQueryEmbeddingProvider({
      model: "embeddinggemma:300m-qat-q4_0",
      delegate,
    }).embedTexts(["What is Life Engine?"]);

    expect(embedTexts).toHaveBeenNthCalledWith(1, ["title: none | text: document body"]);
    expect(embedTexts).toHaveBeenNthCalledWith(2, [
      "task: search result | query: What is Life Engine?",
    ]);
  });

  it("leaves other OpenAI-compatible embedding models unchanged", async () => {
    const embedTexts = vi.fn(async (texts: string[]) => texts.map(() => [1]));
    const delegate = { embedTexts };

    await createDocumentEmbeddingProvider({
      model: "text-embedding-small",
      delegate,
    }).embedTexts(["document body"]);
    await createQueryEmbeddingProvider({
      model: "text-embedding-small",
      delegate,
    }).embedTexts(["question"]);

    expect(embedTexts).toHaveBeenNthCalledWith(1, ["document body"]);
    expect(embedTexts).toHaveBeenNthCalledWith(2, ["question"]);
  });
});
