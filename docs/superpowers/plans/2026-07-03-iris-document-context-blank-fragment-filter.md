# Iris Document Context Blank Fragment Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep blank document chunks out of answer draft prompt context and returned allowed fragment metadata.

**Architecture:** Filter allowed fragments in `DocumentRetrievalContextBuilder` after live permission checks and before prompt assembly.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Blank Fragment Filtering

**Files:**
- Modify: `apps/core/tests/document-retrieval-context.test.ts`
- Modify: `apps/core/src/memory/document-retrieval-context.ts`

- [x] **Step 1: Write failing retrieval context test**

Add a test where one allowed fragment has whitespace-only text and assert it is absent from `allowedFragments` and prompt context while `retrievedFragmentCount` still includes it.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/document-retrieval-context.test.ts --reporter=dot`

Expected: FAIL because blank fragments are still returned and rendered.

- [x] **Step 3: Implement blank filtering**

Filter `allowedFragments` with `fragment.text.trim().length > 0` after permission filtering.

- [x] **Step 4: Run retrieval context test to verify it passes**

Run: `npm --workspace apps/core test -- tests/document-retrieval-context.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-document-context-blank-fragment-filter.md`

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit 0.

- [x] **Step 2: Mark checklist complete**

Update this plan so completed steps are checked.

- [x] **Step 3: Commit and push**

Run:

```bash
git add apps/core/src/memory/document-retrieval-context.ts apps/core/tests/document-retrieval-context.test.ts docs/superpowers/specs/2026-07-03-iris-document-context-blank-fragment-filter-design.md docs/superpowers/plans/2026-07-03-iris-document-context-blank-fragment-filter.md
git commit -m "feat: filter blank retrieved document context"
git push --force-with-lease origin codex/iris-document-source-registry
```
