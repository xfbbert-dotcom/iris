# Iris Redis Dead-Letter ACK Atomicity Implementation Plan

## Goal

Prevent max-attempt Redis failures from leaving the same logical work both in the DLQ and in the
processing recovery surface, or from stranding the idempotency key after terminal failure.

## Steps

- [x] Add failing Redis queue tests requiring max-attempt DLQ handling to use one eval containing
  `SREM`.
- [x] Observe RED in raw event, document sync, and document reindex Redis queue tests.
- [x] Add one dead-letter ACK Lua script to each Redis queue implementation.
- [x] Route max-attempt failure handling through the script with DLQ, processing, and seen keys
  passed together.
- [x] Update stable-id and bounded-error assertions to inspect the eval DLQ payload.
- [x] Confirm full Redis queue test files pass.
- [x] Run full repository verification.
- [ ] Commit, push, update PR #3, and verify GitHub checks.

## Verification

- RED: `npm --workspace apps/core test -- tests/redis-raw-event-queue.test.ts tests/redis-document-sync-queue.test.ts tests/redis-document-reindex-queue.test.ts -t "moves failed"`
- GREEN: same focused command passes.
- GREEN: `npm --workspace apps/core test -- tests/redis-raw-event-queue.test.ts tests/redis-document-sync-queue.test.ts tests/redis-document-reindex-queue.test.ts` passes with 127 tests.
