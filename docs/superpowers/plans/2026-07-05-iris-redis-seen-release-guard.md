# Iris Redis Seen Release Guard Implementation Plan

**Goal:** Prevent invalid Redis queue payloads from releasing unrelated
idempotency keys during DLQ cleanup.

**Architecture:** Keep the existing Redis queue and DLQ contracts. Tighten only
the invalid-payload `seen` release helpers so they can release a key only after
lightweight semantic validation against fields from the same payload.

**Tech Stack:** TypeScript, Vitest, existing Redis raw event, document sync, and
document reindex queue adapters.

## Tasks

- [x] Add regression tests for mismatched invalid document sync payloads.
- [x] Add regression tests for mismatched invalid document reindex payloads.
- [x] Add regression tests for non-Feishu invalid raw event payloads.
- [x] Confirm the tests fail because the old helper releases the untrusted key.
- [x] Recompute document sync and reindex canonical keys before release.
- [x] Require Feishu raw-event provenance before raw-event key release.
- [x] Confirm focused Redis queue tests pass.

## Verification

Focused command:

```powershell
npm --workspace apps/core test -- redis-document-sync-queue.test.ts redis-document-reindex-queue.test.ts redis-raw-event-queue.test.ts
```

Observed:

- Red: 3 expected failures, one per Redis queue family.
- Green: 3 files passed, 115 tests passed.
