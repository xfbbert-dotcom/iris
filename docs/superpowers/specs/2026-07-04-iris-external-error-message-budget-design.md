# Iris External Error Message Budget Design

## Goal

Prevent oversized external service error messages from propagating through Iris exceptions,
operator responses, or logs.

## Architecture

Add `readExternalErrorMessage` as the shared boundary helper for external adapter errors. The helper
reads common response shapes:

- OpenAI-compatible: `error.message`
- Feishu-style: `msg` or `message`

It trims useful messages, falls back to `unknown error`, and truncates oversized messages to `512`
characters with a visible ` ... [truncated]` marker.

The helper is used by:

- OpenAI-compatible model provider.
- OpenAI-compatible embedding provider.
- Feishu document body fetcher.
- Feishu tenant access token provider.
- Feishu document permission checker.

## Invariants

- Existing short provider and Feishu error messages remain unchanged.
- Non-JSON, timeout, HTTP status, and Feishu code-handling behavior is unchanged.
- Truncated messages preserve a visible marker so operators can tell the external message was
  larger than Iris retained.
- Each adapter still owns its own status-specific error prefix.

## Out Of Scope

- Redacting specific secret patterns inside external error messages.
- Reading plain-text non-JSON response bodies.
- Changing retry, timeout, or status classification behavior.
