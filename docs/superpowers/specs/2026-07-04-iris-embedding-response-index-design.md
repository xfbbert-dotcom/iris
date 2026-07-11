# Iris Embedding Response Index Design

## Context

Iris uses embedding vectors to retrieve document fragments. The OpenAI-compatible embedding adapter
currently sorts response items by `index` when every item includes one, but it does not verify that
indexes are unique, integer, in range, or consistently present. A malformed provider response could
silently pair a text with the wrong vector, degrading retrieval quality.

## Decision

When any embedding response item includes an `index`, treat indexes as authoritative and require:

- every item has an integer safe `index`;
- indexes are unique;
- indexes cover the response item range `0..data.length - 1`.

If no item includes an `index`, keep the existing compatibility behavior and trust provider order.
The existing response-count and finite-number vector checks remain unchanged.

## Error Handling

Invalid indexes throw:

`embedding response indices were invalid`

This fails the reindex job instead of indexing potentially misaligned vectors.

## Testing

Add focused embedding provider tests for duplicate indexes, out-of-range indexes, and partial index
presence. Run focused tests, then the full verification suite.
