# Iris Reindex Limit Safe Integer Plan

## Goal

Reject unsafe integer reindex limits at the API boundary and sanitize unsafe
limits inside the planner before they reach snapshot queries.

## Steps

- [x] Add a failing API test for unsafe reindex request limits.
- [x] Reject unsafe integer limits in `parseReindexDocumentProfileRequest`.
- [x] Add a failing planner test for unsafe integer limits.
- [x] Sanitize unsafe planner limits to zero.
- [x] Update the architecture whitepaper and focused design note.
- [x] Run full verification before commit and push.
