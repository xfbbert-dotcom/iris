# Iris Worker Error Normalization Design

## Context

Raw event, document sync, and document reindex workers all rely on a shared
error-message normalizer before recording retries, dead letters, or batch
failures. JavaScript can throw arbitrary values, including objects that cannot
be converted with `String(value)`.

If the normalizer throws while handling an original worker failure, Iris loses
the observable failure path and may skip retry/dead-letter bookkeeping.

## Decision

Worker error normalization must be best-effort and non-throwing:

- standard `Error` instances use their `.message`;
- other thrown values are stringified when possible;
- non-stringifiable values fall back to `unknown error`;
- blank and oversized messages continue to use the existing fallback and
  truncation policy.

## Scope

- Does not change retry counts, queue state transitions, or worker loop control
  flow.
- Does not expose stack traces or full external response bodies.
- Applies to all worker paths that already use the shared normalizer.

## Quality Bar

- A standard `Error` still normalizes to its trimmed message.
- A non-stringifiable thrown value does not escape the normalizer.
- Focused worker-error tests and full repository verification pass.
