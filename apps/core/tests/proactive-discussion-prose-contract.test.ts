import { expect, test, vi } from "vitest";
import { createPdModel } from "../src/proactive-discussion/model.js";
import { pdAssessment, pdContext, pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";
import { createPdModel as createFixtureModel } from "./fixtures/proactive-discussion-prose-client.js";

const prose = {
  issueDescription: "招聘预算不足", observation: "预算10万元，招2人每人8万元。",
  reasoning: "2人共16万元，比预算多6万元。", suggestion: "建议核对资金或调整人数。",
  uncertainty: "fact", changeExplanation: "发现预算差额。",
  draftText: "2人共16万元，比10万元预算多6万元，建议核对资金或调整人数。",
};
const review = { fieldChecks: pdReviewFieldChecks(), supported: true, reason: "fixture", requiredNumbers: [], adviceQuote: "建议核对资金或调整人数。" };
function sequence(values: unknown[]) {
  let index = 0;
  return { complete: vi.fn(async () => JSON.stringify(values[index++])) };
}
test("program binds locked identity and references to generated prose before review", async () => {
  const client = sequence([{ prose }, review]);
  const result = await createPdModel({ client }).render({ context: pdContext(), assessment: pdAssessment() });
  expect(result).toMatchObject({ assessment: { evidenceRefs: pdAssessment().evidenceRefs, reasoning: prose.reasoning },
    draft: { text: prose.draftText, evidenceRefs: pdAssessment().evidenceRefs } });
  expect(client.complete).toHaveBeenCalledTimes(2);
});
test.each(["evidenceRefs", "decision", "issueRef", "materialChange"])("prose cannot override %s", async field => {
  const client = sequence([{ prose: { ...prose, [field]: "forged" } }]);
  await expect(createPdModel({ client }).render({ context: pdContext(), assessment: pdAssessment() })).rejects.toThrow();
  expect(client.complete).toHaveBeenCalledTimes(1);
});
test("program-bound prose repair still receives final review and cannot self-approve", async () => {
  const rejected = { ...review, supported: false };
  const client = sequence([{ prose }, rejected, { prose: { ...prose, reasoning: "修正后的有条件判断。" } }, rejected]);
  expect(await createPdModel({ client }).render({ context: pdContext(), assessment: pdAssessment() })).toBeNull();
  expect(client.complete).toHaveBeenCalledTimes(4);
});

test("live generation rejects even a valid legacy pair instead of silently dropping its identity fields", async () => {
  const client = sequence([{ assessment: pdAssessment(), draft: { text: prose.draftText, evidenceRefs: pdAssessment().evidenceRefs } }, review]);
  await expect(createPdModel({ client }).render({ context: pdContext(), assessment: pdAssessment() })).rejects.toThrow();
  expect(client.complete).toHaveBeenCalledTimes(1);
});

test("fixture migration cannot hide an extra identity field", async () => {
  const a = pdAssessment();
  const client = sequence([{ assessment: { ...a, issueRef: { ...a.issueRef, extra: "invalid" } },
    draft: { text: prose.draftText, evidenceRefs: a.evidenceRefs } }, review]);
  await expect(createFixtureModel({ client }).render({ context: pdContext(), assessment: a })).rejects.toThrow();
  expect(client.complete).toHaveBeenCalledTimes(1);
});
