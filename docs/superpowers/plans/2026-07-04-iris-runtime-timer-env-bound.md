# Iris Runtime Timer Environment Bound Implementation Plan

**Goal:** Fail oversized timer-related environment settings during config
loading instead of later runtime construction.

**Architecture:** Add a timer-specific environment reader that composes the
existing positive safe integer parsing with the Node timer maximum delay bound.
Use it only for fields that flow into `setTimeout()`.

**Tech Stack:** TypeScript, Vitest.

---

## File Structure

- Modify `apps/core/src/config/env.ts`.
- Modify `apps/core/tests/env.test.ts`.
- Create `docs/superpowers/specs/2026-07-04-iris-runtime-timer-env-bound-design.md`.
- Create `docs/superpowers/plans/2026-07-04-iris-runtime-timer-env-bound.md`.

### Task 1: Regression Tests

- [x] Add env tests for model, embedding, and Feishu document timeout values
  above `2147483647`.
- [x] Add env tests for event, document sync, and reindex worker interval values
  above `2147483647`.
- [x] Run `npm --workspace apps/core test -- env.test.ts` and observe RED.

Observed: env tests failed because all six timer-related env fields accepted
`2147483648`.

### Task 2: Implementation

- [x] Add a timer-specific environment reader with the Node timer maximum.
- [x] Use it only for timeout and polling interval env values.
- [x] Preserve existing non-timer numeric validation behavior.
- [x] Run `npm --workspace apps/core test -- env.test.ts` and observe GREEN.

Observed: env tests passed with 49 passing tests.

### Task 3: Verification And PR

- [x] Run `npm run verify`.
- [x] Commit and push.
- [x] Watch PR #3 checks.

Observed: `npm run verify` passed. Core reported 739 passing tests and 4 skipped
tests. Python worker tests reported 7 passing tests. Docker Compose config
rendered successfully.

Observed: pushed commit `f7fbd42`; GitHub Actions reported AI Worker and Core
success for PR #3.
