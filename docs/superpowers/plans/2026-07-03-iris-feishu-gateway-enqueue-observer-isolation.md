# Iris Feishu Gateway Enqueue Observer Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Feishu Gateway enqueue error observer failures from escaping the ack-first callback path.

**Architecture:** Keep the existing fire-and-forget enqueue behavior. Add a tiny local reporting helper around `onEnqueueError` so observer failures are swallowed while the original enqueue error is still delivered to the hook.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: RED Test

**Files:**
- Modify: `apps/core/tests/feishu-gateway.test.ts`

- [x] **Step 1: Write the failing test**

Add a Gateway test where `rawEventQueue.enqueue` rejects and `onEnqueueError` throws. Assert the callback response remains HTTP 200 and the hook receives the original enqueue error.

- [x] **Step 2: Verify RED**

Run:

```powershell
npm --workspace apps/core test -- tests/feishu-gateway.test.ts
```

Expected: Vitest catches an unhandled rejection from the throwing observer.

### Task 2: Implementation

**Files:**
- Modify: `apps/core/src/feishu/feishu-gateway.ts`

- [x] **Step 1: Isolate enqueue error reporting**

Replace direct `onError?.(error)` calls with a helper that catches and ignores hook exceptions.

- [x] **Step 2: Verify GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/feishu-gateway.test.ts
```

Expected: all Feishu Gateway tests pass with no unhandled rejection.

### Task 3: Full Verification and Publish

**Files:**
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

- [x] **Step 1: Update whitepaper**

Add a Feishu Gateway observer isolation guardrail to the architecture pressure tests.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit successfully.

- [x] **Step 3: Commit, push, and update PR**

Run:

```powershell
git add apps/core/src/feishu/feishu-gateway.ts apps/core/tests/feishu-gateway.test.ts docs/superpowers
git commit -m "fix: isolate Feishu enqueue error observers"
git push --force-with-lease origin codex/iris-document-source-registry
```

Expected: PR #3 points to the new commit and its summary mentions Feishu enqueue error observer isolation.
