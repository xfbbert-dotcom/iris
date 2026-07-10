# Iris Current-Group Document Retrieval Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent production answer drafting in one Feishu group from retrieving group-visible
documents observed only in another group.

**Architecture:** Carry the current answer `chatId` through the retrieval context into the fragment
repository, push exact current-group evidence into SQL before vector ranking, and independently
enforce the same scope in the TypeScript source-policy guard. Keep authorized wiki and
user-submitted sources under their existing company-level policies.

**Tech Stack:** TypeScript, Vitest, Postgres, pgvector.

## Global Constraints

- Do not introduce implicit cross-group grants.
- Do not weaken Feishu real-time permission checks or local source policy.
- Preserve development-only `allow-indexed` behavior.
- Build SQL placeholders from the values array; do not concatenate user input into SQL.
- Treat blank or missing production answer `chatId` as no group-visible scope.

---

### Task 1: Specify Current-Group Retrieval Scope

**Files:**
- Add: `docs/superpowers/specs/2026-07-10-iris-current-group-document-retrieval-scope-design.md`
- Add: `docs/superpowers/plans/2026-07-10-iris-current-group-document-retrieval-scope.md`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

- [x] **Step 1: Document the cross-group leak and defense-in-depth decision**
- [x] **Step 2: Record exact current-group evidence as an answer-time invariant**
- [x] **Step 3: Preserve company-level wiki and user-submitted source behavior**

### Task 2: Drive the Change with Failing Tests

**Files:**
- Modify: `apps/core/tests/answer-draft-runtime.test.ts`
- Modify: `apps/core/tests/document-retrieval-context.test.ts`
- Modify: `apps/core/tests/document-fragment-repository.test.ts`

- [ ] **Step 1: Add runtime tests for exact same-group evidence and cross-group denial**
- [ ] **Step 2: Add a source-policy test that excludes group-visible source types without `chatId`**
- [ ] **Step 3: Add a context-builder test that forwards the current group to fragment search**
- [ ] **Step 4: Add repository SQL tests for origin/evidence filtering and dynamic parameters**
- [ ] **Step 5: Extend Postgres integration coverage for matching and nonmatching groups**
- [ ] **Step 6: Run focused tests and verify RED for the missing scope behavior**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-runtime.test.ts tests/document-retrieval-context.test.ts tests/document-fragment-repository.test.ts --reporter=dot
```

### Task 3: Implement SQL and Policy Defense in Depth

**Files:**
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`
- Modify: `apps/core/src/memory/document-retrieval-context.ts`
- Modify: `apps/core/src/documents/document-fragment-repository.ts`

- [ ] **Step 1: Normalize and pass current-group scope per source-policy answer request**
- [ ] **Step 2: Exclude group-visible source types when source-policy lacks group scope**
- [ ] **Step 3: Require exact same-group source evidence in the TypeScript policy guard**
- [ ] **Step 4: Add optional repository `groupId` filtering before vector ranking**
- [ ] **Step 5: Preserve `allow-indexed`, wiki, and user-submitted behavior**
- [ ] **Step 6: Run focused tests and verify GREEN**

### Task 4: Verify, Review, and Publish

- [ ] **Step 1: Run full verification**

```powershell
npm run verify
```

- [ ] **Step 2: Review the diff against the whitepaper and security invariants**
- [ ] **Step 3: Address review findings and rerun affected tests**
- [ ] **Step 4: Commit and push the branch**
- [ ] **Step 5: Watch PR #3 checks and confirm a clean merge state**
