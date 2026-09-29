import { expect, test, vi } from "vitest";
import { createOpenAICompatibleChatCompletionsClient } from "../src/model/openai-compatible-chat-completions-client.js";
import { createPdModel } from "./fixtures/proactive-discussion-prose-client.js";
import { pdAssessment, pdContext } from "./fixtures/proactive-discussion.js";

test("JSON-mode transport preserves proactive relationship validation and its two-attempt bound", async () => {
  const invalid = { ...pdAssessment(), issueRef: null };
  const bodies: Array<Record<string, any>> = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop",
      message: { content: JSON.stringify({ assessment: invalid }) } }] }),
    { headers: { "content-type": "application/json" } });
  });
  const client = createOpenAICompatibleChatCompletionsClient({ config: {
    provider: "openai-compatible", baseUrl: "https://model.invalid/v1", apiKey: "synthetic-only",
    model: "test", timeoutMs: 5000, structuredOutputMode: "json_object",
  }, fetch });

  await expect(createPdModel({ client }).assess(pdContext())).rejects.toThrow("assessment was invalid");
  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages.some((message: any) => message.role === "system"
      && message.content.includes(JSON.stringify({ type: "string", enum: ["new_issue"] })))).toBe(true);
  }
});

test("JSON-mode transport does not strip fences or turn a provider's unrelated result into an assessment", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop",
    message: { content: '```json\n{"expression":"8+8","result":16}\n```' } }] }),
  { headers: { "content-type": "application/json" } }));
  const client = createOpenAICompatibleChatCompletionsClient({ config: {
    provider: "openai-compatible", baseUrl: "https://model.invalid/v1", apiKey: "synthetic-only",
    model: "test", timeoutMs: 5000, structuredOutputMode: "json_object",
  }, fetch });
  await expect(createPdModel({ client }).assess(pdContext())).rejects.toThrow("assessment was invalid");
  expect(fetch).toHaveBeenCalledTimes(2);
});
