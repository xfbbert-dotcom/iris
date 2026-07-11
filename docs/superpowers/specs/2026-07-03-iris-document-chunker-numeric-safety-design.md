# Iris Document Chunker Numeric Safety Design

## Problem

Document chunking is the first step before embedding and semantic retrieval.
The chunker already validates positive chunk sizes, but JavaScript values such as
`NaN`, `Infinity`, fractional numbers, and unsafe integers can slip past simple
greater-than checks or produce imprecise slicing behavior.

If invalid chunk settings are accepted, Iris can emit empty or distorted chunks
and quietly weaken document recall quality.

## Decision

Document chunker sizing options must be positive safe integers:

- `maxChunkChars` must be a positive safe integer.
- `minChunkChars` must be a positive safe integer.
- `minChunkChars` must remain less than or equal to `maxChunkChars`.

This is a local constructor guard; the default chunking strategy and merge/split
behavior stay unchanged.

## Non-Goals

- Do not tune default chunk sizes.
- Do not change paragraph merging behavior.
- Do not change embedding or retrieval ranking.
- Do not introduce document-type-specific chunking in this patch.

## Quality Bar

- `NaN`, `Infinity`, fractional, zero, negative, and unsafe chunk size values are
  rejected before chunking starts.
- Existing paragraph splitting, hard splitting, short-tail merging, and blank
  text behavior remain unchanged.
