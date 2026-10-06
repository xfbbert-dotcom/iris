import { describe, expect, it, vi } from "vitest";

import type { ModelProviderConfig } from "../src/config/env.js";
import { createOpenAICompatibleChatCompletionsClient } from
  "../src/model/openai-compatible-chat-completions-client.js";
import type { OpenAICompatibleChatMessage, OpenAICompatibleJsonSchemaResponseFormat } from
  "../src/model/openai-compatible-chat-completions-client.js";

describe("OpenAICompatibleChatCompletionsClient", () => {
  it.each([undefined, "json_schema"] as const)("preserves the native request with mode %s", async structuredOutputMode => {
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
        ...(structuredOutputMode === undefined ? {} : { structuredOutputMode }),
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
    expect(init.body).toBe(JSON.stringify({
      model: "model-a",
      messages: [{ role: "user", content: "Return the result." }],
      response_format: responseFormat,
    }));
  });

  it.each([true, false])("sends the complete schema in one system message in json_object mode (system=%s)", async hasSystem => {
    const messages: OpenAICompatibleChatMessage[] = [
      ...(hasSystem ? [{ role: "system" as const, content: "Keep the authorized task scope." }] : []),
      { role: "user", content: "Calculate 8 plus 8." },
    ];
    const originalMessages = structuredClone(messages);
    const responseFormat = schemaOnlyLabelFormat();
    const originalFormat = structuredClone(responseFormat);
    const requests: RequestInit[] = [];
    const client = createOpenAICompatibleChatCompletionsClient({
      config: { ...modelConfig(), structuredOutputMode: "json_object" },
      fetch: async (_url, init) => { requests.push(init!); return completionResponse('{"result":16,"label":"schema-only-label"}'); },
    });

    const result = await client.complete(messages, { responseFormat });

    expect(result).toBe('{"result":16,"label":"schema-only-label"}');
    expect(requests).toHaveLength(1);
    const body = JSON.parse(String(requests[0]!.body));
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    if (hasSystem) expect(body.messages[0].content).toContain("Keep the authorized task scope.");
    expect(body.messages[1]).toEqual({ role: "user", content: "Calculate 8 plus 8." });
    const schemaStart = body.messages[0].content.indexOf('{"type":"object"');
    expect(schemaStart).toBeGreaterThan(0);
    expect(JSON.parse(body.messages[0].content.slice(schemaStart))).toEqual(originalFormat.json_schema.schema);
    expect(messages).toEqual(originalMessages);
    expect(responseFormat).toEqual(originalFormat);
  });

  it.each([undefined, "json_schema", "json_object"] as const)("leaves requests without a response format unchanged in mode %s", async structuredOutputMode => {
    const requests: RequestInit[] = [];
    const messages: OpenAICompatibleChatMessage[] = [{ role: "user", content: "Hello." }];
    const client = createOpenAICompatibleChatCompletionsClient({
      config: { ...modelConfig(), ...(structuredOutputMode === undefined ? {} : { structuredOutputMode }) },
      fetch: async (_url, init) => { requests.push(init!); return completionResponse("Hello."); },
    });

    await expect(client.complete(messages)).resolves.toBe("Hello.");
    expect(requests[0]!.body).toBe(JSON.stringify({ model: "model-a", messages }));
  });

  it("does not accumulate schema text across retries or repeated completions", async () => {
    const bodies: string[] = [];
    const messages: OpenAICompatibleChatMessage[] = [{ role: "system", content: "Original instruction." }, { role: "user", content: "Calculate 8 plus 8." }];
    const original = structuredClone(messages);
    const responseFormat = schemaOnlyLabelFormat();
    const client = createOpenAICompatibleChatCompletionsClient({
      config: { ...modelConfig(), structuredOutputMode: "json_object" },
      sleep: async () => {},
      random: () => 0,
      fetch: async (_url, init) => {
        bodies.push(String(init!.body));
        return bodies.length === 1 ? new Response("{}", { status: 503 }) : completionResponse('{"result":16,"label":"schema-only-label"}');
      },
    });

    await client.complete(messages, { responseFormat });
    await client.complete(messages, { responseFormat });

    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
    const body = JSON.parse(bodies[0]!);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content.split('"schema-only-label"')).toHaveLength(2);
    expect(messages).toEqual(original);
  });

  it("rejects an invalid directly supplied mode before making a request", async () => {
    const fetch = vi.fn(async () => completionResponse("unexpected"));
    const create = () => createOpenAICompatibleChatCompletionsClient({
      config: { ...modelConfig(), structuredOutputMode: "private-invalid-mode" } as unknown as ModelProviderConfig,
      fetch,
    });
    expect(create).toThrow("model provider structured output mode is invalid");
    expect(create).not.toThrow("private-invalid-mode");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { config: { maxTokens: 4096, enableThinking: false }, wire: { max_tokens: 4096, enable_thinking: false } },
    { config: { maxTokens: 512 }, wire: { max_tokens: 512 } },
    { config: { enableThinking: true }, wire: { enable_thinking: true } },
  ])("sends only explicitly selected optional transport fields: $wire", async ({ config, wire }) => {
    const requests: RequestInit[] = [];
    const client = createOpenAICompatibleChatCompletionsClient({
      config: { ...modelConfig(), ...config },
      fetch: async (_url, init) => { requests.push(init!); return completionResponse("ok"); },
    });
    await expect(client.complete([{ role: "user", content: "Hello." }])).resolves.toBe("ok");
    expect(JSON.parse(String(requests[0]!.body))).toEqual({
      model: "model-a", messages: [{ role: "user", content: "Hello." }], ...wire,
    });
  });

  it.each([
    ["maxTokens", 0], ["maxTokens", -1], ["maxTokens", 1.5],
    ["maxTokens", Number.MAX_SAFE_INTEGER + 1], ["maxTokens", "private-invalid-tokens"],
    ["maxTokens", null], ["enableThinking", "private-invalid-thinking"],
    ["enableThinking", 0], ["enableThinking", null],
  ])("rejects invalid directly supplied %s before HTTP", (name, value) => {
    const fetch = vi.fn(async () => completionResponse("unexpected"));
    const create = () => createOpenAICompatibleChatCompletionsClient({
      config: { ...modelConfig(), [name as string]: value } as ModelProviderConfig, fetch,
    });
    expect(create).toThrow(`model provider ${name}`);
    expect(create).not.toThrow("private-invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["json_schema", "json_object"] as const)("rejects over-budget or invalid schema before HTTP in mode %s", async structuredOutputMode => {
    const fetch = vi.fn(async () => completionResponse("unexpected"));
    const client = createOpenAICompatibleChatCompletionsClient({ config: { ...modelConfig(), structuredOutputMode }, fetch });
    const oversized = schemaOnlyLabelFormat();
    oversized.json_schema.schema.description = "大".repeat(11_000);
    const invalid = schemaOnlyLabelFormat();
    invalid.json_schema.strict = false as true;

    await expect(client.complete([], { responseFormat: oversized })).rejects.toThrow("model provider response format exceeds 32768 bytes");
    await expect(client.complete([], { responseFormat: invalid })).rejects.toThrow("model provider response format is invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns nonconforming provider text untouched without changing output modes", async () => {
    const content = '```json\n{"result":16}\n```';
    const fetch = vi.fn(async () => completionResponse(content));
    const client = createOpenAICompatibleChatCompletionsClient({ config: { ...modelConfig(), structuredOutputMode: "json_object" }, fetch });

    await expect(client.complete([{ role: "user", content: "Calculate 8 plus 8." }], { responseFormat: schemaOnlyLabelFormat() })).resolves.toBe(content);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

function modelConfig(): ModelProviderConfig {
  return { provider: "openai-compatible", baseUrl: "https://api.example.com/v1", apiKey: "key-a", model: "model-a", timeoutMs: 5000 };
}

function completionResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }), { headers: { "content-type": "application/json" } });
}

function schemaOnlyLabelFormat(): OpenAICompatibleJsonSchemaResponseFormat {
  return {
    type: "json_schema",
    json_schema: {
      name: "schema_only_label",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["result", "label"],
        properties: { result: { type: "number", enum: [16] }, label: { $ref: "#/$defs/label" } },
        $defs: { label: { type: "string", enum: ["schema-only-label"] } },
      },
    },
  };
}
