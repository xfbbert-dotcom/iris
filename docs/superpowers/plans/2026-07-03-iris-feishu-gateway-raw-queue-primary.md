# Iris Feishu Gateway Raw Queue Primary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent default Feishu callback handling from double-writing to the unused legacy in-memory queue when the raw event queue is available.

**Architecture:** In `createFeishuGateway`, use `rawEventQueue` as the primary enqueue path and only fall back to `EventQueue` when no raw queue exists.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Raw Queue Primary Gateway Behavior

**Files:**
- Modify: `apps/core/tests/feishu-gateway.test.ts`
- Modify: `apps/core/src/feishu/feishu-gateway.ts`

- [x] **Step 1: Write failing gateway test**

Assert the legacy queue remains empty when a raw event queue is provided.

- [x] **Step 2: Run focused test to verify it fails**

Run: `npm --workspace apps/core test -- tests/feishu-gateway.test.ts --reporter=dot`

Expected: FAIL because the gateway currently double-writes.

- [x] **Step 3: Implement raw queue primary behavior**

Use an `if/else`: enqueue to `rawEventQueue` when present, otherwise enqueue to the legacy queue.

- [x] **Step 4: Run focused test and typecheck**

Run:

```bash
npm --workspace apps/core test -- tests/feishu-gateway.test.ts --reporter=dot
npm run typecheck
```

Expected: both pass.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-feishu-gateway-raw-queue-primary.md`

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit 0.

- [x] **Step 2: Commit and push**

Run:

```bash
git add apps/core/src/feishu/feishu-gateway.ts apps/core/tests/feishu-gateway.test.ts docs/superpowers/specs/2026-07-03-iris-feishu-gateway-raw-queue-primary-design.md docs/superpowers/plans/2026-07-03-iris-feishu-gateway-raw-queue-primary.md
git commit -m "fix: prefer raw event queue in feishu gateway"
git push --force-with-lease origin codex/iris-document-source-registry
```
