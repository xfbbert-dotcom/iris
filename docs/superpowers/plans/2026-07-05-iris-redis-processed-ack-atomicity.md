# Iris Redis Processed ACK Atomicity Implementation Plan

## Goal

Prevent Redis processed ACK from stranding `seen` keys when processing-list cleanup and seen-key
release are split across separate commands.

## Steps

- [x] Add failing Redis queue tests requiring processed ACK to use one eval containing both `LREM`
  and `SREM`.
- [x] Observe RED in raw event, document sync, and document reindex Redis queue tests.
- [x] Add one processed ACK Lua script to each Redis queue implementation.
- [x] Route successful ACK through the script with processing and seen keys passed together.
- [x] Update older ACK assertions to the new eval-based contract.
- [x] Confirm focused ACK tests pass.
- [x] Confirm full Redis queue test files pass.

## Verification

- RED: `npm --workspace apps/core test -- tests/redis-raw-event-queue.test.ts tests/redis-document-sync-queue.test.ts tests/redis-document-reindex-queue.test.ts -t "removes processed Redis"`
- GREEN: same focused command passes.
- GREEN: `npm --workspace apps/core test -- tests/redis-raw-event-queue.test.ts tests/redis-document-sync-queue.test.ts tests/redis-document-reindex-queue.test.ts` passes with 127 tests.
