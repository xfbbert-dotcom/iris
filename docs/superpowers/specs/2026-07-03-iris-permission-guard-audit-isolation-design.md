# Iris Permission Guard Audit Isolation Design

## Context

Answer-time retrieval uses the live permission guard to remove document fragments that Iris should not show to the model. When a document is denied or permission checking errors, the guard writes an audit event so operators can inspect why context was withheld. That audit write is observability, not authorization.

If an audit backend fails, permission filtering must still finish with fail-closed behavior: denied or uncertain fragments stay out of the answer context, while allowed fragments can still be used.

## Decision

Treat permission audit logging as best-effort:

- Permission decisions remain authoritative even when audit logging fails.
- Denied and errored documents must still be omitted from allowed fragments.
- Allowed fragments from other documents must still be returned.
- Audit write failures must not turn answer drafting into a 500 response.

## Scope

This does not add audit retries, a dead-letter queue for audit events, or a separate telemetry backend. It only isolates audit write failures from the permission guard's filtering result.

## Quality Bar

Permission guard tests must prove that a throwing `auditLog.record()` call does not reject filtering, does not allow denied fragments through, and still returns allowed fragments from other documents.
