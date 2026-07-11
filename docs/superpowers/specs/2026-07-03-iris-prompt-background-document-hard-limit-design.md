# Iris Prompt Background Document Hard Limit Design

## Context

Document retrieval caps semantic search at 12 fragments, but `assemblePromptContext` is the final prompt boundary and previously trusted callers to pass a bounded, meaningful background document list. If an upstream caller or future code path passed too many documents, the prompt could still let background material dilute live chat context.

## Decision

`assemblePromptContext` now applies a final background document guard:

- Drop background documents with blank source or blank text.
- Keep only the first 12 meaningful background documents.
- Preserve the existing XML order: background documents first, live chat context last.

The first 12 documents are preserved because upstream retrieval order represents relevance order.

## Scope

- Does not change semantic retrieval limits.
- Does not change live chat anchoring or live chat limits.
- Does not change XML escaping or trimming behavior for retained documents.

## Quality Bar

- More than 12 background documents never enter the prompt.
- Blank background documents never enter the prompt.
- Live chat remains the final prompt section.
