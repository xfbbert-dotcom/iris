import { expect, test } from "vitest";
import { compilePdSourceCalculation } from "../src/proactive-discussion/source-calculation.js";

const sources = [
  { ref: "budget", text: "本季度招聘预算 10 万元。" },
  { ref: "cost", text: "招聘两个人，每人要 8 万元；我们认为这些预算足够。" },
  { ref: "update", text: "新的可读报价确认每人的招聘成本从 8 万变为 12 万，两个人仍计划招。" },
];
const binding = (index: number, quantityQuote: string) => ({ sourceRef: sources[index]!.ref,
  contextQuote: sources[index]!.text, quantityQuote });
const original = { count: binding(1, "两个人"), unitCost: binding(1, "8 万元"),
  budget: binding(0, "10 万元"), priorUnitCost: null };
const updated = { ...original, count: binding(2, "两个人"), unitCost: binding(2, "12 万"), priorUnitCost: binding(2, "8 万") };

test("computes original and update amounts from bound literals without interpreting source business prose", () => {
  expect(compilePdSourceCalculation(sources, original)?.values).toEqual({ total: "160000", budget: "100000",
    difference: "60000", previousTotal: null, increase: null });
  const result = compilePdSourceCalculation(sources, updated);
  expect(result?.values).toEqual({ total: "240000", budget: "100000", difference: "140000", previousTotal: "160000", increase: "80000" });
  expect(result?.text).toContain("总成本24万元");
  expect(result?.text).toContain("原单价对应成本16万元");
  expect(result?.text).toContain("多14万元");
  expect(result?.bindings).toContainEqual({ ref: "update", quote: sources[2]!.text, role: "unitCost", quantityQuote: "12 万" });
});

test("literal checks deliberately do not prove budget vs unit-price roles", () => {
  const wrongRoles = { ...original, budget: original.unitCost, unitCost: original.budget };
  expect(compilePdSourceCalculation(sources, wrongRoles)?.values).toEqual({ total: "200000", budget: "80000",
    difference: "120000", previousTotal: null, increase: null });
  // The original semantic review must reject this plan; local arithmetic cannot.
});

test("literal checks deliberately do not prove which quoted price is old or current", () => {
  const wrongTime = { ...updated, unitCost: updated.priorUnitCost, priorUnitCost: updated.unitCost };
  const result = compilePdSourceCalculation(sources, wrongTime);
  expect(result?.values).toEqual({ total: "160000", budget: "100000", difference: "60000", previousTotal: "240000", increase: "-80000" });
  expect(result?.text).toContain("相同数量");
  expect(result?.text).toContain("减少8万元");
});

test("works with arbitrary source prose and exact mixed monetary scales", () => {
  const arbitrary = [{ ref: "raw", text: "今天的讨论列出设备3台、单价1000.01元、原单价0.09万元、限额0.5万元，尚待评估。" }];
  const q = (quantityQuote: string) => ({ sourceRef: "raw", contextQuote: arbitrary[0]!.text, quantityQuote });
  const result = compilePdSourceCalculation(arbitrary, { count: q("3台"), unitCost: q("1000.01元"), budget: q("0.5万元"), priorUnitCost: q("0.09万元") });
  expect(result?.values).toEqual({ total: "3000.03", budget: "5000", difference: "-1999.97", previousTotal: "2700", increase: "300.03" });
  expect(result?.text).toContain("少1999.97元");
});

test.each([
  null, {}, { ...original, count: undefined }, { ...original, priorUnitCost: undefined },
  { ...original, operator: "subtract" }, { ...original, budget: { ...original.budget, value: "999" } },
  { ...original, budget: { ...original.budget, sourceRef: "missing" } },
  { ...original, budget: { ...original.budget, contextQuote: "批准预算10万元。" } },
  { ...original, budget: { ...original.budget, quantityQuote: "18万元" } },
  { ...original, count: original.unitCost }, { ...original, unitCost: original.count },
])("rejects invalid schema, dimensions and unbound literals: %j", input => {
  expect(compilePdSourceCalculation(sources, input)).toBeNull();
});

test.each(["-8万元", "＋8万元", "0.8万元", "18万元", "二/两个人", "1e8万元", "1E8万元"])("cannot use a suffix of a numeric token: %s", literal => {
  const raw = [{ ref: "raw", text: literal }];
  const quantityQuote = literal.includes("个人") ? "两个人" : "8万元";
  const candidate = { sourceRef: "raw", contextQuote: literal, quantityQuote };
  expect(compilePdSourceCalculation([...sources, ...raw], literal.includes("个人")
    ? { ...original, count: candidate } : { ...original, unitCost: candidate })).toBeNull();
});

test("rejects a count suffix of unsupported scientific notation", () => {
  const raw = { ref: "raw", text: "数量1e2人。" };
  expect(compilePdSourceCalculation([...sources, raw], { ...original,
    count: { sourceRef: raw.ref, contextQuote: raw.text, quantityQuote: "2人" } })).toBeNull();
});

test("rejects ambiguous source identities and over-limit quotes", () => {
  expect(compilePdSourceCalculation([...sources, sources[0]!], original)).toBeNull();
  expect(compilePdSourceCalculation(sources, { ...original, budget: { ...original.budget, contextQuote: "a".repeat(1001) } })).toBeNull();
});
