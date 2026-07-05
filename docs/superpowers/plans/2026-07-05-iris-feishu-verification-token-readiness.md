# Iris Feishu Verification Token Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent v1 rollout readiness from passing when Feishu callback setup only has
`FEISHU_ENCRYPT_KEY`.

**Architecture:** Keep the existing Feishu request verifier behavior. Tighten the readiness contract
so internal rollout setup requires a readable verification token for URL verification.

**Tech Stack:** TypeScript, Vitest, Markdown docs.

---

### Task 1: Add Failing Readiness Test

**Files:**
- Modify: `apps/core/tests/internal-rollout-readiness.test.ts`

- [x] **Step 1: Cover encrypt-key-only readiness**

Add a readiness test where `FEISHU_VERIFICATION_TOKEN` is blank and `FEISHU_ENCRYPT_KEY` is set.

Observed: focused readiness tests failed because the report incorrectly returned `ok: true`.

### Task 2: Tighten Readiness Logic

**Files:**
- Modify: `apps/core/src/admin/internal-rollout-readiness.ts`

- [x] **Step 1: Require verification token**

Fail `feishuWebhookAuth` when `FEISHU_VERIFICATION_TOKEN` is absent. Keep `FEISHU_ENCRYPT_KEY`
listed as an optional related environment variable.

Observed: focused readiness tests passed with `6` tests.

### Task 3: Document V1 Callback Boundary

**Files:**
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
- Modify: `docs/operations/internal-rollout-runbook.md`
- Create: `docs/superpowers/specs/2026-07-05-iris-feishu-verification-token-readiness-design.md`
- Create: `docs/superpowers/plans/2026-07-05-iris-feishu-verification-token-readiness.md`

- [x] **Step 1: Explain token vs encrypt key**

Document that v1 requires `FEISHU_VERIFICATION_TOKEN` for URL verification and treats
`FEISHU_ENCRYPT_KEY` as optional signature verification, not encrypted payload support.
