# Iris Reindex Active Profile Guard Implementation Plan

## Goal

Prevent stale Redis reindex jobs for inactive embedding profiles from mutating fragments or producing
misleading worker results.

## Steps

- [x] Add a failing worker test for an inactive-profile job.
- [x] Observe RED in `document-reindex-worker.test.ts`.
- [x] Add an optional active-profile guard to `DocumentReindexWorker`.
- [x] Wire `activeEmbeddingProfileId` from the reindex runtime into the worker.
- [x] Add runtime wiring coverage for stale Redis queue jobs.
- [x] Update the architecture whitepaper.
- [x] Run full repository verification.
- [ ] Commit, push, update PR #3, and verify GitHub checks.

## Verification

- RED: `npm --workspace apps/core test -- tests/document-reindex-worker.test.ts`
- GREEN: `npm --workspace apps/core test -- tests/document-reindex-worker.test.ts tests/reindex-worker-runtime.test.ts`
- Full: `npm run typecheck`; `npm test`; `npm run test:python`; `docker compose config`; `git diff --check`
