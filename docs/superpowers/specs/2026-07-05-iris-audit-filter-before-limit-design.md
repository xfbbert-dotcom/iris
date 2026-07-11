# Iris Audit Filter Before Limit Design

## Context

The internal audit endpoints help operators answer questions such as "show me recent permission
guard errors" or "who disabled this runtime capability." The current in-memory query path applies
`limit` before filters, which means a filtered query can return nothing when the latest retained
events are unrelated, even if matching retained events still exist slightly earlier.

## Decision

For filtered audit queries, Iris must apply filters before the recent limit:

- scan the retained in-memory audit window;
- keep events matching `documentId`, `type`, and `operatorHint`;
- return the newest `limit` matching events;
- summarize the newest `limit` matching events.

Unfiltered queries keep the existing fast behavior of reading only the latest `limit` retained
events. The response metadata should describe the retained events inspected and the total matching
events before the final limit is applied.

## Invariants

- `limit=0` still returns no events or summaries.
- Event responses remain newest first.
- Summary grouping and sorting remain unchanged after the filtered window is selected.
- Existing retention metadata remains unchanged.
- This is still an in-memory v1 operator surface; it does not add persistent audit storage.

## Out Of Scope

- Cursor pagination.
- Persisted audit storage.
- New audit event types.
- Changing runtime control or permission guard audit payloads.
