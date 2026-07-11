# Iris Audit Event Timestamps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-recorded timestamps to in-memory audit events.

**Architecture:** Keep `AuditLog.record()` accepting plain `AuditEvent`. Store `RecordedAuditEvent` internally by adding `recordedAt` inside `InMemoryAuditLog`.

**Tech Stack:** TypeScript, Vitest.

---

## File Structure

- `apps/core/src/audit/audit-log.ts`: add `RecordedAuditEvent`, `now` option, and `recordedAt` assignment.
- `apps/core/tests/audit-log.test.ts`: add deterministic timestamp assertions.
- `apps/core/tests/answer-draft-api.test.ts`: assert audit API includes ISO `recordedAt`.
- `docs/superpowers/specs/2026-07-03-iris-audit-event-timestamps-design.md`: design record.

## Tasks

### Task 1: Audit Event Timestamps

- [x] **Step 1: Write failing tests**

Update audit log tests to construct `new InMemoryAuditLog({ now: () => fixedDate })` and assert stored events include `recordedAt: fixedDate`.

Update `GET /internal/audit/events` API test to expect `recordedAt: "2026-07-03T06:00:00.000Z"` style strings.

- [x] **Step 2: Verify red**

Run:

```powershell
npm --workspace apps/core test -- tests/audit-log.test.ts tests/answer-draft-api.test.ts
```

Expected: fail because `recordedAt` is not stored/returned yet.

- [x] **Step 3: Implement timestamps**

In `apps/core/src/audit/audit-log.ts`:

- export `RecordedAuditEvent = AuditEvent & { recordedAt: Date }`;
- change `events` to `RecordedAuditEvent[]`;
- add `now?: () => Date` to options;
- when recording, push `{ ...event, fragmentIds: [...event.fragmentIds], recordedAt: new Date(this.now()) }`.

- [x] **Step 4: Verify green**

Run:

```powershell
npm --workspace apps/core test -- tests/audit-log.test.ts tests/answer-draft-api.test.ts
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
git add docs/superpowers/specs/2026-07-03-iris-audit-event-timestamps-design.md docs/superpowers/plans/2026-07-03-iris-audit-event-timestamps.md apps/core/src/audit/audit-log.ts apps/core/tests/audit-log.test.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: timestamp in-memory audit events"
git push
```

- [x] **Step 3: Update PR**

Add Phase 4A to PR #3:

```markdown
- Add Phase 4A audit event timestamps: server-recorded timestamps for in-memory audit diagnostics.
```

## Self-Review

- Spec coverage: in-memory timestamping, API serialization, tests, and verification are covered.
- Placeholder scan: no TBD/TODO placeholders.
- Scope: timestamps only; no filtering or persistence.
