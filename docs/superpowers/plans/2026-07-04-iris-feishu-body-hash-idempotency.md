# Iris Feishu Body Hash Idempotency Implementation Plan

**Goal:** Reduce fallback raw-event idempotency collision risk by replacing the
hand-rolled 32-bit body hash with SHA-256.

**Architecture:** Keep Feishu Gateway's ack-first behavior and event ID priority
order. Change only the fallback body hash implementation.

**Tech Stack:** TypeScript, Node crypto, Vitest.

---

## File Structure

- Modify `apps/core/src/feishu/feishu-gateway.ts`.
- Modify `apps/core/tests/feishu-gateway.test.ts`.
- Create `docs/superpowers/specs/2026-07-04-iris-feishu-body-hash-idempotency-design.md`.
- Create `docs/superpowers/plans/2026-07-04-iris-feishu-body-hash-idempotency.md`.

### Task 1: Regression Test

- [x] Add a Gateway test expecting fallback body idempotency keys to contain a
  64-character hex digest.
- [x] Run `npm --workspace apps/core test -- feishu-gateway.test.ts` and observe
  RED.

Observed RED: the new test failed with the legacy fallback key `body-de2b41a7`,
confirming the previous implementation used a short 32-bit body hash.

### Task 2: Implementation

- [x] Replace the 32-bit fallback hash with SHA-256.
- [x] Preserve `body-` prefix and deterministic duplicate behavior.
- [x] Run focused Gateway tests and observe GREEN.

Observed GREEN: `npm --workspace apps/core test -- feishu-gateway.test.ts`
passed with 31 Gateway tests.

### Task 3: Verification And PR

- [x] Run `npm run verify`.
- [x] Commit and push.
- [x] Watch PR #3 checks.

Verification: `npm run verify` passed with 54 Core test files, 749 passing
tests, 4 skipped tests, 7 Python worker tests, and a valid Docker Compose
configuration.

PR update: pushed commit `30fc860` (`fix: strengthen feishu body hash
idempotency`) to PR #3.

Remote checks: GitHub Actions passed for AI Worker and Core.
