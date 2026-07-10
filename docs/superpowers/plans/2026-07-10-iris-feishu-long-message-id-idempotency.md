# Iris Feishu Long Message ID Idempotency Implementation Plan

**Goal:** Prevent duplicate raw events when Feishu retries a callback with no usable event ID and a
long `message_id` whose `message:`-prefixed fallback would exceed the raw event ID budget.

**Architecture:** Keep event IDs first, message IDs second, body hashes last. Add a compact
`message-hash:<sha256(message_id)>` fallback only when the message ID is non-blank but too long to
prefix safely.

**Tech Stack:** TypeScript, Vitest, existing Feishu Gateway tests.

---

### Task 1: Capture The Regression

- [x] Add a Feishu Gateway test that sends two callbacks with the same 512-character `message_id`,
  no usable event ID, and different `retry_count` values.
- [x] Assert both queued raw events use the same `raw-event:feishu:message-hash:<sha256>` key.
- [x] Run the focused gateway test and confirm RED.

Observed: `npm --workspace apps/core test -- tests/feishu-gateway.test.ts --reporter=dot`
failed because the two retries fell back to different `body-<sha256>` idempotency keys.

### Task 2: Add Compact Message-ID Fallback

- [x] Add `normalizeMessageEventId()` at the Feishu Gateway boundary.
- [x] Return `message:<message_id>` when the prefixed value fits the raw event ID budget.
- [x] Return `message-hash:<sha256(message_id)>` when the message ID is non-blank but too long to
  prefix safely.
- [x] Run the focused gateway test and confirm GREEN.

Observed: `npm --workspace apps/core test -- tests/feishu-gateway.test.ts --reporter=dot`
passed with 39 tests.

### Task 3: Publish And Verify

- [x] Run full verification.

Observed:

- `npm run typecheck` passed.
- `npm test` passed with 1045 tests passed / 4 skipped.
- `npm run test:python` passed with 7 tests.
- `docker compose config` passed.
- `git diff --check` passed with Windows line-ending warnings only.

- [ ] Commit, push, update PR #3, and confirm GitHub Actions checks.
