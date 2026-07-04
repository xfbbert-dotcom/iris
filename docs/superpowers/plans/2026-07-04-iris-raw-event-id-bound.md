# Iris Raw Event Id Bound Implementation Plan

**Goal:** Prevent malformed external event IDs from becoming oversized Redis
idempotency keys.

**Architecture:** Define a shared maximum event ID source length in the raw event
queue boundary. Gateway ID resolution should ignore oversized external IDs so it
falls back to body hashing, while direct helper calls fail explicitly.

**Tech Stack:** TypeScript, Vitest.

---

## File Structure

- Modify `apps/core/src/events/raw-event-queue.ts`.
- Modify `apps/core/src/feishu/feishu-gateway.ts`.
- Modify `apps/core/tests/raw-event-queue.test.ts`.
- Modify `apps/core/tests/feishu-gateway.test.ts`.
- Modify `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`.
- Create `docs/superpowers/specs/2026-07-04-iris-raw-event-id-bound-design.md`.
- Create `docs/superpowers/plans/2026-07-04-iris-raw-event-id-bound.md`.

### Task 1: Regression Tests

- [x] Add raw-event helper test rejecting event IDs longer than 512 characters.
- [x] Add gateway test proving oversized Feishu event IDs fall back to body hash.
- [x] Run focused tests and observe RED.

Observed: focused tests failed because 513-character event IDs were accepted and
used directly in idempotency keys.

### Task 2: Implementation

- [x] Export a raw event ID source length maximum.
- [x] Enforce the maximum in `createRawEventIdempotencyKey()`.
- [x] Make Feishu Gateway ignore oversized external ID candidates before hash
  fallback.
- [x] Run focused tests and observe GREEN.

Observed: focused raw-event queue and Feishu Gateway tests passed with 73
passing tests.

### Task 3: Architecture And Verification

- [x] Update the architecture whitepaper event-layer guardrails.
- [x] Run `npm run verify`.
- [ ] Commit and push.
- [ ] Watch PR #3 checks.

Observed: `npm run verify` passed. Core reported 748 passing tests and 4 skipped
tests. Python worker tests reported 7 passing tests. Docker Compose config
rendered successfully.
