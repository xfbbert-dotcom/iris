import { expect, test } from "vitest";
import type { OpenAICompatibleChatCompletionsClient } from "../src/model/openai-compatible-chat-completions-client.js";
import { ModelProviderHttpError } from "../src/model/model-provider-error.js";
import { pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";

const evalPath = "../../../scripts/pilot/proactive-discussion-eval.ts";
async function run(input: Record<string, unknown>): Promise<any> {
  const evaluator = await import(evalPath);
  return evaluator.runSyntheticProactiveDiscussionEval({ rounds: 1, includeTrace: true, ...input });
}

function scriptedPlan({ failure, finalSupported = true, explanation = "喜欢不能直接证明愿意付费。" }: {
  failure?: "binding" | "semantic" | "json" | "schema" | "scope_http";
  finalSupported?: boolean;
  explanation?: string;
} = {}) {
  const requests: Array<{ stage: string; input: any; messages: unknown; options: unknown }> = [];
  let scopeCalls = 0;
  const client: OpenAICompatibleChatCompletionsClient = { async complete(messages, options) {
    const stage = options!.responseFormat!.json_schema.name;
    const input = JSON.parse(messages[1]!.content);
    requests.push(structuredClone({ stage, input, messages, options }));
    if (stage === "iris_proactive_discussion_assessment") {
      if (!input.triggerMessageId.includes("inference")) return JSON.stringify({ decision: "skip", reason: "no_work_value",
        issueRef: null, evidenceRefs: [], observation: "", reasoning: "", suggestion: "", uncertainty: "fact",
        materialChange: { kind: "none", explanation: "", evidenceRefs: [] } });
      const refs = input.sourceCatalog.map((source: { ref: string }) => source.ref);
      return JSON.stringify({ decision: "intervene", reason: "material_issue",
        issueRef: { kind: "new", description: "因此认定全部用户都会付费，直接按全量付费用户定收入。" },
        evidenceRefs: refs, observation: "访谈只报告喜欢。", reasoning: "仍需验证付费。", suggestion: "建议验证付费意愿。",
        uncertainty: "qualified_inference", materialChange: { kind: "new_issue", explanation, evidenceRefs: refs } });
    }
    if (stage === "iris_proactive_discussion_generated_pair") return JSON.stringify({ prose: {
      issueDescription: "付费结论缺少验证", observation: "访谈只报告喜欢。", reasoning: "仍需验证付费。",
      suggestion: "建议验证付费意愿。", uncertainty: "qualified_inference", changeExplanation: explanation,
      draftText: "访谈只报告喜欢。仍需验证付费。建议验证付费意愿。",
    } });
    if (stage === "iris_proactive_discussion_opinion_plan" || stage === "iris_proactive_discussion_opinion_plan_repair") {
      const initial = stage === "iris_proactive_discussion_opinion_plan";
      if (initial && failure === "json") return "{bad-json";
      const plan = { kind: "inference", premise: { sourceRef: input.evidence[0].ref, quote: input.evidence[0].text },
        decision: { sourceRef: input.evidence[1].ref, quote: input.evidence[1].text }, changeExplanation: explanation };
      if (initial && failure === "binding") plan.decision = { ...plan.premise };
      if (initial && failure === "schema") plan.kind = "unknown-plan";
      return JSON.stringify(plan);
    }
    if (stage === "iris_proactive_discussion_scope_review") {
      scopeCalls++;
      if (failure === "scope_http") throw new ModelProviderHttpError(503, "PRIVATE-UPSTREAM");
      const supported = (failure !== "semantic" || scopeCalls > 1) && finalSupported;
      return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported, reason: supported ? "来源支持。" : "请核对结论。",
        requiredNumbers: [], adviceQuote: supported ? input.assessment.suggestion : null });
    }
    if (stage === "iris_proactive_discussion_pair_repair") return JSON.stringify({ updates: [] });
    throw new Error("unexpected fixture stage");
  } };
  return { client, requests };
}

function records(result: any) { return result.syntheticTrace.records.filter((record: any) => record.caseId === "inference"); }
function inference(result: any) { return result.results.find((item: any) => item.caseId === "inference"); }

test("source-plan selection uses the same model path with trace on and off while default stays legacy", async () => {
  const plain = scriptedPlan(), traced = scriptedPlan(), legacy = scriptedPlan();
  const off = await run({ client: plain.client, opinionMode: "source-plan", includeTrace: false });
  const on = await run({ client: traced.client, opinionMode: "source-plan" });
  const old = await run({ client: legacy.client });
  expect(inference(on).error).toBeNull();
  expect(on.results).toEqual(off.results);
  expect(traced.requests).toEqual(plain.requests);
  expect(off.syntheticTrace).toBeNull();
  expect(on.opinionMode).toBe("source-plan");
  expect(old.opinionMode).toBe("legacy");
  expect(traced.requests.some(request => request.stage === "iris_proactive_discussion_opinion_plan")).toBe(true);
  expect(legacy.requests.some(request => request.stage === "iris_proactive_discussion_generated_pair")).toBe(true);
});

test("plan trace preserves raw plan and links the actual scope request candidate before marking accepted", async () => {
  const fixture = scriptedPlan();
  const result = await run({ client: fixture.client, opinionMode: "source-plan" });
  const rows = records(result);
  expect(rows.map((row: any) => row.stage)).toEqual(["assessment", "plan_generation", "scope_review"]);
  const scope = fixture.requests.find(request => request.stage === "iris_proactive_discussion_scope_review")!.input;
  expect(rows[1]).toMatchObject({ candidate: scope.sourcePlan, compiledObserved: true, acceptedDraft: true,
    replayValidation: { accepted: false, reason: "not_replayed" },
    boundCandidate: { assessment: scope.assessment, draft: scope.draft, sourcePlan: scope.sourcePlan } });
  expect(rows[2].planCallIndex).toBe(rows[1].callIndex);
  expect(inference(result).draft).toEqual(scope.draft);
  expect(result.syntheticTrace.complete).toBe(true);
});

test("binding recovery records only actual currentPlan and localValidation without inventing a draft or review", async () => {
  const fixture = scriptedPlan({ failure: "binding" });
  const result = await run({ client: fixture.client, opinionMode: "source-plan" });
  const rows = records(result);
  expect(rows.map((row: any) => row.stage)).toEqual(["assessment", "plan_generation", "plan_repair", "scope_review"]);
  const repair = fixture.requests.find(request => request.stage === "iris_proactive_discussion_opinion_plan_repair")!.input;
  expect(rows[1]).toMatchObject({ compiledObserved: false, acceptedDraft: false });
  expect(rows[1]).not.toHaveProperty("boundCandidate");
  expect(rows[2].repairInput).toEqual({ currentPlan: repair.currentPlan, localValidation: repair.localValidation });
  expect(rows[2].repairInput).not.toHaveProperty("draft");
  expect(rows[2].repairInput).not.toHaveProperty("review");
  expect(rows[2]).toMatchObject({ compiledObserved: true, acceptedDraft: true });
  expect(rows[3].planCallIndex).toBe(rows[2].callIndex);
  expect(inference(result).error).toBeNull();
});

test.each([true, false])("semantic plan repair retains actual prior pair and review; final acceptance=%s", async finalSupported => {
  const fixture = scriptedPlan({ failure: "semantic", finalSupported });
  const result = await run({ client: fixture.client, opinionMode: "source-plan" });
  const rows = records(result);
  expect(rows.map((row: any) => row.stage)).toEqual(["assessment", "plan_generation", "scope_review", "plan_repair", "scope_review"]);
  const repair = fixture.requests.find(request => request.stage === "iris_proactive_discussion_opinion_plan_repair")!.input;
  expect(rows[3].repairInput).toEqual({ currentPlan: repair.currentPlan, assessment: repair.assessment, draft: repair.draft, review: repair.review });
  expect(rows[3].repairInput).not.toHaveProperty("localValidation");
  expect(rows[1]).toMatchObject({ compiledObserved: true, acceptedDraft: false });
  expect(rows[3]).toMatchObject({ compiledObserved: true, acceptedDraft: finalSupported });
  expect(rows[4].planCallIndex).toBe(rows[3].callIndex);
  expect(inference(result).error).toBe(finalSupported ? null : "draft_rejected");
});

test.each(["json", "schema"] as const)("%s plan failure never fabricates a compiled candidate or a specific binding failure", async failure => {
  const fixture = scriptedPlan({ failure });
  const result = await run({ client: fixture.client, opinionMode: "source-plan" });
  const rows = records(result);
  expect(inference(result)).toMatchObject({ error: "render_failed", draft: null });
  expect(rows.map((row: any) => row.stage)).toEqual(["assessment", "plan_generation"]);
  expect(rows[1]).toMatchObject({ compiledObserved: false, acceptedDraft: false });
  expect(rows[1]).not.toHaveProperty("boundCandidate");
  expect(rows[1]).not.toHaveProperty("localValidation");
  expect(rows[1].replayValidation.reason).toBe(failure === "json" ? "json_invalid" : "not_replayed");
});

test("scope HTTP failure keeps the observed compiled pair without calling it accepted", async () => {
  const fixture = scriptedPlan({ failure: "scope_http" });
  const result = await run({ client: fixture.client, opinionMode: "source-plan" });
  const plan = records(result).find((row: any) => row.stage === "plan_generation");
  const scope = fixture.requests.find(request => request.stage === "iris_proactive_discussion_scope_review")!.input;
  expect(inference(result)).toMatchObject({ error: "render_failed", draft: null, diagnostic: { category: "http", statusCode: 503 } });
  expect(plan).toMatchObject({ compiledObserved: true, acceptedDraft: false,
    boundCandidate: { assessment: scope.assessment, draft: scope.draft, sourcePlan: scope.sourcePlan } });
  expect(JSON.stringify(result.syntheticTrace)).not.toContain("PRIVATE-UPSTREAM");
});

test("plan and bound candidate retain existing redaction and text limits", async () => {
  const fixture = scriptedPlan({ explanation: "PRIVATE-PLAN" + "验".repeat(700) });
  const result = await run({ client: fixture.client, opinionMode: "source-plan", traceRedactions: ["PRIVATE-PLAN"] });
  const plan = records(result).find((row: any) => row.stage === "plan_generation");
  expect(plan.candidate.changeExplanation).toHaveLength(500);
  expect(plan.boundCandidate.assessment.materialChange.explanation).toHaveLength(500);
  expect(plan.boundCandidate.sourcePlan.changeExplanation).toHaveLength(500);
  expect(JSON.stringify(result.syntheticTrace)).not.toContain("PRIVATE-PLAN");
  expect(plan.sanitization.truncatedFields).toContain("changeExplanation");
});

test.each(["skip_prose", "source_focus"] as const)("trace does not approve an assessment rejected by the source-plan %s contract", async defect => {
  const base = scriptedPlan();
  const client: OpenAICompatibleChatCompletionsClient = { async complete(messages, options) {
    const value = JSON.parse(await base.client.complete(messages, options));
    if (options?.responseFormat?.json_schema.name === "iris_proactive_discussion_assessment"
      && JSON.parse(messages[1]!.content).triggerMessageId.includes("inference")) {
      if (defect === "source_focus") value.issueRef.description = "这不是来源句子";
      else Object.assign(value, { decision: "skip", reason: "no_work_value", issueRef: null,
        materialChange: { kind: "none", explanation: "", evidenceRefs: [] } });
    }
    return JSON.stringify(value);
  } };
  const result = await run({ client, opinionMode: "source-plan" });
  expect(inference(result).error).toBe("assessment_failed");
  expect(records(result)).toHaveLength(2);
  expect(records(result).every((row: any) => row.replayValidation.accepted === false)).toBe(true);
});
