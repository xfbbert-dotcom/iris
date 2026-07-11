# Iris Feishu Document Body Fetcher Design

Date: 2026-07-03
Status: Phase 2Z design

## Goal

Phase 2Z adds the first Feishu-backed `DocumentBodyFetcher` implementation. It lets the existing document sync runner fetch body text for Feishu docx-style document sources through Feishu's raw-content API boundary.

This phase makes the document sync pipeline ready for real Feishu document bodies while keeping wiki traversal, file export, and runtime startup as separate phases.

## Scope

In scope:

- Add a Feishu tenant access token provider.
- Add a Feishu document body fetcher implementing `DocumentBodyFetcher`.
- Extract docx document tokens from supported Feishu/Lark document URLs.
- Fetch raw document content through an injected HTTP transport.
- Return `bodyText`, optional `sourceVersion`, and `fetchedAt`.
- Fail clearly for unsupported source types, unsupported URL shapes, API non-zero codes, invalid JSON, empty content, and HTTP failures.

Out of scope:

- Wiki tree traversal.
- File export and binary parsing.
- Rich block preservation.
- Runtime wiring.
- Permission freshness guard at answer time.

## Supported URL Shapes

The first implementation supports document URLs where the path contains either:

- `/docx/<document_id>`
- `/docs/<document_id>`

The token is read from the path segment immediately after `docx` or `docs`.

URLs under `/wiki/...`, `/file/...`, and unknown path shapes are rejected with explicit errors. They remain discoverable and queued, but cannot be fetched until their own fetcher support exists.

## Feishu API Boundary

The fetcher should use:

```text
GET /open-apis/docx/v1/documents/{document_id}/raw_content
Authorization: Bearer <tenant_access_token>
```

Expected successful body shape:

```json
{
  "code": 0,
  "data": {
    "content": "..."
  }
}
```

The implementation should not hard-code global `fetch` in tests. It accepts an injected `fetch` compatible function and `baseUrl`, defaulting to `https://open.feishu.cn`.

## Tenant Access Token Provider

Add `FeishuTenantAccessTokenProvider`.

It posts app credentials to:

```text
POST /open-apis/auth/v3/tenant_access_token/internal
```

Expected successful body shape:

```json
{
  "code": 0,
  "tenant_access_token": "...",
  "expire": 7200
}
```

The provider caches tokens until shortly before expiration. Tests should use fake time rather than waiting.

## Error Handling

Fetcher errors should be precise enough for `DocumentSyncRunner` to store useful failed snapshots:

- unsupported source type;
- unsupported Feishu document URL;
- tenant token request failed;
- tenant token response invalid;
- raw content request failed;
- raw content response invalid;
- raw content is empty.

The fetcher must not mark permissions itself. Permission and sync state updates remain owned by the sync runner and future permission guard layers.

## Constitutional Alignment

This phase advances the whitepaper requirement that Iris reads document bodies, not only links. It keeps the Feishu API integration behind a replaceable fetcher boundary, preserving the separation between document discovery, document sync, and answer-time permission enforcement.
