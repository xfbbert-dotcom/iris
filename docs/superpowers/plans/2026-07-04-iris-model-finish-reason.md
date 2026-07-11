# Iris Model Finish Reason Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent truncated OpenAI-compatible model responses from being returned as completed Iris answers.

**Architecture:** Keep validation inside `apps/core/src/model/openai-compatible-model-provider.ts`. Extend the first-choice reader to reject explicit non-`stop` finish reasons before returning message content.

**Tech Stack:** TypeScript, Vitest, OpenAI-compatible chat completions API.

---

## File Structure

- Modify `apps/core/tests/openai-compatible-model-provider.test.ts` with a failing truncated-response test.
- Modify `apps/core/src/model/openai-compatible-model-provider.ts` with minimal finish-reason validation.

### Task 1: Regression Test

**Files:**
- Modify: `apps/core/tests/openai-compatible-model-provider.test.ts`

- [x] **Step 1: Write failing test**

Add this test inside `describe("OpenAICompatibleModelProvider", ...)`:

```ts
it("throws on explicitly truncated model responses", async () => {
  const provider = createOpenAICompatibleModelProvider({
    config: config(),
    fetch: vi.fn(async () =>
      jsonResponse({
        choices: [{ finish_reason: "length", message: { content: "Partial answer" } }],
      }),
    ),
  });

  await expect(
    provider.generateAnswerDraft({ question: "Q", promptContext: "C" }),
  ).rejects.toThrow("model provider response did not finish normally");
});
```

- [x] **Step 2: Run RED**

Run: `npm --workspace apps/core test -- openai-compatible-model-provider.test.ts`

Expected: FAIL because the current adapter returns `"Partial answer"`.

Observed: FAIL. The truncated response resolved `{ answerText: "Partial answer" }` instead of
rejecting.

### Task 2: Minimal Implementation

**Files:**
- Modify: `apps/core/src/model/openai-compatible-model-provider.ts`

- [x] **Step 1: Reject explicit non-normal finish reasons**

After reading `firstChoice`, add:

```ts
const finishReason = firstChoice.finish_reason;
if (finishReason !== undefined && finishReason !== null && finishReason !== "stop") {
  throw new Error("model provider response did not finish normally");
}
```

- [x] **Step 2: Run GREEN**

Run: `npm --workspace apps/core test -- openai-compatible-model-provider.test.ts`

Expected: PASS.

Observed: PASS with 8 model provider tests passing.

### Task 3: Verification And PR

- [x] **Step 1: Run full verification**

Run: `npm run verify`

Expected: PASS for diff check, typecheck, Core tests, Python tests, and Docker Compose config.

Observed: PASS. Core reported 732 passing tests and 4 skipped tests. Python worker tests reported
7 passing tests. Docker Compose config rendered successfully.

- [x] **Step 2: Commit and push**

Run:

```powershell
git add apps/core/src/model/openai-compatible-model-provider.ts apps/core/tests/openai-compatible-model-provider.test.ts docs/superpowers/specs/2026-07-04-iris-model-finish-reason-design.md docs/superpowers/plans/2026-07-04-iris-model-finish-reason.md
git commit -m "fix: reject truncated model responses"
git push
```

- [x] **Step 3: Watch PR checks**

Run: `gh pr checks 3 --watch --interval 10`

Expected: Core and AI Worker checks pass.

Observed: PASS. GitHub Actions reported Core and AI Worker success for PR #3.
