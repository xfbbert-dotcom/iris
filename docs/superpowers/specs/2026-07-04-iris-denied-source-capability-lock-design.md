# Iris Denied Source Capability Lock Design

## Context

Document sources can be usable for answer retrieval and knowledge draft
generation. When Feishu permission checks or administrative controls mark a
source as `denied`, leaving any document-content capability enabled creates a
misleading state and risks future code paths treating the source as usable.

## Decision

`permissionState: "denied"` is a source-level capability lock. Both answering
and knowledge draft usage must be disabled when a source becomes denied.
Policy updates and later registrations must preserve this lock until permission
state changes away from `denied`.

## Consequences

- Admin inventory cannot show a denied source as usable for knowledge drafts.
- Rediscovery or source-type upgrades cannot silently reopen document usage.
- Existing planner and retrieval filters keep their fail-closed behavior, with
  registry state now matching the visible product policy.

