# Iris Postgres Knowledge Draft Upgrade Design

## Problem

The in-memory document source registry upgrades `canUseForKnowledgeDrafts` when the same
document URI is later registered by a source type that supports knowledge drafts. The
Postgres registry upgraded the source type and evidence, but left
`can_use_for_knowledge_drafts` unchanged during registration merges.

That creates a production-only mismatch: a user-submitted document could later become an
authorized wiki document, but the Postgres source could remain unusable for knowledge draft
work.

## Decision

When Postgres registration merges into an existing `document_sources` row, update:

```sql
can_use_for_knowledge_drafts = can_use_for_knowledge_drafts or $nextCapability
```

This matches the current in-memory registry behavior and keeps existing `false -> true`
upgrades for higher-trust source types. `can_use_for_answering` remains preserved during
re-registration so administrator answer-disable decisions are not silently reversed.

## Non-Goals

- Do not add a new policy-lock schema field in this patch.
- Do not change source type priority.
- Do not change evidence idempotency.
- Do not change manual policy update endpoints.

## Quality Bar

- Postgres registration merge SQL explicitly ORs knowledge draft capability.
- The new SQL parameter order is covered by a no-database unit test.
- Existing evidence idempotency and transaction behavior remain intact.
