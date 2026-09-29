import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { createPdModel } from "../src/proactive-discussion/model.js";
import { pdReviewFieldChecks } from "./fixtures/proactive-discussion.js";

const archive = JSON.parse(readFileSync(new URL("../../../docs/development/evidence/iris-bound-prose-20260929.json", import.meta.url), "utf8"));
const initial = JSON.parse(archive.completions[0].content).assessment;
const generated = JSON.parse(archive.completions[1].content);
const review = JSON.parse(archive.completions[2].content);
const oldRepair = JSON.parse(archive.completions[3].content).prose;
async function context() {
  const path = "../../../scripts/pilot/proactive-discussion-eval.ts";
  return (await import(path)).createProactiveDiscussionEvalCases().find((entry: { id: string }) => entry.id === "qualified-risk").context;
}
function clientFor(repair: unknown, finalSupported = true) {
  const outputs = [generated, review, repair, { fieldChecks: pdReviewFieldChecks(), supported: finalSupported,
    reason: "fixture", requiredNumbers: [], adviceQuote: review.adviceQuote }];
  let index = 0;
  return { complete: vi.fn(async () => JSON.stringify(outputs[index++])) };
}
test("corrects only reasoning while retaining this generation's issue and business change through final review", async () => {
  const client = clientFor({ updates: [{ field: "reasoning", value: oldRepair.reasoning }] });
  const result = await createPdModel({ client }).render({ context: await context(), assessment: initial });
  expect(result?.assessment.reasoning).toBe(oldRepair.reasoning);
  expect(result?.assessment.issueRef).toEqual({ kind: "new", description: generated.prose.issueDescription });
  expect(result?.assessment.materialChange.explanation).toBe(generated.prose.changeExplanation);
  expect(result?.assessment.observation).toBe(generated.prose.observation);
  expect(result?.draft.text).toBe(generated.prose.draftText);
  expect(result?.assessment.materialChange.explanation).not.toBe(oldRepair.changeExplanation);
  expect(client.complete).toHaveBeenCalledTimes(4);
});
test.each([
  { updates: [{ field: "issueDescription", value: null }] },
  { updates: [{ field: "evidenceRefs", value: "forged" }] },
  { updates: [{ field: "reasoning", value: "x" }, { field: "reasoning", value: "y" }] },
  { updates: [{ field: "reasoning", value: "" }] },
  { prose: oldRepair },
])("rejects invalid updates without final review: %j", async repair => {
  const client = clientFor(repair);
  expect(await createPdModel({ client }).render({ context: await context(), assessment: initial })).toBeNull();
  expect(client.complete).toHaveBeenCalledTimes(3);
});
test("retaining fields does not bypass final semantic rejection", async () => {
  const client = clientFor({ updates: [{ field: "reasoning", value: oldRepair.reasoning }] }, false);
  expect(await createPdModel({ client }).render({ context: await context(), assessment: initial })).toBeNull();
  expect(client.complete).toHaveBeenCalledTimes(4);
});
