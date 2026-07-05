# Iris Feishu Registration Token Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject comma-contaminated Feishu document tokens from manual/internal registration paths.

**Architecture:** Keep URI validation centralized in the shared Feishu document token parser used by
registration, permission checks, and document body fetching.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Failing Registration Test

**Files:**
- Modify: `apps/core/tests/document-sync-runtime.test.ts`

- [x] **Step 1: Add failing user-submitted registration coverage**

Assert that `https://docs.feishu.cn/docx/user_doc_token_1,please` is rejected with
`unsupported Feishu document source URI` and does not call the source registry again.

- [x] **Step 2: Verify RED**

Run the focused runtime test and confirm the promise resolves before the fix.

### Task 2: Shared Parser Guard

**Files:**
- Modify: `apps/core/src/documents/feishu-document-body-fetcher.ts`
- Modify: `apps/core/tests/feishu-document-body-fetcher.test.ts`

- [x] **Step 1: Add parser coverage**

Assert comma-contaminated docx and wiki token segments parse as unsupported.

- [x] **Step 2: Reject ASCII commas in Feishu document tokens**

Return `undefined` from the shared token normalizer when the token contains an ASCII comma.

- [x] **Step 3: Verify GREEN**

Run runtime, document body fetcher, and group link extractor tests.

### Task 3: Documentation And Full Verification

- [x] Update the architecture whitepaper, registry design note, and internal rollout runbook.
- [x] Run `npm run verify`.
