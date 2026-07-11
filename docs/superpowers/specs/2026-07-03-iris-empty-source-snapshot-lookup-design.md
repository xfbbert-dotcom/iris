# Iris Empty Source Snapshot Lookup Design

## Context

The source inventory API can request latest snapshot summaries with `includeLatestSnapshot=true`. When the source page is empty, the route still called the batch latest-snapshot lookup with an empty `sourceIds` array. That creates avoidable repository work and makes test doubles or future query instrumentation record a misleading lookup.

## Decision

Short-circuit empty inventory pages before asking for latest snapshots:

- source list is still resolved normally,
- if `includeLatestSnapshot` is not true, behavior is unchanged,
- if `includeLatestSnapshot` is true and the page is empty, return `{ ok: true, sources: [] }`,
- non-empty pages keep using the existing batch latest-snapshot lookup.

## Scope

- Does not change source filtering.
- Does not change latest snapshot summary shape.
- Does not change sync health calculation for non-empty pages.

## Quality Bar

- Empty source pages never call `getLatestSnapshots`.
- Non-empty pages still use one batch latest-snapshot lookup.
- `limit=0` remains a valid inventory request.
