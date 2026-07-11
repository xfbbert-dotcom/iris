# Iris Feishu Permission Non-Zero Code Design

## Context

Feishu OpenAPI can return HTTP success with a non-zero JSON `code`. In the
answer-time permission guard, treating every non-zero code as `false` is safe for
content leakage, but it hides infrastructure or authentication failures as
ordinary permission denials.

The v1 rollout needs both properties: fail closed and keep operator diagnostics
accurate.

## Decision

The Feishu document permission checker distinguishes three outcomes for HTTP
success responses:

- `code === 0`: permission probe succeeded;
- known permission-denied code: return `false`;
- unknown non-zero code: throw an error.

The existing permission guard catches thrown checker errors, excludes the
fragment, and records `permission_guard_error` when an audit log is configured.

## Scope

- Does not allow any fragment that was previously denied.
- Does not change HTTP 403/404 behavior; those remain denials.
- Does not change transient HTTP failure, malformed JSON, timeout, or response
  budget behavior; those remain errors.

## Quality Bar

- Known Feishu permission-denied code `99991663` returns `false` even when the
  HTTP status is successful.
- Unknown non-zero codes throw with the Feishu error message.
- The checker remains fail-closed through the existing permission guard.
