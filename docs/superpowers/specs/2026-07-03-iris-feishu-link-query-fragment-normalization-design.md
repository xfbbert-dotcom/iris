# Iris Feishu Link Query and Fragment Normalization Design

## Problem

Feishu copied document links often include query strings such as `?from=from_copylink`
or fragments such as `#heading`. Iris currently treats those full URLs as distinct
document source URIs, so the same document can be registered, synced, and indexed more
than once.

## Decision

Normalize discovered Feishu document links in the link extractor by dropping URL
`search` and `hash` after host validation.

This keeps source identity focused on the document URL path. Downstream registry
deduplication, sync planning, and idempotency keys then receive one canonical source URI
for the same document.

## Non-Goals

- Do not change body fetch parsing; it already reads document tokens from the path.
- Do not canonicalize arbitrary non-Feishu URLs; unsupported hosts remain ignored.
- Do not strip path segments, because Feishu document tokens live in the path.

## Quality Bar

- Links with only different query strings or fragments dedupe to one source URI.
- Existing host filtering and trailing punctuation trimming still work.
