# Iris Worker Loop Timer Delay Bound Implementation Plan

**Goal:** Prevent worker polling intervals above Node's safe timer delay from
overflowing into very short polling loops.

**Architecture:** Keep the worker loop positive/safe-integer validation local to
each loop, and add a timer-specific upper bound only for `intervalMs`. Do not cap
`batchLimit` with the timer limit.

**Tech Stack:** TypeScript, Vitest fake timers, Node timers.

---

## File Structure

- Modify `apps/core/tests/raw-event-worker-loop.test.ts`.
- Modify `apps/core/tests/document-sync-worker-loop.test.ts`.
- Modify `apps/core/tests/document-reindex-worker-loop.test.ts`.
- Modify `apps/core/src/events/raw-event-worker-loop.ts`.
- Modify `apps/core/src/documents/document-sync-worker-loop.ts`.
- Modify `apps/core/src/reindex/document-reindex-worker-loop.ts`.
- Modify `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`.

### Task 1: Regression Tests

- [x] Add raw event worker loop test rejecting `intervalMs: 2_147_483_648`.
- [x] Add document sync worker loop test rejecting `intervalMs: 2_147_483_648`.
- [x] Add document reindex worker loop test rejecting `intervalMs: 2_147_483_648`.
- [x] Run focused tests and observe RED.

Observed: focused worker-loop tests failed because all three loops accepted
`2_147_483_648`.

### Task 2: Implementation

- [x] Add a Node timer maximum delay constant to each loop module.
- [x] Apply the upper bound only after `intervalMs` passes positive safe integer validation.
- [x] Preserve current `batchLimit` validation behavior.
- [x] Run focused tests and observe GREEN.

Observed: focused worker-loop tests passed with 24 passing tests.

### Task 3: Architecture And Verification

- [x] Update the architecture whitepaper runtime configuration safety section.
- [x] Run `npm run verify`.
- [x] Commit and push.
- [x] Watch PR #3 checks.

Observed: `npm run verify` passed. Core reported 733 passing tests and 4 skipped
tests. Python worker tests reported 7 passing tests. Docker Compose config
rendered successfully.

Observed: pushed commit `9f13632`; GitHub Actions reported AI Worker and Core
success for PR #3.
