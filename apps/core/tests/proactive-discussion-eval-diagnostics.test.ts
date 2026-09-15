import { expect, test } from "vitest";
import { createPdModel } from "../src/proactive-discussion/model.js";
import { createOpenAICompatibleChatCompletionsClient } from "../src/model/openai-compatible-chat-completions-client.js";
import { pdContext, pdAssessment } from "./fixtures/proactive-discussion.js";

const evalPath = "../../../scripts/pilot/proactive-discussion-eval.ts";

test.each([
  { label: "invalid assessment after one repair", outputs: ["not-json", "not-json"], phase: "assessment", category: "assessment_validation", calls: 2 },
  { label: "invalid draft", outputs: [JSON.stringify(pdAssessment()), "not-json"], phase: "render", category: "draft_validation", calls: 2 },
  { label: "invalid scope review", outputs: [JSON.stringify(pdAssessment()), JSON.stringify({ text: "两人共16万，缺口6万。", evidenceRefs: pdAssessment().evidenceRefs }), "not-json"], phase: "render", category: "scope_review_validation", calls: 3 },
])("eval distinguishes $label without returning provider content", async ({ outputs, phase, category, calls }) => {
  const { runProactiveDiscussionEval } = await import(evalPath);
  let completed = 0;
  const model = createPdModel({ client: { complete: async () => outputs[completed++]! } });
  const [result] = await runProactiveDiscussionEval({ model, rounds: 1,
    cases: [{ id: "bounded", context: pdContext(), expectedDecision: "intervene", reviewCriteria: [] }] });
  expect(result.diagnostic).toEqual({ phase, category });
  expect(completed).toBe(calls);
  expect(result.error).toBe(phase === "assessment" ? "assessment_failed" : "render_failed");
  expect(JSON.stringify(result)).not.toContain("not-json");
});

test("eval keeps safe HTTP status from the actual client and omits upstream details", async () => {
  const { runProactiveDiscussionEval } = await import(evalPath);
  const secret = "private-upstream-text";
  const client = createOpenAICompatibleChatCompletionsClient({
    config: { provider: "openai-compatible", baseUrl: "https://private.invalid/v1", apiKey: secret, model: "synthetic", timeoutMs: 1000 },
    fetch: async () => new Response(JSON.stringify({ error: { message: secret } }), { status: 429 }),
  });
  const [result] = await runProactiveDiscussionEval({ model: createPdModel({ client }), rounds: 1,
    cases: [{ id: "bounded", context: pdContext(), expectedDecision: "intervene", reviewCriteria: [] }] });
  expect(result.diagnostic).toEqual({ phase: "assessment", category: "http", statusCode: 429 });
  expect(JSON.stringify(result)).not.toMatch(/private-upstream|private\.invalid|Bearer/u);
});

test("eval reports unknown render failures without serializing arbitrary error fields", async () => {
  const { runProactiveDiscussionEval } = await import(evalPath);
  const [result] = await runProactiveDiscussionEval({ model: {
    assess: async () => pdAssessment(),
    render: async () => { throw Object.assign(new Error("private-upstream-text"), { statusCode: 403, body: "private-body" }); },
  }, rounds: 1, cases: [{ id: "bounded", context: pdContext(), expectedDecision: "intervene", reviewCriteria: [] }] });
  expect(result.diagnostic).toEqual({ phase: "render", category: "unknown" });
  expect(result.assessment).toEqual(pdAssessment());
  expect(JSON.stringify(result)).not.toMatch(/private-upstream|private-body|403/u);
});
