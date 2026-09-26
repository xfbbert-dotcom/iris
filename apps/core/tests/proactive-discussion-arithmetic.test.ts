import { expect, test, vi } from "vitest";
import { createPdModel } from "../src/proactive-discussion/model.js";
import { validatePdScopeReview } from "../src/proactive-discussion/review-receipts.js";
import { pdAssessment, pdContext, pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";
import { inspectPdCalculations } from "../src/proactive-discussion/arithmetic.js";

const approve = (text: string) => ({ fieldChecks: pdReviewFieldChecks(), supported: true,
  reason: "受支持", requiredNumbers: [], adviceQuote: text });

test("preserves the literal operation, signed operands and exact offsets without model extraction", () => {
  const text = "核算：16万元减去可用预算10万元，差额为-6万元。";
  expect(inspectPdCalculations(text)).toEqual([{ start: 3, end: 25,
    quote: "16万元减去可用预算10万元，差额为-6万元", operator: "减去",
    left: "16万元", right: "10万元", claimed: "-6万元", matches: false }]);
  expect(inspectPdCalculations("-\t6 + 10 = 4")[0]?.matches).toBe(true);
});

test.each([
  "16 - 10 = -6。建议核对预算。",
  "16万元减去可用预算10万元，差额为-6万元。建议核对预算。",
  "2 × 8 = 15。建议核对预算。",
  "0.3减去0.1等于0.3。建议核对预算。",
  "10万元 - 160000元 = 6万元。建议核对预算。",
  "16万元−10万元＝−6万元。建议核对预算。",
])("does not accept an explicitly false calculation even when the model approves: %s", text => {
  expect(validatePdScopeReview(approve(text), text)).toMatchObject({ supported: false,
    reason: expect.stringContaining("算术") });
});

test.each([
  "16 - 10 = 6。建议核对预算。",
  "10万元减去需求16万元，余额为-6万元。建议核对预算。",
  "16万元 - 160000元 = 0元。建议核对预算。",
  "0.1 + 0.2 = 0.3。建议核对预算。",
  "2 × 8万元 = 16万元。建议核对预算。",
  "16万元 / 2 = 8万元。建议核对预算。",
  "“16-10=-6”这个说法错误，建议核对预算。",
  "16 - 10并不等于-6。建议核对预算。",
  "不是16-10=-6，而是16-10=6。建议核对预算。",
  "16 - 10 - 2 = 4。建议核对预算。",
  "(16 - 10) / 2 = 3。建议核对预算。",
  "1e3 - 10 = 990。建议核对预算。",
  "1,016 - 10 = 1,006。建议核对预算。",
  "16减10减2等于4。建议核对预算。",
  "16减10等于8减2。建议核对预算。",
  "16减去负的10等于26。建议核对预算。",
  "16除以负数2等于-8。建议核对预算。",
  "16-10=-6不对，应为6。建议核对预算。",
  "16-10=-6是错的。建议核对预算。",
  "假设16-10=-6，则会自相矛盾。建议核对预算。",
])("does not reject valid or outside-grammar statements: %s", text => {
  expect(validatePdScopeReview(approve(text), text).supported).toBe(true);
});

test("routes an assessment arithmetic contradiction through the sole repair and returns the corrected pair", async () => {
  const original = pdAssessment();
  const bad = { ...original, reasoning: "需求总额16万元减去可用预算10万元，差额为-6万元。" };
  const good = { ...original, reasoning: "需求总额16万元减去可用预算10万元，差额为6万元。" };
  const draft = { text: "两人共16万元，比10万元预算多6万元。建议核对预算。", evidenceRefs: original.evidenceRefs };
  const replies = [{ assessment: bad, draft }, approve(draft.text), { assessment: good, draft }, approve(draft.text)];
  const client = { complete: vi.fn(async () => JSON.stringify(replies.shift())) };
  const result = await createPdModel({ client }).render({ context: pdContext(), assessment: original });
  expect(result).toEqual({ assessment: good, draft });
  expect(client.complete).toHaveBeenCalledTimes(4);
});

test("final positive model verdict cannot waive an unchanged arithmetic error", async () => {
  const original = pdAssessment();
  const bad = { ...original, reasoning: "16万元减10万元，差额为-6万元。" };
  const draft = { text: "两人共16万元，缺口6万元。建议核对预算。", evidenceRefs: original.evidenceRefs };
  const replies = [{ assessment: bad, draft }, approve(draft.text), { assessment: bad, draft }, approve(draft.text)];
  const client = { complete: vi.fn(async () => JSON.stringify(replies.shift())) };
  expect(await createPdModel({ client }).render({ context: pdContext(), assessment: original })).toBeNull();
  expect(client.complete).toHaveBeenCalledTimes(4);
});
