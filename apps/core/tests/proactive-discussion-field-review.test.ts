import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { expect, test, vi } from "vitest";
import { createPdModel } from "../src/proactive-discussion/model.js";
import { createPdScopeReviewJsonSchema, validatePdScopeReview } from "../src/proactive-discussion/review-receipts.js";
import type { OpenAICompatibleChatCompletionOptions, OpenAICompatibleChatMessage } from "../src/model/openai-compatible-chat-completions-client.js";
import { pdAssessment, pdContext } from "./fixtures/proactive-discussion.js";

const fields = ["issueRef", "observation", "reasoning", "suggestion", "uncertainty", "materialChange"] as const;
const draft = { text: "两人总成本16万元，比10万元预算多6万元。建议核对预算。", evidenceRefs: pdAssessment().evidenceRefs };
const checks = () => Object.fromEntries(fields.map(field => [field, { supported: true, reason: `${field} 已对照授权材料核查。` }]));
const review = () => ({ fieldChecks: checks(), supported: true, reason: "各字段及文案受支持。",
  requiredNumbers: [{ label: "总额", expectedValue: "16", unit: "万元", draftQuote: draft.text },
    { label: "差额", expectedValue: "6", unit: "万元", draftQuote: draft.text }], adviceQuote: "建议核对预算。" });
function clientFor(values: unknown[]) {
  let index = 0;
  return { complete: vi.fn(async (_messages: OpenAICompatibleChatMessage[], _options?: OpenAICompatibleChatCompletionOptions) => {
    if (index >= values.length) throw new Error("unexpected extra model call");
    return JSON.stringify(values[index++]);
  }) };
}

test("rejects the unchanged archived false-positive review for missing field obligations, not semantic proof", () => {
  const saved = JSON.parse(readFileSync(new URL("../../../docs/development/evidence/iris-bailian-20260920-json-arithmetic.json", import.meta.url), "utf8"));
  const content = (index: number) => JSON.parse(JSON.parse(saved.requests[index].responseBodyRaw).choices[0].message.content);
  expect(content(0).assessment.reasoning).toContain("差额为-6万元");
  expect(content(0).assessment.uncertainty).toBe("fact");
  expect(content(2).supported).toBe(true);
  expect(() => validatePdScopeReview(content(2), content(1).text)).toThrow("scope review was invalid");
});

test.each(fields)("overall true cannot override a failed %s check", field => {
  const value = review();
  value.fieldChecks[field] = { supported: false, reason: "该字段存在未纠正的缺陷。" };
  const result = validatePdScopeReview(value, draft.text);
  expect(result.supported).toBe(false);
  expect(result).toMatchObject({ fieldChecks: value.fieldChecks });
  expect(result.reason).toContain(field);
});

test.each(fields)("runtime and wire schema reject omitted %s checks", field => {
  const value = review();
  delete value.fieldChecks[field];
  const validateWire = new Ajv({ strict: true }).compile(createPdScopeReviewJsonSchema(draft.text));
  expect(validateWire(value)).toBe(false);
  expect(() => validatePdScopeReview(value, draft.text)).toThrow("scope review was invalid");
});

test.each([
  ["unknown field", (value: ReturnType<typeof review>) => { value.fieldChecks.extra = { supported: true, reason: "额外" }; }],
  ["empty reason", (value: ReturnType<typeof review>) => { value.fieldChecks.reasoning!.reason = ""; }],
  ["blank reason", (value: ReturnType<typeof review>) => { value.fieldChecks.reasoning!.reason = "  \n"; }],
  ["oversized reason", (value: ReturnType<typeof review>) => { value.fieldChecks.reasoning!.reason = "长".repeat(401); }],
] as const)("rejects %s in both validation contracts", (_name, mutate) => {
  const value = review(); mutate(value);
  const validateWire = new Ajv({ strict: true }).compile(createPdScopeReviewJsonSchema(draft.text));
  expect(validateWire(value)).toBe(false);
  expect(() => validatePdScopeReview(value, draft.text)).toThrow("scope review was invalid");
});

test("all checks passing cannot override an overall draft rejection", () => {
  const value = { ...review(), supported: false, reason: "最终文案未保留限定。" };
  expect(validatePdScopeReview(value, draft.text)).toEqual(value);
});

test.each([false, true])("one repair rechecks the current pair; final field failure cannot be hidden by a correct draft (final accepted=%s)", async finalAccepted => {
  const original = { ...pdAssessment(), reasoning: "16万元减去10万元为-6万元，必然无法履约。" };
  const repaired = { assessment: { ...original, reasoning: "16万元减去10万元为6万元；若无其他预算，可能影响计划。",
    uncertainty: "qualified_inference" as const }, draft };
  const firstReview = review();
  firstReview.fieldChecks.reasoning = { supported: false, reason: "减法符号错误且未来履约后果被写成确定事实。" };
  firstReview.fieldChecks.uncertainty = { supported: false, reason: "未来影响需限定，并使用 qualified_inference。" };
  const finalReview = { ...review(), numberRevisions: [] };
  finalReview.fieldChecks.reasoning!.supported = finalAccepted;
  const client = clientFor([{ assessment: original, draft }, firstReview, repaired, finalReview]);
  const result = await createPdModel({ client }).render({ context: pdContext(), assessment: original });
  expect(result).toEqual(finalAccepted ? repaired : null);
  expect(client.complete).toHaveBeenCalledTimes(4);
  const repairInput = JSON.parse(client.complete.mock.calls[2]![0][1]!.content);
  expect(repairInput.review).toMatchObject({ supported: false, fieldChecks: firstReview.fieldChecks });
  const finalInput = JSON.parse(client.complete.mock.calls[3]![0][1]!.content);
  expect(finalInput.assessment).toEqual(repaired.assessment);
  expect(finalInput.identityTarget).toEqual({ decision: original.decision, reason: original.reason,
    issueRef: original.issueRef, evidenceRefs: original.evidenceRefs,
    materialChange: { kind: original.materialChange.kind, evidenceRefs: original.materialChange.evidenceRefs } });
  expect(finalInput).not.toHaveProperty("originalAssessment");
  expect(finalInput.previousReview.requiredNumbers).toEqual(firstReview.requiredNumbers);
  for (const index of [1, 3]) {
    const prompt = client.complete.mock.calls[index]![0][0]!.content;
    expect(prompt).toContain("fieldChecks");
    expect(prompt).toContain("uncertainty 标记判断");
    expect(prompt).toContain("符号");
  }
});

test("an explicitly qualified, source-supported pair passes without another call", async () => {
  const assessment = { ...pdAssessment(), reasoning: "两人费用16万元，比10万元预算多6万元；若无其他预算，可能影响计划。",
    uncertainty: "qualified_inference" as const };
  const value = review();
  const wire = new Ajv({ strict: true }).compile(createPdScopeReviewJsonSchema(draft.text));
  expect(wire(value)).toBe(true);
  const client = clientFor([{ assessment, draft }, value]);
  expect(await createPdModel({ client }).render({ context: pdContext(), assessment })).toEqual({ assessment, draft });
  expect(client.complete).toHaveBeenCalledTimes(2);
});
