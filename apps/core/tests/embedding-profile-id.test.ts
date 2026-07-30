import { describe, expect, it } from "vitest";

import {
  assertSupportedRuntimeEmbeddingDimension,
  createEmbeddingProfileId,
} from "../src/model/embedding-profile-id.js";

describe("embedding profile ids", () => {
  it("creates the Qwen 1024-dimensional profile id", () => {
    expect(
      createEmbeddingProfileId({
        provider: "openai-compatible",
        model: "qwen3-embedding:0.6b",
        dimensions: 1024,
      }),
    ).toBe("openai-compatible:qwen3-embedding:0.6b:1024");
  });

  it("accepts the 1024-dimensional runtime embedding contract", () => {
    expect(() => assertSupportedRuntimeEmbeddingDimension(1024)).not.toThrow();
  });
});
