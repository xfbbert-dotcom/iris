# Iris Legacy Feishu Event Queue Cloning Design

## Problem

`InMemoryEventQueue` stores legacy `RawFeishuEvent` objects by reference and exposes
the internal `events` array directly. Caller mutations after enqueue, or mutations
through `queue.events`, can corrupt internal queue state.

This queue is legacy but still used by tests and fallback wiring. During the small
Phase 2B rollout, keeping it defensive prevents confusing behavior.

## Decision

Clone legacy Feishu events at state boundaries:

- clone on enqueue
- expose `events` through a getter that returns cloned entries
- clone `receivedAt` as a new `Date`
- deep clone `body` with `structuredClone`

## Non-Goals

- Do not change legacy dedupe semantics.
- Do not add processing behavior for the legacy queue.

## Quality Bar

- Mutating an input event after enqueue does not mutate stored state.
- Mutating an event returned from `queue.events` does not mutate stored state.
- Existing legacy queue tests and gateway tests continue to pass.
