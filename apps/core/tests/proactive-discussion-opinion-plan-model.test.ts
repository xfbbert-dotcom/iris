import { expect, test, vi } from "vitest";
import { createPdModel } from "../src/proactive-discussion/model.js";
import { pdAssessment, pdContext, pdContextWithIssue, pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";
import type { OpenAICompatibleChatCompletionsClient } from "../src/model/openai-compatible-chat-completions-client.js";

function setup(verdicts = [true], repairExtra: Record<string, unknown> = {}) {
  const context = pdContext();
  context.items[0]!.text = "供应商接口还没有联调验证。";
  context.items[1]!.text = "准备向客户承诺下周肯定交付。";
  const assessment = pdAssessment();
  assessment.issueRef = { kind: "new", description: context.items[1]!.text };
  assessment.reasoning = "UNVERIFIED_INITIAL_CERTAINTY";
  assessment.materialChange.explanation = "UNVERIFIED_INITIAL_VALUE";
  const plan = { kind: "dependency", premise: { sourceRef: context.items[0]!.ref, startUnit: 0, endUnit: 8 },
    decision: { sourceRef: context.items[1]!.ref, startUnit: 0, endUnit: 7 },
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

test.each(["generation", "binding_repair", "review_repair"] as const)("a conditional plan can withdraw a mistaken intervention at %s without more review or repair", async stage => {
  const { context, assessment, plan, client, model } = setup([false]);
  context.items[0]!.text = "版本A完成后，把文档事项落实。";
  assessment.issueRef = { kind: "new", description: context.items[0]!.text };
  const withdrawal = { kind: "no_intervention", reason: "no_material_issue" };
  const mistaken = { ...plan,
    premise: { sourceRef: context.items[0]!.ref, startUnit: 0, endUnit: 2 },
    decision: { sourceRef: context.items[0]!.ref, startUnit: 4, endUnit: 8 } };
  if (stage === "generation") client.complete.mockResolvedValueOnce(JSON.stringify(withdrawal));
  if (stage === "binding_repair") client.complete
    .mockResolvedValueOnce(JSON.stringify({ ...mistaken, decision: mistaken.premise }))
    .mockResolvedValueOnce(JSON.stringify(withdrawal));
  if (stage === "review_repair") client.complete
    .mockResolvedValueOnce(JSON.stringify(mistaken))
    .mockResolvedValueOnce(JSON.stringify({ fieldChecks: { ...pdReviewFieldChecks(), reasoning: { supported: false, reason: "原句已保留先后条件。" } },
      supported: false, reason: "没有绕过前提的决定。", requiredNumbers: [], adviceQuote: null }))
    .mockResolvedValueOnce(JSON.stringify(withdrawal));
  expect(await model.render({ context, assessment })).toBeNull();
  expect(client.complete).toHaveBeenCalledTimes(stage === "generation" ? 1 : stage === "binding_repair" ? 2 : 3);
  expect(assessment.decision).toBe("intervene");
  const initialInput = JSON.parse(client.complete.mock.calls[0]![0][1]!.content);
  expect(initialInput.evidence[0].text).toBe("版本A完成后，把文档事项落实。");
});

test("malformed withdrawal is a render failure rather than silently accepted abstention", async () => {
  const { context, assessment, client, model } = setup();
  client.complete.mockResolvedValueOnce(JSON.stringify({ kind: "no_intervention", reason: "no_material_issue", draftText: "未审核意见" }));
  await expect(model.render({ context, assessment })).rejects.toThrow("proactive discussion draft was invalid");
  expect(client.complete).toHaveBeenCalledTimes(1);
});

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
  { verificationTarget: { sourceRef: "missing", startUnit: 0, endUnit: 2 } },
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

test.each([true, false])("a locally invalid binding consumes the only correction before full review: %s", async supported => {
  const { context, assessment, plan, client, model } = setup([supported]);
  const invalid = { ...plan, decision: plan.premise };
  client.complete.mockResolvedValueOnce(JSON.stringify(invalid));
  const pair = await model.render({ context, assessment });
  expect(pair !== null).toBe(supported);
  expect(client.complete).toHaveBeenCalledTimes(3);
  const correction = JSON.parse(client.complete.mock.calls[1]![0][1]!.content);
  expect(correction.currentPlan).toEqual(invalid);
  expect(correction.localValidation.reason).toContain("premise and decision must differ");
  expect(correction.evidence).toEqual(context.items.map(item => ({ ...item, kind: "message" })));
  expect(correction.discussion.materials).toEqual(context.items);
  expect(correction).not.toHaveProperty("draft");
  expect(correction).not.toHaveProperty("review");
  expect(correction).not.toHaveProperty("assessment");
  expect(JSON.stringify(correction)).not.toContain("UNVERIFIED_INITIAL");
  const reviewed = JSON.parse(client.complete.mock.calls[2]![0][1]!.content);
  expect(reviewed.sourcePlan).toEqual(plan);
  expect(reviewed.draft.text).toContain(context.items[1]!.text);
  expect(reviewed).not.toHaveProperty("previousReview");
});

test.each(["same", "missing", "unsupported"])("failed local correction stays an execution failure: %s", async kind => {
  const { context, assessment, plan, client, model } = setup();
  const invalid = { ...plan, decision: plan.premise };
  const correction = kind === "same" ? invalid : kind === "unsupported" ? { kind: "unsupported" }
    : { ...plan, decision: { sourceRef: "missing", startUnit: 0, endUnit: 0 } };
  client.complete.mockResolvedValueOnce(JSON.stringify(invalid)).mockResolvedValueOnce(JSON.stringify(correction));
  await expect(model.render({ context, assessment })).rejects.toThrow("proactive discussion draft was invalid");
  expect(client.complete).toHaveBeenCalledTimes(2);
  expect(assessment.decision).toBe("intervene");
});

test("local binding recovery respects cancellation before another model request", async () => {
  const { context, assessment, plan, client, model } = setup();
  client.complete.mockResolvedValueOnce(JSON.stringify({ ...plan, decision: plan.premise }));
  const active = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("cancelled"));
  await expect(model.render({ context, assessment }, active)).rejects.toThrow("cancelled");
  expect(client.complete).toHaveBeenCalledTimes(1);
});

test("unparseable JSON has no binding correction and transport errors are not retried", async () => {
  const { context, assessment, client, model } = setup();
  client.complete.mockResolvedValueOnce("{");
  await expect(model.render({ context, assessment })).rejects.toThrow("proactive discussion draft was invalid");
  expect(client.complete).toHaveBeenCalledTimes(1);
  client.complete.mockRejectedValueOnce(new Error("transport"));
  await expect(model.render({ context, assessment })).rejects.toThrow("transport");
  expect(client.complete).toHaveBeenCalledTimes(2);
});

test("controlled plan requires the source-bound workflow and rejects competing prose modes", () => {
  const client = { complete: vi.fn() };
  expect(() => createPdModel({ client, opinionPlan: true })).toThrow();
  expect(() => createPdModel({ client, canonicalOpinion: true, sourceBoundIdentity: true,
    assessmentOpinion: true, opinionPlan: true })).toThrow();
});

function silentAssessment() {
  return { ...pdAssessment(), decision: "skip", reason: "duplicate", issueRef: null,
    evidenceRefs: [], observation: "", reasoning: "", suggestion: "", uncertainty: "fact",
    materialChange: { kind: "none", explanation: "", evidenceRefs: [] } };
}

test("plan-mode silence requests and returns a decision without unaudited prose", async () => {
  const { context, client, model } = setup();
  const silent = silentAssessment();
  client.complete.mockResolvedValueOnce(JSON.stringify({ assessment: silent }));
  expect(await model.assess(context)).toEqual(silent);
  const schema = client.complete.mock.calls[0]![1]!.responseFormat!.json_schema.schema as any;
  const branch = schema.properties.assessment.anyOf.find((value: any) => value.properties.decision.enum[0] === "skip");
  for (const field of ["observation", "reasoning", "suggestion"]) {
    expect(branch.properties[field]).toEqual({ type: "string", enum: [""] });
  }
  expect(client.complete).toHaveBeenCalledTimes(1);
});

test.each(["observation", "reasoning", "suggestion"] as const)("plan-mode skip rejects %s instead of silently erasing it", async field => {
  const { context, client, model } = setup();
  const silent = silentAssessment();
  const invalid = { ...silent, [field]: "发送结果未知。" };
  client.complete.mockResolvedValueOnce(JSON.stringify({ assessment: invalid }))
    .mockResolvedValueOnce(JSON.stringify({ assessment: silent }));
  expect(await model.assess(context)).toEqual(silent);
  expect(client.complete).toHaveBeenCalledTimes(2);
  expect(client.complete.mock.calls[1]![0][0]!.content).toContain("skip must not contain unreviewed prose");
  expect(client.complete.mock.calls[1]![1]!.responseFormat).toEqual(client.complete.mock.calls[0]![1]!.responseFormat);
  expect(invalid[field]).toBe("发送结果未知。");
});

test("plan-mode skip recovery is bounded and cannot turn a rejected response into a valid decision", async () => {
  const { context, client, model } = setup();
  client.complete.mockResolvedValue(JSON.stringify({ assessment: { ...silentAssessment(), reasoning: "发送结果未知。" } }));
  await expect(model.assess(context)).rejects.toThrow("proactive discussion assessment was invalid");
  expect(client.complete).toHaveBeenCalledTimes(2);
});

test("legacy assessment keeps its existing skip prose contract", async () => {
  const { context, client } = setup();
  const silent = { ...silentAssessment(), reasoning: "已有相同问题。" };
  client.complete.mockResolvedValueOnce(JSON.stringify({ assessment: silent }));
  expect(await createPdModel({ client }).assess(context)).toEqual(silent);
  expect(client.complete).toHaveBeenCalledTimes(1);
});

test.each(["duplicate", "resolved"])("decision-only skip preserves typed %s, identity and evidence", async reason => {
  const { client, model } = setup();
  const context = pdContextWithIssue();
  const silent = { ...silentAssessment(), reason, issueRef: { kind: "existing", id: "issue-1" },
    evidenceRefs: [context.items[1]!.ref] };
  client.complete.mockResolvedValueOnce(JSON.stringify({ assessment: silent }));
  expect(await model.assess(context)).toEqual(silent);
  expect(client.complete).toHaveBeenCalledTimes(1);
});

test("plan-mode intervening assessment retains its full validation contract", async () => {
  const { context, assessment, client, model } = setup();
  client.complete.mockResolvedValueOnce(JSON.stringify({ assessment }));
  expect(await model.assess(context)).toEqual(assessment);
  const schema = client.complete.mock.calls[0]![1]!.responseFormat!.json_schema.schema as any;
  const branch = schema.properties.assessment.anyOf.find((value: any) => value.properties.decision.enum[0] === "intervene");
  expect(branch.properties.reasoning.minLength).toBe(1);
  expect(branch.properties.reasoning.enum).toBeUndefined();
});
