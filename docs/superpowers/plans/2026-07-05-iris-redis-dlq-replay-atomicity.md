# Iris Redis DLQ Replay Atomicity Implementation Plan

## Goal

Prevent operator DLQ replay from leaving the same logical work both queued and still replayable in
the DLQ list.

## Steps

- [x] Add failing Redis queue tests requiring replay to pass seen, queue, and DLQ keys to one eval.
- [x] Observe RED in raw event, document sync, and document reindex Redis queue tests.
- [x] Add one DLQ replay Lua script to each Redis queue implementation.
- [x] Route single and batch replay through the script while preserving attempts reset and stale
  seen-key upsert semantics.
- [x] Update older replay assertions to the new eval-based contract.
- [x] Confirm full Redis queue test files pass.
- [x] Run full repository verification.
- [ ] Commit, push, update PR #3, and verify GitHub checks.

## Verification

- RED: `npm --workspace apps/core test -- tests/redis-raw-event-queue.test.ts tests/redis-document-sync-queue.test.ts tests/redis-document-reindex-queue.test.ts`
- GREEN: same command passes with 127 tests.
