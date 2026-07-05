# Iris Feishu Link ASCII Comma Boundary Design

## Goal

Prevent document URLs pasted into group chat from absorbing adjacent English comma-separated text.
When a user writes `https://docs.feishu.cn/docx/token,please review`, Iris should register the
document token, not `token,please`.

## Decision

`FeishuDocumentLinkExtractor` treats ASCII comma as a URL boundary during matching, alongside
whitespace, quotes, and existing fullwidth chat punctuation boundaries.

## Invariants

- Existing supported Feishu and Lark document links still normalize to canonical `https` URLs.
- Query strings and fragments are still stripped before deduplication.
- Fullwidth punctuation behavior is unchanged.
- The first valid link before the comma is preserved instead of dropping the candidate entirely.

## Out Of Scope

- Expanding supported Feishu URL shapes.
- Adding warnings for malformed chat text.
- Changing document body fetch token validation.
