import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { Ajv } from "ajv";
import { createPdModel, validatePdScopeReview } from "../src/proactive-discussion/model.js";
import { createPdScopeReviewJsonSchema, type PdScopeReviewHistory } from "../src/proactive-discussion/review-receipts.js";
import type { PdContext } from "../src/proactive-discussion/contracts.js";
import { pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";

const draft = "5人表示喜欢不等于全量用户付费。建议验证实际付费意愿。";
const unavailable = { label: "收入总额", expectedValue: null, unit: null, draftQuote: null,
  missingInputs: "未提供用户总数、单价与实际付费转化率。" };
const review = (numbers: unknown[]) => ({ fieldChecks: pdReviewFieldChecks(), supported: true,
  reason: "无法计算收入，但可以指出推理缺口并验证付费意愿。", requiredNumbers: numbers,
  adviceQuote: "建议验证实际付费意愿。" });

test("represents an unavailable calculation without demanding a fabricated zero in the draft", () => {
  expect(validatePdScopeReview(review([unavailable]), draft)).toEqual(review([unavailable]));
  const accepts = new Ajv({ strict: false }).compile(createPdScopeReviewJsonSchema(draft));
  expect(accepts(review([unavailable]))).toBe(true);
});

test.each([
  { ...unavailable, missingInputs: " " },
  { ...unavailable, missingInputs: undefined },
  { ...unavailable, expectedValue: "0" },
  { ...unavailable, unit: "不适用" },
  { ...unavailable, draftQuote: draft },
])("rejects ambiguous or mixed unavailable states: %j", number => {
  expect(() => validatePdScopeReview(review([number]), draft)).toThrow();
  expect(new Ajv({ strict: false }).compile(createPdScopeReviewJsonSchema(draft))(review([number]))).toBe(false);
});

test("a real zero still requires its complete value and unit in the draft", () => {
  const zero = { label: "差额", expectedValue: "0", unit: "万元", draftQuote: "差额0万元。" };
  expect(validatePdScopeReview(review([zero, unavailable]), `差额0万元。${draft}`).supported).toBe(true);
  expect(validatePdScopeReview(review([zero, unavailable]), draft).supported).toBe(false);
});

test("unavailable status cannot silently discharge a previously computable amount", () => {
  const history: PdScopeReviewHistory = { previousNumbers: [{ label: "总额", expectedValue: "16", unit: "万元", draftQuote: null }],
    evidence: [{ ref: "M1", text: "数据尚未提供。" }] };
  expect(validatePdScopeReview({ ...review([unavailable]), numberRevisions: [] }, draft, history).supported).toBe(false);
});

test("unknown inputs do not become numeric continuity obligations on the next review", () => {
  const first = validatePdScopeReview(review([unavailable]), draft);
  expect(validatePdScopeReview({ ...review([]), numberRevisions: [] }, draft, { previousNumbers: first.requiredNumbers, evidence: [] }).supported).toBe(true);
});

test("unavailable entries cannot override a semantic rejection or an explicit arithmetic contradiction", () => {
  expect(validatePdScopeReview({ ...review([unavailable]), supported: false }, draft).supported).toBe(false);
  expect(validatePdScopeReview(review([unavailable]), `16万元减10万元，差额为-6万元。${draft}`).supported).toBe(false);
});

test("mixed history keeps original revision indices when a known requirement is withdrawn with evidence", () => {
  const first = validatePdScopeReview(review([unavailable]), draft);
  const history: PdScopeReviewHistory = { previousNumbers: [...first.requiredNumbers,
    { label: "差额", expectedValue: "0", unit: "元", draftQuote: null }],
    evidence: [{ ref: "M1", text: "访谈5人，都表示喜欢。" }] };
  const revision = { previousIndex: 1, replacementIndex: 0, reason: "来源未提供单价及用户总数，0无依据。",
    sourceRef: "M1", sourceQuote: "访谈5人，都表示喜欢。" };
  expect(validatePdScopeReview({ ...review([unavailable]), numberRevisions: [revision] }, draft, history).supported).toBe(true);
  expect(validatePdScopeReview({ ...review([unavailable]), numberRevisions: [{ ...revision, previousIndex: 0 }] }, draft, history).supported).toBe(false);
});

test("the archived inference pair can return without rewriting the draft to satisfy unknown amounts", async () => {
  const archived = JSON.parse(readFileSync(new URL("../../../docs/development/evidence/iris-advice-ablation-20260927.json", import.meta.url), "utf8"));
  const generated = archived.completions.find((c: { caseId: string; stage: string }) => c.caseId === "inference" && c.stage.endsWith("generated_pair"));
  const pair = JSON.parse(generated.content);
  const approval = { ...review([unavailable]), adviceQuote: pair.draft.text };
  const client = { complete: vi.fn().mockResolvedValueOnce(generated.content).mockResolvedValueOnce(JSON.stringify(approval)) };
  const evalPath = "../../../scripts/pilot/proactive-discussion-eval.ts";
  const { createProactiveDiscussionEvalCases } = await import(evalPath) as {
    createProactiveDiscussionEvalCases(): { id: string; context: PdContext }[];
  };
  const context = createProactiveDiscussionEvalCases().find(c => c.id === "inference")!.context;
  expect(await createPdModel({ client }).render({ context, assessment: pair.assessment })).toEqual(pair);
  expect(client.complete).toHaveBeenCalledTimes(2);
});
