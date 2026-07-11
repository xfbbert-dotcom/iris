# Iris JSON Body Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion.

**Goal:** Reject oversized JSON request bodies before custom parsing or Feishu gateway handling.

**Architecture:** Use Fastify's `bodyLimit` as the first application-layer guard. Keep route-specific schema validation unchanged.

**Tech Stack:** TypeScript, Fastify, Vitest.

---

### Task 1: Add Regression Coverage

**Files:**
- Modify: `apps/core/tests/feishu-gateway.test.ts`

- [x] **Step 1: Add oversized Feishu callback test**

Post a valid JSON callback above the v1 global body budget and assert HTTP `413`, no verifier call,
and no queue writes.

- [x] **Step 2: Confirm red**

Run: `npm --workspace apps/core run test -- tests/feishu-gateway.test.ts -t "oversized"`

Expected: fails before implementation because the callback currently returns `200`.

### Task 2: Apply Global JSON Body Limit

**Files:**
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Configure Fastify body limit**

Set the Core App `bodyLimit` to `256 KiB`.

- [x] **Step 2: Confirm focused green**

Run: `npm --workspace apps/core run test -- tests/feishu-gateway.test.ts -t "oversized"`

Expected: oversized JSON returns HTTP `413` before verifier or queue work.

- [x] **Step 3: Run full verification**

Run: `npm run verify`

Expected: all local verification commands pass.
