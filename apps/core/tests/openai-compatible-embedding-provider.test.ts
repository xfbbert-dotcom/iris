import { describe, expect, it, vi } from "vitest";

import { createOpenAICompatibleEmbeddingProvider } from "../src/model/openai-compatible-embedding-provider.js";

describe("OpenAICompatibleEmbeddingProvider", () => {
  it("sends an embeddings request and returns vectors in order", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        data: [
          { index: 0, embedding: [1, 0, 0] },
          { index: 1, embedding: [0, 1, 0] },
        ],
      }),
    );
    const provider = createOpenAICompatibleEmbeddingProvider({
      config: {
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiKey: "key-a",
        model: "embedding-model",
        dimensions: 3,
        timeoutMs: 5000,
      },
      fetch,
    });

    await expect(provider.embedTexts(["alpha", "beta"])).resolves.toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/embeddings");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer key-a",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: "embedding-model",
      input: ["alpha", "beta"],
      dimensions: 3,
    });
  });

  it("omits dimensions when not configured and skips fetch for empty input", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ data: [{ index: 0, embedding: [1, 0, 0] }] }),
    );
    const provider = createOpenAICompatibleEmbeddingProvider({
      config: config(),
      fetch,
    });

    await expect(provider.embedTexts([])).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();

    await provider.embedTexts(["alpha"]);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      model: "embedding-model",
      input: ["alpha"],
    });
  });

  it("throws on count mismatch", async () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      config: config(),
      fetch: vi.fn(async () => jsonResponse({ data: [] })),
    });

    await expect(provider.embedTexts(["alpha"])).rejects.toThrow("embedding response count mismatch");
  });

  it("throws on invalid vector values", async () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      config: config(),
      fetch: vi.fn(async () =>
        jsonResponse({ data: [{ index: 0, embedding: [Number.NaN] }] }),
      ),
    });

    await expect(provider.embedTexts(["alpha"])).rejects.toThrow(
      "embedding vector contains invalid value",
    );
  });

  it("throws on non-2xx responses", async () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      config: config(),
      fetch: vi.fn(async () => jsonResponse({ error: { message: "bad key" } }, { status: 401 })),
    });

    await expect(provider.embedTexts(["alpha"])).rejects.toThrow(
      "embedding provider request failed with status 401: bad key",
    );
  });

  it("aborts requests after timeout", async () => {
    const fetch = vi.fn(((_url: URL | RequestInfo, init?: RequestInit) => {
      init?.signal?.dispatchEvent(new Event("abort"));
      return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }) as typeof globalThis.fetch);
    const provider = createOpenAICompatibleEmbeddingProvider({
      config: { ...config(), timeoutMs: 1 },
      fetch,
    });

    await expect(provider.embedTexts(["alpha"])).rejects.toThrow(
      "embedding provider request timed out",
    );
  });
});

function config() {
  return {
    provider: "openai-compatible" as const,
    baseUrl: "https://api.example.com/v1",
    apiKey: "key-a",
    model: "embedding-model",
    timeoutMs: 5000,
  };
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}
