# Iris Disabled Group Answer Retrieval Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent disabled Feishu groups from contributing previously indexed group-visible document fragments to answer drafts.

**Architecture:** Reuse the answer draft runtime source-policy callback. Add a small group-scope check for `group_visible_document` sources that consults the shared runtime controller when group ids are available.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Add Disabled Group Retrieval Test

**Files:**
- Modify: `apps/core/tests/answer-draft-runtime.test.ts`

- [x] **Step 1: Write the failing test**

Add a source-policy runtime test with one disabled-group document, one enabled-group document, and one user-submitted document.

- [x] **Step 2: Run focused test to verify failure**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-runtime.test.ts
```

Expected: the new test fails because disabled-group document text still enters the prompt.

### Task 2: Enforce Group Scope In Retrieval Gate

**Files:**
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`

- [x] **Step 1: Extend the runtime retrieval gate type**

Add optional `canProcessGroupMessage(groupId: string): boolean` to the answer runtime's runtime gate shape.

- [x] **Step 2: Gate group-visible sources by enabled source groups**

For `group_visible_document`, require `canReadDocuments()` and, when group ids exist, at least one enabled group according to `canProcessGroupMessage`.

- [x] **Step 3: Run focused test to verify pass**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-runtime.test.ts
npm run typecheck
```

### Task 3: Verify and Publish

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run typecheck
python -m pytest
docker compose config
npm test
```

- [ ] **Step 2: Commit and push**

Commit with:

```powershell
git add apps/core/src/runtime/answer-draft-runtime.ts apps/core/tests/answer-draft-runtime.test.ts docs/superpowers/specs/2026-07-04-iris-disabled-group-answer-retrieval-guard-design.md docs/superpowers/plans/2026-07-04-iris-disabled-group-answer-retrieval-guard.md
git commit -m "fix: gate answer retrieval by disabled groups"
git push --force-with-lease origin codex/iris-document-source-registry
```
