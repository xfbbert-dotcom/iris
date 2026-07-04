# Iris Document Source Policy Atomic Update Plan

## Goal

Prevent Admin Console document source policy updates from leaving answer
retrieval and knowledge draft capabilities in a partially updated state.

## Steps

- [x] Add failing in-memory registry tests for combined policy updates.
- [x] Add failing Postgres registry tests for single-statement policy updates.
- [x] Add a failing runtime wiring test that expects `sources.updatePolicy`.
- [x] Add `updatePolicy` to the in-memory document source registry.
- [x] Add `updatePolicy` to the Postgres document source registry.
- [x] Route document sync runtime policy updates through the atomic registry
  interface.
- [x] Update the architecture whitepaper with the control-plane atomicity rule.
- [x] Run focused and full verification before commit and push.
