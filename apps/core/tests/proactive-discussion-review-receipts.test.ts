import { expect, test } from "vitest";
import * as pdModel from "../src/proactive-discussion/model.js";
import { createPdScopeReviewJsonSchema } from "../src/proactive-discussion/review-receipts.js";
import { pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";

type NumberReceipt = { label: string; expectedValue: string; unit: string; draftQuote: string | null };
type Review = { fieldChecks: ReturnType<typeof pdReviewFieldChecks>; supported: boolean; reason: string; requiredNumbers: NumberReceipt[]; adviceQuote: string | null };

function validate(value: unknown, draft: string): Review {
  const api = pdModel as unknown as { validatePdScopeReview?: (value: unknown, draft: string) => Review };
  expect(api.validatePdScopeReview).toBeTypeOf("function");
  return api.validatePdScopeReview!(value, draft);
}

function positive(draftQuote: string | null, expectedValue = "6", unit = "万元"): Review {
  return { fieldChecks: pdReviewFieldChecks(), supported: true, reason: "数字和建议均存在。", requiredNumbers: [
    { label: "差额", expectedValue, unit, draftQuote },
  ], adviceQuote: "建议核对预算" };
}

test.each([
  ["总额16万元，差额6万元。", "差额6万元", true],
  ["总额16万元，差额6万元。", "6万元", true],
  ["总额16万元。", "6万元", false],
  ["总额16万元。", "总额16万元", false],
  ["差额0.6万元。", "6万元", false],
  ["差额-6万元。", "6万元", false],
  ["差额负6万元。", "6万元", false],
  ["差额- 6万元。", "6万元", false],
  ["差额1,006万元。", "6万元", false],
  ["差额1e6万元。", "6万元", false],
  ["差额６6万元。", "6万元", false],
  ["差额6.0万元。", "6万元", false],
  ["差额6 万元。", "6 万元", true],
  ["差额6万元。", "6", false],
  ["差额6万元。", "不存在的6万元句子", false],
  ["差额6万元。", null, false],
] as const)("checks complete draft tokens and quoted spans: %s / %s", (draft, quote, supported) => {
  expect(validate(positive(quote), `${draft}建议核对预算。`).supported).toBe(supported);
});

test("preserves the original affirmative result only when its actual advice quote exists", () => {
  const original = positive("差额6万元");
  expect(validate(original, "差额6万元，建议核对预算。")).toEqual(original);
  for (const adviceQuote of [null, "建议批准预算", " 建议核对预算"]) {
    const invalid = { ...original, adviceQuote };
    expect(validate(invalid, "差额6万元，建议核对预算。")).toMatchObject({ supported: false,
      reason: "复核凭据未通过当前草稿原句核对；请核对必要数字和具体建议。" });
    expect(invalid.supported).toBe(true);
  }
});

test("does not normalize or rewrite a quote to manufacture a match", () => {
  const review = { ...positive("差额6万元"), adviceQuote: "建议核对预算é" };
  expect(validate(review, "差额6万元，建议核对预算e\u0301。").supported).toBe(false);
  expect(review.adviceQuote).toBe("建议核对预算é");
});

test("keeps semantic rejection unchanged even without affirmative quote receipts", () => {
  const rejected = { ...positive(null), supported: false, reason: "事实类别被改变。", adviceQuote: null };
  expect(validate(rejected, "访谈5人喜欢，不是已经付费。")).toEqual(rejected);
});

test("allows a declared empty number list without pretending it proves numeric completeness", () => {
  const review = { fieldChecks: pdReviewFieldChecks(), supported: true, reason: "未声明关键数字。", requiredNumbers: [], adviceQuote: "建议核对预算" };
  expect(validate(review, "总成本16万元，建议核对预算。")).toEqual(review);
});

test.each([
  ["legacy affirmative result", { supported: true, reason: "受支持。" }],
  ["unknown fields", { ...positive("6万元"), privateExtra: "secret" }],
  ["nondecimal expected value", positive("6万元", "8+8")],
  ["oversized expected value", positive("6万元", "1".repeat(41))],
  ["oversized unit", positive("6万元", "6", "万".repeat(31))],
  ["whitespace unit", positive("6万元", "6", " 万元")],
  ["oversized quote", positive("问".repeat(1201))],
  ["too many number rows", { ...positive("6万元"), requiredNumbers: Array(9).fill(positive("6万元").requiredNumbers[0]) }],
  ["unknown nested fields", { ...positive("6万元"), requiredNumbers: [{ ...positive("6万元").requiredNumbers[0], extra: true }] }],
] as const)("rejects %s as invalid shape", (_label, value) => {
  expect(() => validate(value, "6万元，建议核对预算。")).toThrow("proactive discussion scope review was invalid");
});

test("limits quote choices to unchanged current-draft segments and its complete text", () => {
  const draft = "总额 16 万元； 差额 6 万元。\n建议核对预算？建议调整预算！\r\n保留 e\u0301;重复。重复。";
  const schema = createPdScopeReviewJsonSchema(draft) as ReviewWireSchema;
  const choices = ["总额 16 万元；", " 差额 6 万元。", "建议核对预算？", "建议调整预算！", "保留 e\u0301;", "重复。", draft];
  for (const quote of [schema.properties.adviceQuote, schema.properties.requiredNumbers.items.properties.draftQuote]) {
    expect(quote.anyOf).toEqual([
      { type: "string", minLength: 1, maxLength: 1200, enum: choices },
      { type: "null" },
    ]);
  }
  expect(schema.properties.requiredNumbers.items.properties.expectedValue).not.toHaveProperty("enum");
});

test.each([
  "一".repeat(1200),
  Array.from({ length: 600 }, (_, index) => `${String.fromCharCode(0x4e00 + index)}。`).join(""),
  Array.from({ length: 400 }, (_, index) => `${String.fromCharCode(0x4e00 + index)}\u0000\n`).join(""),
  "\u0000".repeat(1200),
])("keeps the complete 1200-character quote schema inside the 32 KiB wire budget", draft => {
  const schema = createPdScopeReviewJsonSchema(draft) as ReviewWireSchema;
  expect(draft).toHaveLength(1200);
  expect(schema.properties.adviceQuote.anyOf[0].enum).toContain(draft);
  const format = { type: "json_schema", json_schema: {
    name: "iris_proactive_discussion_scope_review", strict: true, schema,
  } };
  expect(Buffer.byteLength(JSON.stringify(format), "utf8")).toBeLessThan(32_768);
});

type ReviewWireSchema = {
  properties: {
    adviceQuote: QuoteWireSchema;
    requiredNumbers: { items: { properties: { draftQuote: QuoteWireSchema; expectedValue: unknown } } };
  };
};
type QuoteWireSchema = { anyOf: [{ type: "string"; enum: string[] }, { type: "null" }] };
