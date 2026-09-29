import { createPdModel as createRuntimeModel } from "../../src/proactive-discussion/model.js";
import type { OpenAICompatibleChatCompletionsClient } from "../../src/model/openai-compatible-chat-completions-client.js";
export * from "../../src/proactive-discussion/model.js";

// Existing semantic fixtures describe the full expected application pair. Encode only
// their editable prose for the new wire contract. Invalid identity/reference fixtures
// deliberately remain invalid wire output: this helper must not silently repair them.
export function proseFixtureClient(client: OpenAICompatibleChatCompletionsClient): OpenAICompatibleChatCompletionsClient {
  return { async complete(messages, options) {
    const content = await client.complete(messages, options);
    const stage = options?.responseFormat?.json_schema.name;
    if (stage !== "iris_proactive_discussion_generated_pair" && stage !== "iris_proactive_discussion_pair_repair") return content;
    try {
      const pair = JSON.parse(content);
      const input = JSON.parse(messages[1]!.content);
      const target = input.target ?? input.identityTarget;
      const a = pair.assessment;
      const sameRefs = (left: unknown, right: unknown) => Array.isArray(left) && Array.isArray(right)
        && new Set(left).size === left.length && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
      const keys = (value: object, expected: string[]) => JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected.sort());
      if (!a || !pair.draft || !target || !keys(pair, ["assessment", "draft"])
        || !keys(a, ["decision", "reason", "issueRef", "evidenceRefs", "observation", "reasoning", "suggestion", "uncertainty", "materialChange"])
        || !keys(pair.draft, ["text", "evidenceRefs"])
        || !keys(a.materialChange, ["kind", "explanation", "evidenceRefs"])
        || a.decision !== target.decision || a.reason !== target.reason
        || a.issueRef?.kind !== target.issueRef?.kind
        || !keys(a.issueRef, a.issueRef.kind === "new" ? ["kind", "description"] : ["kind", "id"])
        || (a.issueRef.kind === "existing" && a.issueRef.id !== target.issueRef.id)
        || !sameRefs(a.evidenceRefs, target.evidenceRefs) || !sameRefs(pair.draft.evidenceRefs, target.evidenceRefs)
        || a.materialChange.kind !== target.materialChange.kind
        || !sameRefs(a.materialChange.evidenceRefs, target.materialChange.evidenceRefs)) return content;
      const prose = {
        issueDescription: a.issueRef.kind === "new" ? a.issueRef.description : null,
        observation: a.observation, reasoning: a.reasoning, suggestion: a.suggestion,
        uncertainty: a.uncertainty, changeExplanation: a.materialChange.explanation, draftText: pair.draft.text,
      };
      if (stage === "iris_proactive_discussion_pair_repair") {
        const base = input.assessment;
        const previous: Record<string, unknown> = { issueDescription: base.issueRef.kind === "new" ? base.issueRef.description : null,
          observation: base.observation, reasoning: base.reasoning, suggestion: base.suggestion,
          uncertainty: base.uncertainty, changeExplanation: base.materialChange.explanation, draftText: input.draft.text };
        return JSON.stringify({ updates: Object.entries(prose).filter(([field, value]) => value !== previous[field])
          .map(([field, value]) => ({ field, value })) });
      }
      return JSON.stringify({ prose });
    } catch { return content; }
  } };
}

export function createPdModel({ client }: { client: OpenAICompatibleChatCompletionsClient }) {
  return createRuntimeModel({ client: proseFixtureClient(client) });
}
