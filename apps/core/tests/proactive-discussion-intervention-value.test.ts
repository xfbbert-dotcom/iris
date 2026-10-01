import { expect, test, vi } from "vitest";
import { createPdModel } from "../src/proactive-discussion/model.js";
import { pdAssessment, pdContext, pdContextWithIssue, pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";
import type { OpenAICompatibleChatCompletionsClient } from "../src/model/openai-compatible-chat-completions-client.js";

const opinion = { opinion: { segments: [
  { role: "observation", text: "两人各8万元，总费用16万元。" },
  { role: "reasoning", text: "超过10万元预算6万元。" },
  { role: "suggestion", text: "建议先核对预算，再确定人数。" },
], uncertainty: "fact", changeExplanation: "首次发现本次预算缺口，尚无同等意见。" } };
function setup(reviews = [true], repaired = opinion) {
  const client = { complete: vi.fn<OpenAICompatibleChatCompletionsClient["complete"]>(async (messages, options) => {
    const name = options!.responseFormat!.json_schema.name;
    if (name.endsWith("_generated_pair")) return JSON.stringify(opinion);
    if (name.endsWith("_pair_repair")) return JSON.stringify(repaired);
    const input = JSON.parse(messages[1]!.content);
    const supported = reviews.shift() ?? false;
    return JSON.stringify({ fieldChecks: { ...pdReviewFieldChecks(),
      materialChange: { supported, reason: supported ? "checked history" : "no new contribution" } },
      supported, reason: "fixture", requiredNumbers: [], adviceQuote: input.draft.text });
  }) };
  const model = createPdModel({ client, canonicalOpinion: true, sourceBoundIdentity: true, separateInterventionValue: true });
  return { client, model };
}
function initial() {
  const a = pdAssessment(); a.issueRef = { kind: "new", description: pdContext().items[1]!.text };
  a.reasoning = "UNVERIFIED_INITIAL_REASON";
  a.materialChange.explanation = "UNVERIFIED_INITIAL_VALUE";
  return a;
}

test("intervention value remains reviewed metadata rather than forced user prose", async () => {
  const { client, model } = setup();
  const pair = await model.render({ context: pdContext(), assessment: initial() });
  expect(pair?.draft.text).toBe(opinion.opinion.segments.map(s => s.text).join(""));
  expect(pair?.assessment.materialChange.explanation).toBe(opinion.opinion.changeExplanation);
  expect(pair?.assessment.reasoning).toBe(opinion.opinion.segments[1]!.text);
  const generation = JSON.parse(client.complete.mock.calls[0]![0][1]!.content);
  expect(generation.discussion.materials).toEqual(pdContext().items);
  expect(generation.evaluationContext.deliveryState).toBe("not_sent");
  expect(JSON.stringify(generation)).not.toContain("UNVERIFIED_INITIAL");
  const review = JSON.parse(client.complete.mock.calls[1]![0][1]!.content);
  expect(review.assessment.materialChange.explanation).toBe(opinion.opinion.changeExplanation);
  expect(review.draft.text).not.toContain("首次");
});

test("generation gets real prior handling without expanding selected fact evidence", async () => {
  const { client, model } = setup(); const context = pdContextWithIssue();
  const a = initial(); a.issueRef = { kind: "existing", id: "issue-1" }; a.materialChange.kind = "new_evidence";
  await model.render({ context, assessment: a });
  const input = JSON.parse(client.complete.mock.calls[0]![0][1]!.content);
  expect(input.discussion.suppliedIssues[0].lastSuggestion).toBe(context.issues[0]!.lastSuggestion);
  expect(input.evidence.map((s: {ref: string}) => s.ref)).toEqual(a.evidenceRefs);
  expect(JSON.stringify(input)).not.toContain("UNVERIFIED_INITIAL");
});

test("one repair updates the metadata and final review can still reject its novelty", async () => {
  const repaired = structuredClone(opinion); repaired.opinion.changeExplanation = "修正后的介入资格仍须审核。";
  const { client, model } = setup([false, false], repaired);
  expect(await model.render({ context: pdContext(), assessment: initial() })).toBeNull();
  expect(client.complete).toHaveBeenCalledTimes(4);
  const final = JSON.parse(client.complete.mock.calls[3]![0][1]!.content);
  expect(final.assessment.materialChange.explanation).toBe(repaired.opinion.changeExplanation);
  expect(final.draft.text).not.toContain(repaired.opinion.changeExplanation);
});

test("separate intervention value requires its complete explicit workflow", () => {
  const client = { complete: vi.fn() };
  expect(() => createPdModel({ client, separateInterventionValue: true })).toThrow();
  expect(() => createPdModel({ client, canonicalOpinion: true, sourceBoundIdentity: true,
    assessmentOpinion: true, separateInterventionValue: true })).toThrow();
});

test("arithmetic contradictions in private intervention value still reach the sole correction", async () => {
  const bad = structuredClone(opinion); bad.opinion.changeExplanation = "需求16万元减去预算10万元，差额为-6万元。";
  const { client, model } = setup([true, true], bad);
  const original = client.complete.getMockImplementation()!;
  client.complete.mockImplementation(async (messages, options) => options?.responseFormat?.json_schema.name.endsWith("_generated_pair")
    ? JSON.stringify(bad) : original(messages, options));
  expect(await model.render({ context: pdContext(), assessment: initial() })).toBeNull();
  expect(client.complete).toHaveBeenCalledTimes(4);
  const repair = JSON.parse(client.complete.mock.calls[2]![0][1]!.content);
  expect(repair.review.reason).toContain("assessment.materialChange.explanation");
  expect(repair.review.supported).toBe(false);
});
