import { expect, test } from "vitest";

import type {
  OpenAICompatibleChatCompletionsClient,
  OpenAICompatibleChatMessage,
  OpenAICompatibleChatCompletionOptions,
} from "../src/model/openai-compatible-chat-completions-client.js";
import { ModelProviderHttpError } from "../src/model/model-provider-error.js";

const evalPath = "../../../scripts/pilot/proactive-discussion-eval.ts";

type SyntheticRun = {
  cases: Array<{ id: string }>;
  results: Array<{ caseId: string; round: number; error: string | null; draft: unknown }>;
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

function scriptedClient({ scopeSupported = true }: { scopeSupported?: boolean } = {}) {
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
      if (stage === "iris_proactive_discussion_draft") {
        return JSON.stringify({ text: "两人总成本 16 万，比 10 万预算多 6 万，建议核对预算。",
          evidenceRefs: input.assessment.evidenceRefs });
      }
      if (stage === "iris_proactive_discussion_scope_review") {
        return JSON.stringify({ supported: scopeSupported, reason: scopeSupported ? "内容受材料支持。" : "候选遗漏必要限定。" });
      }
      throw new Error("unexpected response format");
    },
  };
  return { client, requests };
}

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
  const draft = run.syntheticTrace!.records.find(record => record.caseId === "arithmetic" && record.stage === "draft");
  const scope = run.syntheticTrace!.records.find(record => record.caseId === "arithmetic" && record.stage === "scope_review");

  expect(result).toMatchObject({ draft: null, error: "draft_rejected" });
  expect(draft).toMatchObject({ acceptedDraft: false, candidate: { text: "两人总成本 16 万，比 10 万预算多 6 万，建议核对预算。" },
    replayValidation: { accepted: true, reason: "accepted" } });
  expect(scope).toMatchObject({ candidate: { supported: false, reason: "候选遗漏必要限定。" },
    replayValidation: { accepted: true, reason: "accepted" } });
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

function skipAssessment() {
  return { decision: "skip", reason: "no_work_value", issueRef: null, evidenceRefs: [], observation: "", reasoning: "",
    suggestion: "", uncertainty: "fact", materialChange: { kind: "none", explanation: "", evidenceRefs: [] } };
}
