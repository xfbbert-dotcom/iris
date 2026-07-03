# Iris Document Sync Runtime Limit Sanitization Design

## Problem

`DocumentSyncRuntime.sources.list()` and `DocumentSyncRuntime.sources.listSnapshots()` slice already-loaded arrays with `input.limit` directly. If a future internal caller passes `Infinity` or `NaN`, `slice(0, Infinity)` can return everything while `NaN` is coerced in a less explicit way.

The runtime boundary should match the rest of Iris' queue, worker, and repository limit policy: non-finite limits mean zero work/results.

## Requirements

- Treat `Infinity`, `-Infinity`, and `NaN` as zero.
- Preserve finite floor/clamp behavior.
- Keep source filtering, source existence checks, and snapshot lookup behavior unchanged.

## Non-goals

- Do not change public API query parsing.
- Do not change inventory filters.
- Do not change snapshot ordering.

## Acceptance

- Runtime source inventory returns `[]` for non-finite limits.
- Runtime source snapshot inventory returns `[]` for non-finite limits after source existence is confirmed.
- Full verification remains green.
