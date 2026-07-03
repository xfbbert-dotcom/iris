# Iris Document Source Query Boolean Flag Design

## Context

The document source inventory API exposes `includeLatestSnapshot` as an optional query flag. Frontend controls commonly serialize an unchecked switch as `includeLatestSnapshot=false`; treating that value as an invalid request makes the admin surface fragile even though the user intent is simply "do not include snapshots."

## Decision

`includeLatestSnapshot` now accepts three states:

- omitted: list or fetch sources without snapshot summaries,
- `false`: same as omitted, for frontend switch compatibility,
- `true`: include latest snapshot summaries and sync health details.

Any other provided value remains invalid and returns `invalid_request`.

## Scope

- Does not add filtering by failed or missing snapshots.
- Does not change `usableForAnswering`, which still only supports the explicit `true` filter.
- Does not change the latest snapshot response shape.

## Quality Bar

- `includeLatestSnapshot=false` never calls latest snapshot lookup methods.
- `includeLatestSnapshot=true` continues to include sanitized snapshot summaries.
- Unrecognized query values still fail fast with `invalid_request`.
