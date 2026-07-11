# Iris Feishu Raw Content Length Preflight Design

## Goal

Reject obviously oversized Feishu raw-content responses before JSON parsing when the HTTP response
declares a `content-length`.

## Architecture

Extend the Feishu document body fetcher's raw-content request path with an optional response-size
preflight:

- Raw-content responses compute a byte budget of `maxContentChars + 4096`.
- If `content-length` is a decimal safe integer above that budget, Iris rejects before
  `response.json()`.
- Missing, malformed, or chunked response lengths still fall back to the existing parsed content
  length check.
- Wiki-node lookups keep their existing behavior because they are metadata responses, not document
  bodies.

This is a pragmatic v1 guardrail, not a full streaming parser. It prevents the common case where
Feishu or a proxy provides a trustworthy response size header that is already too large.

## Invariants

- Valid raw-content responses below the budget still parse normally.
- Oversized parsed document content still fails with the existing character-limit error.
- Timeout handling still covers both headers and body parsing.
- Non-OK and non-zero Feishu response handling is unchanged.

## Out Of Scope

- Streaming JSON parsing with a hard byte counter.
- Changing `IRIS_FEISHU_DOCUMENT_MAX_CONTENT_CHARS`.
- Applying the preflight to wiki-node metadata responses.
- Truncating or partially ingesting oversized documents.
