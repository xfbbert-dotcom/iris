# Iris Audit Log Event Cloning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent caller-side mutation from changing stored in-memory audit events.

**Architecture:** Keep `InMemoryAuditLog` API unchanged. Clone the event and `fragmentIds` array inside `record()` before applying bounded retention.

**Tech Stack:** TypeScript, Vitest.

---

## File Structure

- `apps/core/src/audit/audit-log.ts`: clone events on record.
- `apps/core/tests/audit-log.test.ts`: add mutation isolation test.
- `docs/superpowers/specs/2026-07-03-iris-audit-log-event-cloning-design.md`: design record.

## Tasks

### Task 1: Clone Events On Record

- [x] **Step 1: Write failing mutation isolation test**

Add a test to `apps/core/tests/audit-log.test.ts`:

```ts
it("clones recorded events so caller mutation cannot change history", async () => {
  const auditLog = new InMemoryAuditLog();
  const event = {
    type: "permission_guard_error" as const,
    documentId: "source-1",
    fragmentIds: ["fragment-1"],
    message: "original",
  };

  await auditLog.record(event);
  event.documentId = "source-mutated";
  event.fragmentIds.push("fragment-mutated");
  event.message = "mutated";

  expect(auditLog.events).toEqual([
    {
      type: "permission_guard_error",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
      message: "original",
    },
  ]);
});
```

- [x] **Step 2: Verify red**

Run:

```powershell
npm --workspace apps/core test -- tests/audit-log.test.ts
```

Expected: fail because the stored event shares references with the caller object.

- [x] **Step 3: Implement cloning**

In `apps/core/src/audit/audit-log.ts`, change `this.events.push(event)` to push:

```ts
{
  ...event,
  fragmentIds: [...event.fragmentIds],
}
```

- [x] **Step 4: Verify green**

Run:

```powershell
npm --workspace apps/core test -- tests/audit-log.test.ts
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
git add docs/superpowers/specs/2026-07-03-iris-audit-log-event-cloning-design.md docs/superpowers/plans/2026-07-03-iris-audit-log-event-cloning.md apps/core/src/audit/audit-log.ts apps/core/tests/audit-log.test.ts
git commit -m "fix: clone in-memory audit events"
git push
```

- [x] **Step 3: Update PR**

Add Phase 3Z to PR #3:

```markdown
- Add Phase 3Z audit event cloning: isolate in-memory audit history from caller-side mutation.
```

## Self-Review

- Spec coverage: event cloning, fragment id cloning, retention compatibility, tests, and verification are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Scope: in-memory audit write isolation only.
