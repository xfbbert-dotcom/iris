# Iris Background Document Context Trim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove meaningless surrounding whitespace from background document prompt content at the final context assembly boundary.

**Architecture:** Trim background document `source` and `text` inside `formatBackgroundDocument`.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Background Document Formatting

**Files:**
- Modify: `apps/core/tests/context-assembly.test.ts`
- Modify: `apps/core/src/memory/context-assembly.ts`

- [x] **Step 1: Write failing context assembly test**

Assert padded background document source and text values render as trimmed XML document content.

- [x] **Step 2: Run focused test to verify it fails**

Run: `npm --workspace apps/core test -- tests/context-assembly.test.ts --reporter=dot`

Expected: FAIL because formatting currently preserves surrounding whitespace.

- [x] **Step 3: Implement trimming**

Trim `document.source` and `document.text` inside `formatBackgroundDocument` before escaping.

- [x] **Step 4: Run focused test to verify it passes**

Run: `npm --workspace apps/core test -- tests/context-assembly.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-background-document-context-trim.md`

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit 0.

- [x] **Step 2: Commit and push**

Run:

```bash
git add apps/core/src/memory/context-assembly.ts apps/core/tests/context-assembly.test.ts docs/superpowers/specs/2026-07-03-iris-background-document-context-trim-design.md docs/superpowers/plans/2026-07-03-iris-background-document-context-trim.md
git commit -m "fix: trim background document prompt content"
git push --force-with-lease origin codex/iris-document-source-registry
```
