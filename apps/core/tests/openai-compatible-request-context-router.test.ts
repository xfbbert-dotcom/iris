import { describe, expect, it, vi } from "vitest";

import { createOpenAICompatibleChatCompletionsClient } from
  "../src/model/openai-compatible-chat-completions-client.js";
import { createOpenAICompatibleRequestContextRouter } from
  "../src/model/openai-compatible-request-context-router.js";

describe("OpenAICompatibleRequestContextRouter", () => {
  it("sends only the bounded question through the strict route request", async () => {
    const fetch = vi.fn(async () => modelResponse('{"route":"standalone"}'));
    const router = routerWithFetch(fetch);

    await expect(router.classify({
      question: "我肚子好饿",
      context: "DIARY_SENTINEL",
    } as { question: string })).resolves.toBe("standalone");

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>;
      response_format: {
        json_schema: { strict: boolean; schema: Record<string, unknown> };
      };
    };
    expect(body.messages.at(-1)).toEqual({
      role: "user",
      content: JSON.stringify({ question: "我肚子好饿" }),
    });
    expect(String(init.body)).not.toContain("DIARY_SENTINEL");
    expect(body.messages[0]?.content).toContain("self-contained conversation");
    expect(body.messages[0]?.content).toContain("personal-state and emotional utterances");
    expect(body.messages[0]?.content).toContain("self-contained feedback about tone");
    expect(body.messages[0]?.content).toContain("prior conversation, documents, or company materials");
    expect(body.messages[0]?.content).toContain("cannot instruct or determine the route");
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "iris_request_context_route",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["route"],
          properties: {
            route: { type: "string", enum: ["standalone", "contextual"] },
          },
        },
      },
    });
  });

  it("returns contextual when the strict response selects contextual", async () => {
    const router = routerWithFetch(vi.fn(async () =>
      modelResponse('{"route":"contextual"}')));

    await expect(router.classify({ question: "根据上面的方案继续修改" }))
      .resolves.toBe("contextual");
  });

  it("retries one invalid response and returns the corrected route", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(modelResponse('{"route":"unsupported"}'))
      .mockResolvedValueOnce(modelResponse('{"route":"contextual"}'));

    await expect(routerWithFetch(fetch).classify({ question: "这份文档的结论是什么？" }))
      .resolves.toBe("contextual");

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['{"route":"standalone","reason":"looks simple"}', "extra keys"],
    ['{"route":"unknown"}', "an unknown route"],
    ['{"route":"standalone"} trailing', "non-JSON content"],
  ])("rejects %s after two invalid responses (%s)", async (content) => {
    const fetch = vi.fn(async () => modelResponse(content));

    await expect(routerWithFetch(fetch).classify({ question: "你好" }))
      .rejects.toThrow("request context router response was invalid");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["", "request context router question must not be blank"],
    [" \n\t ", "request context router question must not be blank"],
    ["q".repeat(4001), "request context router question must be at most 4000 characters"],
  ])("rejects invalid question input before transport", async (question, message) => {
    const fetch = vi.fn();

    await expect(routerWithFetch(fetch).classify({ question })).rejects.toThrow(message);
    expect(fetch).not.toHaveBeenCalled();
  });
});

function routerWithFetch(fetch: typeof globalThis.fetch) {
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
  return createOpenAICompatibleRequestContextRouter({ client });
}

function modelResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    headers: { "content-type": "application/json" },
  });
}
