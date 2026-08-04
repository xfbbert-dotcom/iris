# Final Residual Fix Report

Date: 2026-07-29

## Scope

Fix the Feishu wiki-space client classification when response headers have arrived but reading the response body rejects with `AbortError` after the request timeout aborts.

## RED Evidence

Added `classifies aborted response body reads as retryable timeouts` in `apps/core/tests/feishu-wiki-space-client.test.ts` before changing production code. The test returns a `200` response with JSON headers and an errored `ReadableStream` body that rejects with `AbortError`.

Command:

```text
npm --workspace apps/core test -- tests/feishu-wiki-space-client.test.ts
```

Result before the fix: 1 failed, 11 passed. The new test expected `classification: "timeout"` and `retriable: true`, but received `WikiSpaceSyncError { classification: "invalid_response", retriable: false }`.

## GREEN Evidence

Changed only the body-reading catch in `requestJson`: preserve the caught error, map `AbortError` to `new WikiSpaceSyncError("timeout", true)`, and retain `invalidResponse()` for all other body-reading failures.

Focused test command result after the fix: 1 test file passed; 12 tests passed; 0 failed.

Additional verification:

```text
npm run typecheck
```

Result: `@iris/core` ran `tsc --noEmit` successfully (exit 0).

```text
git diff --check
```

Result: exit 0 with no whitespace errors.

## Self-Review

- The regression test exercises the public `getNode` behavior with a response whose headers are available and whose body reader rejects, rather than asserting implementation details.
- `readBoundedJsonResponse` intentionally rethrows `AbortError`; the client now preserves that transport-timeout signal instead of collapsing it into malformed input.
- Malformed JSON and oversized response failures still take the unchanged `invalidResponse()` branch and remain terminal/non-retriable. Existing focused tests cover both cases.
- Scope is limited to the wiki-space client, its focused test, and this required evidence report. No deployment or hosted-model call was performed.

## Remaining Concerns

The focused regression simulates the body reader rejecting with `AbortError`; it does not perform a live Feishu network call. This is intentional for deterministic unit coverage. No release-blocking concerns remain within the requested scope.
