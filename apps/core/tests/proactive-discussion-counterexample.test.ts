import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { createPdModel } from "../src/proactive-discussion/model.js";
import { pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";
import type { OpenAICompatibleChatCompletionsClient } from "../src/model/openai-compatible-chat-completions-client.js";
const report = JSON.parse(readFileSync(new URL("../../../docs/development/evidence/iris-repair-updates-20260929.json", import.meta.url), "utf8"));
const entry = (stage: string) => report.completions.find((c: {caseId: string; stage: string}) => c.caseId === "qualified-risk" && c.stage.endsWith(stage));
const initial = JSON.parse(entry("_assessment").content).assessment;
const generated = JSON.parse(entry("_generated_pair").content);
const fixedReason = "接口尚未联调验证，交付承诺缺少已验证的依据；若联调遇到问题，可能影响交付，仍需核实排期。";
const fixedDraft = "接口尚未联调验证，下周能否交付仍需确认。建议先核实联调排期，再向客户说明有条件的预计交付时间。";
const finding = { field: "reasoning", quote: "将直接导致无法按期履约", compatibleScenario: "发现的问题在交付前得到解决，仍然按期交付。", unsupportedStep: "来源未说明问题无法及时解决，条件下的必然后果没有依据。" };
async function context() { const path = "../../../scripts/pilot/proactive-discussion-eval.ts"; return (await import(path)).createProactiveDiscussionEvalCases().find((c: { id: string }) => c.id === "qualified-risk").context; }
function setup(challenges: unknown[], finalSupported = true, scopeReviews?: unknown[]) {
  const calls: string[] = [];
  const client = { complete: vi.fn<OpenAICompatibleChatCompletionsClient["complete"]>(async (messages, options) => {
    const stage = options!.responseFormat!.json_schema.name;
    calls.push(stage);
    if (stage.endsWith("_generated_pair")) return JSON.stringify(generated);
    if (stage.endsWith("_counterexamples")) return JSON.stringify(challenges.shift());
    if (stage.endsWith("_pair_repair")) return JSON.stringify({updates:[{field:"reasoning",value:fixedReason},{field:"draftText",value:fixedDraft}]});
    if (scopeReviews) return JSON.stringify(scopeReviews.shift());
    const input = JSON.parse(messages[1]!.content);
    return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: finalSupported, reason: "fixture review", requiredNumbers: [], adviceQuote: input.draft.text });
  }) };
  return { client, calls, run: async () => createPdModel({client, counterexampleReview: true}).render({context: await context(), assessment: initial}) };
}
test("a source-compatible counterexample routes current prose through the sole repair then full final review", async () => {
  const s = setup([{findings:[finding]},{findings:[]}]);
  const pair = await s.run();
  expect(pair?.assessment.reasoning).toBe(fixedReason);
  expect(pair?.draft.text).toBe(fixedDraft);
  expect(s.calls.map(c=>c.replace("iris_proactive_discussion_", ""))).toEqual(["generated_pair","counterexamples","pair_repair","counterexamples","scope_review"]);
  const repairInput=JSON.parse(s.client.complete.mock.calls[2]![0][1]!.content);
  expect(repairInput.review.kind).toBe("counterexample_rejection");
  expect(repairInput.review.fieldChecks).toBeUndefined();
});
test("empty findings never replace the original full review", async () => {
  const s = setup([{findings:[]},{findings:[]}],false);
  expect(await s.run()).toBeNull();
  expect(s.calls.filter(c=>c.endsWith("_scope_review"))).toHaveLength(2);
  expect(s.calls.filter(c=>c.endsWith("_pair_repair"))).toHaveLength(1);
});
test("a surviving counterexample rejects without a second repair or final approval", async () => {
  const s=setup([{findings:[finding]},{findings:[{...finding,quote:"仍需核实排期"}]}]);
  expect(await s.run()).toBeNull();
  expect(s.calls.filter(c=>c.endsWith("_pair_repair"))).toHaveLength(1);
  expect(s.calls.some(c=>c.endsWith("_scope_review"))).toBe(false);
});
test.each([{findings:[{...finding,quote:"not in candidate"}]},{findings:[{...finding,field:"evidence"}]},{findings:[],supported:true}])("invalid counterexample response cannot approve or trigger a repair: %j",async value=>{
  const s=setup([value]);
  await expect(s.run()).rejects.toThrow("counterexample review was invalid");
  expect(s.calls.filter(c=>c.endsWith("_pair_repair"))).toHaveLength(0);
});
test("final checks cannot use an old candidate quote after correction",async()=>{
  const s=setup([{findings:[finding]},{findings:[finding]}]);
  expect(await s.run()).toBeNull();
  expect(s.calls.some(c=>c.endsWith("_scope_review"))).toBe(false);
});
test("empty challenges cannot drop a numeric diagnosis from the original initial review",async()=>{
  const scope={fieldChecks:pdReviewFieldChecks(),supported:false,reason:"fixture",requiredNumbers:[{label:"total",expectedValue:"16",unit:"万元",draftQuote:null}],adviceQuote:generated.prose.draftText};
  const final={...scope,supported:true,requiredNumbers:[],numberRevisions:[],adviceQuote:fixedDraft};
  const s=setup([{findings:[]},{findings:[]}],true,[scope,final]);
  expect(await s.run()).toBeNull();
  const input=JSON.parse(s.client.complete.mock.calls.at(-1)![0][1]!.content);
  expect(input.previousReview.requiredNumbers[0].expectedValue).toBe("16");
});
test("final challenge provider failures remain technical failures",async()=>{
  const s=setup([{findings:[finding]}]);
  const original=s.client.complete.getMockImplementation()!;let checks=0;
  s.client.complete.mockImplementation(async (messages,options)=>{
    if(options?.responseFormat?.json_schema.name.endsWith("_counterexamples") && ++checks===2) throw Error("provider failure");
    return original(messages,options);
  });
  await expect(s.run()).rejects.toThrow("provider failure");
});
test("context cancellation after challenge prevents repair and further review",async()=>{
  const s=setup([{findings:[finding]}]);let checkpoints=0;
  await expect(createPdModel({client:s.client,counterexampleReview:true}).render({context:await context(),assessment:initial},async()=>{
    if(++checkpoints===3)throw Error("context changed");
  })).rejects.toThrow("context changed");
  expect(s.calls).toHaveLength(2);
});
