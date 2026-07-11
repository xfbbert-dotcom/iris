# Iris In-Memory Raw Event Queue Cloning Design

## Problem

`InMemoryRawEventQueue` stores and returns `RawEvent` objects by reference. Because
`rawBody` contains the original Feishu event body, caller-side mutations can leak
into queued or requeued state during Phase 2B in-memory deployments.

## Decision

Clone raw events at queue boundaries:

- when enqueueing
- when dequeueing
- when requeueing failed events
- when storing failed events in the in-memory DLQ

Clone `receivedAt` as a new `Date` and clone `rawBody` deeply with `structuredClone`,
which is suitable for JSON-like Feishu event bodies.

## Non-Goals

- Do not change retry, dedupe, or DLQ count semantics.
- Do not add raw event DLQ listing APIs.

## Quality Bar

- Mutating an input event after enqueue does not mutate queued state.
- Mutating an input event after requeue does not mutate queued retry state.
- Existing raw event queue behavior remains unchanged.
