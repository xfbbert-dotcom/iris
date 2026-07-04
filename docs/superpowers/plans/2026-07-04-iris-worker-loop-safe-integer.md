# Iris Worker Loop Safe Integer Plan

## Goal

Reject unsafe integer worker loop intervals and batch limits even when loops are
constructed directly.

## Steps

- [x] Add failing raw event worker loop tests for unsafe interval and batch
  limits.
- [x] Add failing document sync worker loop tests for unsafe interval and batch
  limits.
- [x] Add failing reindex worker loop tests for unsafe interval and batch
  limits.
- [x] Add safe-integer validation to each worker loop constructor guard.
- [x] Update the architecture whitepaper and focused design note.
- [x] Run focused and full verification before commit and push.
