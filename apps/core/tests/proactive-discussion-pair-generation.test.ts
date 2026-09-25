import { expect, test, vi } from "vitest";

import type { OpenAICompatibleChatCompletionOptions, OpenAICompatibleChatMessage } from "../src/model/openai-compatible-chat-completions-client.js";
import { createPdModel, type PdReviewedIntervention } from "../src/proactive-discussion/model.js";
import { pdAssessment, pdContext, pdContextWithIssue, pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";
import type { PdContext } from "../src/proactive-discussion/contracts.js";

function inputAssessment() {
  return { ...pdAssessment(), reasoning: "16万元减10万元等于-6万元，因此必然无法履约。" };
}

function generatedPair(): PdReviewedIntervention {
  return {
    assessment: { ...pdAssessment(), reasoning: "16万元减10万元为6万元；若没有其他预算，可能影响计划。", uncertainty: "qualified_inference" },
    draft: { text: "两人共16万元，比10万元预算多6万元；若没有其他预算，可能影响计划。建议先确认是否追加预算。", evidenceRefs: pdAssessment().evidenceRefs },
  };
}

function review(supported = true) {
  return { fieldChecks: pdReviewFieldChecks(), supported, reason: supported ? "同一预算问题，算术和限定受支持。" : "尚需纠正。",
    requiredNumbers: [{ label: "差额", expectedValue: "6", unit: "万元", draftQuote: "比10万元预算多6万元" }],
    adviceQuote: "建议先确认是否追加预算" };
}

test("first generation and review replace the stale assessment together with the draft in two calls", async () => {
  const original = inputAssessment();
  const pair = generatedPair();
  const client = fakeClient((stage) => stage === "iris_proactive_discussion_scope_review" ? review()
    : stage === "iris_proactive_discussion_draft" ? pair.draft : pair);

  const result = await createPdModel({ client }).render({ context: pdContext(), assessment: original });

  expect(result).toEqual(pair);
  expect(result?.assessment.reasoning).not.toContain("-6");
  expect(original.reasoning).toBe("16万元减10万元等于-6万元，因此必然无法履约。");
  expect(client.complete).toHaveBeenCalledTimes(2);
  const input = JSON.parse(client.complete.mock.calls[1]![0][1]!.content);
  expect(input).toMatchObject({ ...pair, identityTarget: { issueRef: original.issueRef,
    evidenceRefs: original.evidenceRefs } });
  expect(client.complete.mock.calls[0]![1]!.responseFormat!.json_schema.schema.required).toEqual(["assessment", "draft"]);
});

test("first generation reconstructs from authorized sources without copying unverified candidate prose", async () => {
  const original = inputAssessment();
  original.observation = "unverified-observation";
  original.suggestion = "unverified-suggestion";
  original.materialChange.explanation = "unverified-change";
  const context = pdContext();
  const client = fakeClient(stage => stage === "iris_proactive_discussion_scope_review" ? review() : generatedPair());
  await createPdModel({ client }).render({ context, assessment: original });
  const serialized = client.complete.mock.calls[0]![0][1]!.content;
  const input = JSON.parse(serialized);
  expect(Object.keys(input).sort()).toEqual(["evidence", "target"]);
  expect(input.target).toEqual({ decision: original.decision, reason: original.reason,
    issueRef: original.issueRef, evidenceRefs: original.evidenceRefs,
    materialChange: { kind: original.materialChange.kind, evidenceRefs: original.materialChange.evidenceRefs } });
  expect(input.evidence.map((item: { ref: string; text: string }) => ({ ref: item.ref, text: item.text })))
    .toEqual(context.items.filter(item => original.evidenceRefs.includes(item.ref)).map(item => ({ ref: item.ref, text: item.text })));
  for (const stale of [original.observation, original.reasoning, original.suggestion, original.materialChange.explanation]) {
    expect(serialized).not.toContain(stale);
  }
  expect(input.target).not.toHaveProperty("uncertainty");
});

test("source-first generation preserves existing issue identity and newly authorized evidence", async () => {
  const context = pdContextWithIssue();
  const original = inputAssessment();
  original.issueRef = { kind: "existing", id: context.issues[0]!.id };
  original.materialChange = { kind: "new_evidence", explanation: "unverified-change", evidenceRefs: [context.sources[1]!.ref] };
  const pair = generatedPair();
  pair.assessment.issueRef = original.issueRef;
  pair.assessment.materialChange = { ...original.materialChange, explanation: "新招聘计划需要复核预算。" };
  const client = fakeClient(stage => stage === "iris_proactive_discussion_scope_review" ? review() : pair);
  expect(await createPdModel({ client }).render({ context, assessment: original })).toEqual(pair);
  const input = JSON.parse(client.complete.mock.calls[0]![0][1]!.content);
  expect(input.existingIssueDescription).toBe(context.issues[0]!.description);
  expect(input.target.issueRef).toEqual(original.issueRef);
  expect(input.target.materialChange).toEqual({ kind: "new_evidence", evidenceRefs: [context.sources[1]!.ref] });
  expect(input.evidence.map((item: { ref: string }) => item.ref)).toEqual(original.evidenceRefs);
  expect(JSON.stringify(input)).not.toContain(original.reasoning);
});

test("the sole repair receives the generated pair while final review still compares the original issue", async () => {
  const original = inputAssessment();
  const pair = generatedPair();
  const repaired = structuredClone(pair);
  repaired.assessment.suggestion = "建议核实新增预算来源后再作承诺。";
  let reviews = 0;
  const client = fakeClient(stage => {
    if (stage === "iris_proactive_discussion_draft") return pair.draft;
    if (stage === "iris_proactive_discussion_scope_review") return { ...review(++reviews > 1), ...(reviews > 1 ? { numberRevisions: [] } : {}) };
    return stage === "iris_proactive_discussion_pair_repair" ? repaired : pair;
  });

  expect(await createPdModel({ client }).render({ context: pdContext(), assessment: original })).toEqual(repaired);
  expect(client.complete).toHaveBeenCalledTimes(4);
  const repairInput = JSON.parse(client.complete.mock.calls[2]![0][1]!.content);
  expect(repairInput).toMatchObject({ ...pair, review: { supported: false },
    identityTarget: { issueRef: original.issueRef, evidenceRefs: original.evidenceRefs } });
  const finalInput = JSON.parse(client.complete.mock.calls[3]![0][1]!.content);
  expect(finalInput).toMatchObject({ ...repaired,
    identityTarget: { issueRef: original.issueRef, evidenceRefs: original.evidenceRefs },
    previousReview: { requiredNumbers: review().requiredNumbers } });
});

test.each(["decision", "reason", "issueKind", "evidence", "changeKind", "changeEvidence", "draftEvidence"])(
  "first generation cannot alter locked %s and does not call the reviewer on invalid output", async field => {
    const pair = generatedPair();
    const value: any = structuredClone(pair);
    if (field === "decision") value.assessment.decision = "skip";
    if (field === "reason") value.assessment.reason = "no_work_value";
    if (field === "issueKind") value.assessment.issueRef = null;
    if (field === "evidence") { value.assessment.evidenceRefs.pop(); value.assessment.materialChange.evidenceRefs.pop(); }
    if (field === "changeKind") value.assessment.materialChange.kind = "none";
    if (field === "changeEvidence") value.assessment.materialChange.evidenceRefs.pop();
    if (field === "draftEvidence") value.draft.evidenceRefs.pop();
    const client = fakeClient(stage => stage === "iris_proactive_discussion_scope_review" ? review()
      : stage === "iris_proactive_discussion_draft" ? pair.draft : value);
    await expect(createPdModel({ client }).render({ context: pdContext(), assessment: inputAssessment() }))
      .rejects.toThrow("proactive discussion draft was invalid");
    expect(client.complete).toHaveBeenCalledTimes(1);
  });

test("a bare draft cannot silently retain the original incorrect assessment", async () => {
  const client = fakeClient(stage => stage === "iris_proactive_discussion_scope_review" ? review() : generatedPair().draft);
  await expect(createPdModel({ client }).render({ context: pdContext(), assessment: inputAssessment() }))
    .rejects.toThrow("proactive discussion draft was invalid");
  expect(client.complete).toHaveBeenCalledTimes(1);
});

test("first review can reject same-source issue switching and a repeated rejection ends at four calls", async () => {
  const pair = generatedPair();
  pair.assessment.issueRef = { kind: "new", description: "另一件权限管理问题" };
  const client = fakeClient((stage, messages) => {
    if (stage === "iris_proactive_discussion_draft") return pair.draft;
    if (stage !== "iris_proactive_discussion_scope_review") return pair;
    const input = JSON.parse(messages[1]!.content);
    const switched = input.identityTarget?.issueRef?.description === "招聘预算不足"
      && input.assessment.issueRef.description === "另一件权限管理问题";
    return { ...review(!switched), ...(input.previousReview ? { numberRevisions: [] } : {}) };
  });
  expect(await createPdModel({ client }).render({ context: pdContext(), assessment: inputAssessment() })).toBeNull();
  expect(client.complete).toHaveBeenCalledTimes(4);
});

function fakeClient(response: (stage: string, messages: readonly OpenAICompatibleChatMessage[]) => unknown) {
  return { complete: vi.fn(async (messages: readonly OpenAICompatibleChatMessage[], options?: OpenAICompatibleChatCompletionOptions) =>
    JSON.stringify(response(options?.responseFormat?.json_schema.name ?? "", messages))) };
}

test("synthetic evaluation records and redacts the accepted generated pair, not the original assessment", async () => {
  const evalPath = "../../../scripts/pilot/proactive-discussion-eval.ts";
  const { createProactiveDiscussionEvalCases, runSyntheticProactiveDiscussionEval } = await import(evalPath);
  const context: PdContext = createProactiveDiscussionEvalCases().find((entry: { id: string }) => entry.id === "arithmetic")!.context;
  const refs = context.sources.map(source => source.ref);
  const original = { ...inputAssessment(), evidenceRefs: refs,
    materialChange: { ...inputAssessment().materialChange, evidenceRefs: refs } };
  const pair = generatedPair();
  pair.assessment.evidenceRefs = refs;
  pair.assessment.materialChange.evidenceRefs = refs;
  pair.assessment.reasoning += " synthetic-secret";
  pair.draft.evidenceRefs = refs;
  const client = fakeClient((stage, messages) => {
    if (stage === "iris_proactive_discussion_assessment") {
      const input = JSON.parse(messages[1]!.content);
      return { assessment: input.triggerMessageId === context.triggerMessageId ? original : {
        decision: "skip", reason: "no_work_value", issueRef: null, evidenceRefs: [], observation: "", reasoning: "",
        suggestion: "", uncertainty: "fact", materialChange: { kind: "none", explanation: "", evidenceRefs: [] },
      } };
    }
    if (stage === "iris_proactive_discussion_scope_review") return review();
    return stage === "iris_proactive_discussion_draft" ? pair.draft : pair;
  });
  const result = await runSyntheticProactiveDiscussionEval({ client, rounds: 1, includeTrace: true, traceRedactions: ["synthetic-secret"] });
  expect(result.results.find((entry: { caseId: string }) => entry.caseId === "arithmetic")).toMatchObject({ assessment: pair.assessment, draft: pair.draft, error: null });
  expect(result.syntheticTrace?.complete).toBe(true);
  const record = result.syntheticTrace?.records.find((entry: { stage: string }) => entry.stage === "generated_pair");
  expect(record).toMatchObject({ replayValidation: { accepted: true }, acceptedDraft: true,
    candidate: { assessment: { uncertainty: "qualified_inference" }, draft: pair.draft } });
  expect(JSON.stringify(record)).not.toContain("synthetic-secret");
  expect(JSON.stringify(record?.candidate)).toContain("16万元减10万元为6万元");
});
