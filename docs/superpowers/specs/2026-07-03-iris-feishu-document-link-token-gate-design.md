# Iris Feishu Document Link Token Gate Design

## Context

Iris discovers group-visible documents from Feishu chat messages before the document sync worker fetches body content. The extractor previously accepted any supported product path whose first segment was `docx`, `docs`, or `wiki`, even when the URL did not contain a document token.

For a small 20-30 person team, the product should feel dependable: Iris should not register half-copied links as document sources and then surface avoidable sync failures.

## Decision

The Feishu document link extractor must only emit supported document links that include a non-blank second path segment. This keeps discovery aligned with the current body fetcher, which reads the second path segment as the document id or wiki node token.

Examples accepted:

- `https://docs.feishu.cn/docx/doc_token`
- `https://tenant.feishu.cn/docs/doc_token`
- `https://tenant.feishu.cn/wiki/wiki_token`

Examples rejected:

- `https://tenant.feishu.cn/docx`
- `https://tenant.feishu.cn/wiki/`

## Scope

This only changes automatic group-chat link discovery. Existing registered sources, manual source registration, source sync state transitions, and answer retrieval behavior are unchanged.

## Quality Bar

- Reject malformed supported-path links before registration.
- Keep existing query-string and fragment normalization.
- Preserve deduplication behavior after URL normalization.
- Cover the boundary with a focused unit test.
