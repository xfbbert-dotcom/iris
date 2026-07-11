# Iris Query Limit Safe Integer Plan

## Goal

Reject unsafe integer query limits at the API boundary for shared admin list
queries.

## Steps

- [x] Add failing API tests for unsafe reindex dead-letter list limits.
- [x] Add failing API tests for unsafe document source inventory limits.
- [x] Require `Number.isSafeInteger` in the shared query-limit parser.
- [x] Update the architecture whitepaper and focused design note.
- [x] Run focused and full verification before commit and push.
