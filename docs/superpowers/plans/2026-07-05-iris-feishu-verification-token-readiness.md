# Iris Feishu Verification Token Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent v1 rollout readiness from passing when Feishu callback setup only has
`FEISHU_ENCRYPT_KEY`.

**Architecture:** Tighten the readiness contract so internal rollout setup requires a readable
verification token for URL verification. Tighten the runtime verifier so an optional encrypt key is
an additional signature guard, not an alternative path that bypasses token validation.

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

### Task 4: Require Combined Runtime Verification

**Files:**
- Modify: `apps/core/tests/feishu-auth.test.ts`
- Modify: `apps/core/src/feishu/feishu-auth.ts`
- Modify: `docs/superpowers/specs/2026-07-05-iris-feishu-verification-token-readiness-design.md`

- [x] **Step 1: Cover token-only, signature-only, and combined verifier modes**

Add Feishu auth tests showing that token-only and signature-only deployments still work, while a
deployment with both `FEISHU_VERIFICATION_TOKEN` and `FEISHU_ENCRYPT_KEY` requires both checks.

Observed: focused `feishu-auth` tests failed because token-only callbacks were accepted even when an
encrypt key was configured.

- [x] **Step 2: Require both checks when both secrets are configured**

Update `createFeishuRequestVerifier()` so each configured secret becomes a required check.

Observed: focused `feishu-auth` tests passed with `8` tests.
