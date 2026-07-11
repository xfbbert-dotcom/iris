# Iris Feishu Message ID Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion.

**Goal:** Use Feishu `message_id` as the secondary raw-event idempotency source when `event_id` is missing or unusable.

**Architecture:** Keep event IDs first, message IDs second, canonical body hash last. The gateway stays ack-first and does not add heavy parsing or worker decisions.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Add Regression Coverage

**Files:**
- Modify: `apps/core/tests/feishu-gateway.test.ts`

- [x] **Step 1: Add retry metadata test**

Send two callbacks with the same `message_id`, missing event IDs, and different retry wrapper metadata.

- [x] **Step 2: Confirm red**

Run: `npm --workspace apps/core test -- tests/feishu-gateway.test.ts`

Expected: fails because both callbacks are queued.

### Task 2: Add Message ID Fallback

**Files:**
- Modify: `apps/core/src/feishu/feishu-gateway.ts`
- Modify: `apps/core/tests/feishu-gateway.test.ts`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

- [x] **Step 1: Resolve message IDs before body hash fallback**

Use `message:<message_id>` only when the event ID is missing, blank, or oversized.

- [x] **Step 2: Preserve canonical body hash fallback**

Keep body-hash behavior for callbacks without usable event IDs or message IDs.

- [x] **Step 3: Run full verification**

Run: `npm run verify`

Expected: all local verification commands pass.
