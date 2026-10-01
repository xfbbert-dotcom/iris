import { expect, test } from "vitest";
import { Ajv } from "ajv";
import { canonicalOpinionFormat, canonicalOpinionProse } from "../src/proactive-discussion/canonical-opinion.js";

const legacy = { opinion: { segments: [
  { role: "observation", text: "接口尚未联调。" },
  { role: "reasoning", text: "目前不足以确定交付时间。" },
  { role: "suggestion", text: "建议先验证接口再确认时间。" },
], uncertainty: "qualified_inference" } };
const separated = { opinion: { ...legacy.opinion,
  changeExplanation: "当前讨论尚未处理这个承诺依据问题，值得首次介入。",
} };

test("separate value contract keeps internal justification out of outward business prose", () => {
  const { prose } = canonicalOpinionProse(separated, true, true);
  expect(prose.draftText).toBe("接口尚未联调。目前不足以确定交付时间。建议先验证接口再确认时间。");
  expect(prose.reasoning).toBe("目前不足以确定交付时间。");
  expect(prose.changeExplanation).toBe("当前讨论尚未处理这个承诺依据问题，值得首次介入。");
  expect(prose.issueDescription).toBe("接口尚未联调。");
});

test("separate value contract rejects absent or blank justification instead of copying reasoning", () => {
  expect(() => canonicalOpinionProse(legacy, true, true)).toThrow();
  expect(() => canonicalOpinionProse({ opinion: { ...separated.opinion, changeExplanation: "  " } }, true, true)).toThrow();
});

test("legacy opinion remains replayable without promoting it to the new contract", () => {
  const { prose } = canonicalOpinionProse(legacy, false);
  expect(prose.changeExplanation).toBe("目前不足以确定交付时间。");
  expect(prose.issueDescription).toBeNull();
  expect(() => canonicalOpinionProse(separated, false)).toThrow();
});

test.each([false, true])("generation and correction wire contracts require separate justification when enabled: %s", repair => {
  const validate = new Ajv().compile(canonicalOpinionFormat(repair, true).json_schema.schema);
  expect(validate(separated)).toBe(true);
  expect(validate(legacy)).toBe(false);
});
