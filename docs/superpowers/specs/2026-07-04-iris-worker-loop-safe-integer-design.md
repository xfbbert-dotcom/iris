# Iris Worker Loop Safe Integer Design

## Context

Worker loops receive `intervalMs` and `batchLimit` from runtime composition, and
tests or future dependency injection can construct them directly. Environment
config already rejects unsafe integers, but direct construction could still pass
values beyond JavaScript's safe integer range.

## Decision

Every worker loop must validate `intervalMs` and `batchLimit` as positive safe
integers at construction time. This applies to raw event, document sync, and
document reindex worker loops.

## Consequences

- Direct loop construction cannot bypass environment numeric validation.
- Unsafe timer intervals or batch limits fail before polling starts.
- Existing positive-integer error behavior remains unchanged for zero,
  fractional, negative, or non-integer values.
