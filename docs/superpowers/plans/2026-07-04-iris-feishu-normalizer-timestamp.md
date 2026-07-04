# Iris Feishu Normalizer Timestamp Implementation Plan

**Goal:** Keep Feishu timestamp parsing consistent across the gateway-facing
normalizer and raw event processor.

**Architecture:** Add a local decimal millisecond reader in
`feishu-event-normalizer.ts`, matching the processor's strict timestamp
semantics without changing the normalized event shape.

**Tech Stack:** TypeScript, Vitest.

---

## File Structure

- Modify `apps/core/src/feishu/feishu-event-normalizer.ts`.
- Modify `apps/core/tests/feishu-event-normalizer.test.ts`.
- Create `docs/superpowers/specs/2026-07-04-iris-feishu-normalizer-timestamp-design.md`.
- Create `docs/superpowers/plans/2026-07-04-iris-feishu-normalizer-timestamp.md`.

### Task 1: Regression Tests

- [x] Add tests rejecting non-decimal and zero Feishu `create_time` values.
- [x] Run `npm --workspace apps/core test -- feishu-event-normalizer.test.ts`
  and observe RED.

Observed: focused normalizer tests failed because `1e3` and `0` were accepted
as timestamps.

### Task 2: Implementation

- [x] Add a positive decimal millisecond parser.
- [x] Use it before constructing the timestamp.
- [x] Preserve valid timestamp normalization.
- [x] Run focused normalizer tests and observe GREEN.

Observed: focused normalizer tests passed with 13 passing tests.

### Task 3: Verification And PR

- [x] Run `npm run verify`.
- [ ] Commit and push.
- [ ] Watch PR #3 checks.

Observed: `npm run verify` passed. Core reported 746 passing tests and 4 skipped
tests. Python worker tests reported 7 passing tests. Docker Compose config
rendered successfully.
