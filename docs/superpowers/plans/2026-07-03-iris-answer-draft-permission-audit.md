# Iris Answer Draft Permission Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire optional permission audit logging into the answer draft runtime.

**Architecture:** Reuse the existing `AuditLog` interface and existing permission guard audit behavior. Add an optional runtime dependency and pass it through to `createDocumentRetrievalContextBuilder()`.

**Tech Stack:** TypeScript, Vitest.

---

## File Structure

- `apps/core/src/runtime/answer-draft-runtime.ts`: add optional `auditLog` dependency and pass it to context builder.
- `apps/core/tests/answer-draft-runtime.test.ts`: prove source-policy denials/errors are audited.
- `docs/superpowers/specs/2026-07-03-iris-answer-draft-permission-audit-design.md`: design record.

## Tasks

### Task 1: Runtime Audit Wiring

- [x] **Step 1: Write failing runtime audit test**

In `apps/core/tests/answer-draft-runtime.test.ts`, import `InMemoryAuditLog`, inject it into `createAnswerDraftRuntime({ dependencies: { auditLog } })`, and assert source-policy permission events are recorded:

```ts
expect(auditLog.events).toEqual([
  {
    type: "permission_guard_denied",
    documentId: "source-disabled",
    fragmentIds: ["fragment-disabled"],
  },
  {
    type: "permission_guard_denied",
    documentId: "source-denied",
    fragmentIds: ["fragment-denied"],
  },
  {
    type: "permission_guard_denied",
    documentId: "source-stale",
    fragmentIds: ["fragment-stale"],
  },
  {
    type: "permission_guard_denied",
    documentId: "source-missing",
    fragmentIds: ["fragment-missing"],
  },
  {
    type: "permission_guard_denied",
    documentId: "source-error",
    fragmentIds: ["fragment-error"],
  },
]);
```

Historical note: this original expectation was superseded by `2026-07-05-iris-source-registry-lookup-error-audit`. Source-registry lookup errors now still fail closed, but they propagate through the permission guard as `permission_guard_error` so operators can distinguish infrastructure failures from ordinary denials.

- [x] **Step 2: Verify red**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-runtime.test.ts
```

Expected: fail because `auditLog` is not a supported runtime dependency or is not passed to the context builder.

- [x] **Step 3: Implement audit dependency**

In `apps/core/src/runtime/answer-draft-runtime.ts`:

- import `type AuditLog`;
- add `auditLog?: AuditLog` to `AnswerDraftRuntimeDependencies`;
- pass `auditLog: dependencies.auditLog` to `createDocumentRetrievalContextBuilder()`.

- [x] **Step 4: Verify green**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-runtime.test.ts
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
git add docs/superpowers/specs/2026-07-03-iris-answer-draft-permission-audit-design.md docs/superpowers/plans/2026-07-03-iris-answer-draft-permission-audit.md apps/core/src/runtime/answer-draft-runtime.ts apps/core/tests/answer-draft-runtime.test.ts
git commit -m "feat: audit answer draft permission denials"
git push
```

- [x] **Step 3: Update PR**

Add Phase 3W to PR #3:

```markdown
- Add Phase 3W answer draft permission audit: optional runtime audit log wiring for permission guard denials and errors.
```

## Self-Review

- Spec coverage: optional dependency, no response-shape change, tests, and PR update are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Scope: audit wiring only; no persistence or logging side effects.
