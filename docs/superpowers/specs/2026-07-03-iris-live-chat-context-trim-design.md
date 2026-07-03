# Iris Live Chat Context Trim Design

## Problem

`assemblePromptContext` filters blank live chat messages, but it formats nonblank messages
with the original `speaker` and `text` strings. If a caller passes padded values, Iris
spends prompt space on meaningless whitespace and can make the live chat context look
sloppier to the model.

## Decision

Trim live chat `speaker` and `text` at prompt formatting time.

This keeps `assemblePromptContext` defensive as the final prompt boundary. Existing XML
escaping remains applied after trimming.

## Non-Goals

- Do not change the live chat message limit rules.
- Do not trim background document bodies in this patch.
- Do not alter XML tag ordering or Context Anchor placement.

## Quality Bar

- Padded live chat speaker/text values render without surrounding whitespace.
- Blank live chat filtering still happens before limit selection.
- XML escaping still protects prompt tags after trimming.
