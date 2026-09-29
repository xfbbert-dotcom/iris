import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { createPdModel, validatePdGeneratedIntervention } from "../src/proactive-discussion/model.js";
import type { PdContext } from "../src/proactive-discussion/contracts.js";
import { pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";
import type { OpenAICompatibleChatMessage, OpenAICompatibleChatCompletionOptions } from "../src/model/openai-compatible-chat-completions-client.js";

const report = JSON.parse(readFileSync(new URL("../../../docs/development/evidence/iris-unavailable-numbers-20260929.json", import.meta.url), "utf8"));
const original = JSON.parse(report.completions.find((c: { caseId: string; stage: string }) =>
  c.caseId === "arithmetic" && c.stage.endsWith("generated_pair")).content);
const projection = (assessment = original.assessment) => [assessment.observation, assessment.reasoning, assessment.suggestion].join("\n\n");
async function context(): Promise<PdContext> {
  const path = "../../../scripts/pilot/proactive-discussion-eval.ts";
  const module = await import(path);
  return module.createProactiveDiscussionEvalCases().find((c: { id: string }) => c.id === "arithmetic").context;
}
function clientFor(value = original, supported = true, invalidRepair = false) {
  return { complete: vi.fn(async (messages: readonly OpenAICompatibleChatMessage[], options?: OpenAICompatibleChatCompletionOptions) => {
    const input = JSON.parse(messages[1]!.content);
    const name = options!.responseFormat!.json_schema.name;
    if (name.endsWith("generated_pair")) return JSON.stringify(value);
    if (name.endsWith("pair_repair")) return JSON.stringify(invalidRepair ? original : { assessment: input.assessment, draft: input.draft });
    return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported, reason: supported ? "fixture" : "建议仍未解决问题",
      requiredNumbers: [], adviceQuote: input.assessment.suggestion });
  }) };
}

test("offline historical recovery preserves its candidate but live requires prose", async () => {
  const client = clientFor();
  const earlier = { ...original.assessment, reasoning: "旧初判错误不可抄", suggestion: "旧建议不可回填" };
  const result = validatePdGeneratedIntervention(original, await context(), earlier).pair;
  expect(result).toEqual({ assessment: original.assessment, draft: { text: projection(), evidenceRefs: original.assessment.evidenceRefs } });
  await expect(createPdModel({ client }).render({ context: await context(), assessment: earlier })).rejects.toThrow();
  expect(client.complete).toHaveBeenCalledTimes(1);
  expect(result.draft.text).not.toContain("旧初判");
  expect(original.draft).not.toHaveProperty("evidenceRefs");
});

test.each([
  ["foreign refs", (v: any) => { v.draft.evidenceRefs = ["foreign"]; }],
  ["duplicate refs", (v: any) => { v.draft.evidenceRefs = [...v.assessment.evidenceRefs, ...v.assessment.evidenceRefs]; }],
  ["unknown outer field", (v: any) => { v.extra = true; }],
  ["unknown draft field", (v: any) => { v.draft.extra = true; }],
  ["invalid assessment", (v: any) => { v.assessment.suggestion = ""; }],
  ["changed locked refs", (v: any) => { v.assessment.evidenceRefs = [v.assessment.evidenceRefs[0]]; }],
  ["empty partial draft", (v: any) => { v.draft.text = ""; }],
  ["oversized reconstruction", (v: any) => { v.assessment.observation = "长".repeat(1190); }],
  ["internal source ref in projected text", (v: any) => { v.assessment.suggestion += v.assessment.evidenceRefs[0]; }],
])("does not reconstruct %s", async (_label, mutate) => {
  const value = structuredClone(original); mutate(value);
  const client = clientFor(value);
  await expect(createPdModel({ client }).render({ context: await context(), assessment: original.assessment })).rejects.toThrow();
  expect(client.complete).toHaveBeenCalledTimes(1);
});

test("legacy reconstruction cannot bypass the live prose contract", async () => {
  const client = clientFor(original, false);
  await expect(createPdModel({ client }).render({ context: await context(), assessment: original.assessment })).rejects.toThrow();
  expect(client.complete).toHaveBeenCalledTimes(1);
});

test("complete legacy output is also rejected by the live contract", async () => {
  const complete = { assessment: original.assessment, draft: { text: projection(), evidenceRefs: original.assessment.evidenceRefs } };
  const client = clientFor(complete, false, true);
  await expect(createPdModel({ client }).render({ context: await context(), assessment: original.assessment })).rejects.toThrow();
  expect(client.complete).toHaveBeenCalledTimes(1);
});
