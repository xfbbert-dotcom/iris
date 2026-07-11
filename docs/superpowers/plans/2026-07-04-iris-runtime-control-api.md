# Iris Runtime Control API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose in-memory backend controls for turning Iris on/off globally and per Feishu group, and enforce those controls at Feishu ingestion.

**Architecture:** Keep `RuntimeController` as the authority for v1 runtime control. Inject one shared controller into app routes and Feishu Gateway so admin mutations affect callback ingestion immediately.

**Tech Stack:** TypeScript, Fastify, Vitest, existing in-memory runtime config.

---

### Task 1: Add Runtime Controller Tests

**Files:**
- Modify: `apps/core/tests/runtime-controller.test.ts`

- [x] **Step 1: Write failing tests**

Add tests for:

- `getSnapshot()` returning global state, sorted disabled group IDs, and cloned capabilities
- `canProcessIncomingEvent()` honoring global and per-group disable gates

- [x] **Step 2: Run focused tests to verify failure**

Run:

```bash
npm --workspace apps/core test -- tests/runtime-controller.test.ts
```

Expected: new tests fail because the methods do not exist yet.

### Task 2: Add Feishu Gateway Gate Tests

**Files:**
- Modify: `apps/core/tests/feishu-gateway.test.ts`

- [x] **Step 1: Write failing test**

Add a gateway test that injects a runtime gate returning `false`, posts a group
message callback, expects HTTP 200, and expects no queue enqueue.

- [x] **Step 2: Run focused gateway test to verify failure**

Run:

```bash
npm --workspace apps/core test -- tests/feishu-gateway.test.ts
```

Expected: the new test fails because gateway does not consult the runtime gate.

### Task 3: Add Runtime Control API Tests

**Files:**
- Create: `apps/core/tests/runtime-control-api.test.ts`

- [x] **Step 1: Write failing API tests**

Add tests for:

- status endpoint
- global disable/enable gating Feishu events
- per-group disable/enable gating Feishu events
- invalid request bodies returning 400

- [x] **Step 2: Run focused API test to verify failure**

Run:

```bash
npm --workspace apps/core test -- tests/runtime-control-api.test.ts
```

Expected: tests fail because the routes do not exist.

### Task 4: Implement Runtime Control

**Files:**
- Modify: `apps/core/src/admin/runtime-controller.ts`
- Modify: `apps/core/src/feishu/feishu-gateway.ts`
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Add controller snapshot and event gate methods**

Add `getSnapshot()` and `canProcessIncomingEvent({ groupId? })`.

- [x] **Step 2: Wire gateway runtime gate**

Resolve Feishu `chat_id` from callback bodies and skip enqueueing when the gate rejects.

- [x] **Step 3: Add Fastify runtime-control routes**

Expose status, global enable/disable, and group enable/disable routes.

- [x] **Step 4: Run focused tests to verify pass**

Run the three focused test commands and expect them to pass.

### Task 5: Verify and Publish

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
git add apps/core/src/admin/runtime-controller.ts apps/core/src/feishu/feishu-gateway.ts apps/core/src/app.ts apps/core/tests/runtime-controller.test.ts apps/core/tests/feishu-gateway.test.ts apps/core/tests/runtime-control-api.test.ts docs/superpowers/specs/2026-07-04-iris-runtime-control-api-design.md docs/superpowers/plans/2026-07-04-iris-runtime-control-api.md
git commit -m "feat: add runtime control api"
git push --force-with-lease origin codex/iris-document-source-registry
```
