# Iris Feishu Raw Content Length Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject Feishu raw-content responses before JSON parsing when `content-length` proves the
payload is already oversized.

**Architecture:** Add an optional response-size preflight to `fetchJsonWithTimeout` and enable it
only for raw-content requests with a `maxContentChars + 4096` byte budget.

**Tech Stack:** TypeScript, Vitest, existing Feishu document body fetcher tests.

---

### Task 1: Write Failing Test

**Files:**
- Modify: `apps/core/tests/feishu-document-body-fetcher.test.ts`

- [x] **Step 1: Add content-length preflight test**

Return a raw-content response with `content-length` above the configured budget and a `json()` body
that would throw if read. Assert Iris rejects with the preflight size error.

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- tests/feishu-document-body-fetcher.test.ts
```

Expected: the new test fails because the current fetcher reads JSON before checking response size.

Observed: the focused test failed with `Feishu document raw content response was not valid JSON`.

### Task 2: Implement Content-Length Preflight

**Files:**
- Modify: `apps/core/src/documents/feishu-document-body-fetcher.ts`

- [x] **Step 1: Add optional response-size guard**

Read `content-length` when present, ignore malformed values, and reject safe or unsafe oversized
decimal values before `response.json()`.

- [x] **Step 2: Enable guard for raw-content requests**

Use `maxContentChars + 4096` as the raw-content JSON response byte budget.

- [x] **Step 3: Run focused test and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/feishu-document-body-fetcher.test.ts
```

Expected: focused Feishu document body fetcher tests pass.

Observed: focused Feishu document body fetcher tests passed with `21` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-feishu-raw-content-length-preflight-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-feishu-raw-content-length-preflight.md`
- Modify: `docs/superpowers/specs/2026-07-04-iris-feishu-document-content-size-bound-design.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `789` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the Feishu raw-content length preflight patch, push
`codex/iris-document-source-registry`, update PR #3, and confirm GitHub Actions Core and AI Worker
checks pass.
