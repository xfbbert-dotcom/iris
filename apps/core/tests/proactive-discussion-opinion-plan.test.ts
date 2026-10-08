import { Ajv } from "ajv";
import { expect, test } from "vitest";
import { compilePdOpinionPlan, pdCanonicalOpinionPlanFormat } from "../src/proactive-discussion/opinion-plan.js";

const evidence = [
  { ref: "dependency", text: "交付依赖的供应商接口还没有联调验证。" },
  { ref: "decision", text: "准备今天向客户承诺下周肯定交付。" },
];
const plan = {
  kind: "dependency",
  premise: { sourceRef: "dependency", quote: "交付依赖的供应商接口还没有联调验证。" },
  decision: { sourceRef: "decision", quote: "准备今天向客户承诺下周肯定交付。" },
  verificationTarget: { sourceRef: "dependency", quote: "供应商接口" },
  changeExplanation: "当前尚未验证的接口依赖与即将作出的确定承诺需要共同核对。",
};
const calculationEvidence = [{ ref: "budget", text: "本季度招聘预算10万元。" },
  { ref: "cost", text: "招聘两个人，每人要8万元；我们认为这些预算足够。" }];
const quantities = {
  count: { sourceRef: "cost", contextQuote: calculationEvidence[1]!.text, quantityQuote: "两个人" },
  unitCost: { sourceRef: "cost", contextQuote: calculationEvidence[1]!.text, quantityQuote: "8万元" },
  budget: { sourceRef: "budget", contextQuote: calculationEvidence[0]!.text, quantityQuote: "10万元" },
  priorUnitCost: null,
};

test.each(["no_material_issue", "insufficient_basis", "already_handled"])("a strict no-intervention plan ends without compiling prose: %s", reason => {
  const withdrawal = { kind: "no_intervention", reason };
  expect(compilePdOpinionPlan(withdrawal, true, evidence)).toBeNull();
  for (const repair of [false, true]) {
    const validate = new Ajv().compile(pdCanonicalOpinionPlanFormat(repair).json_schema.schema);
    expect(validate(withdrawal)).toBe(true);
  }
});

test.each([
  { kind: "no_intervention" },
  { kind: "no_intervention", reason: "other" },
  { kind: "no_intervention", reason: "no_material_issue", draftText: "必须马上停止。" },
  { kind: "no_intervention", reason: "already_handled", changeExplanation: "未审核解释" },
  { kind: "no_intervention", reason: "insufficient_basis", premise: plan.premise },
])("withdrawal cannot carry unaudited prose or malformed reasons: %j", value => {
  expect(() => compilePdOpinionPlan(value, true, evidence)).toThrow();
  for (const repair of [false, true]) {
    const validate = new Ajv().compile(pdCanonicalOpinionPlanFormat(repair).json_schema.schema);
    expect(validate(value)).toBe(false);
  }
});

test("dependency plan compiles one source-bound opinion without authored consequences or internal justification", () => {
  const { prose } = compilePdOpinionPlan(plan, true, evidence)!;
  expect(prose.observation).toContain("交付依赖的供应商接口还没有联调验证。");
  expect(prose.observation).toContain("准备今天向客户承诺下周肯定交付。");
  expect(prose.suggestion).toContain("供应商接口");
  expect(prose.uncertainty).toBe("qualified_inference");
  expect(prose.issueDescription).toBe(prose.observation);
  expect(prose.changeExplanation).toBe(plan.changeExplanation);
  expect(prose.draftText).not.toContain(plan.changeExplanation);
  expect(prose.draftText).not.toMatch(/必然|将直接导致|违约|\n/u);
});

test.each([
  { ...plan, consequence: "将直接导致无法按期交付" },
  { ...plan, suggestion: "让新增供应商承诺交期" },
  { ...plan, premise: { sourceRef: "missing", quote: plan.premise.quote } },
  { ...plan, premise: { sourceRef: "dependency", quote: "供应商接口已经联调失败。" } },
  { ...plan, decision: { ...plan.premise } },
  { ...plan, verificationTarget: { sourceRef: "dependency", quote: "客户" } },
  { ...plan, verificationTarget: { sourceRef: "other", quote: "供应商接口" } },
  { ...plan, changeExplanation: " " },
])("unbound, new authored, or inapplicable plan data is refused: %j", value => {
  expect(() => compilePdOpinionPlan(value, true, [...evidence, { ref: "other", text: "供应商接口" }])).toThrow();
});

test("a target elsewhere in selected evidence cannot bypass its chosen premise and decision", () => {
  const value = { ...plan, premise: { sourceRef: "dependency", quote: "还没有联调验证" } };
  expect(() => compilePdOpinionPlan(value, true, evidence)).toThrow();
});

test("inference advice refers to the selected conclusion, not a separately selected known premise", () => {
  const sources = [{ ref: "likes", text: "我们访谈了5个人，他们都说喜欢。" },
    { ref: "revenue", text: "因此认定全部用户都会付费，直接按全量付费用户定收入。" }];
  const { prose } = compilePdOpinionPlan({ kind: "inference", premise: { sourceRef: "likes", quote: sources[0]!.text },
    decision: { sourceRef: "revenue", quote: sources[1]!.text },
    changeExplanation: "喜欢与付费之间仍缺乏验证。" }, false, sources)!;
  expect(prose.issueDescription).toBeNull();
  expect(prose.observation).toContain(sources[0]!.text);
  expect(prose.reasoning).toContain("不足以证明");
  expect(prose.observation).toContain(sources[1]!.text);
  expect(prose.suggestion).toBe("建议围绕上述结论开展小范围验证并收集证据，根据结果修订判断和推进条件。");
  expect(prose.suggestion).not.toContain(sources[0]!.text);
  expect(prose.draftText).not.toMatch(/没有人会买|已经付款|供应商|严重样本偏差/u);
});

test("inference refuses the old redundant verification target instead of relabeling interview facts as a hypothesis", () => {
  const sources = [{ ref: "likes", text: "我们访谈了5个人，他们都说喜欢。" },
    { ref: "revenue", text: "因此认定全部用户都会付费，直接按全量付费用户定收入。" }];
  expect(() => compilePdOpinionPlan({ kind: "inference", premise: { sourceRef: "likes", quote: sources[0]!.text },
    decision: { sourceRef: "revenue", quote: sources[1]!.text },
    verificationTarget: { sourceRef: "likes", quote: sources[0]!.text },
    changeExplanation: "喜欢不等于愿意付费。" }, true, sources)).toThrow();
});

test("a dependency can concern a planned action without inventing a promise or proven violation", () => {
  const sources = [{ ref: "permission", text: "客户数据权限还没确认，接下来就把完整客户名单公开给合作方。" }];
  const { prose } = compilePdOpinionPlan({ kind: "dependency",
    premise: { sourceRef: "permission", quote: "客户数据权限还没确认" },
    decision: { sourceRef: "permission", quote: "接下来就把完整客户名单公开给合作方" },
    verificationTarget: { sourceRef: "permission", quote: "客户数据权限" },
    changeExplanation: "公开客户名单的决定仍缺少已确认的权限前提。" }, true, sources)!;
  expect(prose.draftText).not.toContain("承诺");
  expect(prose.draftText).not.toMatch(/已违规|已获授权|已经公开/u);
  expect(prose.reasoning).toContain("关键验证");
  expect(prose.suggestion).toContain("客户数据权限");
});

test.each([false, true])("plan wire format accepts only the bounded branch for generation or repair: %s", repair => {
  const validate = new Ajv().compile(pdCanonicalOpinionPlanFormat(repair).json_schema.schema);
  expect(validate(plan)).toBe(true);
  const { verificationTarget, ...withoutTarget } = plan;
  expect(validate(withoutTarget)).toBe(false);
  expect(validate({ ...withoutTarget, kind: "inference" })).toBe(true);
  expect(validate({ ...withoutTarget, kind: "inference", verificationTarget })).toBe(false);
  expect(validate({ ...plan, draftText: "unreviewed free prose" })).toBe(false);
  expect(validate({ kind: "calculation", quantities, changeExplanation: "成本更新需要重新核算。" })).toBe(true);
  expect(validate({ kind: "calculation", quantities, changeExplanation: "成本更新需要重新核算。", total: 999 })).toBe(false);
});

test("calculation branch refuses arbitrary text without supported source quantities", () => {
  expect(() => compilePdOpinionPlan({ kind: "calculation", quantities, changeExplanation: "核算" }, true, evidence)).toThrow();
});

test("calculation plan cannot substitute an unbound amount for a literal quantity", () => {
  expect(() => compilePdOpinionPlan({ kind: "calculation", changeExplanation: "核算", quantities: { ...quantities,
    budget: { ...quantities.budget, quantityQuote: "18万元" } } }, true, calculationEvidence)).toThrow();
});

test("calculation plan uses computed quantities without accepting model-authored amounts", () => {
  const { prose } = compilePdOpinionPlan({ kind: "calculation", quantities, changeExplanation: "当前预算判断需复核。" }, true, calculationEvidence)!;
  expect(prose.observation).toContain("总成本16万元");
  expect(prose.observation).toContain("多6万元");
  expect(prose.uncertainty).toBe("fact");
  expect(prose.draftText).not.toContain("当前预算判断需复核");
});
