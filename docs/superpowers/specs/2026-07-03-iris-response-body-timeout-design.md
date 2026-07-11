# Iris External Response Body Timeout Design

## Context

Iris external HTTP providers use `AbortController` to bound request time, but several implementations clear the timer immediately after `fetch()` resolves. A server can return headers and then stall while the response body is read through `response.json()`. In that case Iris can still hang even though the request had a timeout.

Affected boundaries:

- OpenAI-compatible model provider.
- OpenAI-compatible embedding provider.
- Feishu tenant access token provider.
- Feishu document body fetcher for wiki-node and raw-content JSON responses.

## Decision

Treat `fetch()` and response body parsing as one timeout-protected operation:

- Keep the abort timer active until `response.json()` finishes.
- If body parsing fails with `AbortError`, surface the same timeout error as the fetch operation.
- Keep non-abort JSON parsing failures mapped to their existing invalid JSON messages.

## Scope

This does not change timeout values, retry policy, prompt assembly, token caching, Feishu document parsing, or model response validation. It only closes the gap between response headers and response body consumption.

## Quality Bar

Tests must prove body-read `AbortError` is reported as a timeout for each external provider family while malformed non-abort JSON still reports invalid JSON.
