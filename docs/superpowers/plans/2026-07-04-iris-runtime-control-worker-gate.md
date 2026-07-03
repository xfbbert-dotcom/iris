# Iris Runtime Control Worker Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent queued Feishu group messages from being processed after Iris is disabled for that group or globally.

**Architecture:** Thread the existing runtime-control gate into the event worker runtime and Feishu message processor. Keep skipped disabled messages as successfully consumed no-ops so they do not retry forever.

**Tech Stack:** TypeScript, Vitest, existing Core App runtime wiring.

---

### Task 1: Add Processor Gate Test

**Files:**
- Modify: `apps/core/tests/feishu-message-event-processor.test.ts`

- [x] **Step 1: Write failing test**

Add a test where `runtimeController.canProcessIncomingEvent({ groupId: "chat-1" })`
returns false and assert that message upsert and document-link registration are not called.

- [x] **Step 2: Run focused test to verify failure**

Run:

```bash
npm --workspace apps/core test -- tests/feishu-message-event-processor.test.ts
```

Expected: the new test fails because the processor does not consult runtime control.

### Task 2: Add Runtime Wiring Test

**Files:**
- Modify: `apps/core/tests/event-worker-runtime.test.ts`

- [x] **Step 1: Write failing test**

Assert that `createEventWorkerRuntime({ runtimeController })` passes the same gate
to `createProcessor()`.

- [x] **Step 2: Run focused test to verify failure**

Run:

```bash
npm --workspace apps/core test -- tests/event-worker-runtime.test.ts
```

Expected: the test fails because runtime controller is not accepted or forwarded.

### Task 3: Implement Worker Gate

**Files:**
- Modify: `apps/core/src/conversation/feishu-message-event-processor.ts`
- Modify: `apps/core/src/runtime/event-worker-runtime.ts`
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Add optional runtime gate to processor**

After parsing the message, skip processing when the runtime gate rejects the chat ID.

- [x] **Step 2: Forward gate through event worker runtime**

Accept `runtimeController` in `createEventWorkerRuntime()` and include it in the processor dependencies.

- [x] **Step 3: Pass app controller to default event worker runtime**

Update `buildApp()` so the default event worker runtime receives the shared controller.

- [x] **Step 4: Run focused tests to verify pass**

Run the two focused commands and expect both suites to pass.

### Task 4: Verify and Publish

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
python -m pytest
docker compose config
npm test
```

- [x] **Step 2: Commit and push**

Commit with:

```bash
git add apps/core/src/conversation/feishu-message-event-processor.ts apps/core/src/runtime/event-worker-runtime.ts apps/core/src/app.ts apps/core/tests/feishu-message-event-processor.test.ts apps/core/tests/event-worker-runtime.test.ts docs/superpowers/specs/2026-07-04-iris-runtime-control-worker-gate-design.md docs/superpowers/plans/2026-07-04-iris-runtime-control-worker-gate.md
git commit -m "fix: gate queued events by runtime control"
git push --force-with-lease origin codex/iris-document-source-registry
```
