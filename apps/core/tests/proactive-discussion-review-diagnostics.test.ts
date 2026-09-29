import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createPdModel } from "./fixtures/proactive-discussion-prose-client.js";
import { validatePdScopeReview, type PdScopeReview } from "../src/proactive-discussion/review-receipts.js";
import { pdAssessment, pdContext, pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";

const draftText = "人数还是2个，总费用16万元，比预算多6万元。建议核对预算。";
const rejectedReview = (): PdScopeReview => ({
  fieldChecks: { ...pdReviewFieldChecks(), uncertainty: { supported: false, reason: "未来影响需要限定。" } },
  supported: false, reason: "未来影响需要限定。",
  requiredNumbers: [{ label: "招聘人数", expectedValue: "2", unit: "人", draftQuote: "人数还是2个" }],
  adviceQuote: "建议核对预算。",
});

test("reports the archived simultaneous numeric receipt defect even when the model already rejected uncertainty", () => {
  const report = JSON.parse(readFileSync(new URL("../../../docs/development/evidence/iris-bailian-20260925-source-first-full-report.json", import.meta.url), "utf8"));
  const calls = report.completions.filter((call: { caseId: string; round: number }) => call.caseId === "material-update" && call.round === 2);
  const pair = JSON.parse(calls.find((call: { stage: string }) => call.stage === "iris_proactive_discussion_generated_pair").content);
  const first = JSON.parse(calls.find((call: { stage: string }) => call.stage === "iris_proactive_discussion_scope_review").content);
  expect(first.supported).toBe(false);
  expect(first.requiredNumbers[2]).toMatchObject({ expectedValue: "2", unit: "人", draftQuote: "人数还是 2 个" });
  const result = validatePdScopeReview(first, pair.draft.text);
  expect(result.supported).toBe(false);
  expect(result.reason).toContain("招聘人数");
  expect(result.reason).toContain("2 人");
  expect(result.reason).toContain(first.reason);
  expect(result.requiredNumbers).toEqual(first.requiredNumbers);
});

test("collects local quote and field failures instead of hiding one behind another", () => {
  const first = { ...rejectedReview(), supported: true, adviceQuote: "建议立即批准预算。" };
  const result = validatePdScopeReview(first, draftText);
  expect(result.supported).toBe(false);
  expect(result.reason).toContain("uncertainty");
  expect(result.reason).toContain("招聘人数");
  expect(result.reason).toContain("建议");
  expect(first.supported).toBe(true);
});

test("retains semantic rejection and bounds combined feedback so final review can parse it", () => {
  const first = { ...rejectedReview(), reason: "原".repeat(2000) };
  const result = validatePdScopeReview(first, draftText);
  expect(result.reason).toContain("招聘人数");
  expect(result.reason.length).toBeLessThanOrEqual(2000);
  expect(result.fieldChecks).toEqual(first.fieldChecks);
  expect(() => validatePdScopeReview(result, draftText)).not.toThrow();
});

test("passes all known failures to the sole repair without weakening final receipt validation", async () => {
  const assessment = pdAssessment();
  const initial = { assessment, draft: { text: draftText, evidenceRefs: assessment.evidenceRefs } };
  const repaired = { assessment: { ...assessment, uncertainty: "qualified_inference" as const },
    draft: { ...initial.draft, text: draftText.replace("2个", "2人") } };
  const first = rejectedReview();
  const final = { ...first, fieldChecks: pdReviewFieldChecks(), supported: true, reason: "已核对。",
    requiredNumbers: [{ ...first.requiredNumbers[0]!, draftQuote: "人数还是2人" }], numberRevisions: [] };
  const responses = [initial, first, repaired, final];
  const inputs: Array<{ review?: PdScopeReview }> = [];
  const client = { complete: async (messages: ReadonlyArray<{ role: string; content: string }>) => {
    inputs.push(JSON.parse(messages.find(message => message.role === "user")!.content));
    if (inputs.length > 4) throw Error("extra repair is not allowed");
    return JSON.stringify(responses[inputs.length - 1]);
  } };
  expect(await createPdModel({ client }).render({ context: pdContext(), assessment })).toEqual(repaired);
  expect(inputs).toHaveLength(4);
  expect(inputs[2]!.review!.reason).toContain("招聘人数");
  expect(inputs[2]!.review!.reason).toContain("未来影响需要限定");
  expect(validatePdScopeReview(final, draftText, {
    previousNumbers: first.requiredNumbers, evidence: pdContext().items,
  }).supported).toBe(false);
});
