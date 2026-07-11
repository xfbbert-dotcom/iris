# Iris Document Source Knowledge Draft Disable Preservation Design

## Context

Document sources can be registered repeatedly as Iris observes the same link in more groups or as an admin authorizes a source. The previous merge behavior used a boolean OR for `canUseForKnowledgeDrafts`, which meant a source manually disabled by an admin could be re-enabled by later discovery.

For the initial 20-30 person rollout, admin controls need to feel trustworthy. If someone turns off a source capability, normal chat activity must not undo that decision.

## Decision

Preserve manually disabled knowledge-draft capability for sources that are already knowledge-draft-capable source types. Automatic capability promotion is only allowed when an existing `user_submitted_document` is upgraded by a later group-visible or authorized wiki registration.

This keeps the useful upgrade path:

- user-submitted document starts with knowledge drafts off
- later authorization/group discovery can promote it to knowledge-draft-capable

And blocks the unsafe path:

- group-visible or authorized wiki source is manually disabled for knowledge drafts
- later repeated registration keeps the capability disabled

## Scope

This applies to both the v1 in-memory registry and the Postgres-backed registry implementation. It does not change answering enablement, permission states, evidence deduplication, or source type priority.

## Quality Bar

- In-memory registry preserves disabled knowledge drafts after repeat group discovery.
- Postgres registry emits conditional merge SQL instead of a plain OR.
- Existing source-type upgrade behavior remains covered by tests.
