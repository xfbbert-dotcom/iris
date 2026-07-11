# Iris Queue Batch Replay Context Design

## Context

Document sync and document reindex queues expose dead-letter replay methods for admin and runtime recovery tooling. Their batch replay methods called the single-item replay method through `this`, which made them fragile if a caller destructured the function or passed it as a callback.

## Decision

Make queue batch dead-letter replay context-independent:

- In factory-created queues, close over the single-item replay function instead of calling through `this`.
- In the in-memory reindex class, bind replay/delete methods in the constructor so method extraction keeps the instance context.

## Scope

- Does not change dead-letter payload shapes.
- Does not change retry, dedupe, or replay result semantics.
- Does not introduce a new queue abstraction.

## Quality Bar

- In-memory and Redis document sync queues can replay dead letters through an extracted `replayDeadLetters` function.
- In-memory and Redis document reindex queues can replay dead letters through an extracted `replayDeadLetters` function.
- Existing single-item replay/delete and list behavior remains unchanged.
