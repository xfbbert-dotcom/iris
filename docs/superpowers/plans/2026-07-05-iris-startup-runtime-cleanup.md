# Iris Startup Runtime Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure failed runtime startup does not leave previously created Iris runtimes open.

**Architecture:** Keep `buildApp` synchronous, but wrap runtime startup in a narrow try/catch that
starts already-created runtimes in order and schedules best-effort cleanup when any `start()` throws.
Reuse existing close ordering and keep the normal Fastify `onClose` path unchanged.

**Tech Stack:** TypeScript, Fastify injection tests, Vitest.

---

### Task 1: Write Failing Startup Cleanup Test

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Add startup failure regression test**

Add a test in `describe("answer draft runtime wiring")` where the event worker runtime throws from
`start()` after the reindex runtime has already started and the answer draft runtime has been
created.

Expected assertions:

```ts
expect(() =>
  buildApp({
    createAnswerDraftRuntime: () => answerDraftRuntime,
    createEventWorkerRuntime: () => eventWorkerRuntime,
    createReindexWorkerRuntime: () => reindexWorkerRuntime,
    createDocumentSyncRuntime: () => undefined,
  }),
).toThrow("event worker start failed");
await flushDeferredEnqueue();
expect(eventWorkerRuntime.close).toHaveBeenCalledOnce();
expect(reindexWorkerRuntime.close).toHaveBeenCalledOnce();
expect(answerDraftRuntime.close).toHaveBeenCalledOnce();
```

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts -t "cleans up runtimes when startup fails"
```

Expected: the test fails because the existing startup path throws before cleanup runs.

Observed: the focused test failed because `eventWorkerRuntime.close` was not called after event
worker startup failed.

### Task 2: Implement Best-Effort Startup Cleanup

**Files:**
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Track runtime startup through one helper**

Create a local helper that accepts created runtime references, invokes `start()` in current order,
and catches startup errors.

- [x] **Step 2: Schedule cleanup on startup failure**

When startup fails, call the existing app close helper in fire-and-forget mode for all created
runtimes in normal close order. Swallow cleanup rejection so the original startup error stays visible.

- [x] **Step 3: Keep normal close path unchanged**

Keep the Fastify `onClose` hook closing document sync, event worker, reindex worker, and answer
draft runtimes in the same order.

- [x] **Step 4: Run focused test and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts -t "cleans up runtimes when startup fails"
```

Expected: the startup cleanup regression test passes.

Observed: the focused startup cleanup regression test passed.

### Task 3: Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-05-iris-startup-runtime-cleanup-design.md`
- Create: `docs/superpowers/plans/2026-07-05-iris-startup-runtime-cleanup.md`

- [x] **Step 1: Run focused runtime/API tests**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts
```

Expected: answer draft API tests pass.

Observed: `answer-draft-api.test.ts` passed with 154 tests.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: all repository verification passes.

Observed: `npm run verify` passed with Core 1006 passed / 4 skipped, Python worker 7 passed, and
Docker Compose config validation succeeded.

- [ ] **Step 3: Commit, push, update PR, and verify checks**

Commit the startup cleanup fix, push `codex/iris-document-source-registry`, update PR #3, and
confirm GitHub Actions Core and AI Worker checks pass.
