# Iris Permission Guard Non-Error Audit Design

## Context

The answer-time permission guard fails closed when live permission checks throw.
Those errors are also written to the audit log as `permission_guard_error`
events so operators can distinguish real denials from infrastructure failures.

JavaScript dependencies can throw non-`Error` values. If Iris only records
messages for `Error` instances, permission filtering remains safe but operator
diagnostics lose the failure detail.

## Decision

Permission guard audit messages should be generated for any thrown permission
check failure:

- standard `Error` instances use their `.message`;
- non-Error thrown values are stringified when possible;
- non-stringifiable values degrade to `unknown error`;
- the existing audit-message normalizer still handles blank and oversized
  messages.

## Scope

- Does not allow any fragment when permission checks fail.
- Does not add messages to ordinary `permission_guard_denied` audit events.
- Does not let audit logging failures affect permission filtering.

## Quality Bar

- Non-Error permission check failures still deny fragments.
- Audit events for non-stringifiable permission failures include
  `message: "unknown error"`.
- Focused permission guard tests and full repository verification pass.
