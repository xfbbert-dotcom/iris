# Iris Context Window Hard Limits Design

## Context

Iris anchors live chat after background documents so current group context stays closest to model output. The default live chat window is 20 messages, but explicit oversized limits could still include too much live chat or retrieve too many document chunks.

This matters when large documents are shared in chat: retrieval should add useful background, not drown out the current conversation.

## Decision

Add hard limits at context assembly and retrieval boundaries:

- `liveChatLimit` is capped at 20 messages.
- `fragmentLimit` is capped at 12 chunks.

Defaults remain unchanged: 20 live chat messages and 8 document fragments.

## Scope

This affects prompt assembly and semantic retrieval limits only. It does not change source indexing, chunking, permission checks, or the XML ordering of background documents before live chat context.

## Quality Bar

- Explicit oversized live chat limits still include only the latest 20 messages.
- Explicit oversized fragment limits are capped before vector search.
- Zero and negative limits keep their existing behavior.
