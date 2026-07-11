# Iris Document Source Policy Atomic Update Design

## Context

Admin Console source policy updates can change both answer retrieval usage and
knowledge draft usage for one document source. If those fields are updated with
two separate storage writes, a failure between the writes can leave the source in
a half-updated state. That makes the operator-facing policy misleading and can
weaken later retrieval or knowledge-draft gates.

## Decision

Document source policy changes are a single control-plane operation. The
registry exposes `updatePolicy`, and runtime code must use that interface rather
than sequencing `setAnsweringEnabled` and `setKnowledgeDraftsEnabled`.

The in-memory registry applies both capability changes through one source update.
The Postgres registry applies both changes with one `update ... returning`
statement, preserving the denied-source capability lock in the same statement.

## Consequences

- A single Admin Console policy request cannot partially apply answer and
  knowledge-draft capabilities.
- Existing single-field methods remain available for narrow internal callers,
  but multi-field runtime updates use the atomic policy interface.
- Denied document sources remain fail-closed even if an operator attempts to
  enable one or both capabilities.
- The policy API response reflects the same source record produced by the
  authoritative storage update.
