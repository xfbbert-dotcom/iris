# Iris Runtime Capability Control API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let administrators toggle individual Iris runtime capabilities through the backend.

**Architecture:** Keep capability state inside the existing in-memory `RuntimeController`. Add a strict parser at the Fastify route boundary so typos and non-boolean values cannot silently change nothing.

**Tech Stack:** TypeScript, Fastify, Vitest.

---

### Task 1: Add Controller Capability Test

**Files:**
- Modify: `apps/core/tests/runtime-controller.test.ts`

- [x] **Step 1: Write failing test**

Add a test for `setCapability()` disabling and re-enabling `proactiveSpeech`.

- [x] **Step 2: Run focused controller test to verify failure**

Run:

```bash
npm --workspace apps/core test -- tests/runtime-controller.test.ts
```

Expected: test fails because `setCapability()` does not exist.

### Task 2: Add API Capability Tests

**Files:**
- Modify: `apps/core/tests/runtime-control-api.test.ts`

- [x] **Step 1: Write failing API tests**

Add tests for:

- patching one or more capabilities
- rejecting unknown capability names
- rejecting non-boolean values

- [x] **Step 2: Run focused API test to verify failure**

Run:

```bash
npm --workspace apps/core test -- tests/runtime-control-api.test.ts
```

Expected: tests fail because the route does not exist.

### Task 3: Implement Capability Control

**Files:**
- Modify: `apps/core/src/admin/runtime-controller.ts`
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Add `setCapability()`**

Add a controller method accepting a known capability key and boolean value.

- [x] **Step 2: Add strict capability patch parser**

Only accept known capability names with boolean values and at least one field.

- [x] **Step 3: Add Fastify route**

Add `PATCH /internal/runtime-control/capabilities`.

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
git add apps/core/src/admin/runtime-controller.ts apps/core/src/app.ts apps/core/tests/runtime-controller.test.ts apps/core/tests/runtime-control-api.test.ts docs/superpowers/specs/2026-07-04-iris-runtime-capability-control-api-design.md docs/superpowers/plans/2026-07-04-iris-runtime-capability-control-api.md
git commit -m "feat: add runtime capability controls"
git push --force-with-lease origin codex/iris-document-source-registry
```
