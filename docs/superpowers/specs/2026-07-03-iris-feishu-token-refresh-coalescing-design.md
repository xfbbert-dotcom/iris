# Iris Feishu Token Refresh Coalescing Design

## Problem

Document sync, wiki lookup, and other Feishu API calls share the tenant access
token provider. The provider caches completed tokens, but without in-flight
coalescing, concurrent callers that arrive while the token is missing or expired
can each trigger their own token request.

For a small internal deployment this can still create avoidable latency spikes,
consume Feishu rate budget, and amplify transient token endpoint failures.

## Decision

The tenant access token provider must share one in-flight refresh promise across
concurrent callers:

- If a valid cached token exists, return it immediately.
- If a refresh is already in progress, return the same promise to other callers.
- If the refresh succeeds, cache the token with the existing refresh skew.
- If the refresh fails or times out, clear the in-flight promise so a later call
  can retry.

This keeps the provider process-local and simple while removing the common
single-process stampede path.

## Non-Goals

- Do not introduce distributed token locking across multiple Core App processes.
- Do not change Feishu token endpoint paths or response parsing.
- Do not change the existing refresh skew.
- Do not cache failed token responses.

## Quality Bar

- Concurrent refresh calls result in one external fetch.
- Concurrent callers receive the same token result.
- A failed coalesced refresh is not sticky; a later call can retry.
- Existing timeout, invalid JSON, non-zero Feishu code, and missing-token errors
  remain unchanged.
