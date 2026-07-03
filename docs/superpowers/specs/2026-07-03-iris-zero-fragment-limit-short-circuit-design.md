# Iris Zero Fragment Limit Short-Circuit Design

## Problem

When `fragmentLimit` is `0`, callers are explicitly asking Iris to answer without retrieved
document fragments. `DocumentRetrievalContextBuilder` still embedded the query and called
vector search with limit `0`, then ran through the rest of the retrieval path.

That wastes latency and provider calls for live-chat-only answers.

## Decision

Sanitize `fragmentLimit` before embedding. If the sanitized limit is `0`, return a prompt
context with no background documents and the requested live chat context.

The result keeps diagnostics explicit:

- `allowedFragments: []`
- `deniedDocumentIds: []`
- `retrievedFragmentCount: 0`

## Non-Goals

- Do not change the default fragment limit.
- Do not skip retrieval for positive limits.
- Do not change live chat limit handling.
- Do not change query validation in the answer draft orchestrator.

## Quality Bar

- `fragmentLimit: 0` does not call the embedding provider.
- `fragmentLimit: 0` does not call vector search.
- `fragmentLimit: 0` does not call live permission checks.
- Live chat context remains available in the prompt.
