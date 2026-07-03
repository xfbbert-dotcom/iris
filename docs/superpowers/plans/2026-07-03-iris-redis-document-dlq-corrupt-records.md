# Iris Redis Document DLQ Corrupt Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep document sync and reindex DLQ management usable even when Redis DLQ records are themselves corrupted.

**Architecture:** Add tolerant parsing at the Redis DLQ management boundary. Corrupt records become non-replayable diagnostics; valid records still parse, replay, and delete exactly as before.

**Tech Stack:** TypeScript, Vitest, Redis queue adapters, Fastify internal APIs via existing runtime facades.

---

## File Map

- Modify: `apps/core/tests/redis-document-sync-queue.test.ts`
  - Adds RED coverage for corrupt sync DLQ listing and deleting malformed objects with stored ids.
- Modify: `apps/core/tests/redis-document-reindex-queue.test.ts`
  - Adds matching RED coverage for reindex DLQ listing and deletion.
- Modify: `apps/core/src/documents/redis-document-sync-queue.ts`
  - Converts corrupt DLQ payloads into non-replayable diagnostics.
- Modify: `apps/core/src/reindex/redis-document-reindex-queue.ts`
  - Mirrors tolerant parsing for reindex DLQ records.
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
  - Adds the pressure-test rule for operator recovery surfaces.

### Task 1: RED Tests For Corrupt Sync DLQ Records

**Files:**
- Modify: `apps/core/tests/redis-document-sync-queue.test.ts`

- [x] **Step 1: Write failing list coverage**

Add a test where `lRange` returns a corrupt payload followed by a valid failed-job payload. Assert `listDeadLetters({ limit: 2 })` resolves with a non-replayable diagnostic first and the valid job second.

- [x] **Step 2: Write failing delete coverage**

Add a test where `lRange` returns a malformed JSON object with a stored `id`. Assert `deleteDeadLetter("dlq-malformed")` removes the exact Redis payload.

- [x] **Step 3: Verify RED**

Run:

```powershell
npm --workspace apps/core test -- tests/redis-document-sync-queue.test.ts
```

Expected before implementation: FAIL because `parseDeadLetterPayload` throws `Invalid document sync dead letter JSON` or `Invalid document sync dead letter payload`.

### Task 2: RED Tests For Corrupt Reindex DLQ Records

**Files:**
- Modify: `apps/core/tests/redis-document-reindex-queue.test.ts`

- [x] **Step 1: Write failing list coverage**

Add the same corrupt-then-valid listing scenario for reindex DLQ records.

- [x] **Step 2: Write failing delete coverage**

Add the same stored-id malformed object deletion scenario for reindex DLQ records.

- [x] **Step 3: Verify RED**

Run:

```powershell
npm --workspace apps/core test -- tests/redis-document-reindex-queue.test.ts
```

Expected before implementation: FAIL because `parseDeadLetterPayload` throws `Invalid document reindex dead letter JSON` or `Invalid document reindex dead letter payload`.

### Task 3: Implement Tolerant DLQ Parsing

**Files:**
- Modify: `apps/core/src/documents/redis-document-sync-queue.ts`
- Modify: `apps/core/src/reindex/redis-document-reindex-queue.ts`

- [x] **Step 1: Pass queue clock into DLQ parsers**

Pass `now` from `listDeadLetters`, `replayDeadLetter`, and `deleteDeadLetter` into `parseDeadLetterPayload` and `findDeadLetterByStoredId`.

- [x] **Step 2: Convert corrupt payloads into diagnostics**

On JSON parse failure, non-object payloads, missing required fields, missing/non-string `rawPayload`, or invalid embedded `job`, return a non-replayable diagnostic with `rawPayload` set to the exact Redis item.

- [x] **Step 3: Preserve delete-by-id for malformed objects**

When a malformed object has a stored `id`, include it as `storedId` in the parsed diagnostic so `deleteDeadLetter(id)` can remove it.

- [x] **Step 4: Verify GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/redis-document-sync-queue.test.ts
npm --workspace apps/core test -- tests/redis-document-reindex-queue.test.ts
```

Expected after implementation: both focused suites pass.

### Task 4: Full Verification And Commit

**Files:**
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
- Create: `docs/superpowers/specs/2026-07-03-iris-redis-document-dlq-corrupt-records-design.md`
- Create: `docs/superpowers/plans/2026-07-03-iris-redis-document-dlq-corrupt-records.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit 0. If GitHub checks are not configured, `gh pr checks` may report "no checks reported" and should be treated as no remote checks, not a failing check.

- [x] **Step 2: Commit and push**

Run:

```powershell
git add apps/core/src/documents/redis-document-sync-queue.ts apps/core/src/reindex/redis-document-reindex-queue.ts apps/core/tests/redis-document-sync-queue.test.ts apps/core/tests/redis-document-reindex-queue.test.ts docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md docs/superpowers/specs/2026-07-03-iris-redis-document-dlq-corrupt-records-design.md docs/superpowers/plans/2026-07-03-iris-redis-document-dlq-corrupt-records.md
git commit -m "fix: tolerate corrupt document dlq records"
git push origin codex/iris-document-source-registry
```
