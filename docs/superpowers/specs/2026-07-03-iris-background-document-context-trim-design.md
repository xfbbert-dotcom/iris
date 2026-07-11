# Iris Background Document Context Trim Design

## Problem

`assemblePromptContext` now trims live chat messages at the final prompt boundary, but
background document `source` and `text` values can still keep meaningless surrounding
whitespace. Feishu documents, wiki exports, and parser outputs can contain padded text,
which wastes prompt budget and makes retrieved evidence look less deliberate to the model.

## Decision

Trim background document `source` and `text` inside `formatBackgroundDocument` before XML
escaping.

This keeps trimming at the final prompt assembly boundary, matching the live chat behavior.
It does not change document retrieval, permission filtering, fragment ordering, or chunk
metadata.

## Non-Goals

- Do not alter document retrieval ranking.
- Do not remove internal whitespace inside document text.
- Do not filter background documents in this patch.
- Do not change XML tag ordering or Context Anchor placement.

## Quality Bar

- Padded background document source values render without surrounding whitespace.
- Padded background document text renders without surrounding whitespace.
- XML escaping still applies after trimming.
- Live chat context remains anchored after background documents.
