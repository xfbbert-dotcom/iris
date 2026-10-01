import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { createPdModel } from "../src/proactive-discussion/model.js";
import { pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";
import type { OpenAICompatibleChatCompletionsClient } from "../src/model/openai-compatible-chat-completions-client.js";

const report = JSON.parse(readFileSync(new URL("../../../docs/development/evidence/iris-repair-updates-20260929.json", import.meta.url), "utf8"));
const initial = JSON.parse(report.completions.find((c: { caseId: string; stage: string }) => c.caseId === "qualified-risk" && c.stage.endsWith("_assessment")).content).assessment;
const opinion = { opinion: { segments: [
  { role: "observation", text: "供应商接口还没联调验证。" },
  { role: "reasoning", text: "现在承诺下周肯定交付缺少验证依据，联调问题可能影响排期。" },
  { role: "suggestion", text: "建议先确认联调排期与验收结果，再给出有条件的交付时间。" },
], uncertainty: "qualified_inference" } };
async function context() {
  const path = "../../../scripts/pilot/proactive-discussion-eval.ts";
  return (await import(path)).createProactiveDiscussionEvalCases().find((c: { id: string }) => c.id === "qualified-risk").context;
}
function setup(generated: unknown = opinion, repaired: unknown = opinion, reviews = [true]) {
  const client = { complete: vi.fn<OpenAICompatibleChatCompletionsClient["complete"]>(async (messages, options) => {
    const stage = options!.responseFormat!.json_schema.name;
    if (stage.endsWith("_generated_pair")) return JSON.stringify(generated);
    if (stage.endsWith("_pair_repair")) return JSON.stringify(repaired);
    const input = JSON.parse(messages[1]!.content);
    return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: reviews.shift() ?? false,
      reason: "fixture", requiredNumbers: [], adviceQuote: input.draft.text });
  }) };
  const run = async (assertActive?: () => Promise<void>) => createPdModel({ client, canonicalOpinion: true }).render({ context: await context(), assessment: initial }, assertActive);
  return { client, run };
}
test("one canonical opinion supplies every stored semantic field without hidden prose", async () => {
  const s = setup(); const pair = await s.run();
  expect(pair?.draft.text).toBe(opinion.opinion.segments.map(s => s.text).join(""));
  expect(pair?.assessment.reasoning).toBe(opinion.opinion.segments[1]!.text);
  expect(pair?.assessment.issueRef).toEqual({ kind: "new", description: pair?.assessment.observation });
  expect(pair?.assessment.materialChange.explanation).toBe(pair?.assessment.reasoning);
  expect(pair?.assessment.evidenceRefs).toEqual(initial.evidenceRefs);
  expect(s.client.complete).toHaveBeenCalledTimes(2);
});
test.each([
  { ...opinion, prose: { reasoning: "将直接导致无法履约" } },
  { opinion: { ...opinion.opinion, reasoning: "hidden claim" } },
  { opinion: { ...opinion.opinion, segments: opinion.opinion.segments.slice(0, 2) } },
  { opinion: { ...opinion.opinion, segments: [...opinion.opinion.segments, { role: "reasoning", text: "x".repeat(1200) }] } },
])("invalid or independent prose cannot bypass canonical projection: %j", async value => {
  const s = setup(value); await expect(s.run()).rejects.toThrow();
  expect(s.client.complete).toHaveBeenCalledTimes(1);
});
test("the sole correction replaces the canonical opinion and all projections together", async () => {
  const bad = structuredClone(opinion); bad.opinion.segments[1]!.text = "将直接导致无法履约。";
  const s = setup(bad, opinion, [false, true]); const pair = await s.run();
  expect(pair?.assessment.reasoning).toBe(opinion.opinion.segments[1]!.text);
  expect(JSON.stringify(pair)).not.toContain("将直接导致");
  expect(s.client.complete).toHaveBeenCalledTimes(4);
  const finalInput = JSON.parse(s.client.complete.mock.calls[3]![0][1]!.content);
  expect(finalInput.assessment.reasoning).toBe(pair?.assessment.reasoning);
  expect(finalInput.draft.text).toBe(pair?.draft.text);
});
test("final semantic rejection does not gain a second correction", async () => {
  const s = setup(opinion, opinion, [false, false]); expect(await s.run()).toBeNull();
  expect(s.client.complete).toHaveBeenCalledTimes(4);
});
test("old independent updates cannot break the canonical invariant during correction", async () => {
  const s = setup(opinion, { updates: [{ field: "reasoning", value: "hidden" }] }, [false]);
  expect(await s.run()).toBeNull(); expect(s.client.complete).toHaveBeenCalledTimes(3);
});
test("cancellation after generation prevents approval", async () => {
  const s = setup(); let checks = 0;
  await expect(s.run(async () => { if (++checks === 2) throw Error("cancelled"); })).rejects.toThrow("cancelled");
  expect(s.client.complete).toHaveBeenCalledTimes(1);
});
test("canonical correction still cannot silently drop the first review's numeric requirements", async () => {
  const s = setup(); const original = s.client.complete.getMockImplementation()!; let reviews = 0;
  s.client.complete.mockImplementation(async (messages, options) => {
    if (!options?.responseFormat?.json_schema.name.endsWith("_scope_review")) return original(messages, options);
    const input = JSON.parse(messages[1]!.content); reviews++;
    return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: reviews > 1, reason: "fixture",
      requiredNumbers: reviews === 1 ? [{ label: "total", expectedValue: "16", unit: "万元", draftQuote: null }] : [],
      ...(reviews > 1 ? { numberRevisions: [] } : {}), adviceQuote: input.draft.text });
  });
  expect(await s.run()).toBeNull(); expect(reviews).toBe(2);
});
test("independent candidates cannot silently compose into another unvalidated workflow", () => {
  const s = setup();
  expect(() => createPdModel({ client: s.client, canonicalOpinion: true, counterexampleReview: true })).toThrow("cannot be combined");
});
