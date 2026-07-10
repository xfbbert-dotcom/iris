# Iris Internal Status Summary Status Semantics Implementation Plan

**Goal:** Keep `/internal/status` summary counts aligned with derived component statuses, especially
for enabled workers that are stopped.

**Architecture:** Preserve component-level statuses and attention ordering. Change only summary
derivation so the operator-facing counts use component `status` instead of raw `ok` booleans.

**Tech Stack:** TypeScript, Vitest, existing internal status snapshot and API tests.

---

### Task 1: Capture The Regression

- [x] Add a snapshot-builder test for an enabled runtime with `ok: true` and `running: false`.
- [x] Assert it does not increment `healthyComponentCount`.
- [x] Assert it appears in `degradedComponents` and increments `degradedComponentCount`.
- [x] Run the focused snapshot test and confirm RED.

Observed: `npm --workspace apps/core test -- tests/internal-status-snapshot.test.ts --reporter=dot`
failed because `healthyComponentCount` was `1` instead of `0`.

### Task 2: Align Summary Semantics

- [x] Count healthy components by derived `status: "healthy"`.
- [x] Count degraded summary components by derived `status: "degraded"` or `status: "stopped"`.
- [x] Keep disabled components in the existing disabled summary.
- [x] Update consolidated `/internal/status` API expectations.
- [x] Update architecture specs and rollout runbook.

### Task 3: Verify And Publish

- [x] Run focused status tests.
- [x] Run full verification.
- [ ] Commit, push, update PR #3, and confirm GitHub Actions checks.

Observed: `npm --workspace apps/core test -- tests/internal-status-snapshot.test.ts tests/answer-draft-api.test.ts tests/runtime-control-api.test.ts --reporter=dot`
passed with 175 tests.

Observed:

- `npm run typecheck` passed.
- `npm test` passed with 1046 tests passed / 4 skipped.
- `npm run test:python` passed with 7 tests.
- `docker compose config` passed.
- `git diff --check` passed with Windows line-ending warnings only.
