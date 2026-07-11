# Iris Runtime Config Safe Integers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject unsafe integer environment settings before they can distort runtime behavior.

**Architecture:** Extend the existing positive integer readers to require `Number.isSafeInteger(parsed)` after the existing integer and positivity checks. Preserve existing errors for zero, negative, and non-integer values.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: RED Tests

**Files:**
- Modify: `apps/core/tests/env.test.ts`

- [x] **Step 1: Add unsafe integer tests**

Add tests showing `IRIS_MODEL_TIMEOUT_MS=9007199254740992` and `IRIS_EMBEDDING_DIMENSIONS=9007199254740992` are rejected.

- [x] **Step 2: Verify RED**

Run:

```powershell
npm --workspace apps/core test -- tests/env.test.ts
```

Expected: both new tests fail because the current readers accept unsafe integers.

### Task 2: Implementation

**Files:**
- Modify: `apps/core/src/config/env.ts`

- [x] **Step 1: Reject unsafe integers**

Add `Number.isSafeInteger(parsed)` checks to both positive integer readers.

- [x] **Step 2: Verify GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/env.test.ts
```

Expected: all environment config tests pass.

### Task 3: Full Verification and Publish

**Files:**
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

- [x] **Step 1: Update whitepaper**

Add a runtime configuration numeric safety guardrail.

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
git add apps/core/src/config/env.ts apps/core/tests/env.test.ts docs/superpowers
git commit -m "fix: reject unsafe integer runtime config"
git push --force-with-lease origin codex/iris-document-source-registry
```

Expected: PR #3 points to the new commit and its summary mentions safe integer config validation.
