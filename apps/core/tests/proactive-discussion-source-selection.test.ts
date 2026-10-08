import { Ajv } from "ajv";
import { expect, test, vi } from "vitest";
import { createPdModel } from "../src/proactive-discussion/model.js";
import { compilePdOpinionPlan } from "../src/proactive-discussion/opinion-plan.js";
import { buildPdOpinionSourceCatalog, resolvePdOpinionSourceSelection } from "../src/proactive-discussion/source-selection.js";
import type { OpenAICompatibleChatCompletionsClient } from "../src/model/openai-compatible-chat-completions-client.js";
import { pdAssessment, pdContext, pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";

function setup() {
  const context = pdContext();
  context.items[0]!.text = "供应商接口还没有联调验证。";
  context.items[1]!.text = "现在就向客户承诺下周肯定交付。";
  const assessment = pdAssessment();
  assessment.issueRef = { kind: "new", description: context.items[1]!.text };
  const plan = { kind: "dependency", premise: { sourceRef: context.items[0]!.ref, startUnit: 0, endUnit: 8 },
    decision: { sourceRef: context.items[1]!.ref, startUnit: 0, endUnit: 8 },
    verificationTarget: { sourceRef: context.items[0]!.ref, startUnit: 0, endUnit: 2 },
    changeExplanation: "当前承诺缺少接口验证。" };
  const client = { complete: vi.fn<OpenAICompatibleChatCompletionsClient["complete"]>(async (messages, options) => {
    if (options!.responseFormat!.json_schema.name.startsWith("iris_proactive_discussion_opinion_plan")) return JSON.stringify(plan);
    const input = JSON.parse(messages[1]!.content);
    return JSON.stringify({ supported: true, fieldChecks: pdReviewFieldChecks(), reason: "fixture review",
      requiredNumbers: [], adviceQuote: input.assessment.suggestion });
  }) };
  const model = createPdModel({ client, canonicalOpinion: true, sourceBoundIdentity: true, opinionPlan: true });
  return { context, assessment, plan, client, model };
}

test("continuous source selection preserves the dropped 就 and passes exact quotes to full review", async () => {
  const { context, assessment, plan, client, model } = setup();
  // Reproduces the observed copy failure without deciding the semantic verdict.
  expect(() => compilePdOpinionPlan({ ...plan,
    premise: { sourceRef: plan.premise.sourceRef, quote: context.items[0]!.text },
    decision: { sourceRef: plan.decision.sourceRef, quote: "现在向客户承诺下周肯定交付。" },
    verificationTarget: { sourceRef: plan.premise.sourceRef, quote: "供应商接口" },
  }, true, context.items)).toThrow("quote is not bound");
  const pair = await model.render({ context, assessment });
  expect(pair?.draft.text).toContain("现在就向客户承诺下周肯定交付。");
  expect(pair?.draft.text).not.toContain("现在向客户");
  expect(pair?.assessment.suggestion).toContain("供应商接口");
  expect(client.complete).toHaveBeenCalledTimes(2);
  const review = JSON.parse(client.complete.mock.calls[1]![0][1]!.content);
  expect(review.sourcePlan).toEqual(plan);
  expect(review.resolvedSourcePlan.decision).toEqual({ sourceRef: plan.decision.sourceRef, quote: "现在就向客户承诺下周肯定交付。" });
  expect(review.resolvedSourcePlan.verificationTarget.quote).toBe("供应商接口");
  expect(review.evidence.map((item: any) => item.text)).toEqual(context.items.map(item => item.text));
});

test("catalog exhaustively preserves whitespace, repeated words, punctuation and Unicode in every selected source", async () => {
  const { context, assessment, client, model } = setup();
  context.items[0]!.text = "甲 乙，\r\n甲 e\u0301🙂";
  client.complete.mockResolvedValueOnce(JSON.stringify({ kind: "no_intervention", reason: "insufficient_basis" }));
  expect(await model.render({ context, assessment })).toBeNull();
  const input = JSON.parse(client.complete.mock.calls[0]![0][1]!.content);
  expect(input.sourceCatalog).toHaveLength(2);
  expect(input.sourceCatalog.map((source: any) => ({ ref: source.sourceRef, text: source.units.map((unit: any) => unit.text).join("") })))
    .toEqual(context.items.map(({ ref, text }) => ({ ref, text })));
  expect(input.sourceCatalog[0].units).toEqual([
    { id: 0, text: "甲" }, { id: 1, text: " " }, { id: 2, text: "乙" }, { id: 3, text: "，" },
    { id: 4, text: "\r\n" }, { id: 5, text: "甲" }, { id: 6, text: " " }, { id: 7, text: "e\u0301" }, { id: 8, text: "🙂" },
  ]);
  expect(input.discussion.materials).toEqual(context.items);
});

test("live generation and repair schemas refuse quote copying and accept only bounded integer endpoints", async () => {
  const { context, assessment, plan, client, model } = setup();
  client.complete.mockResolvedValueOnce(JSON.stringify({ ...plan, decision: plan.premise }));
  await model.render({ context, assessment }).catch(() => null);
  expect(client.complete.mock.calls).toHaveLength(3);
  for (const call of client.complete.mock.calls.slice(0, 2)) {
    const validate = new Ajv().compile(call[1]!.responseFormat!.json_schema.schema);
    expect(validate(plan)).toBe(true);
    expect(validate({ ...plan, decision: { sourceRef: plan.decision.sourceRef, quote: context.items[1]!.text } })).toBe(false);
    expect(validate({ ...plan, decision: { ...plan.decision, startUnit: 0.5 } })).toBe(false);
    expect(validate({ ...plan, decision: { ...plan.decision, startUnit: -1 } })).toBe(false);
  }
});

test.each(["range", "review"] as const)("%s repair uses the same complete catalog and preserves the one-repair budget", async failure => {
  const { context, assessment, plan, client, model } = setup();
  if (failure === "range") client.complete.mockResolvedValueOnce(JSON.stringify({ ...plan, decision: { ...plan.decision, endUnit: 999 } }));
  else client.complete.mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValueOnce(JSON.stringify({
    supported: false, fieldChecks: { ...pdReviewFieldChecks(), reasoning: { supported: false, reason: "fixture rejection" } },
    reason: "fixture rejection", requiredNumbers: [], adviceQuote: null,
  }));
  expect(await model.render({ context, assessment })).not.toBeNull();
  expect(client.complete).toHaveBeenCalledTimes(failure === "range" ? 3 : 4);
  const first = JSON.parse(client.complete.mock.calls[0]![0][1]!.content);
  const repair = JSON.parse(client.complete.mock.calls[failure === "range" ? 1 : 2]![0][1]!.content);
  expect(first.sourceCatalog).toHaveLength(2);
  expect(repair.sourceCatalog).toEqual(first.sourceCatalog);
  expect(repair.evidence).toEqual(first.evidence);
  const final = JSON.parse(client.complete.mock.calls.at(-1)![0][1]!.content);
  expect(final.resolvedSourcePlan.decision.quote).toBe("现在就向客户承诺下周肯定交付。");
});

test("live quote-only responses cannot fall back to the canonical internal compiler", async () => {
  const { context, assessment, plan, client, model } = setup();
  client.complete.mockResolvedValueOnce(JSON.stringify({ ...plan,
    premise: { sourceRef: plan.premise.sourceRef, quote: context.items[0]!.text },
    decision: { sourceRef: plan.decision.sourceRef, quote: context.items[1]!.text },
    verificationTarget: { sourceRef: plan.premise.sourceRef, quote: "供应商接口" },
  }));
  await expect(model.render({ context, assessment })).rejects.toThrow("draft was invalid");
  expect(client.complete).toHaveBeenCalledTimes(1);
});

test("a render snapshots full source context before awaits so review and repairs cannot see different text", async () => {
  const { context, assessment, plan, client, model } = setup();
  client.complete.mockImplementationOnce(async () => {
    context.items[0]!.text = "CHANGED_AFTER_CATALOG";
    return JSON.stringify(plan);
  });
  const pair = await model.render({ context, assessment });
  expect(pair?.draft.text).toContain("供应商接口还没有联调验证。");
  const generation = JSON.parse(client.complete.mock.calls[0]![0][1]!.content);
  const review = JSON.parse(client.complete.mock.calls[1]![0][1]!.content);
  expect(review.evidence).toEqual(generation.evidence);
  expect(review.discussion).toEqual(generation.discussion);
  expect(review.sourceCatalog).toEqual(generation.sourceCatalog);
  expect(JSON.stringify(review)).not.toContain("CHANGED_AFTER_CATALOG");
});

test("resolved quotes preserve combining Unicode bytes while outward prose keeps its existing NFC contract", async () => {
  const { context, assessment, plan, client, model } = setup();
  context.items[0]!.text = "甲 乙，\r\n甲 e\u0301🙂";
  client.complete.mockResolvedValueOnce(JSON.stringify({ ...plan, verificationTarget: { ...plan.premise, startUnit: 7, endUnit: 8 } }));
  const pair = await model.render({ context, assessment });
  const review = JSON.parse(client.complete.mock.calls[1]![0][1]!.content);
  expect(review.resolvedSourcePlan.premise.quote).toBe("甲 乙，\r\n甲 e\u0301🙂");
  expect(review.resolvedSourcePlan.verificationTarget.quote).toBe("e\u0301🙂");
  expect(pair?.draft.text).toContain("甲 乙，\r\n甲 é🙂");
});

test.each([
  { sourceRef: "source", startUnit: 2, endUnit: 1 },
  { sourceRef: "source", startUnit: 0, endUnit: 20 },
  { sourceRef: "foreign", startUnit: 0, endUnit: 0 },
  { sourceRef: "source", startUnit: 1, endUnit: 1 },
  { sourceRef: "source", startUnit: -1, endUnit: 1 },
  { sourceRef: "source", startUnit: 0.5, endUnit: 1 },
  { sourceRef: "source", startUnit: 0 },
  { sourceRef: "source", startUnit: 0, endUnit: 0, quote: "甲" },
])("invalid, foreign or whitespace-only ranges are rejected: %j", premise => {
  const catalog = buildPdOpinionSourceCatalog([{ ref: "source", text: "甲 乙" }]);
  expect(() => resolvePdOpinionSourceSelection({ kind: "inference", premise,
    decision: { sourceRef: "source", startUnit: 2, endUnit: 2 }, changeExplanation: "test" }, catalog)).toThrow();
});

test("resolver rejects ambiguous references, missing unit IDs, empty sources and quotes over 200 characters", () => {
  const range = { sourceRef: "source", startUnit: 0, endUnit: 0 };
  const plan = { kind: "inference", premise: range, decision: range, changeExplanation: "test" };
  for (const catalog of [
    buildPdOpinionSourceCatalog([{ ref: "source", text: "甲" }, { ref: "source", text: "乙" }]),
    [{ sourceRef: "source", units: [{ id: 1, text: "甲" }] }],
    buildPdOpinionSourceCatalog([{ ref: "source", text: "" }]),
    buildPdOpinionSourceCatalog([{ ref: "source", text: "a".repeat(201) }]),
  ]) expect(() => resolvePdOpinionSourceSelection(plan, catalog)).toThrow();
});

test("verification target containment uses source locations even when identical words repeat elsewhere", () => {
  const catalog = buildPdOpinionSourceCatalog([{ ref: "source", text: "甲 乙 甲" }]);
  expect(() => resolvePdOpinionSourceSelection({ kind: "dependency",
    premise: { sourceRef: "source", startUnit: 0, endUnit: 0 },
    decision: { sourceRef: "source", startUnit: 2, endUnit: 2 },
    verificationTarget: { sourceRef: "source", startUnit: 4, endUnit: 4 }, changeExplanation: "test",
  }, catalog)).toThrow("outside the selected gap");
});
