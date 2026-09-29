import { expect, test, vi } from "vitest";
import type { OpenAICompatibleChatCompletionOptions, OpenAICompatibleChatMessage } from "../src/model/openai-compatible-chat-completions-client.js";
import { createPdModel } from "./fixtures/proactive-discussion-prose-client.js";
import { pdAssessment, pdContextWithIssue, pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";

test("existing issue generation keeps the verified old baseline in every locked pair reference set", async () => {
  const context = pdContextWithIssue();
  const newRef = context.sources[1]!.ref;
  const selected = { ...pdAssessment(), issueRef: { kind: "existing" as const, id: context.issues[0]!.id },
    evidenceRefs: [newRef], materialChange: { kind: "new_evidence" as const, explanation: "成本变化", evidenceRefs: [newRef] } };
  const expectedRefs = [newRef, context.sources[0]!.ref];
  const inputs: any[] = [];
  const client = { complete: vi.fn(async (messages: readonly OpenAICompatibleChatMessage[], options?: OpenAICompatibleChatCompletionOptions) => {
    const input = JSON.parse(messages[1]!.content); inputs.push(input);
    const stage = options!.responseFormat!.json_schema.name;
    if (stage === "iris_proactive_discussion_assessment") return JSON.stringify({ assessment: selected });
    if (stage === "iris_proactive_discussion_scope_review") return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: true,
      reason: "新旧来源齐全。", requiredNumbers: [], adviceQuote: "建议重新核算。" });
    return JSON.stringify({ assessment: { ...selected, evidenceRefs: input.target.evidenceRefs },
      draft: { text: "建议重新核算。", evidenceRefs: input.target.evidenceRefs } });
  }) };
  const model = createPdModel({ client });
  const assessed = await model.assess(context);
  expect(assessed.evidenceRefs).toEqual(expectedRefs);
  const result = await model.render({ context, assessment: assessed });
  expect(result?.assessment.evidenceRefs).toEqual(expectedRefs);
  expect(result?.draft.evidenceRefs).toEqual(expectedRefs);
  expect(result?.assessment.materialChange.evidenceRefs).toEqual([newRef]);
  expect(inputs[1].evidence.map((item: { ref: string }) => item.ref)).toEqual(expectedRefs);
  expect(inputs[1].evidence[1].text).toBe(context.items[0]!.text);
  expect(inputs[2].evidence.map((item: { ref: string }) => item.ref)).toEqual(expectedRefs);
  expect(inputs[2].identityTarget?.evidenceRefs).toEqual(expectedRefs);
  expect(selected.evidenceRefs).toEqual([newRef]);
  expect(client.complete).toHaveBeenCalledTimes(3);
});

test("a bound historical source without current text cannot masquerade as available generation evidence", async () => {
  const context = pdContextWithIssue();
  context.items = context.items.slice(1);
  const selected = { ...pdAssessment(), issueRef: { kind: "existing" as const, id: context.issues[0]!.id },
    evidenceRefs: [context.sources[1]!.ref],
    materialChange: { kind: "new_evidence" as const, explanation: "成本变化", evidenceRefs: [context.sources[1]!.ref] } };
  const complete = vi.fn(async () => { throw new Error("must not be called"); });
  await expect(createPdModel({ client: { complete } }).render({ context, assessment: selected }))
    .rejects.toThrow("proactive discussion evidence text is unavailable");
  expect(complete).not.toHaveBeenCalled();
});

test("multiple current fragments sharing a source ref remain available together, without a false missing-text error", async () => {
  const context = pdContextWithIssue();
  const ref = context.sources[0]!.ref;
  context.items.push({ ref, text: "同一来源的补充口径：覆盖本季度。" });
  const original = pdAssessment();
  const inputs: any[] = [];
  const client = { complete: vi.fn(async (messages: readonly OpenAICompatibleChatMessage[], options?: OpenAICompatibleChatCompletionOptions) => {
    inputs.push(JSON.parse(messages[1]!.content));
    return JSON.stringify(options!.responseFormat!.json_schema.name === "iris_proactive_discussion_scope_review"
      ? { fieldChecks: pdReviewFieldChecks(), supported: true, reason: "保留完整片段。", requiredNumbers: [], adviceQuote: "建议核对预算。" }
      : { assessment: original, draft: { text: "建议核对预算。", evidenceRefs: original.evidenceRefs } });
  }) };
  expect(await createPdModel({ client }).render({ context, assessment: original })).not.toBeNull();
  for (const input of inputs) {
    expect(input.evidence.find((item: { ref: string }) => item.ref === ref)?.text)
      .toBe(context.items[0]!.text + "\n" + context.items[2]!.text);
  }
  expect(client.complete).toHaveBeenCalledTimes(2);
});

test("both reviews and the sole repair receive the current discussion and prior intervention state", async () => {
  const context = pdContextWithIssue();
  const original = { ...pdAssessment(), issueRef: { kind: "existing" as const, id: context.issues[0]!.id },
    materialChange: { kind: "new_evidence" as const, explanation: "新的消息", evidenceRefs: [context.sources[1]!.ref] } };
  context.issues[0]!.state = "surfaced";
  context.issues[0]!.lastSuggestion = "这个预算问题已提醒，正在核对。";
  const draft = { text: "建议先核对预算。", evidenceRefs: original.evidenceRefs };
  const inputs: { stage: string; input: any }[] = [];
  const client = { complete: vi.fn(async (messages: readonly OpenAICompatibleChatMessage[], options?: OpenAICompatibleChatCompletionOptions) => {
    const stage = options!.responseFormat!.json_schema.name;
    const input = JSON.parse(messages[1]!.content);
    inputs.push({ stage, input });
    if (stage === "iris_proactive_discussion_scope_review") {
      // This fake proves context delivery/consumption, not model semantic accuracy.
      const duplicate = input.discussion?.suppliedIssues[0]?.state === "surfaced";
      return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: !duplicate,
        reason: duplicate ? "没有新增意见，不应重复发言。" : "看不到前次记录。", requiredNumbers: [], adviceQuote: draft.text });
    }
    return JSON.stringify({ assessment: original, draft });
  }) };
  expect(await createPdModel({ client }).render({ context, assessment: original })).toBeNull();
  expect(inputs).toHaveLength(4);
  for (const { input } of inputs.slice(1)) {
    expect(input.discussion.materials).toEqual(context.items);
    expect(input.discussion.triggerMaterial).toEqual(context.items[1]);
    expect(input.discussion.suppliedIssues[0]).toMatchObject({ id: context.issues[0]!.id,
      state: "surfaced", lastSuggestion: context.issues[0]!.lastSuggestion });
    expect(input.evidence.map((item: { ref: string }) => item.ref)).toEqual(original.evidenceRefs);
    expect(input.identityTarget?.issueRef).toEqual({ kind: "existing", id: context.issues[0]!.id });
    expect(input).not.toHaveProperty("originalAssessment");
  }
  // The first source-grounded generation must not regain old opinion prose.
  expect(inputs[0]!.input).not.toHaveProperty("discussion");
  expect(JSON.stringify(inputs[0]!.input)).not.toContain(context.issues[0]!.lastSuggestion);
});

test("both reviews and repair receive an unsent identity target without the original assessment prose", async () => {
  const context = pdContextWithIssue();
  context.issues = [];
  const original = { ...pdAssessment(), observation: "OLD_INTERNAL_OBSERVATION",
    reasoning: "OLD_INTERNAL_REASONING", suggestion: "OLD_INTERNAL_SUGGESTION",
    materialChange: { ...pdAssessment().materialChange, explanation: "OLD_INTERNAL_CHANGE" } };
  const candidate = pdAssessment();
  const draft = { text: "建议先核对预算。", evidenceRefs: original.evidenceRefs };
  const inputs: { stage: string; input: any }[] = [];
  let reviewCount = 0;
  const client = { complete: vi.fn(async (messages: readonly OpenAICompatibleChatMessage[], options?: OpenAICompatibleChatCompletionOptions) => {
    const stage = options!.responseFormat!.json_schema.name;
    const input = JSON.parse(messages[1]!.content);
    inputs.push({ stage, input });
    if (stage === "iris_proactive_discussion_scope_review") {
      reviewCount += 1;
      return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: reviewCount === 2,
        reason: reviewCount === 1 ? "当前候选需要核对措辞。" : "当前候选可保留。",
        requiredNumbers: [], adviceQuote: draft.text });
    }
    return JSON.stringify({ assessment: candidate, draft });
  }) };

  expect(await createPdModel({ client }).render({ context, assessment: original }))
    .toEqual({ assessment: candidate, draft });
  expect(inputs.map(({ stage }) => stage)).toEqual([
    "iris_proactive_discussion_generated_pair", "iris_proactive_discussion_scope_review",
    "iris_proactive_discussion_pair_repair", "iris_proactive_discussion_scope_review",
  ]);
  // This verifies the wire's projection and time-role boundary, not model semantic judgment.
  for (const { input } of inputs.slice(1)) {
    expect(input).not.toHaveProperty("originalAssessment");
    expect(input.identityTarget).toEqual({
      decision: "intervene", reason: "material_issue", issueRef: { kind: "new", description: "招聘预算不足" },
      evidenceRefs: original.evidenceRefs,
      materialChange: { kind: "new_issue", evidenceRefs: original.materialChange.evidenceRefs },
    });
    expect(input.evaluationContext).toEqual({
      deliveryState: "not_sent",
      identityTargetRole: "identity_only",
      priorHandlingSource: "discussion",
    });
    for (const oldProse of [original.observation, original.reasoning, original.suggestion, original.materialChange.explanation]) {
      expect(JSON.stringify(input)).not.toContain(oldProse);
    }
    expect(input.discussion.suppliedIssues).toEqual([]);
    expect(input.assessment).toEqual(candidate);
    expect(input.draft).toEqual(draft);
  }
  expect(inputs[0]!.input).not.toHaveProperty("evaluationContext");
  expect(inputs[0]!.input).not.toHaveProperty("originalAssessment");
});

test("review includes a latest handling message even when it was not selected as prose evidence", async () => {
  const context = pdContextWithIssue();
  const original = { ...pdAssessment(), evidenceRefs: [context.sources[0]!.ref],
    materialChange: { ...pdAssessment().materialChange, evidenceRefs: [context.sources[0]!.ref] } };
  context.items[1]!.text = "大家已经暂停计划并正在核对，不需要重复建议。";
  const inputs: any[] = [];
  const client = { complete: vi.fn(async (messages: readonly OpenAICompatibleChatMessage[], options?: OpenAICompatibleChatCompletionOptions) => {
    const input = JSON.parse(messages[1]!.content); inputs.push(input);
    return JSON.stringify(options!.responseFormat!.json_schema.name === "iris_proactive_discussion_scope_review"
      ? { fieldChecks: pdReviewFieldChecks(), supported: false, reason: "已有处理，没有新增建议。", requiredNumbers: [], adviceQuote: "建议核对预算。" }
      : { assessment: original, draft: { text: "建议核对预算。", evidenceRefs: original.evidenceRefs } });
  }) };
  expect(await createPdModel({ client }).render({ context, assessment: original })).toBeNull();
  expect(inputs[1].discussion.triggerMaterial.text).toBe(context.items[1]!.text);
  expect(inputs[1].evidence).toHaveLength(1);
  expect(inputs[1].evidence[0].ref).toBe(context.sources[0]!.ref);
  expect(context.sources).toHaveLength(2);
});

test("initial and final reviewers receive a literal, non-normalizing receipt contract and repair sees local mismatches", async () => {
  const context = pdContextWithIssue();
  const original = pdAssessment();
  const draft = { text: "预算10万元，建议核对预算。", evidenceRefs: original.evidenceRefs };
  const calls: { stage: string; messages: readonly OpenAICompatibleChatMessage[] }[] = [];
  const client = { complete: vi.fn(async (messages: readonly OpenAICompatibleChatMessage[], options?: OpenAICompatibleChatCompletionOptions) => {
    const stage = options!.responseFormat!.json_schema.name; calls.push({ stage, messages });
    if (stage !== "iris_proactive_discussion_scope_review") return JSON.stringify({ assessment: original, draft });
    const input = JSON.parse(messages[1]!.content);
    return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: true, reason: "数字算术等价但未按字面合同返回。",
      requiredNumbers: [{ label: "预算", expectedValue: "100000", unit: "元", draftQuote: "预算10万元" }],
      adviceQuote: "建议核对预算", ...(input.previousReview ? { numberRevisions: [] } : {}) });
  }) };
  expect(await createPdModel({ client }).render({ context, assessment: original })).toBeNull();
  const reviews = calls.filter(call => call.stage === "iris_proactive_discussion_scope_review");
  expect(reviews).toHaveLength(2);
  for (const call of reviews) {
    expect(call.messages[0]!.content).toContain("不得把金额换算为另一单位");
    expect(call.messages[0]!.content).toContain("不得补写草稿没有的单位字");
  }
  const repair = calls.find(call => call.stage === "iris_proactive_discussion_pair_repair")!;
  expect(repair.messages[0]!.content).toContain("算术等价不代表字面凭据合格");
  expect(JSON.parse(repair.messages[1]!.content).review.reason).toContain("100000 元");
  expect(client.complete).toHaveBeenCalledTimes(4);
});
