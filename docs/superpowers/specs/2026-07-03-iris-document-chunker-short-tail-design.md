# Iris Document Chunker Short Tail Design

## Context

Iris indexes document chunks independently. Very short trailing blocks such as final decisions, acknowledgements, or closing notes produce weak standalone embeddings when separated from the preceding context.

The existing chunker already merges blocks until the current chunk reaches `minChunkChars`, but it could still emit a tiny final chunk when the previous chunk was already large enough.

## Decision

`mergeBlocks` now merges a very short trailing block into the previous chunk when:

- the block is the final block,
- its length is less than half of `minChunkChars`, and
- the merged chunk stays within `maxChunkChars`.

This improves semantic quality for tiny document tails without broadly merging normal short paragraphs or headings.

## Scope

- Does not add chunk overlap.
- Does not change hard splitting for single long blocks.
- Does not merge non-trailing short blocks.
- Does not allow any chunk to exceed `maxChunkChars`.

## Quality Bar

- Tiny trailing conclusions keep their preceding context.
- Existing deterministic chunk ordering is preserved.
- Blank chunk filtering remains unchanged.
