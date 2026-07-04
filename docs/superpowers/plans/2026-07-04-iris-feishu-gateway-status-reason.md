# Iris Feishu Gateway Status Reason Implementation Plan

**Goal:** Make Feishu Gateway enqueue-failure degradation explicit in
`/internal/status`.

**Architecture:** Keep the change inside the Core App status serializer. Do not
change gateway enqueue or ack-first semantics.

**Tech Stack:** TypeScript, Fastify injection tests, Vitest.

---

## File Structure

- Modify `apps/core/src/app.ts`.
- Modify `apps/core/tests/answer-draft-api.test.ts`.
- Create `docs/superpowers/specs/2026-07-04-iris-feishu-gateway-status-reason-design.md`.
- Create `docs/superpowers/plans/2026-07-04-iris-feishu-gateway-status-reason.md`.

### Task 1: Regression Test

- [x] Add a consolidated status assertion for `enqueue_failures_present`.
- [x] Run the focused API test and observe RED.

Observed RED: the focused API test failed because the degraded Feishu Gateway
status did not include `degradedReason`.

### Task 2: Implementation

- [x] Add `degradedReason` to degraded Feishu Gateway status.
- [x] Keep healthy gateway status unchanged.
- [x] Run the focused API test and observe GREEN.

Observed GREEN: `npm --workspace apps/core test -- answer-draft-api.test.ts -t
"surfaces Feishu gateway enqueue failures"` passed.

### Task 3: Verification And PR

- [x] Run `npm run verify`.
- [ ] Commit and push.
- [ ] Watch PR #3 checks.

Verification: `npm run verify` passed with 54 Core test files, 750 passing
tests, 4 skipped tests, 7 Python worker tests, and a valid Docker Compose
configuration.
