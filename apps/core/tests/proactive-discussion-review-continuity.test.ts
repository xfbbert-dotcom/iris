import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { createPdModel } from "./fixtures/proactive-discussion-prose-client.js";
import { validatePdScopeReview, createPdScopeReviewJsonSchema } from "../src/proactive-discussion/review-receipts.js";
import { pdAssessment, pdContext, pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";

type History = {
  previousNumbers: Array<{ label: string; expectedValue: string; unit: string; draftQuote: string | null }>;
  evidence: Array<{ ref: string; text: string }>;
};
const validate = validatePdScopeReview as (value: unknown, draft: string, history?: History) => { supported: boolean; reason: string };
const source = { ref: "authorized-budget", text: "预算10万元。招聘两人，每人8万元。" };
const draft = "两人总成本16万元，比10万元预算多6万元。建议先核对预算。";
const receipt = (value: string) => ({ label: "差额", expectedValue: value, unit: "万元", draftQuote: draft });
const history = (value = "6"): History => ({ previousNumbers: [{ ...receipt(value), draftQuote: null }], evidence: [source] });
const finalReview = () => ({ fieldChecks: pdReviewFieldChecks(), supported: true, reason: "根据原文和当前稿复核。",
  requiredNumbers: [receipt("16"), receipt("6")], adviceQuote: "建议先核对预算。", numberRevisions: [] as unknown[] });
const revision = () => ({ previousIndex: 0, replacementIndex: 1, reason: "两人各8万元合计16万元，减去10万元是6万元，不是60万元。",
  sourceRef: source.ref, sourceQuote: source.text });

test.each([false, true])("does not accept the archived forgotten-gap pair through real render (explicit revisions=%s)", async explicitRevisions => {
  const saved = JSON.parse(readFileSync(new URL("../../../docs/development/evidence/iris-semantic-spike-20260917-pair-edit.json", import.meta.url), "utf8"));
  const evaluatorPath = "../../../scripts/pilot/proactive-discussion-eval.ts";
  const { createProactiveDiscussionEvalCases } = await import(evaluatorPath);
  const context = createProactiveDiscussionEvalCases().find((item: { id: string }) => item.id === "arithmetic").context;
  const assessment = JSON.parse(saved.calls[0].originalMessages.find((item: { role: string }) => item.role === "user").content).assessment;
  let index = 0;
  const client = { complete: vi.fn(async () => {
    const content = saved.calls[index++].content;
    // Test-only adapter preserves the archived draft and assessment verbatim
    // inside the current generation envelope; this is not a new model result.
    if (index === 1) return JSON.stringify({ assessment, draft: JSON.parse(content) });
    if (index !== 2 && index !== 4) return content;
    // Test-only contract adaptation isolates numeric continuity; these checks
    // are not historical model output or evidence of semantic acceptance.
    return JSON.stringify({ ...JSON.parse(content), fieldChecks: pdReviewFieldChecks(),
      ...(index === 4 && explicitRevisions ? { numberRevisions: [] } : {}) });
  }) };
  expect(saved.returnedPair).toBe(true); // Retain the historical failure; don't rewrite the archive.
  await expect(createPdModel({ client }).render({ context, assessment })).resolves.toBeNull();
  expect(client.complete).toHaveBeenCalledTimes(4);
});

test("rejects silent omission even when final current-number receipts are otherwise valid", () => {
  const result = finalReview();
  result.requiredNumbers = [receipt("16")];
  expect(validate(result, draft, history())).toMatchObject({ supported: false,
    reason: "最终复核未完整处理此前数字核对项。" });
});

test("retains correct quantities and accepts an explicitly source-grounded correction of a mistaken first review", () => {
  expect(validate(finalReview(), draft, history()).supported).toBe(true);
  expect(validate({ ...finalReview(), numberRevisions: [revision()] }, draft, history("60")).supported).toBe(true);
});

test("permits withdrawing an inapplicable earlier requirement without inventing it in the draft", () => {
  const sourceText = "两项报价币种不同，暂时不能直接相加或计算差额。";
  const text = "报价币种不同，建议先统一币种和口径再核算。";
  const result = { ...finalReview(), requiredNumbers: [], adviceQuote: "建议先统一币种和口径再核算。",
    numberRevisions: [{ ...revision(), replacementIndex: null, sourceQuote: sourceText,
      reason: "原文明确报价币种不同，初审要求相加后的差额不成立。" }] };
  expect(validate(result, text, { ...history(), evidence: [{ ...source, text: sourceText }] }).supported).toBe(true);
});

test.each([
  ["unknown previous index", { previousIndex: 1 }],
  ["missing replacement", { replacementIndex: 2 }],
  ["unknown source", { sourceRef: "not-authorized" }],
  ["invented source quote", { sourceQuote: "原文明确差额6万元。" }],
  ["quote from the draft instead of a source", { sourceQuote: draft }],
  ["trimmed-into-existence quote", { sourceQuote: ` ${source.text}` }],
] as const)("rejects a revision with %s", (_label, change) => {
  expect(validate({ ...finalReview(), numberRevisions: [{ ...revision(), ...change }] }, draft, history("60")).supported).toBe(false);
});

test("does not let duplicate revisions, an unhandled second item or a false replacement receipt erase an obligation", () => {
  expect(validate({ ...finalReview(), numberRevisions: [revision(), revision()] }, draft, history("60")).supported).toBe(false);
  const twoItems = { ...history("60"), previousNumbers: [...history("60").previousNumbers, receipt("7")] };
  expect(validate({ ...finalReview(), numberRevisions: [revision()] }, draft, twoItems).supported).toBe(false);
  expect(validate({ ...finalReview(), requiredNumbers: [receipt("16"), receipt("60")], numberRevisions: [revision()] }, draft, history("60")).supported).toBe(false);
});

test("requires the final revision contract only with earlier numeric diagnoses", () => {
  const { numberRevisions: _unused, ...base } = finalReview();
  expect(validate(base, draft).supported).toBe(true);
  expect(validate(base, draft, { previousNumbers: [], evidence: [source] }).supported).toBe(true);
  expect(() => validate(base, draft, history())).toThrow("proactive discussion scope review was invalid");
  expect(() => validate({ ...finalReview(), numberRevisions: [{ ...revision(), hidden: "untrusted" }] }, draft, history("60"))).toThrow();
  expect(() => validate({ ...finalReview(), numberRevisions: [{ ...revision(), reason: " " }] }, draft, history("60"))).toThrow();
});

test("binds final review to the initial diagnosis and keeps the existing single-repair call bound", async () => {
  const context = pdContext();
  const assessment = pdAssessment();
  const firstReview = { fieldChecks: pdReviewFieldChecks(), supported: false, reason: "差额应为60万元。", requiredNumbers: history("60").previousNumbers, adviceQuote: null };
  const repaired = { assessment, draft: { text: draft, evidenceRefs: assessment.evidenceRefs } };
  const evidence = context.items[0]!;
  const final = { ...finalReview(), numberRevisions: [{ ...revision(), sourceRef: evidence.ref, sourceQuote: evidence.text }] };
  const responses = [repaired, firstReview, repaired, final];
  const requests: any[] = [];
  const client = { complete: vi.fn(async (messages: any, options: any) => {
    requests.push({ messages, options });
    return JSON.stringify(responses[requests.length - 1]);
  }) };
  await expect(createPdModel({ client }).render({ context, assessment })).resolves.toEqual(repaired);
  expect(client.complete).toHaveBeenCalledTimes(4);
  const input = JSON.parse(requests[3].messages[1].content);
  expect(input.previousReview).toEqual({ ...firstReview, reason: expect.stringContaining(firstReview.reason) });
  expect(input.evidence.map((item: { ref: string }) => item.ref)).toEqual(assessment.evidenceRefs);
  expect(requests[1].options.responseFormat.json_schema.schema.required).not.toContain("numberRevisions");
  expect(requests[3].options.responseFormat.json_schema.schema.required).toContain("numberRevisions");
});

test("keeps final review schema bounded and restricts revision sources to current evidence", () => {
  const createSchema = createPdScopeReviewJsonSchema as (text: string, history?: History) => any;
  const worst = Array.from({ length: 400 }, (_, i) => `${String.fromCharCode(0x4e00 + i)}\u0000\n`).join("");
  const schema = createSchema(worst, history());
  expect(schema.required).toContain("numberRevisions");
  expect(schema.properties.numberRevisions.items.properties.sourceRef.enum).toEqual([source.ref]);
  expect(Buffer.byteLength(JSON.stringify({ type: "json_schema", json_schema: {
    name: "iris_proactive_discussion_scope_review", strict: true, schema,
  } }), "utf8")).toBeLessThan(32_768);
});
