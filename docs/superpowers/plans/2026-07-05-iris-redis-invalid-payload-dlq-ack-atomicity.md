# Iris Redis Invalid Payload DLQ ACK Atomicity Implementation Plan

## Goal

Prevent invalid queued Redis payloads from being both diagnostic DLQ entries and recoverable
processing payloads, while preserving safe idempotency-key release behavior.

## Steps

- [x] Add failing Redis queue tests requiring invalid-payload DLQ handling to use one eval
  containing `SREM`.
- [x] Observe RED in raw event, document sync, and document reindex Redis queue tests.
- [x] Extend the dead-letter ACK Lua script to skip `SREM` when no safe idempotency key is
  supplied.
- [x] Route invalid queued payload handling through the dead-letter ACK helper in all three Redis
  queue implementations.
- [x] Confirm full Redis queue test files pass.
- [x] Run full repository verification.
- [ ] Commit, push, update PR #3, and verify GitHub checks.

## Verification

- RED: `npm --workspace apps/core test -- tests/redis-raw-event-queue.test.ts tests/redis-document-sync-queue.test.ts tests/redis-document-reindex-queue.test.ts`
- GREEN: same command passes with 127 tests.
