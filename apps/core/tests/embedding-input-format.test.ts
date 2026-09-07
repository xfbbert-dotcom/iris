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

  it("bounds long multilingual search payloads without changing the answer's source text", async () => {
    const question = "刚才发的问卷主要想了解什么？";
    const source = `${question}\n\nRecent live chat:\n用户：${"问卷用于了解用户的实际体验与困惑。".repeat(100)}`;
    const originalSource = source;
    const accepted: string[] = [];
    const provider = createQueryEmbeddingProvider({
      model: "embeddinggemma:300m-qat-q4_0",
      delegate: {
        async embedTexts(texts) {
          for (const text of texts) {
            if (Buffer.byteLength(text, "utf8") > 512) {
              throw new Error("search payload exceeds the small local runner budget");
            }
            accepted.push(text);
          }
          return texts.map(() => [0.5, 0.25]);
        },
      },
    });

    await expect(provider.embedTexts([question, source])).resolves.toEqual([[0.5, 0.25], [0.5, 0.25]]);
    expect(accepted[1]).toContain(question);
    expect(accepted[1]).toContain("问卷用于了解用户的实际体验");
    expect(accepted[1]).not.toContain("\uFFFD");
    expect(source).toBe(originalSource);
  });

  it("does not change long document embeddings or other models when bounding search queries", async () => {
    const source = "问卷正文".repeat(300);
    const accepted: string[] = [];
    const delegate = { async embedTexts(texts: string[]) {
      accepted.push(...texts);
      return texts.map(() => [1]);
    } };

    await createDocumentEmbeddingProvider({ model: "embeddinggemma:300m-qat-q4_0", delegate })
      .embedTexts([source]);
    await createQueryEmbeddingProvider({ model: "another-embedding-model", delegate })
      .embedTexts([source]);

    expect(accepted).toEqual([`title: none | text: ${source}`, source]);
  });
});
