# Iris Redis Retry ACK Atomicity Implementation Plan

## Goal

Prevent Redis retry handling from leaving the same logical work in both pending and processing when
retry upsert succeeds but processing-list cleanup fails.

## Steps

- [x] Add failing Redis queue tests requiring retry ACK to use one eval containing `LREM`.
- [x] Observe RED in raw event, document sync, and document reindex Redis queue tests.
- [x] Add one retry ACK Lua script to each Redis queue implementation.
- [x] Route retriable failure handling through the script with seen, queue, and processing keys
  passed together.
- [x] Update older retry-upsert assertions to the new eval-based contract.
- [x] Confirm focused retry tests pass.
- [x] Confirm full Redis queue test files pass.
- [x] Run full repository verification.
- [ ] Commit, push, update PR #3, and verify GitHub checks.

## Verification

- RED: `npm --workspace apps/core test -- tests/redis-raw-event-queue.test.ts tests/redis-document-sync-queue.test.ts tests/redis-document-reindex-queue.test.ts -t "requeues failed"`
- GREEN: same focused command passes.
- GREEN: `npm --workspace apps/core test -- tests/redis-raw-event-queue.test.ts tests/redis-document-sync-queue.test.ts tests/redis-document-reindex-queue.test.ts` passes with 127 tests.
