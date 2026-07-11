# Iris Feishu Token Fetch Timeout Design

## Context

Feishu document body sync needs a tenant access token before it can resolve wiki nodes or fetch raw document content. The document body fetcher now has bounded request timeouts, but `createFeishuTenantAccessTokenProvider` still performs an unbounded external `fetch`. If tenant-token retrieval stalls, the document sync worker can hang before reaching the document fetch timeout guard.

## Decision

Add timeout handling to the Feishu tenant access token provider:

- `createFeishuTenantAccessTokenProvider` accepts `timeoutMs`, defaulting to `10000`.
- Tenant-token HTTP requests pass an `AbortSignal` to `fetch`.
- `AbortError` is mapped to `Feishu tenant access token request timed out`.
- `createDocumentSyncRuntime` passes the existing `documentFetchTimeoutMs` into both the token provider and the document body fetcher, because token acquisition is part of the document sync fetch path.

## Scope

This does not change token caching, token refresh skew, Feishu credential configuration, retry policy, or queue behavior. A timed-out token request remains a document sync fetch failure that downstream worker and queue policy can retry or dead-letter.

## Quality Bar

Tests must prove tenant-token fetches receive abort signals, timeout errors are stable, existing cache behavior still works, and document sync runtime wires the configured timeout into both Feishu token and body fetch dependencies.
