# Iris Internal Status Error Message Budget Design

## Goal

Prevent oversized operational errors from bloating `/internal/status` responses.

## Architecture

Add `normalizeInternalStatusErrorMessage` as the shared internal-status diagnostic boundary. The
helper:

- Converts `Error` and non-`Error` failures to text.
- Trims short messages.
- Falls back to `unknown error` for blank messages.
- Truncates oversized messages to `1000` characters with ` ... [truncated]`.

The first use is Feishu gateway raw-event enqueue failures. When queue persistence fails after the
gateway has acknowledged Feishu, Iris records a bounded `latestEnqueueError.message` in the
consolidated status snapshot. The external enqueue observer still receives the original error so
logs and alerts can preserve full diagnostic detail.

## Invariants

- Feishu callback acknowledgement behavior is unchanged.
- Gateway enqueue failure counts and degraded status behavior are unchanged.
- `onFeishuGatewayEnqueueError` still receives the original error object.
- Existing short status messages remain readable and unchanged except for trimming.

## Out Of Scope

- Redacting secret patterns inside operational errors.
- Changing the shape of `/internal/status`.
- Bounding raw Feishu callback payloads.
- Changing worker loop snapshot error handling, which has its own worker-loop boundary.
