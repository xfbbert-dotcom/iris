# Iris Document Source Idempotent UpdatedAt Design

## Context

Feishu can retry the same message event with the same `messageId`. Iris already
deduplicates document-source evidence so retried events do not append duplicate
evidence rows. However, refreshing `updatedAt` for an otherwise identical retry
still pollutes operator views and source ordering.

For a 20-30 person rollout, the source registry should make retries boring:
duplicate evidence should not look like a new source update.

## Decision

Document-source registration only refreshes `updatedAt` when the registration
changes the source:

- new evidence is added;
- source type is upgraded;
- missing metadata or ownership fields are filled;
- sync state changes from `failed` to `pending` because new evidence arrived;
- effective knowledge-draft policy changes.

Duplicate evidence retries with no effective metadata or policy change preserve
the original `updatedAt` in both in-memory and Postgres registries.

## Scope

- Does not change evidence deduplication keys.
- Does not suppress new evidence from another message, group, user submission,
  or admin authorization.
- Does not prevent explicit admin policy changes from refreshing `updatedAt`.
- Does not change source list sorting beyond making idempotent retries stop
  reordering sources.

## Quality Bar

- In-memory registry tests prove duplicate evidence retries preserve `updatedAt`.
- Postgres registry tests prove registration SQL no longer writes `updated_at`
  unconditionally.
- Existing source merge, sync reset, and policy override behavior remains green.
