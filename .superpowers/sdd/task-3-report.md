# Task 3 Evidence Report: Eligible Message Planner And Event Integration

## Status

Complete on `codex/iris-automatic-memory-extraction`. Task 3 adds eligible persisted-message extraction scheduling and injects it into the existing Feishu event path without transferring extraction resource ownership to the event runtime.

## Files

- `apps/core/src/memory-extraction/memory-extraction-planner.ts`
- `apps/core/tests/memory-extraction-planner.test.ts`
- `apps/core/src/conversation/feishu-message-event-processor.ts`
- `apps/core/tests/feishu-message-event-processor.test.ts`
- `apps/core/src/runtime/event-worker-runtime.ts`
- `apps/core/tests/event-worker-runtime.test.ts`
- `.superpowers/sdd/task-3-report.md`

No other production or test files were changed.

## RED Evidence

Tests were written before production code. This exact command exited 1:

```powershell
npm --workspace apps/core test -- tests/memory-extraction-planner.test.ts tests/feishu-message-event-processor.test.ts tests/event-worker-runtime.test.ts --reporter=dot
```

Observed result:

- 3 test files failed.
- `memory-extraction-planner.test.ts` could not load the missing planner module.
- 3 processor regressions failed because planning was never called and planner failures were not surfaced.
- 1 runtime regression failed because the injected planner was absent from processor composition.
- Remaining existing tests passed: 26 passed, 4 failed, with the planner suite unable to collect.

These failures were caused by the missing Task 3 behavior rather than fixture, syntax, or environment errors.

## GREEN Evidence

### Focused Task 3 Tests

```powershell
npm --workspace apps/core test -- tests/memory-extraction-planner.test.ts tests/feishu-message-event-processor.test.ts tests/event-worker-runtime.test.ts --reporter=dot
```

Exit 0: 3 files passed; 41 tests passed.

### Typecheck

```powershell
npm --workspace apps/core run typecheck
```

Exit 0: `tsc --noEmit` completed without diagnostics.

### Full Core Suite

```powershell
npm --workspace apps/core test -- --reporter=dot
```

Exit 0: 80 files passed; 1,372 tests passed; 13 skipped; 1,385 total.

### Diff Gate

```powershell
git diff --check
```

Exit 0. Git emitted only the repository's existing LF-to-CRLF working-copy notices.

## Implementation Evidence

- Undefined and whitespace-only text is ignored before runtime or persistence calls.
- With a configured bot identity, exact Iris messages and messages lacking a trustworthy sender identity fail closed and cannot schedule self-learning.
- Both runtime gates are synchronously rechecked immediately before `registerRequest`.
- Registration uses the persisted `ConversationMessage.id`, `chatId`, and `providerMessageId`.
- New and idempotent replay registrations both call `enqueue`, repairing a prior database-success/Redis-failure path.
- Queue jobs are built only through `createMemoryExtractionJob` and contain bounded identifiers and timestamps, never message text or sender data.
- The processor attempts mention response, persistence, planner registration, and allowed document discovery in order. Planner errors are isolated until document discovery is attempted.
- Error priority is deterministic: mention response, planner, then document discovery. Existing message-persistence failure behavior remains unchanged.
- A disabled `readGroupContext` gate returns before persistence, planning, or document discovery while preserving the existing mention attempt.
- `createEventWorkerRuntime` accepts and forwards only an optional planner interface. It does not construct or own extraction Postgres, Redis, repository, queue, worker, or model resources.
- No new logging or diagnostics include message text, sender identity, prompts, credentials, or provider responses.

## Self-Review

- Re-read Task 3 in the approved plan and design after implementation.
- Inspected the complete owned-file diff and verified no unrelated production/test files changed.
- Confirmed planner runtime checks occur with no asynchronous work between the final gate and durable registration invocation.
- Confirmed idempotent repository `created` status is intentionally ignored so every replay reaches queue enqueue.
- Confirmed processor catches planner errors independently and attempts allowed document discovery before throwing.
- Confirmed omitted optional planners remain omitted from processor composition, preserving existing runtime behavior.
- Confirmed all tests use persisted identifiers and assert identifier-only queue payloads.

## Concerns

- The full suite's 13 skipped tests are existing environment-gated Postgres integration cases. Task 3 has unit coverage over its repository/queue contracts, but this run did not start an external Postgres service.
- No unresolved Task 3 correctness or scope concern was known at the original commit; the later review finding and fix are recorded below.

## Review Fix: Confirmed Sender Open ID

### Finding

The event parser persisted `senderId` by falling back from Feishu `open_id` to `union_id` and then `user_id`. The planner compared that namespace-erased value directly with `irisBotOpenId`, so an Iris-authored callback without a confirmed Open ID could be mistaken for a human message and schedule self-learning.

### RED Evidence

Before the production fix, this exact command exited 1:

```powershell
npm --workspace apps/core test -- tests/memory-extraction-planner.test.ts tests/feishu-message-event-processor.test.ts tests/event-worker-runtime.test.ts --reporter=dot
```

Observed result: 2 files failed, 4 tests failed, and 38 tests passed. The direct planner regressions scheduled both an exact Iris Open ID supplied in the new identity argument and an unconfirmed fallback identity. The processor regression showed no identity argument was propagated, and the real event-to-planner path registered 3 messages instead of only the confirmed human message.

### GREEN Evidence

Focused Task 3 tests:

```powershell
npm --workspace apps/core test -- tests/memory-extraction-planner.test.ts tests/feishu-message-event-processor.test.ts tests/event-worker-runtime.test.ts --reporter=dot
```

Exit 0: 3 files passed; 42 tests passed.

Typecheck:

```powershell
npm --workspace apps/core run typecheck
```

Exit 0: `tsc --noEmit` completed without diagnostics.

Full Core suite:

```powershell
npm --workspace apps/core test -- --reporter=dot
```

Exit 0: 80 files passed; 1,373 tests passed; 13 skipped; 1,386 total.

### Implementation And Self-Review

- Parsing now preserves a separately validated `senderOpenId` signal while retaining the existing `open_id` to `union_id` to `user_id` fallback for persisted `senderId`.
- The processor strips `senderOpenId` before `upsertMessage`, so the persistence input and stored conversation-message contract are unchanged.
- The persisted message and confirmed Open ID signal are passed separately to the planner.
- With `irisBotOpenId` configured, an absent, blank, or exact Iris sender Open ID fails closed before runtime checks or durable registration. A confirmed non-Iris Open ID remains eligible.
- End-to-end processor-to-planner coverage includes missing Open ID with Union ID fallback, missing Open ID with User ID fallback, exact Iris Open ID, and confirmed human Open ID.
- Queue payload creation remains identifier-only through `createMemoryExtractionJob`; no message or sender content was added to queue payloads or diagnostics.
- No event-runtime extraction resource ownership or unrelated Task 3 behavior changed.
- No unresolved concern remains from this review finding.
