import { Ajv } from "ajv";
import { expect, test } from "vitest";
import { compilePdOpinionPlan, pdCanonicalOpinionPlanFormat } from "../src/proactive-discussion/opinion-plan.js";
import { buildPdOpinionSourceCatalog, pdOpinionSelectionFormat, resolvePdOpinionSourceSelection } from "../src/proactive-discussion/source-selection.js";

// The first source is the failed synthetic run's exact source and selected roles.
// These compiler checks specify the action contract, not a model semantic verdict.
test.each([
  { text: "版本A尚未验收，但现在就向客户承诺，文档全部事项明天完成。",
    premise: "版本A尚未验收", decision: "但现在就向客户承诺，文档全部事项明天完成" },
  { text: "客户数据授权尚未确认，但今天就把完整名单向合作方开放。",
    premise: "客户数据授权尚未确认", decision: "但今天就把完整名单向合作方开放" },
])("dependency advice gates the selected decision instead of asking to reconfirm known status: $premise", ({ text, premise, decision }) => {
  const result = compilePdOpinionPlan({ kind: "dependency",
    premise: { sourceRef: "source", quote: premise }, decision: { sourceRef: "source", quote: decision },
    changeExplanation: "待核对依赖关系。" }, true, [{ ref: "source", text }]);
  expect(result?.prose.observation).toBe(`材料里一方面说“${premise}”，另一方面提出“${decision}”。`);
  expect(result?.prose.reasoning).toBe("现有材料还不足以支持直接推进上述决定。");
  expect(result?.prose.suggestion).toBe("建议先暂缓上述决定，补齐所依赖的验证或确认，明确可执行的范围和条件，再确定推进安排。");
  expect(result?.prose.suggestion).not.toContain(premise);
  expect(result?.prose.draftText).not.toMatch(/已违规|违法|必然|已执行|将直接导致/u);
  expect(result?.prose.uncertainty).toBe("qualified_inference");
});

test("generation and repair allow dependency with only premise and decision and refuse the obsolete target role", () => {
  for (const repair of [false, true]) {
    for (const [format, binding] of [
      [pdCanonicalOpinionPlanFormat(repair), { sourceRef: "source", quote: "前提" }],
      [pdOpinionSelectionFormat(repair), { sourceRef: "source", startUnit: 0, endUnit: 0 }],
    ] as const) {
      const validate = new Ajv().compile(format.json_schema.schema);
      const plan = { kind: "dependency", premise: binding, decision: binding, changeExplanation: "核对" };
      expect(validate(plan)).toBe(true);
      expect(validate({ ...plan, verificationTarget: binding })).toBe(false);
    }
  }
});

test("an old dependency target cannot silently retain the known-status reconfirmation contract", () => {
  const source = { ref: "source", text: "甲 乙" };
  const premise = { sourceRef: "source", startUnit: 0, endUnit: 0 };
  expect(() => resolvePdOpinionSourceSelection({ kind: "dependency", premise,
    decision: { sourceRef: "source", startUnit: 2, endUnit: 2 }, verificationTarget: premise,
    changeExplanation: "核对" }, buildPdOpinionSourceCatalog([source]))).toThrow();
});
