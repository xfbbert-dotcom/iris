# Iris Internal Status Error Normalization Design

## Context

Internal status surfaces gateway enqueue failures and other operator-visible
degradation signals. Those status updates should remain available even when the
original failure is unusual.

JavaScript can throw values that cannot be converted with `String(value)`. If
the internal status normalizer throws while recording an error, Iris loses the
operator-visible failure snapshot.

## Decision

Internal status error normalization must be best-effort and non-throwing:

- standard `Error` instances use their `.message`;
- non-Error thrown values are stringified when possible;
- non-stringifiable values degrade to `unknown error`;
- existing blank and oversized message fallback/truncation rules remain.

## Scope

- Applies to internal status error-message normalization.
- Does not change status aggregation, component severity, or readiness checks.
- Does not expose stack traces or raw external response bodies.

## Quality Bar

- Standard error messages still normalize and trim.
- Non-stringifiable status errors return `unknown error`.
- Focused internal status error-message tests and full repository verification
  pass.
