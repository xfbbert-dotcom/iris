# Iris Feishu Link Extractor Single Source Design

## Context

Feishu message normalization exposed `documentLinks` metadata, while the actual document registration path used `FeishuDocumentLinkExtractor`. The normalizer had a separate URL parser that accepted file links and did not normalize query strings or fragments, so future callers could observe different document-link semantics than the registration path.

## Decision

`normalizeFeishuEvent` now reuses `createFeishuDocumentLinkExtractor()` for its `documentLinks` metadata. The normalizer therefore follows the same rules as document registration:

- support Feishu/Lark docx, docs, and wiki document paths,
- reject unsupported file/minutes paths,
- reject missing document tokens,
- trim chat punctuation,
- drop query strings and fragments before deduplication.

## Scope

- Does not change `FeishuMessageEventProcessor`; it already uses the official extractor.
- Does not add support for new Feishu product URL types.
- Does not change non-text message handling.

## Quality Bar

- Link metadata and registration link discovery do not diverge.
- Unsupported Feishu product links do not appear as document metadata.
- Copied links with query strings collapse to one canonical source URI.
