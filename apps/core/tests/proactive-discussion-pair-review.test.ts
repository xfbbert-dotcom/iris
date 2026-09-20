import { expect, test, vi } from "vitest";

import type {
  OpenAICompatibleChatCompletionOptions,
  OpenAICompatibleChatMessage,
} from "../src/model/openai-compatible-chat-completions-client.js";
import { createOpenAICompatibleChatCompletionsClient } from "../src/model/openai-compatible-chat-completions-client.js";
import { createPdModel } from "../src/proactive-discussion/model.js";
import type { PdAssessment, PdContext, PdDraft } from "../src/proactive-discussion/contracts.js";
import { pdAssessment, pdContext, pdContextWithIssue, pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";

const originalDraft: PdDraft = {
  text: "两人总成本为 16 万元，比 10 万元预算多 6 万元，并会影响项目执行。建议先核对预算。",
  evidenceRefs: pdAssessment().evidenceRefs,
};

const budgetReceipts = {
  fieldChecks: pdReviewFieldChecks(),
  requiredNumbers: [
    { label: "总成本", expectedValue: "16", unit: "万元", draftQuote: "16 万元" },
    { label: "差额", expectedValue: "6", unit: "万元", draftQuote: "6 万元" },
  ],
  adviceQuote: "建议先核对预算",
};

function correctedPair() {
  const original = pdAssessment();
  return {
    assessment: {
      ...original,
      issueRef: { kind: "new" as const, description: "招聘计划可能存在预算缺口" },
      reasoning: "两人总成本为 16 万元，比 10 万元预算多 6 万元；若均由该预算承担，可能影响计划。",
      suggestion: "建议先核对预算口径，再决定是否调整人数或预算。",
      uncertainty: "qualified_inference" as const,
      materialChange: { ...original.materialChange, explanation: "发现可直接核算的 6 万元差额及有待核实的影响。" },
    },
    draft: {
      text: "两人总成本为 16 万元，比 10 万元预算多 6 万元；若均由该预算承担，可能影响计划。建议先核对预算口径。",
      evidenceRefs: original.evidenceRefs,
    },
  };
}

test("returns one jointly reviewed assessment and draft without adding a successful-path call", async () => {
  const assessment = pdAssessment();
  const client = sequenceClient([
    JSON.stringify({ assessment, draft: originalDraft }),
    JSON.stringify({ supported: true, reason: "assessment 与 draft 均受来源支持。", ...budgetReceipts }),
  ]);

  const result = await createPdModel({ client }).render({ context: pdContext(), assessment });

  expect(result).toEqual({ assessment, draft: originalDraft });
  expect(client.complete).toHaveBeenCalledTimes(2);
  const reviewMessages = client.complete.mock.calls[1]?.[0] ?? [];
  const reviewInput = JSON.parse(reviewMessages[1]?.content ?? "{}");
  expect(reviewInput).toMatchObject({ assessment, draft: originalDraft });
  expect(reviewInput.originalAssessment).toEqual(assessment);
  expect(reviewMessages[0]?.content).toContain("assessment 和 draft");
  expect(reviewMessages[0]?.content).toContain("建议核实");
  expect(reviewMessages[0]?.content).toContain("已经执行");
});

test("repairs semantic text once, re-reviews it, and returns only the accepted pair", async () => {
  const repaired = correctedPair();
  const active = vi.fn(async () => undefined);
  const client = sequenceClient([
    JSON.stringify({ assessment: pdAssessment(), draft: originalDraft }),
    JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: false, reason: "assessment 和 draft 把未来影响写成确定事实。", requiredNumbers: [], adviceQuote: null }),
    JSON.stringify(repaired),
    JSON.stringify({ supported: true, reason: "修正后的 pair 保留算术事实并限定未来影响。", ...budgetReceipts }),
  ]);

  const result = await createPdModel({ client }).render({
    context: pdContext(),
    assessment: pdAssessment(),
  }, active);

  expect(result).toEqual(repaired);
  expect(client.complete).toHaveBeenCalledTimes(4);
  expect(active).toHaveBeenCalledTimes(5);
  expect(client.complete.mock.calls[2]?.[1]?.responseFormat?.json_schema.name)
    .toBe("iris_proactive_discussion_pair_repair");
  const repairInput = JSON.parse(client.complete.mock.calls[2]?.[0]?.[1]?.content ?? "{}");
  expect(repairInput).toMatchObject({ assessment: pdAssessment(), draft: originalDraft,
    review: { supported: false } });
  const finalReviewInput = JSON.parse(client.complete.mock.calls[3]?.[0]?.[1]?.content ?? "{}");
  expect(finalReviewInput).toMatchObject({ ...repaired, originalAssessment: pdAssessment() });
});

test("lets the final model review reject a repair that switches to another issue within the same references", async () => {
  const switched = correctedPair();
  switched.assessment.issueRef = { kind: "new", description: "权限审批流程存在风险" };
  switched.assessment.observation = "权限审批流程尚未明确。";
  switched.assessment.reasoning = "权限风险可能影响招聘计划。";
  switched.assessment.suggestion = "建议先核实权限审批流程。";
  switched.assessment.materialChange.explanation = "发现权限审批风险。";
  switched.draft.text = "权限审批流程尚未明确，建议先核实审批要求。";
  let callIndex = 0;
  const client = {
    complete: vi.fn(async (messages: readonly OpenAICompatibleChatMessage[]) => {
      callIndex += 1;
      if (callIndex === 1) return JSON.stringify({ assessment: pdAssessment(), draft: originalDraft });
      if (callIndex === 2) {
        return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: false, reason: "原 pair 对影响表述过于确定。", requiredNumbers: [], adviceQuote: null });
      }
      if (callIndex === 3) return JSON.stringify(switched);

      const input = JSON.parse(messages[1]?.content ?? "{}");
      const switchedIssueDetected = input.originalAssessment?.issueRef?.description === "招聘预算不足"
        && input.assessment?.issueRef?.description === "权限审批流程存在风险";
      return JSON.stringify({
        fieldChecks: pdReviewFieldChecks(),
        supported: !switchedIssueDetected,
        reason: switchedIssueDetected ? "修正结果切换成了另一个问题。" : "没有原始问题可供比较。",
        requiredNumbers: [], adviceQuote: "建议先核实审批要求",
      });
    }),
  };

  await expect(createPdModel({ client }).render({ context: pdContext(), assessment: pdAssessment() }))
    .resolves.toBeNull();
  expect(client.complete).toHaveBeenCalledTimes(4);
});

test("carries grounded arithmetic and fallible-review rules through repair and final review", async () => {
  const repaired = correctedPair();
  const rejection = { fieldChecks: pdReviewFieldChecks(), supported: false,
    reason: "未来影响不应写成确定事实；60%的增幅未经授权。", requiredNumbers: [], adviceQuote: null };
  const client = sequenceClient([
    JSON.stringify({ assessment: pdAssessment(), draft: originalDraft }), JSON.stringify(rejection), JSON.stringify(repaired),
    JSON.stringify({ supported: true, reason: "保留直接算术，限定未来影响。", ...budgetReceipts }),
  ]);

  await expect(createPdModel({ client }).render({ context: pdContext(), assessment: pdAssessment() }))
    .resolves.toEqual(repaired);
  expect(client.complete).toHaveBeenCalledTimes(4);
  // Capture real outgoing prompts; these assertions don't simulate semantic review.
  for (const index of [1, 2, 3]) {
    const messages = client.complete.mock.calls[index]?.[0] ?? [];
    expect(messages[0]?.content).toContain("口径可比的直接算术及业务比率属于受支持内容");
    expect(messages[0]?.content).toContain("业务比率不是模型信心评分");
    expect(messages[0]?.content).toContain("总额、基准差额和更新增减量");
    const input = JSON.parse(messages[1]?.content ?? "{}");
    expect(input.evidence).toEqual(pdContext().items.map(item => ({ ...item, kind: "message" })));
  }
  const repairMessages = client.complete.mock.calls[2]?.[0] ?? [];
  expect(repairMessages[0]?.content).toContain("复核理由是待核对的诊断，不是事实裁决；授权原文优先");
  expect(repairMessages[0]?.content).toContain("不能通过删去有依据的关键数值迎合错误复核");
  expect(repairMessages[0]?.content).toContain("qualified_inference");
  expect(JSON.parse(repairMessages[1]?.content ?? "{}").review).toEqual(rejection);
});

test("the runtime repair validator permits semantic corrections but locks structural identity and refs", async () => {
  const validate = await repairValidator();
  const context = pdContext();
  const original = pdAssessment();
  const repaired = correctedPair();

  expect(validate(repaired, context, original)).toEqual(repaired);
  expect(() => validate({
    ...repaired,
    assessment: { ...repaired.assessment, evidenceRefs: [original.evidenceRefs[0]],
      materialChange: { ...repaired.assessment.materialChange, evidenceRefs: [original.evidenceRefs[0]] } },
    draft: { ...repaired.draft, evidenceRefs: [original.evidenceRefs[0]] },
  }, context, original)).toThrow("proactive discussion pair repair was invalid");
  expect(() => validate({
    ...repaired,
    assessment: { ...repaired.assessment, issueRef: { kind: "existing", id: "issue-1" } },
  }, context, original)).toThrow("proactive discussion pair repair was invalid");

  const contextWithIssue = pdContextWithIssue();
  const secondIssue = { ...contextWithIssue.issues[0]!, id: "issue-2", description: "另一个有效问题" };
  const twoIssueContext = { ...contextWithIssue, issues: [...contextWithIssue.issues, secondIssue] };
  const existingOriginal: PdAssessment = {
    ...original,
    issueRef: { kind: "existing", id: "issue-1" },
    materialChange: { ...original.materialChange, kind: "new_evidence" },
  };
  const switchedExisting = {
    ...repaired,
    assessment: { ...repaired.assessment, issueRef: { kind: "existing" as const, id: "issue-2" },
      materialChange: { ...repaired.assessment.materialChange, kind: "new_evidence" as const } },
  };
  expect(() => validate(switchedExisting, twoIssueContext, existingOriginal))
    .toThrow("proactive discussion pair repair was invalid");
});

test.each([
  ["malformed pair repair", ["not-json"]],
  ["invalid structural pair repair", [JSON.stringify({ ...correctedPair(), assessment: {
    ...correctedPair().assessment, evidenceRefs: [pdAssessment().evidenceRefs[0]],
  } })]],
  ["second semantic rejection", [JSON.stringify(correctedPair()), JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: false, reason: "仍不受支持。", requiredNumbers: [], adviceQuote: null })]],
  ["malformed final review", [JSON.stringify(correctedPair()), "not-json"]],
] as const)("returns null after one %s without another correction", async (_label, tail) => {
  const client = sequenceClient([
    JSON.stringify({ assessment: pdAssessment(), draft: originalDraft }),
    JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: false, reason: "需要修正。", requiredNumbers: [], adviceQuote: null }),
    ...tail,
  ]);

  await expect(createPdModel({ client }).render({ context: pdContext(), assessment: pdAssessment() }))
    .resolves.toBeNull();
  expect(client.complete).toHaveBeenCalledTimes(tail.length + 2);
});

test("propagates a technical repair failure instead of treating it as a semantic rejection", async () => {
  const transportError = new TypeError("network unavailable");
  const client = sequenceClient([
    JSON.stringify({ assessment: pdAssessment(), draft: originalDraft }),
    JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: false, reason: "需要修正。", requiredNumbers: [], adviceQuote: null }),
    transportError,
  ]);

  await expect(createPdModel({ client }).render({ context: pdContext(), assessment: pdAssessment() }))
    .rejects.toBe(transportError);
  expect(client.complete).toHaveBeenCalledTimes(3);
});

test("checks the active lease after the final review before returning an accepted pair", async () => {
  const leaseLost = new Error("lease lost");
  let checks = 0;
  const client = sequenceClient([
    JSON.stringify({ assessment: pdAssessment(), draft: originalDraft }),
    JSON.stringify({ supported: true, reason: "受支持。", ...budgetReceipts }),
  ]);

  await expect(createPdModel({ client }).render({ context: pdContext(), assessment: pdAssessment() }, async () => {
    checks += 1;
    if (checks === 3) throw leaseLost;
  })).rejects.toBe(leaseLost);
  expect(client.complete).toHaveBeenCalledTimes(2);
});

test("uses the existing pair repair when an affirmative review cites the 6 inside 16 as the missing gap", async () => {
  const missingGap: PdDraft = { ...originalDraft, text: "招聘总成本16万元，高于10万元预算。建议先核对预算。" };
  const repaired = correctedPair();
  const originalAssessment = { ...pdAssessment(), reasoning: "合计16万元，比预算多6万元。" };
  const client = sequenceClient([
    JSON.stringify({ assessment: originalAssessment, draft: missingGap }),
    JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: true, reason: "草稿已说明6万元差额。", requiredNumbers: [
      { label: "差额", expectedValue: "6", unit: "万元", draftQuote: "6万元" },
    ], adviceQuote: "建议先核对预算" }),
    JSON.stringify(repaired),
    JSON.stringify({ supported: true, reason: "修正草稿含明确差额。", ...budgetReceipts, numberRevisions: [] }),
  ]);

  await expect(createPdModel({ client }).render({ context: pdContext(), assessment: originalAssessment })).resolves.toEqual(repaired);
  expect(client.complete).toHaveBeenCalledTimes(4);
  const repairInput = JSON.parse(client.complete.mock.calls[2]?.[0]?.[1]?.content ?? "{}");
  expect(repairInput.review).toMatchObject({ supported: false,
    reason: "复核凭据未通过当前草稿原句核对；请核对必要数字和具体建议。" });
  expect(repairInput.draft).toEqual(missingGap);
  expect(repairInput.assessment).toEqual(originalAssessment);
  const scopeFormat = client.complete.mock.calls[1]?.[1]?.responseFormat?.json_schema.schema;
  expect(scopeFormat).toMatchObject({ type: "object", additionalProperties: false,
    required: ["fieldChecks", "supported", "reason", "requiredNumbers", "adviceQuote"], properties: {
      requiredNumbers: { type: "array", maxItems: 8, items: { additionalProperties: false,
        required: ["label", "expectedValue", "unit", "draftQuote"], properties: {
          expectedValue: { type: "string", maxLength: 40 }, unit: { type: "string", maxLength: 30 },
          draftQuote: { anyOf: [{ type: "string", minLength: 1, maxLength: 1200 }, { type: "null" }] },
        } } },
      adviceQuote: { anyOf: [{ type: "string", minLength: 1, maxLength: 1200 }, { type: "null" }] },
    } });
});

test.each(["lost number", "stale advice"])("rejects final receipts against the repaired draft after %s without another repair", async failure => {
  const repaired = correctedPair();
  if (failure === "lost number") repaired.draft.text = "两人总成本为 16 万元，高于预算。建议先核对预算口径。";
  const finalReceipts = { ...budgetReceipts, adviceQuote: failure === "stale advice" ? "建议先核对预算。" : budgetReceipts.adviceQuote };
  const client = sequenceClient([
    JSON.stringify({ assessment: pdAssessment(), draft: originalDraft }),
    JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: false, reason: "请限定未来影响。", requiredNumbers: [], adviceQuote: null }),
    JSON.stringify(repaired),
    JSON.stringify({ supported: true, reason: "修正已充分。", ...finalReceipts }),
  ]);

  await expect(createPdModel({ client }).render({ context: pdContext(), assessment: pdAssessment() })).resolves.toBeNull();
  expect(client.complete).toHaveBeenCalledTimes(4);
  expect(JSON.parse(client.complete.mock.calls[3]?.[0]?.[1]?.content ?? "{}").draft).toEqual(repaired.draft);
});

test.each(["json_schema", "json_object"] as const)("sends only the current draft's quote choices through the real client HTTP body in %s mode", async structuredOutputMode => {
  const repaired = correctedPair();
  const responses = [
    { assessment: pdAssessment(), draft: originalDraft },
    { fieldChecks: pdReviewFieldChecks(), supported: false, reason: "请限定未来影响。", requiredNumbers: [], adviceQuote: null },
    repaired,
    { fieldChecks: pdReviewFieldChecks(), supported: true, reason: "修正已充分。", requiredNumbers: [
      { label: "差额", expectedValue: "6", unit: "万元", draftQuote: "两人总成本为 16 万元，比 10 万元预算多 6 万元；" },
    ], adviceQuote: "建议先核对预算口径。" },
  ];
  const bodies: Array<{ messages: OpenAICompatibleChatMessage[]; response_format: any }> = [];
  const client = createOpenAICompatibleChatCompletionsClient({
    config: { provider: "openai-compatible", baseUrl: "https://model.example/v1", apiKey: "test-only", model: "test-only", timeoutMs: 5000, structuredOutputMode },
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: {
        content: JSON.stringify(responses[bodies.length - 1]),
      } }] }), { headers: { "content-type": "application/json" } });
    },
  });

  await expect(createPdModel({ client }).render({ context: pdContext(), assessment: pdAssessment() })).resolves.toEqual(repaired);
  expect(bodies).toHaveLength(4);
  for (const [index, draft, expected] of [
    [1, originalDraft.text, ["两人总成本为 16 万元，比 10 万元预算多 6 万元，并会影响项目执行。", "建议先核对预算。", originalDraft.text]],
    [3, repaired.draft.text, ["两人总成本为 16 万元，比 10 万元预算多 6 万元；", "若均由该预算承担，可能影响计划。", "建议先核对预算口径。", repaired.draft.text]],
  ] as const) {
    const body = bodies[index]!;
    const schema = structuredOutputMode === "json_schema"
      ? body.response_format.json_schema.schema
      : JSON.parse(body.messages[0]!.content.slice(body.messages[0]!.content.indexOf('{"type":"object"')));
    if (structuredOutputMode === "json_object") expect(body.response_format).toEqual({ type: "json_object" });
    expect(JSON.parse(body.messages[1]!.content).draft.text).toBe(draft);
    for (const quote of [schema.properties.adviceQuote, schema.properties.requiredNumbers.items.properties.draftQuote]) {
      expect(quote.anyOf[0].enum).toEqual(expected);
      expect(quote.anyOf[1]).toEqual({ type: "null" });
      expect(quote.anyOf[0].enum).not.toContain("建议先核对预算口径，再决定是否调整人数或预算。");
      expect(quote.anyOf[0].enum).not.toContain(pdContext().items[0]!.text);
      if (index === 3) expect(quote.anyOf[0].enum).not.toContain(originalDraft.text);
    }
    expect(schema.properties.requiredNumbers.items.properties.expectedValue).not.toHaveProperty("enum");
  }
});

type RepairValidator = (
  value: unknown,
  context: PdContext,
  originalAssessment: PdAssessment,
) => { assessment: PdAssessment; draft: PdDraft };

async function repairValidator(): Promise<RepairValidator> {
  const module = await import("../src/proactive-discussion/model.js") as unknown as Record<string, unknown>;
  expect(module.validatePdRepairedIntervention).toBeTypeOf("function");
  return module.validatePdRepairedIntervention as RepairValidator;
}

function sequenceClient(responses: Array<string | Error>) {
  let index = 0;
  return {
    complete: vi.fn(async (
      _messages: readonly OpenAICompatibleChatMessage[],
      _options?: OpenAICompatibleChatCompletionOptions,
    ) => {
      const response = responses[index++] ?? responses.at(-1)!;
      if (response instanceof Error) throw response;
      return response;
    }),
  };
}
