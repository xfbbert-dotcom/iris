# Iris Document Sync Failure Normalization Design

## Context

Document sync fetchers can fail because Feishu is unavailable, permissions
changed, the response is malformed, or a dependency throws an unexpected value.
Iris records fetch failures as failed snapshots so operators can see the latest
failure and the source can move to a recoverable `failed` state.

JavaScript can throw arbitrary values, including objects that cannot be
converted with `String(value)`. If error formatting throws, Iris loses the
failed snapshot and the sync-state transition.

## Decision

Document sync fetch-failure normalization must be best-effort and non-throwing:

- standard `Error` instances use their `.message`;
- non-Error thrown values are stringified when possible;
- non-stringifiable values degrade to `unknown error`;
- the existing document snapshot error-message normalizer still handles blank
  and oversized messages.

## Scope

- Applies to fetch failures inside the document sync runner.
- Does not convert succeeded snapshot persistence, mark-synced, or reindex
  enqueue failures into failed document snapshots.
- Does not change retry or sync-state recovery semantics.

## Quality Bar

- Existing non-Error string failures are still recorded.
- Non-stringifiable fetch failures are recorded as failed snapshots with
  `unknown error`.
- Focused document sync pipeline tests and full repository verification pass.
