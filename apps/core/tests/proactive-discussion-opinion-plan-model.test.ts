import { expect, test, vi } from "vitest";
import { createPdModel } from "../src/proactive-discussion/model.js";
import { pdAssessment, pdContext, pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";
import type { OpenAICompatibleChatCompletionsClient } from "../src/model/openai-compatible-chat-completions-client.js";

function setup(verdicts = [true], repairExtra: Record<string, unknown> = {}) {
  const context = pdContext();
  context.items[0]!.text = "供应商接口还没有联调验证。";
  context.items[1]!.text = "准备向客户承诺下周肯定交付。";
  const assessment = pdAssessment();
  assessment.issueRef = { kind: "new", description: context.items[1]!.text };
  assessment.reasoning = "UNVERIFIED_INITIAL_CERTAINTY";
  assessment.materialChange.explanation = "UNVERIFIED_INITIAL_VALUE";
  const plan = { kind: "dependency", premise: { sourceRef: context.items[0]!.ref, quote: context.items[0]!.text },
    decision: { sourceRef: context.items[1]!.ref, quote: context.items[1]!.text },
    verificationTarget: { sourceRef: context.items[0]!.ref, quote: "供应商接口" },
    changeExplanation: "当前尚未处理这个确定承诺所依赖的验证缺口。" };
  const client = { complete: vi.fn<OpenAICompatibleChatCompletionsClient["complete"]>(async (messages, options) => {
    const name = options!.responseFormat!.json_schema.name;
    if (name === "iris_proactive_discussion_opinion_plan") return JSON.stringify(plan);
    if (name === "iris_proactive_discussion_opinion_plan_repair") return JSON.stringify({ ...plan, ...repairExtra });
    const input = JSON.parse(messages[1]!.content);
    const supported = verdicts.shift() ?? false;
    return JSON.stringify({ fieldChecks: { ...pdReviewFieldChecks(), reasoning: { supported, reason: "fixture relation review" } },
      supported, reason: "fixture", requiredNumbers: [], adviceQuote: input.draft?.text ?? "unused" });
  }) };
  const model = createPdModel({ client, canonicalOpinion: true, sourceBoundIdentity: true, opinionPlan: true });
  return { context, assessment, plan, client, model };
}

test("controlled plan compiles source-bound prose and still receives full semantic review", async () => {
  const { context, assessment, plan, client, model } = setup();
  const pair = await model.render({ context, assessment });
  expect(pair?.draft.text).toContain("供应商接口");
  expect(pair?.draft.text).not.toContain("将直接导致无法按期交付");
  expect(pair?.assessment.materialChange.explanation).toBe(plan.changeExplanation);
  expect(pair?.draft.text).not.toContain(plan.changeExplanation);
  expect(client.complete).toHaveBeenCalledTimes(2);
  const generatedInput = JSON.parse(client.complete.mock.calls[0]![0][1]!.content);
  expect(generatedInput.discussion.materials).toEqual(context.items);
  expect(JSON.stringify(generatedInput)).not.toContain("UNVERIFIED_INITIAL");
  const reviewedInput = JSON.parse(client.complete.mock.calls[1]![0][1]!.content);
  expect(reviewedInput.assessment).toEqual(pair?.assessment);
  expect(reviewedInput.draft).toEqual(pair?.draft);
  expect(reviewedInput.sourcePlan).toEqual(plan);
  expect(reviewedInput.identityTarget.issueRef.sourceFocus.sourceQuote).toBe(context.items[1]!.text);
});

test("only one complete plan correction is allowed and final rejection remains effective", async () => {
  const { context, assessment, plan, client, model } = setup([false, false], { changeExplanation: "修正后仍需核对新增价值。" });
  expect(await model.render({ context, assessment })).toBeNull();
  expect(client.complete).toHaveBeenCalledTimes(4);
  const correction = JSON.parse(client.complete.mock.calls[2]![0][1]!.content);
  expect(correction.currentPlan).toEqual(plan);
  const final = JSON.parse(client.complete.mock.calls[3]![0][1]!.content);
  expect(final.assessment.materialChange.explanation).toBe("修正后仍需核对新增价值。");
  expect(final.previousReview.supported).toBe(false);
  expect(final.sourcePlan).toEqual({ ...plan, changeExplanation: "修正后仍需核对新增价值。" });
});

test.each([
  { draftText: "一定会违约。" },
  { kind: "unsupported" },
  { verificationTarget: { sourceRef: "missing", quote: "供应商接口" } },
])("invalid plan correction remains an execution failure without a prose fallback: %j", async repairExtra => {
  const { context, assessment, client, model } = setup([false, true], repairExtra);
  await expect(model.render({ context, assessment })).rejects.toThrow("proactive discussion draft was invalid");
  expect(client.complete).toHaveBeenCalledTimes(3);
});

test("an unsupported plan is an execution failure, not a no-work-value skip or prose fallback", async () => {
  const { context, assessment, client, model } = setup();
  client.complete.mockResolvedValueOnce(JSON.stringify({ kind: "unsupported", changeExplanation: "unknown" }));
  await expect(model.render({ context, assessment })).rejects.toThrow("proactive discussion draft was invalid");
  expect(client.complete).toHaveBeenCalledTimes(1);
  expect(assessment.decision).toBe("intervene");
});

test("real skip does not generate any plan", async () => {
  const { context, assessment, client, model } = setup();
  Object.assign(assessment, { decision: "skip", reason: "already_handled", issueRef: null,
    materialChange: { kind: "none", explanation: "", evidenceRefs: [] } });
  expect(await model.render({ context, assessment })).toBeNull();
  expect(client.complete).not.toHaveBeenCalled();
});

test("controlled plan requires the source-bound workflow and rejects competing prose modes", () => {
  const client = { complete: vi.fn() };
  expect(() => createPdModel({ client, opinionPlan: true })).toThrow();
  expect(() => createPdModel({ client, canonicalOpinion: true, sourceBoundIdentity: true,
    assessmentOpinion: true, opinionPlan: true })).toThrow();
});
