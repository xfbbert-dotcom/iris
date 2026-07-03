# Iris Answer Runtime Retrieval Capability Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure answer draft retrieval respects runtime document and knowledge-base capability switches.

**Architecture:** Reuse the existing source-policy permission callback and add capability checks after source lookup. Keep the retrieval builder unchanged.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Add Runtime Retrieval Gate Test

**Files:**
- Modify: `apps/core/tests/answer-draft-runtime.test.ts`

- [x] **Step 1: Write failing test**

Add a source-policy runtime test with group-visible, authorized wiki, and user-submitted fragments while both retrieval capabilities are disabled.

- [x] **Step 2: Run focused test to verify failure**

Run:

```bash
npm --workspace apps/core test -- tests/answer-draft-runtime.test.ts
```

Expected: test fails because group-visible and wiki fragments still enter context.

### Task 2: Implement Retrieval Capability Gates

**Files:**
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Accept runtime gate in answer runtime**

Add optional `runtimeController` with `canReadDocuments()` and `canRetrieveKnowledgeBase()`.

- [x] **Step 2: Apply source-type checks in source-policy permission callback**

Reject group-visible and wiki sources when their corresponding runtime capability is disabled.

- [x] **Step 3: Pass app controller into default answer runtime**

Update `buildApp()` runtime composition and its wiring test.

- [x] **Step 4: Run focused tests to verify pass**

Run answer draft runtime and app API wiring tests.

### Task 3: Verify and Publish

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
python -m pytest
docker compose config
npm test
```

- [x] **Step 2: Commit and push**

Commit with:

```bash
git add apps/core/src/runtime/answer-draft-runtime.ts apps/core/src/app.ts apps/core/tests/answer-draft-runtime.test.ts apps/core/tests/answer-draft-api.test.ts docs/superpowers/specs/2026-07-04-iris-answer-runtime-retrieval-capability-gates-design.md docs/superpowers/plans/2026-07-04-iris-answer-runtime-retrieval-capability-gates.md
git commit -m "fix: gate answer retrieval by runtime capabilities"
git push --force-with-lease origin codex/iris-document-source-registry
```
