import { expect, test } from "vitest";

import type {
  OpenAICompatibleChatCompletionsClient,
  OpenAICompatibleChatMessage,
  OpenAICompatibleChatCompletionOptions,
} from "../src/model/openai-compatible-chat-completions-client.js";
import { ModelProviderHttpError } from "../src/model/model-provider-error.js";
import { pdAssessment, pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";

const evalPath = "../../../scripts/pilot/proactive-discussion-eval.ts";

type SyntheticRun = {
  cases: Array<{ id: string }>;
  results: Array<{ caseId: string; round: number; error: string | null; draft: unknown; assessment: Record<string, unknown> | null }>;
  syntheticTrace: null | {
    complete: boolean;
    validationBasis: string;
    recordsDropped: number;
    records: Array<Record<string, any>>;
  };
};

async function runSynthetic(input: Record<string, unknown>): Promise<SyntheticRun> {
  const evaluator = await import(evalPath) as unknown as Record<string, unknown>;
  expect(evaluator.runSyntheticProactiveDiscussionEval).toBeTypeOf("function");
  return (evaluator.runSyntheticProactiveDiscussionEval as (value: unknown) => Promise<SyntheticRun>)(input);
}

function scriptedClient({ scopeSupported = true, wrongArithmetic = false }: { scopeSupported?: boolean; wrongArithmetic?: boolean } = {}) {
  const requests: unknown[] = [];
  const client: OpenAICompatibleChatCompletionsClient = {
    async complete(messages, options) {
      requests.push(structuredClone({ messages, options }));
      const stage = options?.responseFormat?.json_schema.name;
      const input = JSON.parse(messages[1]!.content);
      if (stage === "iris_proactive_discussion_assessment") {
        if (!String(input.triggerMessageId).includes("arithmetic")) return JSON.stringify(skipAssessment());
        const refs = input.sourceCatalog.map((source: { ref: string }) => source.ref);
        return JSON.stringify({ decision: "intervene", reason: "material_issue",
          issueRef: { kind: "new", description: "招聘预算不足" }, evidenceRefs: refs,
          observation: "两人总成本 16 万。", reasoning: "比 10 万预算多 6 万。", suggestion: "建议核对预算。",
          uncertainty: "fact", materialChange: { kind: "new_issue", explanation: "发现预算差额。", evidenceRefs: refs } });
      }
      if (stage === "iris_proactive_discussion_generated_pair") {
        return JSON.stringify({
          assessment: { ...pdAssessment(), ...input.target,
            issueRef: { ...input.target.issueRef, description: "招聘预算不足" },
            reasoning: wrongArithmetic ? "16万元减10万元，差额为-6万元。" : "生成时复核：比10万元预算多6万元。",
            materialChange: { ...input.target.materialChange, explanation: "发现预算差额。" } },
          draft: { text: "两人总成本 16 万，比 10 万预算多 6 万，建议核对预算。",
            evidenceRefs: input.target.evidenceRefs },
        });
      }
      if (stage === "iris_proactive_discussion_scope_review") {
        return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: scopeSupported, reason: scopeSupported ? "内容受材料支持。" : "候选遗漏必要限定。",
          requiredNumbers: [], adviceQuote: scopeSupported ? "建议核对预算。" : null });
      }
      if (stage === "iris_proactive_discussion_pair_repair") {
        return JSON.stringify({ assessment: input.assessment, draft: input.draft });
      }
      throw new Error("unexpected response format");
    },
  };
  return { client, requests };
}

test("trace replays the same assessment arithmetic rejection as runtime despite model approval", async () => {
  const { client } = scriptedClient({ wrongArithmetic: true });
  const result = await runSynthetic({ client, rounds: 1, includeTrace: true });
  expect(result.results.find(item => item.caseId === "arithmetic")).toMatchObject({ error: "draft_rejected", draft: null });
  const reviews = result.syntheticTrace!.records.filter(item => item.caseId === "arithmetic" && item.stage === "scope_review");
  expect(reviews).toHaveLength(2);
  for (const review of reviews) expect(review).toMatchObject({ candidate: { supported: true }, replayValidation: { accepted: false } });
});

test("trace opt-in leaves model results and request payloads unchanged and keeps case-round calls separate", async () => {
  const offClient = scriptedClient();
  const onClient = scriptedClient();
  const off = await runSynthetic({ client: offClient.client, rounds: 2, includeTrace: false });
  const on = await runSynthetic({ client: onClient.client, rounds: 2, includeTrace: true });

  expect(on.results).toEqual(off.results);
  expect(onClient.requests).toEqual(offClient.requests);
  expect(off.syntheticTrace).toBeNull();
  expect(on.syntheticTrace).toMatchObject({ complete: true,
    validationBasis: "diagnostic_replay_not_runtime_error_detail", recordsDropped: 0 });
  expect(on.syntheticTrace!.records).toHaveLength(34);
  expect(on.syntheticTrace!.records.map(record => record.callIndex)).toEqual([...Array(34)].map((_, index) => index + 1));
  const assessments = on.syntheticTrace!.records.filter(record => record.stage === "assessment");
  expect(assessments).toHaveLength(30);
  expect(assessments.map(record => `${record.caseId}:${record.round}:${record.attempt}`)).toEqual([
    ...off.cases.map(entry => `${entry.id}:1:1`), ...off.cases.map(entry => `${entry.id}:2:1`),
  ]);
  const acceptedScope = on.syntheticTrace!.records.find(record => record.stage === "scope_review");
  expect(acceptedScope).toMatchObject({ candidate: { supported: true }, replayValidation: { accepted: true, reason: "accepted" } });
  const generated = on.syntheticTrace!.records.filter(record => record.stage === "generated_pair");
  expect(generated).toHaveLength(2);
  for (const record of generated) {
    expect(record).toMatchObject({ acceptedDraft: true, attempt: 1,
      candidate: { assessment: { reasoning: "生成时复核：比10万元预算多6万元。" },
        draft: { text: "两人总成本 16 万，比 10 万预算多 6 万，建议核对预算。" } },
      replayValidation: { accepted: true, reason: "accepted" },
    });
  }
  expect(on.results.filter(result => result.caseId === "arithmetic").map(result => result.assessment?.reasoning))
    .toEqual(["生成时复核：比10万元预算多6万元。", "生成时复核：比10万元预算多6万元。"]);
});

test("wire envelopes retain flat validated trace candidates and reject envelope extras without retaining them", async () => {
  const legacy = scriptedClient().client;
  const wrapped: OpenAICompatibleChatCompletionsClient = {
    async complete(messages, options) {
      const content = await legacy.complete(messages, options);
      return options?.responseFormat?.json_schema.name === "iris_proactive_discussion_assessment"
        ? JSON.stringify({ assessment: JSON.parse(content) }) : content;
    },
  };
  const before = await runSynthetic({ client: legacy, rounds: 1, includeTrace: true });
  const after = await runSynthetic({ client: wrapped, rounds: 1, includeTrace: true });
  expect(after.results).toEqual(before.results);
  expect(after.syntheticTrace).toEqual(before.syntheticTrace);
  const invalid: OpenAICompatibleChatCompletionsClient = {
    async complete() { return JSON.stringify({ assessment: skipAssessment(), leakedExtra: "PRIVATE-ENVELOPE" }); },
  };
  const rejected = await runSynthetic({ client: invalid, rounds: 1, includeTrace: true });
  expect(rejected.results.every(result => result.error === "assessment_failed")).toBe(true);
  expect(rejected.syntheticTrace!.records).toHaveLength(30);
  expect(rejected.syntheticTrace!.records.every(record => record.replayValidation.accepted === false)).toBe(true);
  expect(JSON.stringify(rejected.syntheticTrace)).not.toContain("PRIVATE-ENVELOPE");
});

test("trace keeps both assessment repair candidates but drops malformed text, illegal refs and unknown fields", async () => {
  const apiKey = "SENSITIVE-API-KEY-TAIL";
  const endpoint = "https://private.invalid/v1";
  const attempts = new Map<string, number>();
  const client: OpenAICompatibleChatCompletionsClient = {
    async complete(messages, options) {
      const stage = options?.responseFormat?.json_schema.name;
      const input = JSON.parse(messages[1]!.content);
      if (stage !== "iris_proactive_discussion_assessment") throw new Error("unexpected render");
      const attempt = (attempts.get(input.triggerMessageId) ?? 0) + 1;
      attempts.set(input.triggerMessageId, attempt);
      if (String(input.triggerMessageId).includes("inference")) {
        return JSON.stringify(attempt === 1 ? { ...skipAssessment(), privateUnknownField: apiKey } : skipAssessment());
      }
      if (!String(input.triggerMessageId).includes("arithmetic")) return JSON.stringify(skipAssessment());
      if (attempt === 2) return `malformed-${apiKey}-${endpoint}`;
      return JSON.stringify({ ...skipAssessment(), evidenceRefs: ["forged-private-ref"],
        observation: `${"x".repeat(490)}${apiKey}-${endpoint}` });
    },
  };
  const run = await runSynthetic({ client, rounds: 1, includeTrace: true, traceRedactions: [apiKey, endpoint] });
  const records = run.syntheticTrace!.records.filter(record => record.caseId === "arithmetic");

  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({ stage: "assessment", attempt: 1,
    replayValidation: { accepted: false, reason: "reference_invalid" },
    sanitization: { droppedReferenceCount: 1 } });
  expect(records[0].sanitization.truncatedFields).toContain("observation");
  expect(records[0].candidate.evidenceRefs).toEqual([]);
  expect(records[1]).toMatchObject({ stage: "assessment", attempt: 2, candidate: null,
    replayValidation: { accepted: false, reason: "json_invalid" } });
  expect(run.syntheticTrace!.records.find(record => record.caseId === "inference" && record.attempt === 1)).toMatchObject({
    replayValidation: { accepted: false, reason: "shape_invalid" },
    sanitization: { droppedFields: ["$unknownFields"] },
  });
  expect(JSON.stringify(run.syntheticTrace)).not.toMatch(/SENSITIVE|private\.invalid|forged-private-ref|malformed-/u);
});

test("a scope-rejected draft remains visible as a bounded non-accepted candidate", async () => {
  const scripted = scriptedClient({ scopeSupported: false });
  const run = await runSynthetic({ client: scripted.client, rounds: 1, includeTrace: true });
  const result = run.results.find(entry => entry.caseId === "arithmetic");
  const draft = run.syntheticTrace!.records.find(record => record.caseId === "arithmetic" && record.stage === "generated_pair");
  const scope = run.syntheticTrace!.records.find(record => record.caseId === "arithmetic" && record.stage === "scope_review");

  expect(result).toMatchObject({ draft: null, error: "draft_rejected" });
  expect(draft).toMatchObject({ acceptedDraft: false,
    candidate: { assessment: { reasoning: "生成时复核：比10万元预算多6万元。" },
      draft: { text: "两人总成本 16 万，比 10 万预算多 6 万，建议核对预算。" } },
    replayValidation: { accepted: true, reason: "accepted" } });
  expect(scope).toMatchObject({ candidate: { supported: false, reason: "候选遗漏必要限定。" },
    replayValidation: { accepted: true, reason: "accepted" } });
});

test("trace retains a failed assessment field check and redacts its diagnostic reason", async () => {
  const base = scriptedClient().client;
  const secret = "PRIVATE-FIELD-CHECK";
  const fieldChecks = pdReviewFieldChecks();
  fieldChecks.reasoning = { supported: false, reason: `该理由的减法方向有误：${secret}` };
  const client: OpenAICompatibleChatCompletionsClient = {
    async complete(messages, options) {
      if (options?.responseFormat?.json_schema.name === "iris_proactive_discussion_scope_review") {
        return JSON.stringify({ fieldChecks, supported: true, reason: "草稿受支持。",
          requiredNumbers: [], adviceQuote: "建议核对预算。" });
      }
      return base.complete(messages, options);
    },
  };
  const run = await runSynthetic({ client, rounds: 1, includeTrace: true, traceRedactions: [secret] });
  const scopes = run.syntheticTrace!.records.filter(record => record.caseId === "arithmetic" && record.stage === "scope_review");
  expect(scopes).toHaveLength(2);
  for (const scope of scopes) {
    expect(scope).toMatchObject({
      candidate: { supported: true, fieldChecks: {
        reasoning: { supported: false, reason: "该理由的减法方向有误：[REDACTED]" },
      } },
      replayValidation: { accepted: false, reason: "receipt_invalid" },
    });
  }
  expect(run.results.find(result => result.caseId === "arithmetic")).toMatchObject({ draft: null, error: "draft_rejected" });
  expect(JSON.stringify(run.syntheticTrace)).not.toContain(secret);
});

test("scope receipt replay rejects an affirmative number quote absent from the draft while retaining its evidence", async () => {
  const base = scriptedClient().client;
  const receipt = { label: "预算差额", expectedValue: "6", unit: "万元", draftQuote: "预算多60万元" };
  const client: OpenAICompatibleChatCompletionsClient = {
    async complete(messages, options) {
      if (options?.responseFormat?.json_schema.name === "iris_proactive_discussion_scope_review") {
        return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: true, reason: "数字已核对。", requiredNumbers: [receipt], adviceQuote: "建议核对预算。" });
      }
      return base.complete(messages, options);
    },
  };
  const run = await runSynthetic({ client, rounds: 1, includeTrace: true });
  const scopes = run.syntheticTrace!.records.filter(record => record.caseId === "arithmetic" && record.stage === "scope_review");
  expect(scopes[0]).toMatchObject({
    candidate: { supported: true, requiredNumbers: [receipt], adviceQuote: "建议核对预算。" },
    replayValidation: { accepted: false, reason: "receipt_invalid" },
  });
  expect(scopes).toHaveLength(2);
  expect(run.results.find(result => result.caseId === "arithmetic")).toMatchObject({ draft: null, error: "draft_rejected" });
});

test.each([false, true])("final scope receipt replay checks the current untruncated repaired draft (stale=%s)", async stale => {
  const base = scriptedClient().client;
  const repairedText = `${"合成说明。".repeat(110)}两人共16万元，较预算多6万元。建议确认预算或调整人数。`;
  const adviceQuote = stale ? "建议核对预算。" : "建议确认预算或调整人数。";
  const receipt = { label: "预算差额", expectedValue: "6", unit: "万元", draftQuote: "较预算多6万元" };
  let reviews = 0;
  const client: OpenAICompatibleChatCompletionsClient = {
    async complete(messages, options) {
      const stage = options?.responseFormat?.json_schema.name;
      if (stage === "iris_proactive_discussion_scope_review") {
        reviews += 1;
        return JSON.stringify(reviews === 1
          ? { fieldChecks: pdReviewFieldChecks(), supported: false, reason: "请修正措辞。", requiredNumbers: [], adviceQuote: null }
          : { fieldChecks: pdReviewFieldChecks(), supported: true, reason: "修正后内容受支持。", requiredNumbers: [receipt], adviceQuote });
      }
      if (stage === "iris_proactive_discussion_pair_repair") {
        const input = JSON.parse(messages[1]!.content);
        return JSON.stringify({ assessment: input.assessment, draft: { text: repairedText, evidenceRefs: input.assessment.evidenceRefs } });
      }
      return base.complete(messages, options);
    },
  };
  const run = await runSynthetic({ client, rounds: 1, includeTrace: true });
  const records = run.syntheticTrace!.records.filter(record => record.caseId === "arithmetic");
  const finalReview = records.filter(record => record.stage === "scope_review").at(-1);
  expect(finalReview).toMatchObject({ attempt: 2,
    candidate: { supported: true, requiredNumbers: [receipt], adviceQuote },
    replayValidation: { accepted: !stale, reason: stale ? "receipt_invalid" : "accepted" },
  });
  const repair = records.find(record => record.stage === "pair_repair");
  expect(repair!.candidate.draft.text).toHaveLength(500);
  expect(repair!.acceptedDraft).toBe(!stale);
  expect(run.results.find(result => result.caseId === "arithmetic")).toMatchObject(stale
    ? { draft: null, error: "draft_rejected" } : { draft: { text: repairedText }, error: null });
});

test("scope receipt trace bounds nested evidence and redacts text without retaining unknown fields", async () => {
  const base = scriptedClient().client;
  const client: OpenAICompatibleChatCompletionsClient = {
    async complete(messages, options) {
      if (options?.responseFormat?.json_schema.name === "iris_proactive_discussion_scope_review") {
        return JSON.stringify({ supported: true, reason: "需要核对。", adviceQuote: "长".repeat(600),
          requiredNumbers: Array.from({ length: 10 }, () => ({ label: "PRIVATE-RECEIPT", expectedValue: "6", unit: "万元",
            draftQuote: "PRIVATE-RECEIPT", hiddenPayload: "NEVER-RETAIN" })) });
      }
      return base.complete(messages, options);
    },
  };
  const run = await runSynthetic({ client, rounds: 1, includeTrace: true, traceRedactions: ["PRIVATE-RECEIPT"] });
  const review = run.syntheticTrace!.records.find(record => record.caseId === "arithmetic" && record.stage === "scope_review")!;
  expect(review.replayValidation).toEqual({ accepted: false, reason: "shape_invalid" });
  expect(review.candidate.requiredNumbers).toHaveLength(8);
  expect(review.candidate.requiredNumbers[0]).toEqual({ label: "[REDACTED]", expectedValue: "6", unit: "万元", draftQuote: "[REDACTED]" });
  expect(review.candidate.adviceQuote).toHaveLength(500);
  expect(review.sanitization.truncatedFields).toEqual(expect.arrayContaining(["requiredNumbers", "adviceQuote"]));
  expect(review.sanitization.droppedFields).toContain("$unknownFields");
  expect(JSON.stringify(run.syntheticTrace)).not.toMatch(/PRIVATE-RECEIPT|NEVER-RETAIN/u);
});

test.each([false, true])("final trace uses prior numeric diagnoses and records explicit revisions (corrected=%s)", async corrected => {
  const base = scriptedClient().client;
  let reviews = 0;
  const client: OpenAICompatibleChatCompletionsClient = {
    async complete(messages, options) {
      if (options?.responseFormat?.json_schema.name !== "iris_proactive_discussion_scope_review") return base.complete(messages, options);
      reviews += 1;
      const input = JSON.parse(messages[1]!.content);
      const receipt = { label: "差额", expectedValue: "60", unit: "万", draftQuote: null };
      if (reviews === 1) return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: false, reason: "初审要求60万。", requiredNumbers: [receipt], adviceQuote: null });
      return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: true, reason: "当前差额为6万。",
        requiredNumbers: [{ ...receipt, expectedValue: "6", draftQuote: "多 6 万" }], adviceQuote: "建议核对预算。",
        numberRevisions: corrected ? [{ previousIndex: 0, replacementIndex: 0, reason: "初审算错，16减10为6。",
          sourceRef: input.evidence[0].ref, sourceQuote: input.evidence[0].text }] : [] });
    },
  };
  const run = await runSynthetic({ client, rounds: 1, includeTrace: true });
  const records = run.syntheticTrace!.records.filter(record => record.caseId === "arithmetic");
  expect(run.syntheticTrace!.complete).toBe(true);
  const final = records.filter(record => record.stage === "scope_review").at(-1)!;
  expect(final).toMatchObject({ candidate: { supported: true },
    replayValidation: { accepted: corrected, reason: corrected ? "accepted" : "receipt_invalid" } });
  expect(final.candidate.numberRevisions).toHaveLength(corrected ? 1 : 0);
  if (corrected) expect(final.candidate.numberRevisions[0]).toMatchObject({ previousIndex: 0, replacementIndex: 0, reason: "初审算错，16减10为6。" });
  expect(records.find(record => record.stage === "pair_repair")!.acceptedDraft).toBe(corrected);
  expect(run.results.find(result => result.caseId === "arithmetic")!.error).toBe(corrected ? null : "draft_rejected");
});

test("revision trace bounds and redacts diagnostics while dropping unknown source identities", async () => {
  const base = scriptedClient().client;
  let reviews = 0;
  const client: OpenAICompatibleChatCompletionsClient = {
    async complete(messages, options) {
      if (options?.responseFormat?.json_schema.name !== "iris_proactive_discussion_scope_review") return base.complete(messages, options);
      if (++reviews === 1) return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: false, reason: "核对差额。", requiredNumbers: [
        { label: "差额", expectedValue: "60", unit: "万", draftQuote: null },
      ], adviceQuote: null });
      return JSON.stringify({ supported: true, reason: "复核。", requiredNumbers: [], adviceQuote: "建议核对预算。",
        numberRevisions: Array.from({ length: 10 }, () => ({ previousIndex: 0, replacementIndex: null,
          reason: `PRIVATE-REVISION${"长".repeat(600)}`, sourceRef: "PRIVATE-SOURCE", sourceQuote: "PRIVATE-REVISION",
          hidden: "NEVER-RETAIN" })) });
    },
  };
  const run = await runSynthetic({ client, rounds: 1, includeTrace: true, traceRedactions: ["PRIVATE-REVISION"] });
  const final = run.syntheticTrace!.records.filter(record => record.caseId === "arithmetic" && record.stage === "scope_review").at(-1)!;
  expect(final.replayValidation).toEqual({ accepted: false, reason: "shape_invalid" });
  expect(final.candidate.numberRevisions).toHaveLength(8);
  expect(final.candidate.numberRevisions[0].reason).toHaveLength(500);
  expect(final.candidate.numberRevisions[0].sourceQuote).toBe("[REDACTED]");
  expect(final.candidate.numberRevisions[0]).not.toHaveProperty("sourceRef");
  expect(final.sanitization.droppedReferenceCount).toBe(8);
  expect(final.sanitization.truncatedFields).toContain("numberRevisions");
  expect(JSON.stringify(run.syntheticTrace)).not.toMatch(/PRIVATE-|NEVER-RETAIN/u);
});

test("assessment diagnostic replay maps invalid decision-field relations to a fixed local reason", async () => {
  let arithmeticAttempts = 0;
  const client: OpenAICompatibleChatCompletionsClient = {
    async complete(messages, options) {
      expect(options?.responseFormat?.json_schema.name).toBe("iris_proactive_discussion_assessment");
      const input = JSON.parse(messages[1]!.content);
      if (!String(input.triggerMessageId).includes("arithmetic")) return JSON.stringify(skipAssessment());
      arithmeticAttempts += 1;
      return JSON.stringify(arithmeticAttempts === 1
        ? { ...skipAssessment(), issueRef: { kind: "new", description: "预算问题" } }
        : skipAssessment());
    },
  };
  const run = await runSynthetic({ client, rounds: 1, includeTrace: true });
  const records = run.syntheticTrace!.records.filter(record => record.caseId === "arithmetic");

  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({ attempt: 1, replayValidation: { accepted: false, reason: "relation_invalid" } });
  expect(records[1]).toMatchObject({ attempt: 2, replayValidation: { accepted: true, reason: "accepted" } });
});

test("HTTP failures remain unchanged and do not serialize error details into trace", async () => {
  const secret = "private-http-body-and-header";
  const client: OpenAICompatibleChatCompletionsClient = {
    async complete(messages: readonly OpenAICompatibleChatMessage[], _options?: OpenAICompatibleChatCompletionOptions) {
      const input = JSON.parse(messages[1]!.content);
      if (String(input.triggerMessageId).includes("arithmetic")) {
        throw Object.assign(new ModelProviderHttpError(429, secret), { headers: { authorization: secret }, body: secret });
      }
      return JSON.stringify(skipAssessment());
    },
  };
  const run = await runSynthetic({ client, rounds: 1, includeTrace: true, traceRedactions: [secret] });

  expect(run.results.find(entry => entry.caseId === "arithmetic")).toMatchObject({ error: "assessment_failed", draft: null });
  expect(run.syntheticTrace!.records.some(record => record.caseId === "arithmetic")).toBe(false);
  expect(JSON.stringify(run.syntheticTrace)).not.toContain(secret);
  expect(run.syntheticTrace!.records.length).toBeLessThanOrEqual(600);
});

function repairingClient(finalSupported: boolean, invalidRepair = false) {
  const base = scriptedClient();
  const requests: unknown[] = [];
  let scopeCalls = 0;
  const client: OpenAICompatibleChatCompletionsClient = {
    async complete(messages, options) {
      requests.push(structuredClone({ messages, options }));
      const input = JSON.parse(messages[1]!.content);
      const stage = options?.responseFormat?.json_schema.name;
      if (stage === "iris_proactive_discussion_scope_review") {
        scopeCalls += 1;
        const supported = scopeCalls % 2 === 0 && finalSupported;
        return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported, reason: "请保留已核算的预算差额，限定未来影响。",
          requiredNumbers: [], adviceQuote: supported ? "建议确认预算或调整人数。" : null });
      }
      if (stage === "iris_proactive_discussion_pair_repair") {
        return JSON.stringify({
          assessment: { ...input.assessment, reasoning: "按现有材料，两人总成本比预算多6万元。" },
          draft: { text: "两人共16万元，较预算多6万元。建议确认预算或调整人数。", evidenceRefs: input.assessment.evidenceRefs },
          ...(invalidRepair ? { privateField: "PAIR-PRIVATE-SECRET" } : {}),
        });
      }
      return base.client.complete(messages, options);
    },
  };
  return { client, requests };
}

test("trace follows one pair repair and marks only its final reviewed draft accepted", async () => {
  const offClient = repairingClient(true);
  const onClient = repairingClient(true);
  const off = await runSynthetic({ client: offClient.client, rounds: 1, includeTrace: false });
  const on = await runSynthetic({ client: onClient.client, rounds: 1, includeTrace: true });
  expect(on.results).toEqual(off.results);
  expect(onClient.requests).toEqual(offClient.requests);
  expect(on.syntheticTrace).toMatchObject({ complete: true, recordsDropped: 0 });
  const records = on.syntheticTrace!.records.filter(record => record.caseId === "arithmetic");
  expect(records.map(record => record.stage)).toEqual(["assessment", "generated_pair", "scope_review", "pair_repair", "scope_review"]);
  expect(records[1]).toMatchObject({ acceptedDraft: false });
  expect(records[3]).toMatchObject({ acceptedDraft: true, attempt: 1,
    candidate: { assessment: { reasoning: "按现有材料，两人总成本比预算多6万元。" }, draft: { text: "两人共16万元，较预算多6万元。建议确认预算或调整人数。" } },
    replayValidation: { accepted: true, reason: "accepted" } });
  expect(records[4]).toMatchObject({ attempt: 2, candidate: { supported: true } });
  expect(on.results.find(result => result.caseId === "arithmetic")).toMatchObject({
    assessment: { reasoning: "按现有材料，两人总成本比预算多6万元。" },
    draft: { text: "两人共16万元，较预算多6万元。建议确认预算或调整人数。" }, error: null,
  });
});

test("trace retains a twice-rejected pair without labelling either draft as accepted", async () => {
  const { client } = repairingClient(false);
  const run = await runSynthetic({ client, rounds: 1, includeTrace: true });
  const records = run.syntheticTrace!.records.filter(record => record.caseId === "arithmetic");
  expect(records).toHaveLength(5);
  expect(records.filter(record => record.stage === "scope_review").map(record => record.candidate.supported)).toEqual([false, false]);
  expect(records.filter(record => record.stage === "generated_pair" || record.stage === "pair_repair").map(record => record.acceptedDraft)).toEqual([false, false]);
  expect(run.results.find(result => result.caseId === "arithmetic")).toMatchObject({ draft: null, error: "draft_rejected" });
});

test("invalid pair repair is diagnosed by the runtime validator and unknown content is not retained", async () => {
  const { client } = repairingClient(true, true);
  const run = await runSynthetic({ client, rounds: 1, includeTrace: true });
  const records = run.syntheticTrace!.records.filter(record => record.caseId === "arithmetic");
  expect(records).toHaveLength(4);
  expect(records[3]).toMatchObject({ stage: "pair_repair", acceptedDraft: false,
    replayValidation: { accepted: false, reason: "repair_invalid" },
    sanitization: { droppedFields: ["$unknownFields"] } });
  expect(JSON.stringify(run.syntheticTrace)).not.toContain("PAIR-PRIVATE-SECRET");
  expect(run.results.find(result => result.caseId === "arithmetic")).toMatchObject({ draft: null, error: "draft_rejected" });
});

function skipAssessment() {
  return { decision: "skip", reason: "no_work_value", issueRef: null, evidenceRefs: [], observation: "", reasoning: "",
    suggestion: "", uncertainty: "fact", materialChange: { kind: "none", explanation: "", evidenceRefs: [] } };
}
