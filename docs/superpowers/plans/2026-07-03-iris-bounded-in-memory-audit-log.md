# Iris Bounded In-Memory Audit Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound in-memory audit retention so a long-running internal service does not accumulate unlimited audit events.

**Architecture:** Keep the existing `InMemoryAuditLog` API and add an optional constructor config. Truncate from the front after each record to retain newest events.

**Tech Stack:** TypeScript, Vitest.

---

## File Structure

- `apps/core/src/audit/audit-log.ts`: add bounded retention constructor and validation.
- `apps/core/tests/audit-log.test.ts`: create focused audit log unit tests.
- `docs/superpowers/specs/2026-07-03-iris-bounded-in-memory-audit-log-design.md`: design record.

## Tasks

### Task 1: Bounded Audit Log

- [x] **Step 1: Write failing audit log tests**

Create `apps/core/tests/audit-log.test.ts` with tests for:

- default construction accepts records;
- invalid max event values throw;
- capacity keeps only newest events.

- [x] **Step 2: Verify red**

Run:

```powershell
npm --workspace apps/core test -- tests/audit-log.test.ts
```

Expected: fail because constructor config is not supported.

- [x] **Step 3: Implement bounded retention**

In `apps/core/src/audit/audit-log.ts`:

- add `type InMemoryAuditLogOptions = { maxEvents?: number }`;
- add constructor defaulting to 1000;
- validate positive integer;
- after push, splice oldest overflow events.

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
git add docs/superpowers/specs/2026-07-03-iris-bounded-in-memory-audit-log-design.md docs/superpowers/plans/2026-07-03-iris-bounded-in-memory-audit-log.md apps/core/src/audit/audit-log.ts apps/core/tests/audit-log.test.ts
git commit -m "feat: bound in-memory audit log"
git push
```

- [x] **Step 3: Update PR**

Add Phase 3Y to PR #3:

```markdown
- Add Phase 3Y bounded in-memory audit log: retain newest audit events only to avoid unbounded memory growth.
```

## Self-Review

- Spec coverage: default, override, validation, overflow behavior, and verification are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Scope: in-memory audit retention only.
