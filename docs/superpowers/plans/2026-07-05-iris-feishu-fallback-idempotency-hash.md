# Iris Feishu Fallback Idempotency Hash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion.

**Goal:** Make body-hash fallback idempotency independent of JSON object key order.

**Architecture:** Keep Feishu platform IDs as the primary idempotency source. Only the fallback body hash canonicalizes JSON before SHA-256 hashing.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Add Regression Coverage

**Files:**
- Modify: `apps/core/tests/feishu-gateway.test.ts`

- [x] **Step 1: Add key-order dedupe test**

Send two no-event-id callback bodies with identical semantic content and different key order.

- [x] **Step 2: Confirm red**

Run: `npm --workspace apps/core run test -- tests/feishu-gateway.test.ts -t "key order"`

Expected: fails because both callbacks are queued.

### Task 2: Canonicalize Fallback Hash Input

**Files:**
- Modify: `apps/core/src/feishu/feishu-gateway.ts`

- [x] **Step 1: Sort object keys recursively before hashing**

Canonicalize object keys while preserving array order and primitive JSON values.

- [x] **Step 2: Confirm focused green**

Run: `npm --workspace apps/core run test -- tests/feishu-gateway.test.ts -t "key order"`

Expected: the duplicate body is deduplicated.

- [x] **Step 3: Run full verification**

Run: `npm run verify`

Expected: all local verification commands pass.
