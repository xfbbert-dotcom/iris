# Iris Feishu Gateway Nonblocking Enqueue Plan

- [x] Add a failing gateway test for a never-settling raw queue enqueue.
- [x] Add a failing gateway test for raw queue enqueue rejection reporting.
- [x] Make raw and legacy queue persistence nonblocking in the gateway.
- [x] Run focused Feishu gateway tests.
- [x] Run full verification before publishing.
- [x] Commit and push the change to the PR branch.

## Ack-First Follow-Up

- [x] Add a failing gateway test proving raw queue persistence work has not started when
  `handleCallback()` returns the Feishu acknowledgement.
- [x] Defer Redis raw queue enqueue work to the next event-loop turn.
- [x] Update raw queue tests to flush the deferred enqueue before checking queue writes or observer
  callbacks.
- [x] Document the v1 durability tradeoff: the gateway prioritizes avoiding Feishu retry storms over
  blocking acknowledgement on Redis serialization.
