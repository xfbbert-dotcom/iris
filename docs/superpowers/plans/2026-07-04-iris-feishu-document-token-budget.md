# Iris Feishu Document Token Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound Feishu document/wiki tokens before using them in downstream Feishu API calls.

**Architecture:** Apply a shared `512` character token budget to URL path token parsing and wiki
node response document tokens.

**Tech Stack:** TypeScript, Vitest, existing Feishu document body fetcher and permission checker
tests.

---

### Task 1: Write Failing Tests

**Files:**
- Modify: `apps/core/tests/feishu-document-body-fetcher.test.ts`
- Modify: `apps/core/tests/feishu-document-permission-checker.test.ts`

- [x] **Step 1: Add URL token parser tests**

Assert `parseFeishuDocxDocumentId` and `parseFeishuWikiNodeToken` return undefined for `513`
character path tokens.

- [x] **Step 2: Add body fetcher wiki response token test**

Assert an oversized wiki `obj_token` rejects before raw content is fetched.

- [x] **Step 3: Add permission checker wiki response token test**

Assert an oversized wiki `obj_token` is treated as unreadable and no metadata check is made.

- [x] **Step 4: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- feishu-document-body-fetcher.test.ts feishu-document-permission-checker.test.ts
```

Expected: the new tests fail because token parsing currently only checks for non-empty strings.

Observed: focused tests failed because oversized URL tokens were accepted, the body fetcher continued
to raw content, and the permission checker returned `true`.

### Task 2: Implement Token Budget

**Files:**
- Modify: `apps/core/src/documents/feishu-document-body-fetcher.ts`
- Modify: `apps/core/src/permissions/feishu-document-permission-checker.ts`

- [x] **Step 1: Add shared document token budget**

Export `MAX_FEISHU_DOCUMENT_TOKEN_CHARS = 512` from the document body fetcher module.

- [x] **Step 2: Normalize URL path and wiki response tokens**

Reject blank or oversized URL tokens and reject oversized body fetcher wiki `obj_token` values.

- [x] **Step 3: Align permission checker wiki response handling**

Use the shared `512` character budget when reading wiki response `obj_token` values for permission
checks.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- feishu-document-body-fetcher.test.ts feishu-document-permission-checker.test.ts
```

Expected: focused Feishu document body fetcher and permission checker tests pass.

Observed: focused tests passed with `31` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-feishu-document-token-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-feishu-document-token-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `813` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the Feishu document token budget patch, push `codex/iris-document-source-registry`, update
PR #3, and confirm GitHub Actions Core and AI Worker checks pass.
