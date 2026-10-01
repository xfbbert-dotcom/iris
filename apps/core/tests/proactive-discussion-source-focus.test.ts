import { expect, test, vi } from "vitest";
import { createPdModel } from "../src/proactive-discussion/model.js";
import { pdAssessment, pdContext, pdContextWithIssue, pdReviewFieldChecks, pdSkipAssessment } from "./fixtures/proactive-discussion.js";
import type { OpenAICompatibleChatCompletionsClient } from "../src/model/openai-compatible-chat-completions-client.js";

const opinion = { opinion: { segments: [
  { role: "observation", text: "两人各8万元，总费用16万元。" },
  { role: "reasoning", text: "超过10万元预算6万元。" },
  { role: "suggestion", text: "建议先核对预算，再确定人数。" },
], uncertainty: "fact" } };
function setup(assessments: unknown[] = [], reviews = [true]) {
  const client = { complete: vi.fn<OpenAICompatibleChatCompletionsClient["complete"]>(async (messages, options) => {
    const name = options!.responseFormat!.json_schema.name;
    if (name.endsWith("_assessment")) return JSON.stringify({ assessment: assessments.shift() });
    if (name.endsWith("_generated_pair") || name.endsWith("_pair_repair")) return JSON.stringify(opinion);
    const input = JSON.parse(messages[1]!.content);
    return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: reviews.shift() ?? false, reason: "fixture",
      requiredNumbers: [], adviceQuote: input.draft.text });
  }) };
  return { client, model: createPdModel({ client, canonicalOpinion: true, sourceBoundIdentity: true }) };
}
test("an inferred new-issue title cannot enter generation through identity metadata", async () => {
  const s = setup();
  await expect(s.model.render({ context: pdContext(), assessment: pdAssessment() })).rejects.toThrow("source focus");
  expect(s.client.complete).not.toHaveBeenCalled();
});
test("assessment gets one bounded correction when the chosen topic is not source text", async () => {
  const correct = pdAssessment(); correct.issueRef = { kind: "new", description: pdContext().items[1]!.text };
  const s = setup([pdAssessment(), correct]);
  expect((await s.model.assess(pdContext())).issueRef).toEqual(correct.issueRef);
  expect(s.client.complete).toHaveBeenCalledTimes(2);
});
test("both generation and review receive a source-bound focus, never the initial analysis", async () => {
  const a = pdAssessment(); a.issueRef = { kind: "new", description: pdContext().items[1]!.text };
  a.reasoning = "已经存在严重样本偏差，这是未验证的内部结论";
  const s = setup(); const pair = await s.model.render({ context: pdContext(), assessment: a });
  expect(pair).not.toBeNull();
  for (const call of s.client.complete.mock.calls) {
    expect(call[0][1]!.content).not.toContain("严重样本偏差");
    const input = JSON.parse(call[0][1]!.content); const target = input.target ?? input.identityTarget;
    expect(target.issueRef).toEqual({ kind: "new", sourceFocus: { sourceRef: a.evidenceRefs[1], sourceQuote: pdContext().items[1]!.text } });
  }
});
test("a quote from an unselected source is not a valid focus", async () => {
  const a = pdAssessment(); a.issueRef = { kind: "new", description: pdContext().items[1]!.text };
  a.evidenceRefs = a.evidenceRefs.slice(0, 1); a.materialChange.evidenceRefs = [...a.evidenceRefs];
  const s = setup();
  await expect(s.model.render({ context: pdContext(), assessment: a })).rejects.toThrow("source focus");
  expect(s.client.complete).not.toHaveBeenCalled();
});
test("skip and existing issue identities do not require new source quotations", async () => {
  const s = setup([pdSkipAssessment()]); expect((await s.model.assess(pdContext())).decision).toBe("skip");
  const a = pdAssessment(); a.issueRef = { kind: "existing", id: "issue-1" }; a.materialChange.kind = "new_evidence";
  const pair = await s.model.render({ context: pdContextWithIssue(), assessment: a });
  expect(pair?.assessment.issueRef).toEqual(a.issueRef);
});
test("the same source focus survives canonical correction and final review", async () => {
  const a = pdAssessment(); a.issueRef = { kind: "new", description: pdContext().items[1]!.text };
  const s = setup([], [false, true]); expect(await s.model.render({ context: pdContext(), assessment: a })).not.toBeNull();
  expect(s.client.complete).toHaveBeenCalledTimes(4);
  const targets = s.client.complete.mock.calls.map(call => {
    const input = JSON.parse(call[0][1]!.content); return (input.target ?? input.identityTarget).issueRef;
  });
  expect(targets.every(target => JSON.stringify(target) === JSON.stringify(targets[0]))).toBe(true);
  expect(targets[0].description).toBeUndefined();
});
test("two invalid identity selections do not fall back to the inferred title", async () => {
  const s = setup([pdAssessment(), pdAssessment()]);
  await expect(s.model.assess(pdContext())).rejects.toThrow("assessment was invalid");
  expect(s.client.complete).toHaveBeenCalledTimes(2);
});
