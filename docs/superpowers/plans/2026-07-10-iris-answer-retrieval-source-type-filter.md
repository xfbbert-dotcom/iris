# Iris Answer Retrieval Source Type Filter Implementation Plan

**Goal:** Prevent answer-time semantic search from retrieving disabled document source categories
before local source policy filtering.

**Architecture:** Add an optional `sourceTypes` filter to document fragment vector search. Let the
answer-draft runtime derive allowed source types from runtime controls for each draft request and
pass them into retrieval context construction.

**Tech Stack:** TypeScript, Vitest, Postgres SQL over pgvector.

---

### Task 1: Capture The Regression

- [x] Add a repository test requiring vector search SQL to filter by requested source types.
- [x] Add a runtime test requiring disabled group/wiki retrieval controls to pass only
  `user_submitted_document` into vector search.
- [x] Run focused tests and confirm RED.

Observed: `npm --workspace apps/core test -- tests/document-fragment-repository.test.ts tests/answer-draft-runtime.test.ts --reporter=dot`
failed because SQL did not include `ds.source_type = any($4::text[])` and runtime search input did
not include `sourceTypes`.

### Task 2: Push Down Source Type Filters

- [x] Add optional `sourceTypes` to `SearchSimilarFragmentsInput`.
- [x] Add `ds.source_type = any($4::text[])` to vector search when the filter is provided.
- [x] Add optional `sourceTypes` to the retrieval context builder.
- [x] Derive allowed answer source types from runtime controls.
- [x] Preserve user-submitted document retrieval by default.
- [x] Update the architecture whitepaper.

### Task 3: Verify And Publish

- [x] Run focused repository and answer runtime tests.
- [x] Run full verification.
- [ ] Commit, push, update PR #3, and confirm GitHub Actions checks.

Observed: `npm --workspace apps/core test -- tests/document-fragment-repository.test.ts tests/answer-draft-runtime.test.ts --reporter=dot`
passed with 32 tests / 1 skipped.

Observed:

- `npm run typecheck` passed.
- `npm test` passed with 1047 tests passed / 4 skipped.
- `npm run test:python` passed with 7 tests.
- `docker compose config` passed.
- `git diff --check` passed with Windows line-ending warnings only.
