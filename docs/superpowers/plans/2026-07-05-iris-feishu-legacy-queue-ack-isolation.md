# Iris Feishu Legacy Queue Ack Isolation Implementation Plan

## Goal

Make the legacy Feishu event queue fallback follow the same ack-first rule as the Redis raw-event queue.

## Steps

- [x] Add a failing gateway test proving `enqueueRawFeishuEvent` is not called before `handleCallback` returns HTTP 200.
- [x] Observe the red failure: the legacy queue spy was called once before the response assertion.
- [x] Change the legacy fallback branch to use the same post-ack scheduling helper as `rawEventQueue`.
- [x] Update legacy queue assertions to flush deferred enqueue work before inspecting stored events and idempotency keys.
- [x] Run focused gateway tests.

## Verification

- RED: `npm --workspace apps/core run test -- tests/feishu-gateway.test.ts -t "legacy queued events"` failed because the legacy queue spy had already been called.
- GREEN: `npm --workspace apps/core run test -- tests/feishu-gateway.test.ts -t "legacy queued events"` passed.
- Focused file: `npm --workspace apps/core run test -- tests/feishu-gateway.test.ts` passed with `36` tests.
