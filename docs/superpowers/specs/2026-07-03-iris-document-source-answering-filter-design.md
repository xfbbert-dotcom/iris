# Iris Document Source Answering Filter Design

## Context

Admins can disable a document source for answer retrieval, but the source inventory API only supported filtering sources where answering was enabled. During the 20-30 person rollout, operators need a quick way to find documents that were intentionally disabled without downloading every source and filtering in the admin UI.

## Decision

Add a first-class answering policy filter across the source inventory stack:

- registry exposes `listSourcesByAnsweringEnabled(enabled)`,
- Postgres uses a parameterized `can_use_for_answering = $1` query,
- document sync runtime accepts `usableForAnswering` as a boolean filter,
- HTTP inventory accepts `usableForAnswering=true` and `usableForAnswering=false`.

Existing `listSourcesUsableForAnswering()` remains as a compatibility shortcut for callers that only need enabled sources.

## Scope

- Does not change answer retrieval eligibility.
- Does not change policy update semantics.
- Does not add multi-filter inventory queries.

## Quality Bar

- Enabled and disabled source lists use the same deterministic source ordering.
- Existing shortcut methods must not depend on JavaScript `this` binding.
- The admin API returns disabled sources without latest snapshot lookups unless requested.
- Invalid non-boolean query values still return `invalid_request`.
