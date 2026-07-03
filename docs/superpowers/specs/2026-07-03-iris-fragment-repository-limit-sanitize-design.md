# Iris Fragment Repository Limit Sanitization Design

## Problem

`DocumentFragmentRepository.searchSimilarFragments()` passes `input.limit` directly to the pgvector search SQL as `LIMIT $3`.

Callers normally sanitize fragment limits before retrieval, but the repository boundary should not allow `Infinity`, `-Infinity`, or `NaN` to reach SQL if a future caller bypasses the higher-level guard.

## Requirements

- Treat non-finite vector search limits as zero.
- Preserve finite floor/clamp behavior.
- Keep vector dimension validation and embedding table routing unchanged.

## Non-goals

- Do not change retrieval ranking.
- Do not change default answer-time fragment limits.
- Do not change permission guard behavior.

## Acceptance

- Vector search sends `LIMIT 0` for `Infinity` and `NaN`.
- Existing vector search behavior remains unchanged for finite limits.
- Full verification remains green.
