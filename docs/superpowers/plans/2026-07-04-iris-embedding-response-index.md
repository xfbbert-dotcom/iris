# Iris Embedding Response Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent malformed embedding response indexes from silently misaligning text inputs and vectors.

**Architecture:** Keep validation inside `apps/core/src/model/openai-compatible-embedding-provider.ts`. Tighten `readEmbeddingVectors()` so any indexed response must provide a full, unique, in-range index set before sorting.

**Tech Stack:** TypeScript, Vitest, OpenAI-compatible embeddings API.

---

## File Structure

- Modify `apps/core/tests/openai-compatible-embedding-provider.test.ts` with failing malformed-index tests.
- Modify `apps/core/src/model/openai-compatible-embedding-provider.ts` with index validation before sorting.

### Task 1: Regression Tests

**Files:**
- Modify: `apps/core/tests/openai-compatible-embedding-provider.test.ts`

- [ ] **Step 1: Write failing tests**

Add this test inside `describe("OpenAICompatibleEmbeddingProvider", ...)`:

```ts
it("rejects invalid embedding response indexes before returning vectors", async () => {
  for (const data of [
    [
      { index: 0, embedding: [1, 0, 0] },
      { index: 0, embedding: [0, 1, 0] },
    ],
    [
      { index: 0, embedding: [1, 0, 0] },
      { index: 2, embedding: [0, 1, 0] },
    ],
    [{ index: 0, embedding: [1, 0, 0] }, { embedding: [0, 1, 0] }],
  ]) {
    const provider = createOpenAICompatibleEmbeddingProvider({
      config: config(),
      fetch: vi.fn(async () => jsonResponse({ data })),
    });

    await expect(provider.embedTexts(["alpha", "beta"])).rejects.toThrow(
      "embedding response indices were invalid",
    );
  }
});
```

- [ ] **Step 2: Run RED**

Run: `npm --workspace apps/core test -- openai-compatible-embedding-provider.test.ts`

Expected: FAIL because duplicate and out-of-range indexes are currently accepted.

### Task 2: Minimal Implementation

**Files:**
- Modify: `apps/core/src/model/openai-compatible-embedding-provider.ts`

- [ ] **Step 1: Validate indexed responses before sorting**

Add helper logic before sorting:

```ts
const indexes = items.map((item) => (isRecord(item) ? item.index : undefined));
if (indexes.some((index) => index !== undefined)) {
  const validIndexes = indexes.filter(
    (index): index is number =>
      typeof index === "number" &&
      Number.isInteger(index) &&
      Number.isSafeInteger(index) &&
      index >= 0 &&
      index < items.length,
  );
  if (validIndexes.length !== items.length || new Set(validIndexes).size !== items.length) {
    throw new Error("embedding response indices were invalid");
  }
  items.sort((a, b) => (a as { index: number }).index - (b as { index: number }).index);
}
```

- [ ] **Step 2: Run GREEN**

Run: `npm --workspace apps/core test -- openai-compatible-embedding-provider.test.ts`

Expected: PASS.

### Task 3: Verification And PR

- [ ] **Step 1: Run full verification**

Run: `npm run verify`

Expected: PASS for diff check, typecheck, Core tests, Python tests, and Docker Compose config.

- [ ] **Step 2: Commit and push**

Run:

```powershell
git add apps/core/src/model/openai-compatible-embedding-provider.ts apps/core/tests/openai-compatible-embedding-provider.test.ts docs/superpowers/specs/2026-07-04-iris-embedding-response-index-design.md docs/superpowers/plans/2026-07-04-iris-embedding-response-index.md
git commit -m "fix: validate embedding response indexes"
git push
```

- [ ] **Step 3: Watch PR checks**

Run: `gh pr checks 3 --watch --interval 10`

Expected: Core and AI Worker checks pass.
