import { expect, test } from "vitest";
import { pdAssessment, pdContext, pdSkipAssessment } from "./fixtures/proactive-discussion.js";

const evalPath = "../../../scripts/pilot/proactive-discussion-eval.ts";

test("evaluator reports the jointly reviewed assessment and draft, not the original candidate", async () => {
  const { runProactiveDiscussionEval } = await import(evalPath);
  const initial = { ...pdAssessment(), reasoning: "会对项目执行造成实质影响。" };
  const reviewed = { ...pdAssessment(), reasoning: "两人共16万元，比10万元预算多6万元。" };
  const draft = { text: "两人共16万元，比预算多6万元，建议核对预算或调整人数。", evidenceRefs: reviewed.evidenceRefs };
  const [result] = await runProactiveDiscussionEval({
    model: { assess: async () => initial, render: async () => ({ assessment: reviewed, draft }) },
    rounds: 1, cases: [{ id: "pair", context: pdContext(), expectedDecision: "intervene", reviewCriteria: [] }],
  });

  expect(result.assessment.reasoning).toBe("两人共16万元，比10万元预算多6万元。");
  expect(result.draft).toEqual(draft);
  expect(result.error).toBeNull();
  expect(initial.reasoning).toBe("会对项目执行造成实质影响。");
});

test("a rejected pair remains an incomplete candidate, never a successful intervention", async () => {
  const { runProactiveDiscussionEval } = await import(evalPath);
  const [result] = await runProactiveDiscussionEval({
    model: { assess: async () => pdAssessment(), render: async () => null },
    rounds: 1, cases: [{ id: "rejected", context: pdContext(), expectedDecision: "intervene", reviewCriteria: [] }],
  });
  expect(result).toMatchObject({ assessment: pdAssessment(), draft: null, error: "draft_rejected", diagnostic: null });
});

test("skip results do not enter joint review or repair", async () => {
  const { runProactiveDiscussionEval } = await import(evalPath);
  const [result] = await runProactiveDiscussionEval({
    model: { assess: async () => pdSkipAssessment(), render: async () => { throw new Error("unexpected render"); } },
    rounds: 1, cases: [{ id: "skip", context: pdContext(), expectedDecision: "skip", reviewCriteria: [] }],
  });
  expect(result).toMatchObject({ assessment: pdSkipAssessment(), draft: null, error: null, diagnostic: null });
});
