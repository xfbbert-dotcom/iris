import { Ajv } from "ajv";
import { expect, test, vi } from "vitest";
import type { OpenAICompatibleChatCompletionOptions, OpenAICompatibleChatMessage } from "../src/model/openai-compatible-chat-completions-client.js";
import { createPdModel } from "../src/proactive-discussion/model.js";
import type { PdAssessment, PdContext } from "../src/proactive-discussion/contracts.js";
import { createPdSourceRef } from "../src/proactive-discussion/contracts.js";
import { pdAssessment, pdContext, pdContextWithIssue, pdSkipAssessment } from "./fixtures/proactive-discussion.js";

async function wireValidator(context = pdContext()) {
  let options: OpenAICompatibleChatCompletionOptions | undefined;
  const client = { complete: vi.fn(async (_messages: readonly OpenAICompatibleChatMessage[], received?: OpenAICompatibleChatCompletionOptions) => {
    options = received;
    return JSON.stringify(pdSkipAssessment());
  }) };
  await createPdModel({ client }).assess(context);
  const schema = options!.responseFormat!.json_schema.schema;
  return { schema, validate: new Ajv({ strict: true }).compile(schema) };
}

test("generation schema admits complete decisions and excludes contradictory branch combinations", async () => {
  const { schema, validate } = await wireValidator();
  expect(schema).toMatchObject({ type: "object", required: ["assessment"], additionalProperties: false });
  expect(validate({ assessment: pdAssessment() })).toBe(true);
  expect(validate({ assessment: pdSkipAssessment() })).toBe(true);
  const invalid = [
    { ...pdAssessment(), issueRef: null },
    { ...pdAssessment(), reason: "duplicate" },
    { ...pdAssessment(), observation: "" },
    { ...pdAssessment(), evidenceRefs: [] },
    { ...pdAssessment(), materialChange: { kind: "none", explanation: "", evidenceRefs: [] } },
    { ...pdAssessment(), materialChange: { ...pdAssessment().materialChange, kind: "new_evidence" } },
    { ...pdAssessment(), materialChange: { ...pdAssessment().materialChange, evidenceRefs: [] } },
    { ...pdSkipAssessment(), reason: "material_issue" },
    { ...pdSkipAssessment(), issueRef: pdAssessment().issueRef },
    { ...pdSkipAssessment(), materialChange: { kind: "none", explanation: "没有变化", evidenceRefs: [] } },
    { ...pdAssessment(), evidenceRefs: ["foreign-ref"] },
  ];
  for (const assessment of invalid) expect(validate({ assessment }), JSON.stringify(assessment)).toBe(false);
  expect(validate({ assessment: pdAssessment(), ignored: true })).toBe(false);
});

function existingAssessment(context: PdContext, kind: "new_evidence" | "unattempted_first"): PdAssessment {
  return { ...pdAssessment(), issueRef: { kind: "existing", id: "issue-1" },
    materialChange: { kind, explanation: "核对当前方案的预算差额。", evidenceRefs: [context.sources[1]!.ref] } };
}

test("existing branches use only eligible catalog IDs without blocking silence", async () => {
  for (const overrides of [ {}, { state: "resolved" as const }, { state: "observing" as const, canReassessUnattempted: true },
    { state: "user_paused" as const }, { hasUnknownDelivery: true } ]) {
    const context = pdContextWithIssue(overrides);
    const { validate } = await wireValidator(context);
    const eligible = context.issues[0]!.state !== "user_paused" && !context.issues[0]!.hasUnknownDelivery;
    expect(validate({ assessment: existingAssessment(context, "new_evidence") })).toBe(eligible);
    expect(validate({ assessment: existingAssessment(context, "unattempted_first") })).toBe(
      eligible && context.issues[0]!.state === "observing" && context.issues[0]!.canReassessUnattempted);
    expect(validate({ assessment: { ...pdSkipAssessment("duplicate"), issueRef: { kind: "existing", id: "issue-1" } } })).toBe(true);
    expect(validate({ assessment: { ...existingAssessment(context, "new_evidence"), issueRef: { kind: "existing", id: "foreign" } } })).toBe(false);
  }
});

test("adapter unwraps a legal wire assessment without changing the public contract or fabricating missing fields", async () => {
  const valid = pdAssessment();
  const client = { complete: vi.fn(async () => JSON.stringify({ assessment: valid })) };
  await expect(createPdModel({ client }).assess(pdContext())).resolves.toEqual(valid);
  expect(client.complete).toHaveBeenCalledTimes(1);
  for (const payload of [
    { assessment: { ...valid, issueRef: null } },
    { assessment: valid, ignored: "do not discard extra fields" },
    { assessment: { ...valid, reasoning: "   " } },
    { assessment: { ...valid, evidenceRefs: [valid.evidenceRefs[0]] } },
  ]) {
    const invalidClient = { complete: vi.fn(async () => JSON.stringify(payload)) };
    await expect(createPdModel({ client: invalidClient }).assess(pdContext())).rejects.toThrow("assessment was invalid");
    expect(invalidClient.complete).toHaveBeenCalledTimes(2);
  }
});

test("shared reference definitions keep a historical catalog inside the existing response-format byte limit", async () => {
  const context = pdContextWithIssue({ state: "observing", canReassessUnattempted: true });
  const original = context.sources[0]!;
  if (original.kind !== "message") throw new Error("fixture requires a message source");
  for (let index = 2; index < 110; index += 1) {
    const binding = { ...original.binding, messageId: `historical-${index}` };
    const source = { kind: "message" as const, binding, ref: createPdSourceRef({ kind: "message", binding }) };
    context.sources.push(source);
    context.items.push({ ref: source.ref, text: context.items[0]!.text });
  }
  context.issues = Array.from({ length: 100 }, (_, index) => ({ ...context.issues[0]!,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` }));
  context.issues[0]!.state = "user_paused";
  context.issues[1]!.state = "surfaced";
  context.issues[1]!.canReassessUnattempted = false;
  const { schema, validate } = await wireValidator(context);
  expect(Buffer.byteLength(JSON.stringify({ type: "json_schema", json_schema: {
    name: "iris_proactive_discussion_assessment", strict: true, schema,
  } }))).toBeLessThan(32_768);
  expect(validate({ assessment: pdAssessment() })).toBe(true);
});
