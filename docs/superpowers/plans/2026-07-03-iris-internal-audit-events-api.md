# Iris Internal Audit Events API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose recent in-memory audit events through an internal API for early operational debugging.

**Architecture:** Reuse `InMemoryAuditLog`. `buildApp()` owns one shared audit log, passes it to default answer draft runtime composition, and serves read-only cloned events at `GET /internal/audit/events`.

**Tech Stack:** TypeScript, Fastify, Vitest.

---

## File Structure

- `apps/core/src/app.ts`: create/inject shared audit log, pass it to answer draft runtime, add `GET /internal/audit/events`.
- `apps/core/tests/answer-draft-api.test.ts`: add endpoint and runtime wiring tests.
- `docs/superpowers/specs/2026-07-03-iris-internal-audit-events-api-design.md`: design record.

## Tasks

### Task 1: Internal Audit Events API

- [x] **Step 1: Write failing API tests**

In `apps/core/tests/answer-draft-api.test.ts`:

- import `InMemoryAuditLog`;
- add a test that injects an audit log with three events and calls `GET /internal/audit/events?limit=2`;
- expect newest two events first;
- add a test for invalid limit returning `400 invalid_request`;
- add a runtime wiring test that checks `createAnswerDraftRuntime` receives `{ dependencies: { auditLog } }` when no orchestrator is injected.

- [x] **Step 2: Verify red**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-api.test.ts
```

Expected: fail because the endpoint/dependency is not wired.

- [x] **Step 3: Implement app wiring**

In `apps/core/src/app.ts`:

- import `InMemoryAuditLog` and `type AuditLog`;
- add `auditLog?: InMemoryAuditLog` to `BuildAppDependencies`;
- create `const auditLog = dependencies.auditLog ?? new InMemoryAuditLog();`;
- when using default runtime, call `createAnswerDraftRuntime({ dependencies: { auditLog } })`;
- add `GET /internal/audit/events` that parses `limit` with `parseDeadLetterLimit`, returns newest events first, and clones `fragmentIds`.

- [x] **Step 4: Verify green**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-api.test.ts
```

Expected: pass.

### Task 2: Full Verification And PR Update

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run typecheck
npm test
python -m pytest
docker compose config
```

If root-level Python cannot import `iris_worker`, run `python -m pytest` from `workers/ai`.

- [x] **Step 2: Commit and push**

Run:

```powershell
git add docs/superpowers/specs/2026-07-03-iris-internal-audit-events-api-design.md docs/superpowers/plans/2026-07-03-iris-internal-audit-events-api.md apps/core/src/app.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: expose internal audit events"
git push
```

- [x] **Step 3: Update PR**

Add Phase 3X to PR #3:

```markdown
- Add Phase 3X internal audit events API: in-memory read endpoint and shared audit log wiring for early debugging.
```

## Self-Review

- Spec coverage: endpoint, limit behavior, runtime wiring, cloning, and PR update are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Scope: in-memory read-only API only.
