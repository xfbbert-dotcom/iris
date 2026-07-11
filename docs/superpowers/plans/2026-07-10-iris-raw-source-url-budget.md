# Iris Raw Source URL Budget Implementation Plan

**Goal:** Allow copied Feishu document registration URLs to contain long disposable query strings
while preserving canonical source URI storage limits.

**Architecture:** Keep the change at the internal API parser. Use a wider raw URL budget before
normalization, then enforce the canonical document-source URI budget after normalization.

**Tech Stack:** TypeScript, Fastify app injection tests, Vitest.

---

### Task 1: Capture The Regression

- [x] Add an authorized wiki registration API test that posts a copied Feishu doc URL with a long
  query string and expects the runtime to receive the clean canonical `sourceUri`.
- [x] Add a user-submitted registration API test for the same copied-URL shape.
- [x] Run the focused API test and confirm RED.

Observed: `npm --workspace apps/core test -- tests/answer-draft-api.test.ts --reporter=dot`
failed with both new tests returning `400` instead of `200`.

### Task 2: Separate Raw And Canonical Budgets

- [x] Add an 8192-character raw source URI budget in `apps/core/src/app.ts`.
- [x] Use that budget only while reading raw registration API `sourceUri` input.
- [x] Enforce `DOCUMENT_SOURCE_URI_MAX_CHARS` on the normalized canonical URI before runtime calls.
- [x] Run the focused API test and confirm GREEN.

Observed: `npm --workspace apps/core test -- tests/answer-draft-api.test.ts --reporter=dot`
passed with 156 tests.

### Task 3: Publish And Verify

- [x] Run full verification.

Observed:

- `npm run typecheck` passed.
- `npm test` passed with 1044 tests passed / 4 skipped.
- `npm run test:python` passed with 7 tests.
- `docker compose config` passed.
- `git diff --check` passed with Windows line-ending warnings only.

- [x] Commit, push, update PR #3, and confirm GitHub Actions checks.

Observed: committed `734f200`, pushed to `codex/iris-document-source-registry`, updated PR #3,
and confirmed GitHub Actions Core and AI Worker checks passed.
