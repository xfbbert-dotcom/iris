# Iris Document Sync Runtime API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start and observe `DocumentSyncRuntime` from the core Fastify app.

**Architecture:** Follow the existing event and reindex runtime patterns in `app.ts`: add a dependency factory, start the runtime during app construction, expose an internal status route, and close the runtime in `onClose`.

**Tech Stack:** TypeScript, Fastify inject tests, Vitest.

---

## File Structure

- Modify `apps/core/src/app.ts`: import and wire `DocumentSyncRuntime`; add `GET /internal/document-sync/status`; close runtime.
- Modify `apps/core/tests/answer-draft-api.test.ts`: add lifecycle and status tests plus a fake runtime helper.

---

### Task 1: App Lifecycle And Status API

**Files:**
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests that:

- injected document sync runtime is started and closed;
- disabled status is returned when runtime is unavailable;
- enabled runtime status is serialized;
- status failure returns `500 document_sync_status_failed`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- answer-draft-api.test.ts`

Expected: FAIL because app does not accept/create document sync runtime or expose the status route.

- [ ] **Step 3: Implement app wiring**

Add `createDocumentSyncRuntime` dependency, call `start()`, add status route, and close it in `onClose`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- answer-draft-api.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/app.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: expose document sync runtime status"
```

---

### Task 2: Verification And PR Update

- [ ] **Step 1: Run full verification**

```bash
npm run typecheck
npm test
python -m pytest
docker compose config
```

Run Python from `workers/ai`.

- [ ] **Step 2: Push branch**

```bash
git push origin codex/iris-document-source-registry
```

- [ ] **Step 3: Update PR body**

Add:

```markdown
- Add Phase 3D document sync runtime API: app startup/shutdown wiring and internal document sync status endpoint.
```

---

## Self-Review

- Spec coverage: lifecycle wiring, status route, error behavior, verification, and PR update are covered.
- Placeholder scan: no placeholders remain.
- Type consistency: route and runtime names match existing app patterns.
