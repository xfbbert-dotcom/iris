# Iris Feishu Signature Header Case Implementation Plan

**Goal:** Make Feishu callback signature verification tolerant of header casing
without weakening signature checks.

**Architecture:** Keep the change inside the Feishu auth primitive. Gateway and
Fastify route behavior stay unchanged.

**Tech Stack:** TypeScript, Vitest.

---

## File Structure

- Modify `apps/core/src/feishu/feishu-auth.ts`.
- Modify `apps/core/tests/feishu-auth.test.ts`.
- Create `docs/superpowers/specs/2026-07-04-iris-feishu-signature-header-case-design.md`.
- Create `docs/superpowers/plans/2026-07-04-iris-feishu-signature-header-case.md`.

### Task 1: Regression Test

- [x] Add a Feishu auth test for mixed-case `X-Lark-*` signature headers.
- [x] Run `npm --workspace apps/core test -- feishu-auth.test.ts` and observe RED.

Observed RED: the mixed-case header test failed with `expected false to be true`,
confirming the previous lookup missed canonical `X-Lark-*` header casing.

### Task 2: Implementation

- [x] Make Feishu auth header lookup case-insensitive.
- [x] Preserve missing-header and invalid-signature fail-closed behavior.
- [x] Run focused Feishu auth tests and observe GREEN.

Observed GREEN: `npm --workspace apps/core test -- feishu-auth.test.ts`
passed with 6 Feishu auth tests.

### Task 3: Verification And PR

- [x] Run `npm run verify`.
- [x] Commit and push.
- [x] Watch PR #3 checks.

Verification: `npm run verify` passed with 54 Core test files, 750 passing
tests, 4 skipped tests, 7 Python worker tests, and a valid Docker Compose
configuration.

PR update: pushed commit `21e9756` (`fix: accept feishu signature header
casing`) to PR #3.

Remote checks: GitHub Actions passed for AI Worker and Core.
