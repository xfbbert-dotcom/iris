# Iris Feishu Gateway Event Worker Queue Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure default Feishu callbacks enter the same raw event queue consumed by the event worker runtime.

**Architecture:** Expose the runtime-created raw queue from `EventWorkerRuntime` and pass it to `createFeishuGateway` from `buildApp()` when no explicit `rawEventQueue` dependency is provided.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Gateway Runtime Queue Wiring

**Files:**
- Modify: `apps/core/tests/feishu-gateway.test.ts`
- Modify: `apps/core/src/runtime/event-worker-runtime.ts`
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Write failing app route test**

Assert a default app route with an event worker runtime writes Feishu callbacks into the runtime raw event queue.

- [x] **Step 2: Run focused test to verify it fails**

Run: `npm --workspace apps/core test -- tests/feishu-gateway.test.ts --reporter=dot`

Expected: FAIL because the gateway does not receive `eventWorkerRuntime.rawEventQueue`.

- [x] **Step 3: Implement runtime queue exposure and app wiring**

Add optional `rawEventQueue` to `EventWorkerRuntime`, return the Redis raw queue from the enabled runtime, and pass `dependencies.rawEventQueue ?? eventWorkerRuntime?.rawEventQueue` to the gateway.

- [x] **Step 4: Run focused test and typecheck**

Run:

```bash
npm run typecheck
npm --workspace apps/core test -- tests/feishu-gateway.test.ts --reporter=dot
```

Expected: both pass.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-feishu-gateway-event-worker-queue-wiring.md`

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
git add apps/core/src/app.ts apps/core/src/runtime/event-worker-runtime.ts apps/core/tests/feishu-gateway.test.ts docs/superpowers/specs/2026-07-03-iris-feishu-gateway-event-worker-queue-wiring-design.md docs/superpowers/plans/2026-07-03-iris-feishu-gateway-event-worker-queue-wiring.md
git commit -m "fix: wire feishu gateway to event worker queue"
git push --force-with-lease origin codex/iris-document-source-registry
```
