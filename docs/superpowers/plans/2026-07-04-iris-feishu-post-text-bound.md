# Iris Feishu Post Text Bound Implementation Plan

**Goal:** Keep Feishu post text extraction stable for malformed or unusually
deep rich-text payloads.

**Architecture:** Add local traversal budgets inside
`feishu-message-event-processor.ts`; this is parsing hygiene at the Feishu event
processing boundary and does not change queue or document registration contracts.

**Tech Stack:** TypeScript, Vitest.

---

## File Structure

- Modify `apps/core/src/conversation/feishu-message-event-processor.ts`.
- Modify `apps/core/tests/feishu-message-event-processor.test.ts`.
- Modify `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`.
- Create `docs/superpowers/specs/2026-07-04-iris-feishu-post-text-bound-design.md`.
- Create `docs/superpowers/plans/2026-07-04-iris-feishu-post-text-bound.md`.

### Task 1: Regression Test

- [x] Add a test proving deeply nested post text beyond the traversal budget is
  ignored without throwing.
- [x] Run `npm --workspace apps/core test -- feishu-message-event-processor.test.ts`
  and observe RED.

Observed: focused processor tests failed because deeply nested post text was
extracted without a traversal budget.

### Task 2: Implementation

- [x] Add max post traversal depth and max readable part constants.
- [x] Stop recursion when either budget is reached.
- [x] Preserve normal post message extraction.
- [x] Run focused processor tests and observe GREEN.

Observed: focused processor tests passed with 12 passing tests.

### Task 3: Architecture And Verification

- [x] Update the architecture whitepaper Feishu Gateway/Event Layer guardrails.
- [x] Run `npm run verify`.
- [x] Commit and push.
- [x] Watch PR #3 checks.

Observed: `npm run verify` passed. Core reported 744 passing tests and 4 skipped
tests. Python worker tests reported 7 passing tests. Docker Compose config
rendered successfully.

Observed: pushed commit `6a9ee4e`; GitHub Actions reported AI Worker and Core
success for PR #3.
