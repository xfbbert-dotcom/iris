import { describe, expect, it, vi } from "vitest";

import { createOpenAICompatibleModelProvider } from "../src/model/openai-compatible-model-provider.js";

describe("OpenAICompatibleModelProvider", () => {
  it("sends a chat completions request and returns trimmed answer text", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: "  Answer draft.  " } }],
      }),
    );
    const provider = createOpenAICompatibleModelProvider({
      config: {
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiKey: "key-a",
        model: "model-a",
        timeoutMs: 5000,
      },
      fetch,
    });

    await expect(
      provider.generateAnswerDraft({
        question: "What changed?",
        promptContext: "<live_chat_context></live_chat_context>",
      }),
    ).resolves.toEqual({ answerText: "Answer draft." });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer key-a",
      "content-type": "application/json",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "model-a",
      temperature: 0.2,
      messages: [
        expect.objectContaining({ role: "system" }),
        {
          role: "user",
          content:
            "Question:\nWhat changed?\n\nContext:\n<live_chat_context></live_chat_context>",
        },
      ],
    });
  });

  it("throws on non-2xx responses", async () => {
    const provider = createOpenAICompatibleModelProvider({
      config: config(),
      fetch: vi.fn(async () => jsonResponse({ error: { message: "bad key" } }, { status: 401 })),
    });

    await expect(
      provider.generateAnswerDraft({ question: "Q", promptContext: "C" }),
    ).rejects.toThrow("model provider request failed with status 401: bad key");
  });

  it("throws on malformed responses", async () => {
    const provider = createOpenAICompatibleModelProvider({
      config: config(),
      fetch: vi.fn(async () => jsonResponse({ choices: [] })),
    });

    await expect(
      provider.generateAnswerDraft({ question: "Q", promptContext: "C" }),
    ).rejects.toThrow("model provider response did not include answer content");
  });

  it("aborts requests after timeout", async () => {
    const fetch = vi.fn(((_url: URL | RequestInfo, init?: RequestInit) => {
      init?.signal?.dispatchEvent(new Event("abort"));
      return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }) as typeof globalThis.fetch);
    const provider = createOpenAICompatibleModelProvider({
      config: { ...config(), timeoutMs: 1 },
      fetch,
    });

    await expect(
      provider.generateAnswerDraft({ question: "Q", promptContext: "C" }),
    ).rejects.toThrow("model provider request timed out");
  });
});

function config() {
  return {
    provider: "openai-compatible" as const,
    baseUrl: "https://api.example.com/v1",
    apiKey: "key-a",
    model: "model-a",
    timeoutMs: 5000,
  };
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}
