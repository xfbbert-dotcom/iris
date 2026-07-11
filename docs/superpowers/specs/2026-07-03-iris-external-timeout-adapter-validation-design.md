# Iris External Timeout Adapter Validation Design

## Context

Environment parsing already rejects invalid timeout values for model, embedding,
and Feishu document fetch settings. Tests and future runtime composition can
still instantiate adapters directly with injected config objects. If those values
are invalid, `setTimeout` can abort immediately, overflow, or behave differently
than the operator intended.

## Decision

External I/O adapters validate timeout values at construction time:

- OpenAI-compatible answer model provider;
- OpenAI-compatible embedding provider;
- Feishu tenant access token provider;
- Feishu document body fetcher.

Each adapter requires `timeoutMs` to be a positive safe integer before any
request can start.

## Scope

This is a defensive adapter guard. It does not change environment variable names,
default timeout values, request timeout behavior, retry policy, or provider
payload parsing.

## Verification

- RED: focused provider tests showed invalid timeout values were accepted during
  adapter construction.
- GREEN: focused provider tests pass after adapters reject invalid values before
  request creation.
