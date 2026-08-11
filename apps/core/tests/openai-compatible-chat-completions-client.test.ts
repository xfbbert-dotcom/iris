import { describe, expect, it, vi } from "vitest";

import { createOpenAICompatibleChatCompletionsClient } from
  "../src/model/openai-compatible-chat-completions-client.js";

describe("OpenAICompatibleChatCompletionsClient", () => {
  it("passes a bounded JSON-schema response format to the provider", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: '{"result":"ok"}' } }],
    }), { headers: { "content-type": "application/json" } }));
    const client = createOpenAICompatibleChatCompletionsClient({
      config: {
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiKey: "key-a",
        model: "model-a",
        timeoutMs: 5000,
      },
      fetch,
    });
    const responseFormat = {
      type: "json_schema" as const,
      json_schema: {
        name: "test_result",
        strict: true as const,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["result"],
          properties: { result: { type: "string", enum: ["ok"] } },
        },
      },
    };

    await expect(client.complete(
      [{ role: "user", content: "Return the result." }],
      { responseFormat },
    )).resolves.toBe('{"result":"ok"}');

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      model: "model-a",
      messages: [{ role: "user", content: "Return the result." }],
      response_format: responseFormat,
    });
  });
});
